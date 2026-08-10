#!/usr/bin/env python3
"""Build the standalone Qualtrics version of the Card Stacking Game.

The generated QSF is deliberately based on a known-good export from the same
Stanford Qualtrics brand.  Only the survey name, blocks, flow, questions, and
the few survey options needed by the timed task are changed.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
QUALTRICS_DIR = ROOT / "qualtrics"
TEMPLATE_PATH = (
    ROOT / "qualtrics-examples" / "Misperceived_Discrimination_Pilot_1.qsf"
)
SCREEN_TYPES_PATH = ROOT / "card_stacking" / "screen_types.txt"
CSS_PATH = ROOT / "_static" / "global" / "card_stacking.css"
JAVASCRIPT_PATH = QUALTRICS_DIR / "card_stacking_qualtrics.js"
DEFAULT_OUTPUT = QUALTRICS_DIR / "Mismanaging_Minutes_Card_Stacking.qsf"

SURVEY_NAME = "Mismanaging Minutes - Card Stacking Game (Qualtrics)"
NUM_SCREEN_TYPES = 50
MAX_DURATION_MINUTES = 40
FASTEST_DECISION_SECONDS = 0.5
MAX_DECISIONS = int(MAX_DURATION_MINUTES * 60 / FASTEST_DECISION_SECONDS)
LOG_CHUNK_COUNT = 64
LOG_CHUNK_MAX_BYTES = 18_000

CARD_DECK = [
    {"color_id": "blue", "label": "Blue card", "color": "#2563eb"},
    {"color_id": "green", "label": "Green card", "color": "#16a34a"},
    {"color_id": "amber", "label": "Yellow card", "color": "#f59e0b"},
    {"color_id": "rose", "label": "Red card", "color": "#e11d48"},
    {"color_id": "violet", "label": "Violet card", "color": "#7c3aed"},
]

LOG_COLUMNS = [
    "screen_number",
    "screen_type_index",
    "chosen_card_id",
    "chosen_card_label",
    "chosen_card_position",
    "chosen_is_main",
    "chosen_x",
    "chosen_y",
    "chosen_z",
    "response_time_ms",
    "task_elapsed_ms",
    "main_cards_collected",
    "points_before",
    "card_points_added",
    "multiplier_applied",
    "multiplier_y",
    "multiplier_z",
    "main_bonus_triggered_this_round",
    "main_bonus_points_added",
    "points_after",
]

# Configuration fields are editable in Survey Flow after import.  The visible
# development setup page writes the same fields before the task begins.
CONFIG_FIELDS = {
    "cs_duration_minutes": "1",
    "cs_num_screen_types": str(NUM_SCREEN_TYPES),
    "cs_show_time_left": "1",
    "cs_show_main_cards": "1",
    "cs_show_total_points": "1",
    "cs_show_click_feedback": "1",
    "cs_feedback_message_ms": "600",
    "cs_use_post_click_delay": "0",
    "cs_post_click_delay_ms": "0",
    "cs_main_bonus_delay_ms": "0",
    "cs_screen_motion_ms": "600",
    "cs_bonus_threshold_main_cards": "55",
    "cs_main_bonus_points": "1650",
    "cs_inactivity_seconds": "30",
}

OUTPUT_FIELDS: dict[str, str | None] = {
    "cs_task_status": None,
    "cs_decision_count": None,
    "cs_task_elapsed_ms": None,
    "cs_final_points": None,
    "cs_main_cards_collected": None,
    "cs_main_bonus_triggered": None,
    "cs_main_bonus_trigger_screen": None,
    "cs_activity_event_count": None,
    "cs_last_activity_source": None,
    "cs_inactivity_elapsed_ms_at_end": None,
    "cs_activity_listener_targets": None,
    "cs_event_counts_supported": None,
    "cs_game_root_count": None,
    "cs_game_owner_token": None,
    "cs_game_owner_claim_source": None,
    "cs_game_owner_claimed_at": None,
    "cs_game_instance_token": None,
    "cs_authoritative_instance": None,
    "cs_suppressed_by_peer": None,
    "cs_authority_channel": None,
    "cs_owner_claim_source": None,
    "cs_seed": None,
    "cs_color_order": None,
    "cs_color_order_indices": None,
    "cs_main_color": None,
    "cs_main_color_index": None,
    "cs_screen_sequence": None,
    "cs_log_columns": ",".join(LOG_COLUMNS),
    "cs_log_chunk_count": None,
    "cs_log_format_version": "csv-v1",
    "cs_log_overflow": None,
    "cs_log_overflow_rows": None,
}


def _number(value: str) -> int | float:
    parsed = float(value)
    return int(parsed) if parsed.is_integer() else parsed


def load_screen_types(path: Path = SCREEN_TYPES_PATH) -> list[dict[str, Any]]:
    """Parse and strictly validate the oTree screen-types source file."""

    screen_types: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 5:
            raise ValueError(
                f"{path}:{line_number}: expected one type id and four cards"
            )
        try:
            type_index = int(parts[0])
            side_values = []
            for card_part in parts[1:]:
                values = [part.strip() for part in card_part.split(",")]
                if len(values) != 3:
                    raise ValueError("each card must contain x,y,z")
                x, y, z = (_number(value) for value in values)
                side_values.append({"x": x, "y": y, "z": z})
        except ValueError as exc:
            raise ValueError(f"{path}:{line_number}: {exc}") from exc
        screen_types.append(
            {"type_index": type_index, "side_values": side_values}
        )

    expected_ids = list(range(1, NUM_SCREEN_TYPES + 1))
    actual_ids = [screen_type["type_index"] for screen_type in screen_types]
    if actual_ids != expected_ids:
        raise ValueError(
            f"{path}: screen type ids must be consecutive 1..{NUM_SCREEN_TYPES}; "
            f"found {actual_ids}"
        )
    return screen_types


def embedded_data_field(name: str, value: str | None = None) -> dict[str, Any]:
    field = {
        "Description": name,
        "Type": "Custom" if value is not None else "Recipient",
        "Field": name,
        "VariableType": "String",
        "DataVisibility": [],
        "AnalyzeText": False,
    }
    if value is not None:
        field["Value"] = value
    return field


def block(
    block_id: str,
    description: str,
    question_id: str | None,
    *,
    block_type: str = "Standard",
) -> dict[str, Any]:
    payload = {
        "Type": block_type,
        "Description": description,
        "ID": block_id,
        "BlockElements": (
            []
            if question_id is None
            else [{"Type": "Question", "QuestionID": question_id}]
        ),
        "Options": {
            "BlockLocking": "false",
            "RandomizeQuestions": "false",
            "BlockVisibility": "Expanded",
        },
    }
    if block_type == "Standard":
        payload["SubType"] = ""
    return payload


def db_question(
    survey_id: str,
    question_id: str,
    export_tag: str,
    description: str,
    question_text: str,
    question_js: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "QuestionText": question_text,
        "DataExportTag": export_tag,
        "QuestionID": question_id,
        "QuestionType": "DB",
        "Selector": "TB",
        "QuestionDescription": description,
        "Validation": {"Settings": {"Type": "None"}},
        "Language": [],
        "DataVisibility": {"Private": False, "Hidden": False},
        "Configuration": {"QuestionDescriptionOption": "UseText"},
        "ChoiceOrder": [],
        "NextChoiceId": 1,
        "NextAnswerId": 1,
    }
    if question_js:
        payload["QuestionJS"] = question_js
    return {
        "SurveyID": survey_id,
        "Element": "SQ",
        "PrimaryAttribute": question_id,
        "SecondaryAttribute": description,
        "TertiaryAttribute": None,
        "Payload": payload,
    }


def build_header(screen_types: list[dict[str, Any]]) -> str:
    css = CSS_PATH.read_text()
    javascript = JAVASCRIPT_PATH.read_text()
    if "</script" in javascript.lower():
        raise ValueError(
            f"{JAVASCRIPT_PATH} contains a closing script tag and cannot be "
            "embedded safely"
        )
    bootstrap = {
        "screenTypes": screen_types,
        "cardDeck": CARD_DECK,
        "maxDecisions": MAX_DECISIONS,
        "maxDurationMinutes": MAX_DURATION_MINUTES,
        "maxAnimationMs": 5_000,
        "thresholdPerMinute": 55,
        "pointsPerMainCard": 30,
        "chunkCount": LOG_CHUNK_COUNT,
        "chunkMaxBytes": LOG_CHUNK_MAX_BYTES,
        "logColumns": LOG_COLUMNS,
    }
    bootstrap_json = json.dumps(
        bootstrap, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    qualtrics_css = """
