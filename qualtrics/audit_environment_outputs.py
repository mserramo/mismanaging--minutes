#!/usr/bin/env python3
"""Stream-audit the certified bank and both review CSVs without OR-Tools."""

from __future__ import annotations

import argparse
import base64
import csv
import itertools
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Sequence

from generate_environment import (
    DEFAULT_BANK,
    DEFAULT_DETAIL,
    DEFAULT_PROFILE,
    DEFAULT_SUMMARY,
    SIDE_TASKS,
    load_profile,
    verify_files,
)


def contribution_delta(before_raw: str, after_raw: str) -> int:
    before = json.loads(before_raw)
    after = json.loads(after_raw)
    return int(after.get("contribution", 0)) - int(before.get("contribution", 0))


def unpack_rounds(bank: dict[str, Any], packed: dict[str, Any]) -> list[list[tuple[str, int | None]]]:
    raw = base64.b64decode(packed["rounds_b64"])
    task_order = bank["task_order"]
    profile = bank["profile"]
    movie_start = int(profile["rounds"]) - int(profile["movie_rounds"]) + 1
    simple_values = {"simple_a": (4, 8, 12), "simple_b": (2, 10, 16)}
    rounds: list[list[tuple[str, int | None]]] = []
    for round_index in range(int(profile["rounds"])):
        offset = round_index * 5
        side_mask = raw[offset]
        simple_codes = raw[offset + 1]
        card_count = 1 + side_mask.bit_count() + int(round_index + 1 >= movie_start)
        codes = []
        for packed_byte in raw[offset + 2 : offset + 5]:
            codes.extend((packed_byte >> 4, packed_byte & 15))
        cards = []
        for code in codes[:card_count]:
            task_id = task_order[code]
            payoff = None
            if task_id == "simple_a":
                payoff = simple_values[task_id][simple_codes & 3]
            elif task_id == "simple_b":
                payoff = simple_values[task_id][(simple_codes >> 2) & 3]
            cards.append((task_id, payoff))
        rounds.append(cards)
    return rounds


