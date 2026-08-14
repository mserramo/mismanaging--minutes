# Mismanaging Minutes: certified Qualtrics treatments

This directory contains the standalone Qualtrics implementation of the
fixed-round task. It supports the sequential baseline and the all-at-once
treatment without changing the oTree implementation.

## Delivered artifacts

- `Mismanaging_Minutes_Card_Stacking.qsf`: importable standalone survey.
- `environment_profile.json`: versioned economic profile. The v4 fixed
  calibration uses R0=100, RM=20, q=.60, Q=60, S=20, B=3,000, M=3,000,
  delta=10, and exactly four side cards on every round. Change the versioned
  `side_cards_per_round` profile value to use any fixed count from one through
  four in a future calibration. Four side tasks are economically available on
  each round; the UI separately maintains permanent slots for all tasks. The
  two convex Cumulative tasks are each capped at 16 pre-movie
  appearances so neither can fill the entire 20-choice optimal side bundle.
  In v4, selecting Infinite Scrolling advances its within-run streak, while
  selecting any other card during an Infinite Scrolling availability run
  resets that streak; the next Infinite Scrolling choice starts again at its
  base payoff.
- `generate_environment.py`: deterministic draw and exact OR-Tools CP-SAT
  certification pipeline.
- `certified_environment_bank.json`: compact 2,048-sequence runtime bank.
- `validated_sequences.csv`: one row per sequence, round, and displayed card.
- `validated_sequence_summary.csv`: one certified summary row per sequence.
- `build_qsf.py`: deterministic builder based on the known-good Stanford QSF
  scaffold.
- `card_stacking_qualtrics.js`: treatment-aware instructions, setup, sequential
  and all-at-once games, inactivity handling, `csv-v3` logging, and outcome
  engine.
- `reconstruct_decisions.py`: backward-compatible `csv-v1`/`csv-v2`/`csv-v3`
  export decoder.
- `browser_harness.html`: local runtime harness.

## Calibration and rebuild

The calibration dependency is deliberately separate from the oTree deployment
requirements. Any change to the versioned profile or an economic rule,
including the Infinite Scrolling state transition, requires regenerating the
bank and both review CSVs before rebuilding the QSF:

```sh
python3 -m pip install -r qualtrics/requirements-calibration.txt
python3 qualtrics/generate_environment.py --workers 8 --executor processes
python3 qualtrics/generate_environment.py --verify-files
python3 qualtrics/audit_environment_outputs.py
python3 qualtrics/build_qsf.py
python3 qualtrics/build_qsf.py --check
```

Each sequence is rejected unless all four completion regimes are proven
optimal, the complete-both allocation uses all S pre-movie side opportunities,
the reserve policy completes both threshold tasks, the configured B/M margins
pass, and the bank diagnostics pass. The detailed and summary CSV SHA-256
hashes are embedded in the bank and QSF.

## Treatments and data

`cs_treatment_mode` is editable in Survey Flow and on the development setup
page. It accepts `sequential` (the default) or `all_at_once`. QID2 is a single
treatment-aware JavaScript instructions container, so both modes retain the
same four-block Setup → Instructions → Game → Outcome scaffold.

Sequential mode presents one round at a time and writes each decision when it
is made. Both treatments use the same wide, fixed control bar so round or
visible-range information, configured counters, click feedback, and the
inactivity clock remain visible while the participant moves through the task.
The sequential bar contains no all-at-once navigation or completion controls.
Both treatments use the same centered 1,144px game frame and the same fluid
ten-column card grid, so each all-at-once row matches the sequential row without
leaving an unused horizontal column after the final card.

All-at-once mode presents all 100 pre-drawn choice sets in a scrolling decision
pane. Its bar retains the `Rounds X–Y of 100` visible-range display, answered
count, points, inactivity clock, and the same payoff-key control used in
sequential mode. It contains no round-jump or Next unanswered navigation. The
choice sets use one fixed 100% scale with no participant zoom control. A participant can review and revise one
selection per round before finishing. The Done control appears beneath round
100 and becomes available only after all rounds are answered. The choice sets
never wrap. A
minimum-width blocker prevents either treatment from running in a viewport
that cannot safely show all ten permanent slots.