/* Qualtrics host-page adjustments, scoped to the Card Stacking survey. */
.Skin .SkinInner { width: min(1180px, 96vw); max-width: none; }
.Skin .QuestionOuter { max-width: none; }
.cs-task { box-sizing: border-box; }
.csq-field {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(150px, 220px);
  align-items: center;
  gap: 10px 24px;
  margin: 12px 0;
}
.csq-checkbox-field { display: block; }
.csq-label { font-weight: 650; }
.csq-checkbox-label {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  width: fit-content;
  cursor: pointer;
}
.csq-checkbox {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  opacity: 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
}
.csq-checkbox-box {
  box-sizing: border-box;
  display: inline-flex !important;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 2px solid #64748b;
  border-radius: 4px;
  background: #fff;
  color: #fff;
}
.csq-checkbox:checked + .csq-checkbox-box {
  border-color: #0f4c81;
  background: #0f4c81;
}
.csq-checkbox:checked + .csq-checkbox-box::after {
  content: "";
  width: 5px;
  height: 10px;
  margin-top: -2px;
  border: solid currentColor;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.csq-checkbox:focus + .csq-checkbox-box,
.csq-checkbox:focus-visible + .csq-checkbox-box {
  outline: 3px solid rgba(15, 76, 129, 0.28);
  outline-offset: 2px;
}
.csq-checkbox:disabled + .csq-checkbox-box {
  border-color: #9ca3af;
  background: #e5e7eb;
}
.csq-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 42px;
  padding: 8px 10px;
  border: 1px solid #9ca3af;
  border-radius: 6px;
  background: #fff;
  color: #111827;
  font: inherit;
}
.csq-input:disabled { background: #f3f4f6; color: #6b7280; }
.csq-continue-button {
  min-height: 44px;
  margin-top: 16px;
  padding: 10px 22px;
  border: 0;
  border-radius: 6px;
  background: #0f4c81;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}
.csq-continue-button:hover, .csq-continue-button:focus { background: #0b365b; }
.csq-validation-errors { color: #991b1b; font-weight: 700; margin-top: 12px; }
.csq-debug-table-wrap { overflow-x: auto; }
@media (max-width: 680px) {
  .csq-field { grid-template-columns: 1fr; gap: 5px; }
}
""".strip()
    return (
        "<style>\n"
        + css
        + "\n"
        + qualtrics_css
        + "\n</style>\n<script>\nwindow.CSQ_BOOTSTRAP = "
        + bootstrap_json
        + ";\n</script>\n<script>\n"
        + javascript
        + "\n</script>"
    )


SETUP_JS = """Qualtrics.SurveyEngine.addOnReady(function () {
    if (!window.CSQ) { throw new Error('Card Stacking engine did not load.'); }
    window.CSQ.initSetup(this);
});"""

GAME_JS = """Qualtrics.SurveyEngine.addOnReady(function () {
    if (!window.CSQ) { throw new Error('Card Stacking engine did not load.'); }
    window.CSQ.initGame(this);
});
Qualtrics.SurveyEngine.addOnUnload(function () {
    if (window.CSQ && window.CSQ.cleanup) { window.CSQ.cleanup(); }
});"""

OUTCOME_JS = """Qualtrics.SurveyEngine.addOnReady(function () {
    if (!window.CSQ) { throw new Error('Card Stacking engine did not load.'); }
    window.CSQ.initOutcome(this);
});"""


def build_qsf() -> dict[str, Any]:
    template = json.loads(TEMPLATE_PATH.read_text())
    screen_types = load_screen_types()
    entry = copy.deepcopy(template["SurveyEntry"])
    entry["SurveyName"] = SURVEY_NAME
    entry["SurveyStatus"] = "Inactive"
    entry["LastActivated"] = "0000-00-00 00:00:00"
    survey_id = entry["SurveyID"]

    originals = {
        element["Element"]: element
        for element in template["SurveyElements"]
        if element.get("Element") in {"PL", "PROJ", "QC", "RS", "SCO", "SO", "STAT"}
    }
    required = {"PL", "PROJ", "QC", "RS", "SCO", "SO", "STAT"}
    missing = required - originals.keys()
    if missing:
        raise ValueError(f"Template is missing required elements: {sorted(missing)}")

    blocks = {
        "0": block(
            "BL_cs_trash",
            "Trash / Unused Questions",
            None,
            block_type="Trash",
        ),
        "1": block(
            "BL_cs_setup",
            "Development Setup",
            "QID1",
        ),
        "2": block("BL_cs_intro", "Card Stacking Instructions", "QID2"),
        "3": block("BL_cs_game", "Card Stacking Game", "QID3"),
        "4": block("BL_cs_outcome", "Card Stacking Outcome", "QID4"),
    }
    bl = {
        "SurveyID": survey_id,
        "Element": "BL",
        "PrimaryAttribute": "Survey Blocks",
        "SecondaryAttribute": None,
        "TertiaryAttribute": None,
        "Payload": blocks,
    }

    fields = [
        embedded_data_field(name, value) for name, value in CONFIG_FIELDS.items()
    ]
    fields.extend(
        embedded_data_field(name, value) for name, value in OUTPUT_FIELDS.items()
    )
    fields.extend(
        embedded_data_field(f"cs_log_chunk_{index:03d}")
        for index in range(1, LOG_CHUNK_COUNT + 1)
    )
    flow_nodes: list[dict[str, Any]] = [
        {"Type": "EmbeddedData", "FlowID": "FL_2", "EmbeddedData": fields},
        {"Type": "Standard", "FlowID": "FL_3", "ID": "BL_cs_setup", "Autofill": []},
        {"Type": "Standard", "FlowID": "FL_4", "ID": "BL_cs_intro", "Autofill": []},
        {"Type": "Standard", "FlowID": "FL_5", "ID": "BL_cs_game", "Autofill": []},
        {"Type": "Standard", "FlowID": "FL_6", "ID": "BL_cs_outcome", "Autofill": []},
    ]
    fl = {
        "SurveyID": survey_id,
        "Element": "FL",
        "PrimaryAttribute": "Survey Flow",
        "SecondaryAttribute": None,
        "TertiaryAttribute": None,
        "Payload": {
            "Type": "Root",
            "FlowID": "FL_1",
            "Flow": flow_nodes,
            "Properties": {"Count": 6},
        },
    }

    questions = [
        db_question(
            survey_id,
            "QID1",
            "cs_development_setup",
            "Development-only Card Stacking configuration",
            '<div id="csq-setup-root" class="cs-setup"></div>'
            "<noscript>This task requires JavaScript.</noscript>",
            SETUP_JS,
        ),
        db_question(
            survey_id,
            "QID2",
            "cs_instructions",
            "Card Stacking Game instructions",
            """<div class="cs-shell">
<h2>Card Stacking Game</h2>
<p>You will see a sequence of screens. On each screen, choose one card. Some cards show points, a percentage, and a multiplier. One card does not show numbers.</p>
<p>Please stay active during the task. If there are too many consecutive seconds of inactivity, the task will end and you will lose the opportunity to earn a bonus.</p>
</div>""",
        ),
        db_question(
            survey_id,
            "QID3",
            "cs_game",
            "Timed Card Stacking Game",
            '<div id="csq-game-root"></div>'
            "<noscript>This task requires JavaScript.</noscript>",
            GAME_JS,
        ),
        db_question(
            survey_id,
            "QID4",
            "cs_outcome",
            "Card Stacking task outcome and development summary",
            '<div id="csq-outcome-root"></div>',
            OUTCOME_JS,
        ),
    ]

    boilerplate = {name: copy.deepcopy(element) for name, element in originals.items()}
    boilerplate["QC"]["SecondaryAttribute"] = str(len(questions))
    so_payload = boilerplate["SO"]["Payload"]
    so_payload.update(
        {
            "BackButton": "false",
            "SaveAndContinue": "false",
            "SurveyTermination": "DefaultMessage",
            "EOSRedirectURL": None,
            "Header": build_header(screen_types),
            "SurveyName": SURVEY_NAME,
            "SurveyTitle": SURVEY_NAME,
            "ProgressBarDisplay": "None",
        }
    )

    elements = [
        bl,
        fl,
        boilerplate["PL"],
        boilerplate["PROJ"],
        boilerplate["QC"],
        boilerplate["RS"],
        boilerplate["SCO"],
        boilerplate["SO"],
        *questions,
        boilerplate["STAT"],
    ]
    qsf = {"SurveyEntry": entry, "SurveyElements": elements}
    validate_generated_qsf(qsf)
    return qsf


def validate_generated_qsf(qsf: dict[str, Any]) -> None:
    if set(qsf) != {"SurveyEntry", "SurveyElements"}:
        raise ValueError("QSF must have exactly SurveyEntry and SurveyElements")
    elements = qsf["SurveyElements"]
    types = [element.get("Element") for element in elements]
    expected = ["BL", "FL", "PL", "PROJ", "QC", "RS", "SCO", "SO"]
    if types[:8] != expected or types[-1] != "STAT" or types[8:-1] != ["SQ"] * 4:
        raise ValueError(f"Unexpected SurveyElements order: {types}")

    survey_id = qsf["SurveyEntry"]["SurveyID"]
    if any(element.get("SurveyID") != survey_id for element in elements):
        raise ValueError("Every SurveyElement must use SurveyEntry.SurveyID")
    rs = next(element for element in elements if element["Element"] == "RS")
    if rs["PrimaryAttribute"] != qsf["SurveyEntry"]["SurveyActiveResponseSet"]:
        raise ValueError("Response-set id is inconsistent")

    sqs = [element for element in elements if element["Element"] == "SQ"]
    qids = [element["PrimaryAttribute"] for element in sqs]
    if qids != ["QID1", "QID2", "QID3", "QID4"]:
        raise ValueError(f"Questions must use sequential numeric QIDs: {qids}")
    for element in sqs:
        payload = element["Payload"]
        if payload["QuestionID"] != element["PrimaryAttribute"]:
            raise ValueError(f"Question id mismatch in {element['PrimaryAttribute']}")
        if payload["QuestionDescription"] != element["SecondaryAttribute"]:
            raise ValueError(
                f"Question description mismatch in {element['PrimaryAttribute']}"
            )

    fl = next(element for element in elements if element["Element"] == "FL")
    embedded = fl["Payload"]["Flow"][0]["EmbeddedData"]
    names = [field["Field"] for field in embedded]
    if len(names) != len(set(names)):
        raise ValueError("Embedded-data field names must be unique")
    expected_chunks = [
        f"cs_log_chunk_{index:03d}" for index in range(1, LOG_CHUNK_COUNT + 1)
    ]
    actual_chunks = [name for name in names if name in expected_chunks]
    if actual_chunks != expected_chunks:
        raise ValueError("Expected exactly 64 ordered log chunk fields")
    if "ChoiceTextEntry" in json.dumps(qsf):
        raise ValueError("ChoiceTextEntry is a known QSF import hazard")


def serialize_qsf(qsf: dict[str, Any]) -> str:
    return json.dumps(qsf, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"output QSF path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify that the existing output exactly matches a fresh build",
    )
    args = parser.parse_args()

    rendered = serialize_qsf(build_qsf())
    if args.check:
        if not args.output.exists():
            raise SystemExit(f"missing generated QSF: {args.output}")
        if args.output.read_text() != rendered:
            raise SystemExit(f"generated QSF is stale: {args.output}")
        print(f"OK: {args.output} matches a fresh deterministic build")
        return

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
