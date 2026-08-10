# Mismanaging Minutes: Qualtrics migration

This directory contains a standalone Qualtrics implementation of the current
oTree Card Stacking development flow. The generated survey has four sequential
blocks: Development Setup, Intro, Game, and Outcome.

## Files

- `Mismanaging_Minutes_Card_Stacking.qsf`: finished Qualtrics import file.
- `build_qsf.py`: deterministic builder. It reads the Stanford QSF scaffold,
  `card_stacking/screen_types.txt`, the existing card CSS, and the
  Qualtrics-specific JavaScript.
- `card_stacking_qualtrics.js`: setup, timed game, logging, and outcome engine.
- `reconstruct_decisions.py`: converts a Qualtrics CSV export into one row per
  decision.
- `browser_harness.html`: local runtime harness used to exercise the same game
  engine outside Qualtrics.

## Build and validate

Run these commands from the repository root:

```sh
python3 qualtrics/build_qsf.py
python3 qualtrics/build_qsf.py --check
node --check qualtrics/card_stacking_qualtrics.js
node qualtrics/test_engine.js
python3 qualtrics/reconstruct_decisions.py --self-test
```

For an end-to-end 4,800-decision round trip through the JavaScript packer and
Python decoder:

```sh
node qualtrics/test_engine.js /tmp/csq-synthetic-export.csv
python3 qualtrics/reconstruct_decisions.py /tmp/csq-synthetic-export.csv -o /tmp/csq-decisions.csv
```

The builder clones the brand, skin, response-set, and boilerplate metadata from
`qualtrics-examples/Misperceived_Discrimination_Pilot_1.qsf`. It deliberately
keeps the Stanford export's `Standard` block/flow vocabulary and canonical
survey-element order.

## Import into Qualtrics

1. Open Qualtrics and create a new project from a survey file (or use the
   survey menu's **Import Survey** action).
2. Select `Mismanaging_Minutes_Card_Stacking.qsf`.
3. Keep the survey inactive while previewing the entire flow: setup, intro,
   game termination, outcome, and the final **Finish** control.
4. Inspect Survey Flow if you want to change any default `cs_*` configuration
   value. The visible Development Setup page also writes these values for each
   run.
5. Activate only after a preview response exports with the expected embedded
   data and the decoder successfully reconstructs it.

Static validation cannot guarantee import behavior for a particular Qualtrics
brand/account. No survey is created, imported, or activated by this package.

## Decision-log format

Each completed decision is encoded as one RFC 4180 CSV record. Complete records
are packed on row boundaries into `cs_log_chunk_001` through
`cs_log_chunk_064`; each stored value is capped at 18,000 UTF-8 bytes. The
column list is in `cs_log_columns`, the populated count is in
`cs_log_chunk_count`, and `cs_log_format_version` is `csv-v1`. If all 64 fields
are exhausted, `cs_log_overflow=1` and `cs_log_overflow_rows` records how many
decision rows could not be stored.

Decode an exported CSV with:

```sh
python3 qualtrics/reconstruct_decisions.py qualtrics-export.csv -o decisions.csv
```

The output repeats response-level export fields alongside the 20 decision-level
columns. Responses with zero decisions produce no decision rows and are counted
in the decoder's terminal summary. The decoder stops with a response-specific
error if chunks are missing, non-contiguous, malformed, unsupported, or marked
as overflowed, so incomplete logs are never treated as complete data.

## Local browser harness

Serve the repository root, then open the harness URL:

```sh
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/qualtrics/browser_harness.html`. The toolbar can
mount each survey page, and `window.harness` exposes configuration and embedded
data for automated checks. It is a runtime test harness, not a substitute for a
full Qualtrics Preview run after import.

`parallel_frame_harness.html` runs a visible game and a hidden duplicate game
at the same time. It reproduces the multiple-renderer behavior seen in
Qualtrics Preview and verifies that only the instance receiving participant
activity may save results or advance the survey. The outcome diagnostics report
the authoritative instance, authority claim source, and coordination channel.