All-at-once decision logs are final-only: a completed response writes the 100
final selections, while inactivity writes only the rounds answered at the end.
Those rows retain a per-row `task_elapsed_ms` and leave `response_time_ms`
blank because the treatment has no sequential per-round response interval.
Response-level fields record `cs_treatment_mode`, `cs_answered_at_end`, and
`cs_all_at_once_final_zoom` (fixed at 100 for all-at-once responses). They also
record the seeded `cs_slot_order` and
`cs_layout_version=fixed-slots-v1`. `reconstruct_decisions.py` repeats these
fields and the treatment on every decoded row while remaining compatible with
older exports that lack them.

Every round renders ten permanent positions: the eight side tasks are shuffled
once from the sequence seed, Main is slot 9, and Movie is slot 10. Active cards
retain their existing labels and dynamic values. Inactive tasks remain in place
as disabled gray cards labeled `Unavailable`, so no task changes position
between rounds. The original certified position is retained separately as
`generated_position`; `chosen_position` is the visible fixed slot. A compact,
two-column payoff key preserves the existing participant-specific colors,
badges, wording, and seeded group order. `cs_payoff_key_mode=overlay` is the
default and opens it from the identical toolbar button in either treatment;
`cs_payoff_key_mode=below` keeps it always visible under the game. Cards use a
fixed centered payoff slot. Simple cards always show their
realized `+X pts.` payoff. Main and Movie payoff text default off, while
non-Simple side-card payoff text defaults on; the three display modes remain
independently configurable. Trio and Fives footers use two lines—`X cards left`
/ `for +Y pts.`—and Infinite Scrolling uses `X cards left` / `in this run`.
No card reports prior selections or previews a later marginal payoff. On the
Game page only, Qualtrics wrapper spacing is removed and any remaining oversized
Stanford-header gap is measured and compactly corrected at runtime.
The Main and Movie counters are optional and default off; the round and awarded-
total-points counters default on. The total includes side-task pay plus the Main
and Movie bonuses once their thresholds are met. The inactivity countdown is
always visible and defaults to two minutes.

## Verification

```sh
python3 qualtrics/test_environment.py
node --check qualtrics/card_stacking_qualtrics.js
node qualtrics/test_engine.js
python3 qualtrics/reconstruct_decisions.py --self-test
node qualtrics/test_engine.js /tmp/csq-v3-export.csv
python3 qualtrics/reconstruct_decisions.py /tmp/csq-v3-export.csv -o /tmp/csq-v3-decisions.csv
python3 /tmp/qsf-validate.py qualtrics/Mismanaging_Minutes_Card_Stacking.qsf
git diff --check
```

For a completed response, the engine stores 100 complete decision records in
`cs_log_chunk_001`–`cs_log_chunk_064`. Each record contains the full displayed
choice set and task states before/after the choice. It separately stores the
reconstructed selected environment in
`cs_environment_chunk_001`–`cs_environment_chunk_064`. No embedded-data value
may exceed 18,000 UTF-8 bytes, and overflow is explicit.

The QSF transports the certified bank in ordered `cs_bank_chunk_NNN` Embedded
Data values, also capped at 18,000 bytes. Those values are distributed across
small Survey Flow nodes so the 1.7 MB bank is never placed in one Survey Header
value. QID3 reconstructs
the bank synchronously before round 1 and clears the transport chunks when the
task ends, so they are not retained in the completed-response export.

## Import into Qualtrics

1. In Qualtrics, create a project from a survey file or choose **Import
   Survey**.
2. Select `Mismanaging_Minutes_Card_Stacking.qsf`.
3. Keep it inactive and preview the entire Setup → Instructions → Game →
   Outcome → Finish flow once with `sequential` and once with `all_at_once`.
4. Confirm that Setup shows the certificate and economic values as read-only.
5. Complete a response in each treatment, also exercise all-at-once inactivity,
   export the responses with embedded data, and round-trip the export through
   `reconstruct_decisions.py` before activation.

The visible Development Setup and debug Outcome pages are intentionally kept in
this development build. Static and local-browser checks cannot guarantee
account-specific import behavior, and this package does not create or activate
a survey in the user's Qualtrics account.
