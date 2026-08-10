#!/usr/bin/env python3
"""Reconstruct one-row-per-decision data from a Qualtrics CSV export.

The card-stacking survey stores complete RFC 4180 decision rows in embedded-
data fields named ``cs_log_chunk_001`` through ``cs_log_chunk_064``.  This
utility repeats the response-level columns for each decoded decision and
appends the decision columns declared in ``cs_log_columns``.
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence, TextIO


COUNT_COLUMN = "cs_log_chunk_count"
COLUMNS_COLUMN = "cs_log_columns"
FORMAT_COLUMN = "cs_log_format_version"
OVERFLOW_COLUMN = "cs_log_overflow"
OVERFLOW_ROWS_COLUMN = "cs_log_overflow_rows"
SUPPORTED_FORMAT = "csv-v1"
MAX_CHUNKS = 64
CHUNK_COLUMNS = tuple(
    f"cs_log_chunk_{chunk_number:03d}"
    for chunk_number in range(1, MAX_CHUNKS + 1)
)
_NONNEGATIVE_INTEGER = re.compile(r"[0-9]+")
_FALSE_VALUES = frozenset({"", "0", "false", "f", "no", "n"})
_TRUE_VALUES = frozenset({"1", "true", "t", "yes", "y"})


class DecodeError(ValueError):
    """Raised when an export cannot be decoded without losing information."""


@dataclass(frozen=True)
class DecodedExport:
    """Fully decoded export plus counts useful to CLI callers and tests."""

    output_header: list[str]
    output_rows: list[list[str]]
    response_count: int
    zero_decision_response_count: int


def _parse_csv_records(stream: TextIO, source_name: str) -> list[tuple[int, list[str]]]:
    reader = csv.reader(stream, strict=True)
    records: list[tuple[int, list[str]]] = []
    try:
        for record_number, row in enumerate(reader, start=1):
            records.append((record_number, row))
    except csv.Error as exc:
        raise DecodeError(
            f"{source_name}: malformed CSV near physical line {reader.line_num}: {exc}"
        ) from exc
    return records


def _find_header(
    records: Sequence[tuple[int, list[str]]], source_name: str
) -> tuple[int, int, list[str]]:
    """Return the sequence index, record number, and normalized export header."""

    for sequence_index, (record_number, row) in enumerate(records[:5]):
        normalized = [cell.strip() for cell in row]
        if COUNT_COLUMN not in normalized:
            continue
        if any(not name for name in normalized):
            raise DecodeError(
                f"{source_name}: CSV record {record_number} has a blank header name"
            )
        duplicates = sorted(
            name for name in set(normalized) if normalized.count(name) > 1
        )
        if duplicates:
            raise DecodeError(
                f"{source_name}: CSV record {record_number} has duplicate header "
                f"column(s): {', '.join(duplicates)}"
            )
        return sequence_index, record_number, normalized
    raise DecodeError(
        f"{source_name}: could not find a header containing {COUNT_COLUMN!r} "
        "among the first 5 CSV records"
    )


def _is_import_id_row(row: Sequence[str]) -> bool:
    """Recognize Qualtrics' machine-readable metadata row."""

    nonempty = [cell.strip() for cell in row if cell.strip()]
    if not nonempty:
        return False
    import_id_cells = sum(
        '"ImportId"' in cell or "'ImportId'" in cell for cell in nonempty
    )
    return import_id_cells >= max(1, len(nonempty) // 2)


def _data_start_index(
    records: Sequence[tuple[int, list[str]]], header_index: int
) -> int:
    """Skip the standard Qualtrics description and ImportId metadata rows."""

    metadata_probe_end = min(len(records), header_index + 4)
    for sequence_index in range(header_index + 1, metadata_probe_end):
        if _is_import_id_row(records[sequence_index][1]):
            return sequence_index + 1
    return header_index + 1


def _record_to_mapping(
    header: Sequence[str],
    row: Sequence[str],
    record_number: int,
    source_name: str,
) -> dict[str, str]:
    if len(row) != len(header):
        raise DecodeError(
            f"{source_name}: CSV record {record_number} has {len(row)} fields; "
            f"the detected header has {len(header)}"
        )
    return dict(zip(header, row))


def _response_context(
    response: dict[str, str], record_number: int, source_name: str
) -> str:
    response_id = ""
    for name, value in response.items():
        if name.casefold() in {"responseid", "response_id"} and value.strip():
            response_id = value.strip()
            break
    if response_id:
        return f"{source_name}: CSV record {record_number} (ResponseId={response_id})"
    return f"{source_name}: CSV record {record_number}"


def _parse_chunk_count(raw_value: str, context: str) -> int:
    value = raw_value.strip()
    if not value:
        return 0
    if not _NONNEGATIVE_INTEGER.fullmatch(value):
        raise DecodeError(
            f"{context}: {COUNT_COLUMN} must be an integer from 0 to "
            f"{MAX_CHUNKS}; got {raw_value!r}"
        )
    parsed = int(value)
    if parsed > MAX_CHUNKS:
        raise DecodeError(
            f"{context}: {COUNT_COLUMN}={parsed} exceeds the supported maximum "
            f"of {MAX_CHUNKS}"
        )
    return parsed


def _parse_boolean(raw_value: str, field_name: str, context: str) -> bool:
    normalized = raw_value.strip().casefold()
    if normalized in _FALSE_VALUES:
        return False
    if normalized in _TRUE_VALUES:
        return True
    raise DecodeError(
        f"{context}: {field_name} must be 0/1 or false/true; got {raw_value!r}"
    )


def _parse_single_csv_record(raw_value: str, field_name: str, context: str) -> list[str]:
    reader = csv.reader(io.StringIO(raw_value, newline=""), strict=True)
    try:
        records = list(reader)
    except csv.Error as exc:
        raise DecodeError(f"{context}: malformed {field_name}: {exc}") from exc
    if len(records) != 1:
        raise DecodeError(
            f"{context}: {field_name} must contain exactly one RFC 4180 record; "
            f"found {len(records)}"
        )
    return records[0]


def _parse_decision_columns(raw_value: str, context: str) -> list[str]:
    if not raw_value:
        return []
    columns = _parse_single_csv_record(raw_value, COLUMNS_COLUMN, context)
    if not columns or any(not name for name in columns):
        raise DecodeError(f"{context}: {COLUMNS_COLUMN} contains a blank column name")
    duplicates = sorted(name for name in set(columns) if columns.count(name) > 1)
    if duplicates:
        raise DecodeError(
            f"{context}: {COLUMNS_COLUMN} contains duplicate column(s): "
            f"{', '.join(duplicates)}"
        )
    return columns


def _validate_packing_metadata(
    response: dict[str, str],
    declared_chunk_count: int,
    context: str,
) -> list[tuple[str, str]]:
    if OVERFLOW_COLUMN in response and _parse_boolean(
        response[OVERFLOW_COLUMN], OVERFLOW_COLUMN, context
    ):
        overflow_rows = response.get(OVERFLOW_ROWS_COLUMN, "").strip()
        detail = f"; omitted decision rows={overflow_rows}" if overflow_rows else ""
        raise DecodeError(
            f"{context}: {OVERFLOW_COLUMN}=1 means the decision log is incomplete"
            f"{detail}"
        )

    format_version = response.get(FORMAT_COLUMN, "").strip()
    if format_version and format_version != SUPPORTED_FORMAT:
        raise DecodeError(
            f"{context}: unsupported {FORMAT_COLUMN}={format_version!r}; "
            f"expected {SUPPORTED_FORMAT!r}"
        )

    nonempty_chunks = [
        (name, response.get(name, ""))
        for name in CHUNK_COLUMNS
        if response.get(name, "") != ""
    ]
    expected_names = list(CHUNK_COLUMNS[:declared_chunk_count])
    actual_names = [name for name, _ in nonempty_chunks]
    if actual_names != expected_names:
        missing = [name for name in expected_names if name not in actual_names]
        unexpected = [name for name in actual_names if name not in expected_names]
        details: list[str] = []
        if missing:
            details.append(f"missing/empty: {', '.join(missing)}")
        if unexpected:
            details.append(f"unexpected nonempty: {', '.join(unexpected)}")
        detail = "; ".join(details) or "chunk fields are not contiguous"
        raise DecodeError(
            f"{context}: declared {COUNT_COLUMN}={declared_chunk_count} does not "
            f"match the chunk fields ({detail})"
        )
    return nonempty_chunks


def _parse_decision_chunks(
    chunks: Iterable[tuple[str, str]],
    decision_columns: Sequence[str],
    context: str,
) -> list[list[str]]:
    decisions: list[list[str]] = []
    for chunk_name, raw_chunk in chunks:
        reader = csv.reader(io.StringIO(raw_chunk, newline=""), strict=True)
        try:
            for chunk_row_number, decision in enumerate(reader, start=1):
                if len(decision) != len(decision_columns):
                    raise DecodeError(
                        f"{context}: {chunk_name} row {chunk_row_number} has "
                        f"{len(decision)} fields; {COLUMNS_COLUMN} declares "
                        f"{len(decision_columns)}"
                    )
                decisions.append(decision)
        except csv.Error as exc:
            raise DecodeError(
                f"{context}: malformed RFC 4180 data in {chunk_name} near chunk "
                f"line {reader.line_num}: {exc}"
            ) from exc
    return decisions


def decode_records(
    records: Sequence[tuple[int, list[str]]], source_name: str = "input"
) -> DecodedExport:
    """Decode parsed Qualtrics records into a rectangular decision table."""

    header_index, _header_record_number, header = _find_header(records, source_name)
    response_fields = [
        name
        for name in header
        if name != COLUMNS_COLUMN and name not in CHUNK_COLUMNS
    ]
    data_start = _data_start_index(records, header_index)

    output_rows: list[list[str]] = []
    canonical_decision_columns: list[str] | None = None
    response_count = 0
    zero_decision_response_count = 0

    for record_number, raw_row in records[data_start:]:
        if not raw_row or all(cell == "" for cell in raw_row):
            continue
        response = _record_to_mapping(
            header, raw_row, record_number, source_name
        )
        context = _response_context(response, record_number, source_name)
        response_count += 1

        declared_chunk_count = _parse_chunk_count(
            response[COUNT_COLUMN], context
        )
        decision_columns = _parse_decision_columns(
            response.get(COLUMNS_COLUMN, ""), context
        )
        chunks = _validate_packing_metadata(
            response, declared_chunk_count, context
        )

        if declared_chunk_count and not decision_columns:
            raise DecodeError(
                f"{context}: {COLUMNS_COLUMN} is empty but "
                f"{COUNT_COLUMN}={declared_chunk_count}"
            )
        if decision_columns:
            if canonical_decision_columns is None:
                collisions = sorted(set(response_fields) & set(decision_columns))
                if collisions:
                    raise DecodeError(
                        f"{context}: decision columns collide with response-level "
                        f"columns: {', '.join(collisions)}"
                    )
                canonical_decision_columns = decision_columns
            elif decision_columns != canonical_decision_columns:
                raise DecodeError(
                    f"{context}: {COLUMNS_COLUMN} differs from an earlier response"
                )

        decisions = _parse_decision_chunks(chunks, decision_columns, context)
        if not decisions:
            zero_decision_response_count += 1
            continue

        response_values = [response[name] for name in response_fields]
        output_rows.extend(response_values + decision for decision in decisions)

    decision_header = canonical_decision_columns or []
    return DecodedExport(
        output_header=response_fields + decision_header,
        output_rows=output_rows,
        response_count=response_count,
        zero_decision_response_count=zero_decision_response_count,
    )


def decode_file(input_path: Path, output_path: Path) -> DecodedExport:
    """Decode *input_path* and write the reconstructed table to *output_path*."""

    try:
        with input_path.open("r", encoding="utf-8-sig", newline="") as stream:
            records = _parse_csv_records(stream, str(input_path))
    except OSError as exc:
        raise DecodeError(f"could not read {input_path}: {exc}") from exc

    decoded = decode_records(records, str(input_path))
    try:
        with output_path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\r\n")
            writer.writerow(decoded.output_header)
            writer.writerows(decoded.output_rows)
    except OSError as exc:
        raise DecodeError(f"could not write {output_path}: {exc}") from exc
    return decoded


def _csv_record(values: Sequence[str]) -> str:
    buffer = io.StringIO(newline="")
    csv.writer(buffer, lineterminator="\r\n").writerow(values)
    return buffer.getvalue()


class _SelfTests(unittest.TestCase):
    maxDiff = None

    def _write_export(self, path: Path, responses: Sequence[Sequence[str]]) -> None:
        header = [
            "ResponseId",
            "cs_task_status",
            COUNT_COLUMN,
            COLUMNS_COLUMN,
            FORMAT_COLUMN,
            OVERFLOW_COLUMN,
            OVERFLOW_ROWS_COLUMN,
            *CHUNK_COLUMNS,
        ]
        description_row = ["Response ID", "Task status", *header[2:]]
        import_id_row = [
            f'{{"ImportId":"{name}"}}' for name in header
        ]
        with path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\r\n")
            writer.writerow(header)
            writer.writerow(description_row)
            writer.writerow(import_id_row)
            writer.writerows(responses)

    @staticmethod
    def _response(
        response_id: str,
        status: str,
        decision_columns: Sequence[str],
        chunks: Sequence[str],
        *,
        count: int | None = None,
        overflow: str = "0",
        overflow_rows: str = "0",
    ) -> list[str]:
        encoded_columns = _csv_record(decision_columns).removesuffix("\r\n")
        chunk_values = list(chunks) + [""] * (MAX_CHUNKS - len(chunks))
        return [
            response_id,
            status,
            str(len(chunks) if count is None else count),
            encoded_columns,
            SUPPORTED_FORMAT,
            overflow,
            overflow_rows,
            *chunk_values,
        ]

    def test_multichunk_round_trip_quotes_and_zero_decisions(self) -> None:
        columns = ["screen_number", "chosen_card_id", "note"]
        first = ["1", "card,one", 'He said "yes"']
        second = ["2", 'card "two"', "plain"]
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = Path(temporary_directory) / "qualtrics.csv"
            output_path = Path(temporary_directory) / "decisions.csv"
            self._write_export(
                input_path,
                [
                    self._response(
                        "R_quoted", "duration_complete", columns,
                        [_csv_record(first), _csv_record(second)],
                    ),
                    self._response(
                        "R_zero", "inactivity", columns, [],
                    ),
                ],
            )

            decoded = decode_file(input_path, output_path)

            self.assertEqual(decoded.response_count, 2)
            self.assertEqual(decoded.zero_decision_response_count, 1)
            self.assertEqual(len(decoded.output_rows), 2)
            with output_path.open("r", encoding="utf-8", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(rows[0]["ResponseId"], "R_quoted")
            self.assertEqual(rows[0]["chosen_card_id"], "card,one")
            self.assertEqual(rows[0]["note"], 'He said "yes"')
            self.assertEqual(rows[1]["chosen_card_id"], 'card "two"')
            self.assertNotIn("R_zero", {row["ResponseId"] for row in rows})

    def test_malformed_decision_row_is_response_specific(self) -> None:
        columns = ["screen_number", "chosen_card_id", "note"]
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = Path(temporary_directory) / "malformed.csv"
            self._write_export(
                input_path,
                [
                    self._response(
                        "R_bad", "duration_complete", columns,
                        [_csv_record(["1", "missing note"])],
                    )
                ],
            )
            with self.assertRaisesRegex(
                DecodeError,
                r"ResponseId=R_bad.*cs_log_chunk_001 row 1 has 2 fields",
            ):
                decode_file(input_path, Path(temporary_directory) / "out.csv")

    def test_chunk_count_mismatch_and_overflow_fail(self) -> None:
        columns = ["screen_number"]
        with tempfile.TemporaryDirectory() as temporary_directory:
            base = Path(temporary_directory)
            mismatch_path = base / "mismatch.csv"
            self._write_export(
                mismatch_path,
                [
                    self._response(
                        "R_mismatch", "duration_complete", columns,
                        [_csv_record(["1"])], count=2,
                    )
                ],
            )
            with self.assertRaisesRegex(DecodeError, r"ResponseId=R_mismatch.*missing/empty"):
                decode_file(mismatch_path, base / "mismatch-out.csv")

            overflow_path = base / "overflow.csv"
            self._write_export(
                overflow_path,
                [
                    self._response(
                        "R_overflow", "duration_complete", columns,
                        [_csv_record(["1"])], overflow="1", overflow_rows="17",
                    )
                ],
            )
            with self.assertRaisesRegex(
                DecodeError, r"ResponseId=R_overflow.*decision log is incomplete.*17"
            ):
                decode_file(overflow_path, base / "overflow-out.csv")


def _run_self_tests() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(_SelfTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def _default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}_decisions.csv")


def _build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Reconstruct one row per card-stacking decision from a Qualtrics "
            "CSV export."
        )
    )
    parser.add_argument("input", nargs="?", type=Path, help="Qualtrics CSV export")
    parser.add_argument(
        "-o", "--output", type=Path,
        help="output CSV (default: INPUT_decisions.csv)",
    )
    parser.add_argument(
        "--self-test", action="store_true",
        help="run the built-in decoder tests and exit",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_argument_parser()
    arguments = parser.parse_args(argv)
    if arguments.self_test:
        if arguments.input is not None or arguments.output is not None:
            parser.error("--self-test cannot be combined with input or --output")
        return _run_self_tests()
    if arguments.input is None:
        parser.error("input is required unless --self-test is used")

    output_path = arguments.output or _default_output_path(arguments.input)
    try:
        decoded = decode_file(arguments.input, output_path)
    except DecodeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    decision_count = len(decoded.output_rows)
    print(
        f"Wrote {decision_count} decision row(s) from "
        f"{decoded.response_count} response(s) to {output_path}"
    )
    if decoded.zero_decision_response_count:
        print(
            f"Skipped {decoded.zero_decision_response_count} response(s) with "
            "zero decisions; their response-level summaries remain in the "
            "original Qualtrics export."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