def audit(
    profile_path: Path, bank_path: Path, detail_path: Path, summary_path: Path
) -> dict[str, int]:
    profile = load_profile(profile_path)
    verify_files(profile, bank_path, detail_path, summary_path)
    bank = json.loads(bank_path.read_text())
    bank_by_id = {int(item["sequence_id"]): item for item in bank["sequences"]}
    with summary_path.open("r", encoding="utf-8", newline="") as stream:
        summaries = {int(row["sequence_id"]): row for row in csv.DictReader(stream)}
    if len(summaries) != int(profile["bank_size"]):
        raise ValueError("summary CSV does not contain one row per sequence")

    row_count = 0
    optimizer_pay = defaultdict(int)
    reserve_pay = defaultdict(int)
    round_count = 0
    previous_key = (0, 0)
    with detail_path.open("r", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        key_function = lambda row: (int(row["sequence_id"]), int(row["round"]))
        decoded_sequence_id = 0
        decoded_rounds: list[list[tuple[str, int | None]]] = []
        for key, grouped_rows in itertools.groupby(reader, key=key_function):
            rows = list(grouped_rows)
            row_count += len(rows)
            round_count += 1
            sequence_id, round_number = key
            if key <= previous_key:
                raise ValueError("detail CSV is not strictly ordered by sequence and round")
            previous_key = key
            if sequence_id != decoded_sequence_id:
                decoded_sequence_id = sequence_id
                decoded_rounds = unpack_rounds(bank, bank_by_id[sequence_id])
            expected_cards = decoded_rounds[round_number - 1]
            actual_cards = [
                (row["task_id"], int(row["displayed_simple_payoff"]) if row["displayed_simple_payoff"] else None)
                for row in rows
            ]
            if [int(row["position"]) for row in rows] != list(range(1, len(rows) + 1)):
                raise ValueError(f"sequence {sequence_id} round {round_number}: positions are not consecutive")
            if actual_cards != expected_cards:
                raise ValueError(f"sequence {sequence_id} round {round_number}: CSV does not match packed bank")
            optimizer_rows = [row for row in rows if row["optimizer_chosen"] == "1"]
            reserve_rows = [row for row in rows if row["reserve_policy_chosen"] == "1"]
            if len(optimizer_rows) != 1:
                raise ValueError(f"sequence {sequence_id} round {round_number}: optimizer choice is not unique")
            if len(reserve_rows) != 1:
                raise ValueError(f"sequence {sequence_id} round {round_number}: reserve choice is not unique")
            optimizer_row = optimizer_rows[0]
            reserve_row = reserve_rows[0]
            if optimizer_row["task_id"] in SIDE_TASKS:
                optimizer_pay[sequence_id] += contribution_delta(
                    optimizer_row["optimizer_task_state_before"],
                    optimizer_row["optimizer_task_state_after"],
                )
            if reserve_row["task_id"] in SIDE_TASKS:
                reserve_pay[sequence_id] += contribution_delta(
                    reserve_row["reserve_task_state_before"],
                    reserve_row["reserve_task_state_after"],
                )

            task_ids = [row["task_id"] for row in rows]
            if len(task_ids) != len(set(task_ids)) or task_ids.count("main") != 1:
                raise ValueError(f"sequence {sequence_id} round {round_number}: invalid distinct/main cards")
            side_count = sum(task_id in SIDE_TASKS for task_id in task_ids)
            if side_count != int(profile["side_cards_per_round"]):
                raise ValueError(
                    f"sequence {sequence_id} round {round_number}: found "
                    f"{side_count} side cards; expected fixed count "
                    f"{profile['side_cards_per_round']}"
                )
            movie_count = task_ids.count("movie")
            expected_movie = int(round_number > int(profile["rounds"]) - int(profile["movie_rounds"]))
            if movie_count != expected_movie:
                raise ValueError(f"sequence {sequence_id} round {round_number}: movie invariant failed")
            if task_ids[side_count] != "main":
                raise ValueError(
                    f"sequence {sequence_id} round {round_number}: main is not "
                    "immediately right of the side cards"
                )
            if expected_movie and task_ids[-1] != "movie":
                raise ValueError(
                    f"sequence {sequence_id} round {round_number}: movie is not "
                    "appended at the right edge"
                )

    expected_rounds = int(profile["bank_size"]) * int(profile["rounds"])
    if round_count != expected_rounds:
        raise ValueError(
            f"detail CSV has {round_count} sequence-rounds; expected {expected_rounds}"
        )

    for sequence_id, packed in bank_by_id.items():
        summary = summaries[sequence_id]
        if optimizer_pay[sequence_id] != int(packed["V11"]):
            raise ValueError(
                f"sequence {sequence_id}: CSV optimizer pay {optimizer_pay[sequence_id]} != V11 {packed['V11']}"
            )
        if reserve_pay[sequence_id] != int(packed["safe_side_payoff"]):
            raise ValueError(
                f"sequence {sequence_id}: CSV reserve pay {reserve_pay[sequence_id]} != {packed['safe_side_payoff']}"
            )
        for field in ("V00", "V01", "V10", "V11"):
            if int(summary[field]) != int(packed[field]):
                raise ValueError(f"sequence {sequence_id}: summary {field} mismatch")
    return {
        "sequences": len(bank_by_id),
        "rounds": round_count,
        "displayed_card_rows": row_count,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--bank", type=Path, default=DEFAULT_BANK)
    parser.add_argument("--detail", type=Path, default=DEFAULT_DETAIL)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    arguments = parser.parse_args(argv)
    counts = audit(arguments.profile, arguments.bank, arguments.detail, arguments.summary)
    print(
        "OK: audited {sequences} sequences, {rounds} rounds, and "
        "{displayed_card_rows} displayed-card rows".format(**counts)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
