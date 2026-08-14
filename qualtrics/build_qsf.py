#!/usr/bin/env python3
"""Build the standalone certified, pre-drawn Qualtrics card-choice task.

The generated QSF is deliberately based on a known-good export from the same
Stanford Qualtrics brand. Only the survey name, blocks, flow, questions, and
the survey options needed by the fixed-round task are changed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
QUALTRICS_DIR = ROOT / "qualtrics"
TEMPLATE_PATH = (
    ROOT / "qualtrics-examples" / "Misperceived_Discrimination_Pilot_1.qsf"
)
CSS_PATH = ROOT / "_static" / "global" / "card_stacking.css"
JAVASCRIPT_PATH = QUALTRICS_DIR / "card_stacking_qualtrics.js"
ENVIRONMENT_BANK_PATH = QUALTRICS_DIR / "certified_environment_bank.json"
VALIDATED_SEQUENCES_PATH = QUALTRICS_DIR / "validated_sequences.csv"
VALIDATED_SUMMARY_PATH = QUALTRICS_DIR / "validated_sequence_summary.csv"
DEFAULT_OUTPUT = QUALTRICS_DIR / "Mismanaging_Minutes_Card_Stacking.qsf"

SURVEY_NAME = "Mismanaging Minutes - Certified Pre-Drawn Environment"
LOG_CHUNK_COUNT = 64
LOG_CHUNK_MAX_BYTES = 18_000
BANK_CHUNK_MAX_BYTES = 18_000
BANK_CHUNKS_PER_FLOW_NODE = 10
BANK_FORMAT_VERSION = "json-v1"

LOG_COLUMNS = [
    "round",
    "phase",
    "sequence_id",
    "seed",
    "chosen_task_id",
    "chosen_task_label",
    "chosen_position",
    "generated_position",
    "chosen_is_main",
    "chosen_is_movie",
    "chosen_is_side",
    "displayed_choice_set_json",
    "task_state_before_json",
    "task_state_after_json",
    "side_points_added",
    "side_points_total",
    "main_count",
    "movie_count",
    "main_complete",
    "movie_complete",
    "main_bonus_awarded",
    "movie_bonus_awarded",
    "total_points",
    "response_time_ms",
    "task_elapsed_ms",
    "infinite_run_id",
    "infinite_rounds_remaining",
]

# Configuration fields are editable in Survey Flow after import.  The visible
# development setup page writes the same fields before the task begins.
CONFIG_FIELDS = {
    "cs_treatment_mode": "sequential",
    "cs_all_at_once_default_zoom": "100",
    "cs_all_at_once_min_zoom": "100",
    "cs_payoff_key_mode": "overlay",
    "cs_show_round": "1",
    "cs_show_main_cards": "0",
    "cs_show_movie_cards": "0",
    "cs_show_total_points": "1",
    "cs_show_main_card_payoff": "0",
    "cs_show_movie_card_payoff": "0",
    "cs_show_side_card_payoff": "1",
    "cs_show_click_feedback": "1",
    "cs_feedback_message_ms": "600",
    "cs_use_post_click_delay": "0",
    "cs_post_click_delay_ms": "0",
    "cs_screen_motion_ms": "600",
    "cs_inactivity_seconds": "120",
}

OUTPUT_FIELDS: dict[str, str | None] = {
    "cs_task_status": None,
    "cs_decision_count": None,
    "cs_answered_at_end": None,
    "cs_task_elapsed_ms": None,
    "cs_all_at_once_final_zoom": None,
    "cs_final_points": None,
    "cs_side_points": None,
    "cs_main_cards_collected": None,
    "cs_movie_cards_collected": None,
    "cs_main_complete": None,
    "cs_movie_complete": None,
    "cs_main_bonus_awarded": None,
    "cs_movie_bonus_awarded": None,
    "cs_side_task_breakdown": None,
    "cs_side_task_counts": None,
    "cs_completed_structured_bonuses": None,
    "cs_activity_event_count": None,
    "cs_last_activity_source": None,
    "cs_inactivity_elapsed_ms_at_end": None,
    "cs_game_owner_token": None,
    "cs_game_owner_claim_source": None,
    "cs_sequence_id": None,
    "cs_seed": None,
    "cs_task_color_map": None,
    "cs_slot_order": None,
    "cs_layout_version": "fixed-slots-v1",
    "cs_profile_version": None,
    "cs_bank_hash": None,
    "cs_validated_sequences_hash": None,
    "cs_validated_summary_hash": None,
    "cs_benchmark_optimal_payoff": None,
    "cs_benchmark_V00": None,
    "cs_benchmark_V01": None,
    "cs_benchmark_V10": None,
    "cs_benchmark_V11": None,
    "cs_log_columns": ",".join(LOG_COLUMNS),
    "cs_log_chunk_count": None,
    "cs_log_format_version": "csv-v3",
    "cs_log_overflow": None,
    "cs_log_overflow_rows": None,
    "cs_environment_columns": "round,phase,displayed_choice_set_json,infinite_run_id,infinite_run_start,infinite_run_end",
    "cs_environment_chunk_count": None,
    "cs_environment_format_version": "csv-v1",
    "cs_environment_overflow": None,
    "cs_environment_overflow_rows": None,
    "cs_bank_chunks_cleared": None,
}


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


def load_environment_bank(path: Path = ENVIRONMENT_BANK_PATH) -> dict[str, Any]:
    bank = json.loads(path.read_text())
    if bank.get("format_version") != "certified-bank-v1":
        raise ValueError(f"{path}: unsupported certified bank format")
    if bank.get("certificate", {}).get("validation_status") != "certified":
        raise ValueError(f"{path}: bank certificate did not pass")
    if len(bank.get("sequences", [])) != int(bank["profile"]["bank_size"]):
        raise ValueError(f"{path}: sequence count does not match the profile")
    core = {key: value for key, value in bank.items() if key != "certificate"}
    core_hash = hashlib.sha256(
        json.dumps(
            core, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    ).hexdigest()
    certificate = bank["certificate"]
    if core_hash != certificate["bank_hash"]:
        raise ValueError(f"{path}: bank hash does not match its certificate")
    for csv_path, field in (
        (VALIDATED_SEQUENCES_PATH, "validated_sequences_sha256"),
        (VALIDATED_SUMMARY_PATH, "validated_sequence_summary_sha256"),
    ):
        digest = hashlib.sha256()
        with csv_path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != certificate[field]:
            raise ValueError(f"{csv_path}: hash does not match the bank certificate")
    return bank


def build_header(bank: dict[str, Any]) -> str:
    css = CSS_PATH.read_text()
    javascript = JAVASCRIPT_PATH.read_text()
    if "</script" in javascript.lower():
        raise ValueError(
            f"{JAVASCRIPT_PATH} contains a closing script tag and cannot be "
            "embedded safely"
        )
    # Keeping the 1.7 MB sequence bank in SurveyOptions.Header makes the QSF
    # structurally valid but causes some Qualtrics brands to reject the import.
    # The header only needs certificate/profile metadata; sequence bytes live in
    # ordered, sub-20 KB Embedded Data fields and are reconstructed on QID3.
    bank_metadata = {key: value for key, value in bank.items() if key != "sequences"}
    bootstrap = {
        "bankMetadata": bank_metadata,
        "chunkCount": LOG_CHUNK_COUNT,
        "chunkMaxBytes": LOG_CHUNK_MAX_BYTES,
        "logColumns": LOG_COLUMNS,
    }
    bootstrap_json = json.dumps(
        bootstrap, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    qualtrics_css = """
/* Qualtrics host-page adjustments, scoped to the Card Stacking survey. */
.Skin .SkinInner {
  box-sizing: border-box;
  width: calc(100vw - 24px);
  max-width: none;
  margin-left: 12px !important;
  margin-right: 12px !important;
}
.csq-game-active #HeaderContainer { margin-bottom: 0 !important; padding-bottom: 0 !important; }
.csq-game-active .SkinInner {
  width: calc(100vw - 24px) !important;
  max-width: none !important;
  padding-top: 0 !important;
  margin-top: 0 !important;
}
.csq-game-active #SkinContent {
  box-sizing: border-box;
  width: 100% !important;
  max-width: none !important;
  padding-top: 0 !important;
  margin-top: 0 !important;
}
.Skin #Questions,
.Skin .QuestionOuter,
.Skin .QuestionBody {
  box-sizing: border-box;
  width: 100% !important;
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}
.csq-game-active #Questions { padding-top: 0 !important; margin-top: 0 !important; }
.csq-game-active #QID3,
.csq-game-active #QID3.QuestionOuter,
.csq-game-active #QID3 .QuestionBody,
.csq-game-active #QID3 .QuestionText {
  box-sizing: border-box;
  width: 100% !important;
  max-width: none !important;
  padding-top: 0 !important;
  margin-top: 0 !important;
}
#csq-game-root {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: none;
  overflow-x: hidden;
  padding: 2px 2px 10px;
}
.csq-game-active #csq-game-root {
  width: min(100%, 1144px);
  margin-left: auto;
  margin-right: auto;
}
.csq-game-layout {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 12px;
  width: 100%;
  min-width: 100%;
}
.cs-task {
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 14px 16px 16px;
}
.csq-sequential-stage {
  box-sizing: border-box;
  width: 100%;
  padding: 8px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
}
.csq-sequential-stage > .cs-task {
  width: 100%;
  padding: 10px 8px 12px;
  border: 1px solid #d8e0ea;
  border-radius: 7px;
  background: #fff;
}
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
.cs-card-row {
  display: grid !important;
  grid-template-columns: repeat(10, minmax(0, 1fr)) !important;
  align-items: stretch;
  gap: 6px;
  width: 100%;
}
.cs-card {
  box-sizing: border-box;
  position: relative;
  display: block;
  flex: 0 0 auto;
  width: 100%;
  min-width: 0;
  min-height: 184px;
  padding: 11px 5px;
}
.cs-card-heading {
  position: absolute;
  top: 11px;
  left: 4px;
  right: 4px;
  display: flex;
  min-height: 25px;
  align-items: flex-start;
  justify-content: center;
}
.cs-card-color-label {
  color: var(--card-color);
  font-size: 14px;
  font-weight: 800;
}
.cs-card-payoff-slot {
  position: absolute;
  top: 50%;
  left: 8px;
  right: 8px;
  display: flex;
  min-height: 24px;
  align-items: center;
  justify-content: center;
  transform: translateY(-50%);
  text-align: center;
}
.cs-card-payoff {
  font-size: 14px;
  font-weight: 800;
  line-height: 1.2;
  white-space: nowrap;
}
.cs-card-footer {
  position: absolute;
  right: 4px;
  bottom: 10px;
  left: 4px;
  display: flex;
  min-height: 25px;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  overflow: hidden;
  color: #64748b;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.05;
  text-align: center;
}
.cs-card-footer-line {
  display: block;
  max-width: 100%;
  white-space: nowrap;
}
.cs-card-inactive {
  border-color: #94a3b8 !important;
  background: #e2e8f0 !important;
  color: #64748b !important;
  box-shadow: none !important;
  cursor: not-allowed !important;
  opacity: 0.82;
  transform: none !important;
}
.cs-card-inactive:hover,
.cs-card-inactive:focus {
  outline: none !important;
  box-shadow: none !important;
}
.cs-card-inactive .cs-card-color-label { color: #64748b !important; }
.cs-card-inactive .cs-card-payoff {
  color: #64748b;
  font-size: 11.5px;
  font-weight: 700;
}
.cs-inactivity-clock {
  color: #475569;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.cs-inactivity-warning { color: #b91c1c; }
.csq-rules-panel {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  flex: none;
  width: 100%;
  max-width: none;
  gap: 0 18px;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
  color: #1f2937;
  overflow: visible;
}
.csq-rules-panel h3 {
  grid-column: 1 / -1;
  margin: 0 0 3px;
  color: #111827;
  font-size: 16px;
  line-height: 1.25;
}
.csq-rule-note {
  grid-column: 1 / -1;
  margin: 0 0 4px;
  color: #334155;
  font-size: 12.5px;
  line-height: 1.3;
}
.csq-rule-row {
  min-width: 0;
  padding: 4px 0 5px;
  border-top: 1px solid #d8e0ea;
}
.csq-rule-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.csq-rule-mapping {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.csq-rule-separator { color: #64748b; font-weight: 750; }
.csq-rule-color {
  color: var(--rule-color);
  font-size: 14.5px;
  font-weight: 850;
}
.csq-rule-task-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: #e5e7eb;
  color: #374151;
  font-size: 11.5px;
  font-weight: 800;
  line-height: 1.25;
}
.csq-rule-payoff {
  margin: 3px 0 0;
  color: #1f2937;
  font-size: 13.25px;
  line-height: 1.3;
}
.csq-sequential,
.csq-all-at-once {
  --csq-choice-scale: 1;
  --csq-toolbar-height: 58px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-left: auto;
  margin-right: auto;
}
.csq-game-toolbar {
  position: fixed !important;
  top: 8px;
  left: 8px;
  z-index: 10000;
  box-sizing: border-box;
  width: calc(100vw - 16px);
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 9px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.09);
  font-size: 14px;
  line-height: 1.25;
  height: 54px;
  min-height: 54px;
}
.csq-game-toolbar-spacer { height: var(--csq-toolbar-height); }
.csq-game-toolbar-primary,
.csq-game-toolbar-controls {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px 12px;
}
.csq-game-toolbar-primary > span,
.csq-game-toolbar-controls > span { white-space: nowrap; }
.csq-game-toolbar-primary { font-weight: 700; }
.csq-game-toolbar-controls { margin-left: auto; }
.csq-toolbar-feedback {
  display: inline-block;
  min-width: 88px;
  color: #475569;
  font-weight: 750;
  text-align: center;
  white-space: nowrap;
}
.csq-toolbar-feedback-visible { color: #0f172a; }
.csq-game-nav-button {
  min-height: 34px;
  padding: 6px 12px;
  border: 0;
  border-radius: 6px;
  background: #0f4c81;
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.2;
  font-weight: 750;
  white-space: nowrap;
}
.csq-game-nav-button:hover,
.csq-game-nav-button:focus { background: #0b365b; }
.csq-game-nav-button:disabled { background: #94a3b8; cursor: not-allowed; }
.csq-payoff-key-open { overflow: hidden !important; }
.csq-rules-overlay {
  position: fixed;
  inset: 0;
  z-index: 10020;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.58);
}
.csq-rules-overlay[hidden] { display: none !important; }
.csq-rules-dialog {
  position: relative;
  box-sizing: border-box;
  width: min(1040px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 14px;
  border: 1px solid #94a3b8;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.3);
}
.csq-rules-dialog .csq-rules-panel { width: 100%; margin: 0; }
.csq-rules-close {
  display: block;
  min-height: 34px;
  margin: 0 0 8px auto;
  padding: 6px 12px;
  border: 1px solid #64748b;
  border-radius: 6px;
  background: #fff;
  color: #0f172a;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 750;
}
.csq-rules-close:hover,
.csq-rules-close:focus { background: #f1f5f9; }
.csq-all-layout {
  display: block;
  width: 100%;
  min-width: 0;
  margin-top: 10px;
}
.csq-all-scroll {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: calc(100vh - var(--csq-toolbar-height) - 44px);
  min-height: 420px;
  overflow: auto;
  overscroll-behavior: auto;
  scrollbar-gutter: auto;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
}
.csq-all-list {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 100%;
  flex-direction: column;
  gap: 10px;
  padding: 8px;
}
.csq-all-round {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 10px 8px 12px;
  border: 1px solid #d8e0ea;
  border-radius: 7px;
  background: #fff;
  scroll-margin: 12px;
}
.csq-all-round-scale {
  box-sizing: border-box;
  width: 100%;
}
.csq-all-round-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 24px;
  margin: 0 0 8px;
  color: #334155;
  font-size: 14px;
  font-weight: 750;
}
.csq-all-card-row {
  display: grid !important;
  grid-template-columns: repeat(10, minmax(0, 1fr)) !important;
  align-items: stretch;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.csq-all-at-once .cs-card {
  flex-basis: auto;
  width: 100%;
  min-width: 0;
  min-height: 184px;
}
.csq-all-helper {
  margin: 0;
  color: #475569;
  font-size: 13px;
  line-height: 1.35;
}
.csq-all-completion {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: #fff;
}
.csq-all-done {
  padding: 7px 10px;
  border: 1px solid #86efac;
  border-radius: 6px;
  background: #f0fdf4;
  color: #166534;
  font-size: 13px;
  font-weight: 750;
}
.csq-all-nav-button {
  min-height: 34px;
  padding: 6px 12px;
  border: 0;
  border-radius: 6px;
  background: #0f4c81;
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.2;
  font-weight: 750;
}
.csq-all-nav-button:hover,
.csq-all-nav-button:focus { background: #0b365b; }
.csq-all-nav-button:disabled {
  background: #94a3b8;
  cursor: not-allowed;
}
.csq-all-wide-blocker {
  box-sizing: border-box;
  max-width: 760px;
  margin: 16px auto;
  padding: 18px 20px;
  border: 2px solid #b45309;
  border-radius: 8px;
  background: #fffbeb;
  color: #78350f;
  font-weight: 700;
  line-height: 1.45;
}
.csq-all-wide-blocker[hidden] { display: none !important; }
.csq-all-at-once > .csq-rules-panel {
  position: static !important;
  flex: none;
  width: 100%;
  max-height: none;
  margin-top: 12px;
  overflow: visible;
  box-shadow: none;
}
.csq-all-at-once > .csq-rules-panel[hidden] { display: none !important; }
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

INTRO_JS = """Qualtrics.SurveyEngine.addOnReady(function () {
    if (!window.CSQ) { throw new Error('Card Stacking engine did not load.'); }
    window.CSQ.initInstructions(this);
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
    bank = load_environment_bank()
    if CONFIG_FIELDS["cs_inactivity_seconds"] != str(
        bank["profile"]["inactivity_seconds"]
    ):
        raise ValueError(
            "Survey Flow inactivity default must match the certified profile"
        )
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
    fields.extend(
        embedded_data_field(f"cs_environment_chunk_{index:03d}")
        for index in range(1, LOG_CHUNK_COUNT + 1)
    )

    # ensure_ascii makes byte-safe slicing exact: every character is one UTF-8
    # byte. No bank value can exceed Qualtrics' 20 KB per-value ceiling.
    bank_json = json.dumps(
        bank, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    )
    bank_chunks = [
        bank_json[offset : offset + BANK_CHUNK_MAX_BYTES]
        for offset in range(0, len(bank_json), BANK_CHUNK_MAX_BYTES)
    ]
    bank_fields = [
        embedded_data_field("cs_bank_format_version", BANK_FORMAT_VERSION),
        embedded_data_field("cs_bank_chunk_count", str(len(bank_chunks))),
    ]
    bank_fields.extend(
        embedded_data_field(f"cs_bank_chunk_{index:03d}", chunk)
        for index, chunk in enumerate(bank_chunks, start=1)
    )

    flow_nodes: list[dict[str, Any]] = []
    next_flow_id = 2
    flow_nodes.append(
        {
            "Type": "EmbeddedData",
            "FlowID": f"FL_{next_flow_id}",
            "EmbeddedData": fields,
        }
    )
    next_flow_id += 1
    for offset in range(0, len(bank_fields), BANK_CHUNKS_PER_FLOW_NODE):
        flow_nodes.append(
            {
                "Type": "EmbeddedData",
                "FlowID": f"FL_{next_flow_id}",
                "EmbeddedData": bank_fields[
                    offset : offset + BANK_CHUNKS_PER_FLOW_NODE
                ],
            }
        )
        next_flow_id += 1
    for block_id in ("BL_cs_setup", "BL_cs_intro", "BL_cs_game", "BL_cs_outcome"):
        flow_nodes.append(
            {
                "Type": "Standard",
                "FlowID": f"FL_{next_flow_id}",
                "ID": block_id,
                "Autofill": [],
            }
        )
        next_flow_id += 1
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
            "Properties": {"Count": len(flow_nodes) + 1},
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
            '<div id="csq-instructions-root"></div>'
            "<noscript>This task requires JavaScript.</noscript>",
            INTRO_JS,
        ),
        db_question(
            survey_id,
            "QID3",
            "cs_game",
            "Fixed-round Card Stacking Game",
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
            "Header": build_header(bank),
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
    intro_payload = sqs[1]["Payload"]
    if 'id="csq-instructions-root"' not in intro_payload["QuestionText"]:
        raise ValueError("QID2 must provide the treatment-aware instructions root")
    if intro_payload.get("QuestionJS") != INTRO_JS:
        raise ValueError("QID2 must initialize treatment-aware instructions")

    fl = next(element for element in elements if element["Element"] == "FL")
    flow = fl["Payload"]["Flow"]
    embedded_nodes = [node for node in flow if node["Type"] == "EmbeddedData"]
    embedded = [
        field for node in embedded_nodes for field in node["EmbeddedData"]
    ]
    names = [field["Field"] for field in embedded]
    if len(names) != len(set(names)):
        raise ValueError("Embedded-data field names must be unique")
    values = {field["Field"]: field.get("Value") for field in embedded}
    expected_defaults = {
        "cs_treatment_mode": "sequential",
        "cs_all_at_once_default_zoom": "100",
        "cs_all_at_once_min_zoom": "100",
        "cs_payoff_key_mode": "overlay",
        "cs_show_main_cards": "0",
        "cs_show_movie_cards": "0",
        "cs_show_total_points": "1",
        "cs_show_main_card_payoff": "0",
        "cs_show_movie_card_payoff": "0",
        "cs_show_side_card_payoff": "1",
        "cs_inactivity_seconds": "120",
    }
    for name, expected_value in expected_defaults.items():
        if values.get(name) != expected_value:
            raise ValueError(
                f"Embedded-data default {name} must be {expected_value!r}"
            )
    required_treatment_outputs = {
        "cs_all_at_once_final_zoom",
        "cs_answered_at_end",
        "cs_slot_order",
        "cs_layout_version",
    }
    missing_treatment_outputs = required_treatment_outputs - set(names)
    if missing_treatment_outputs:
        raise ValueError(
            "Missing all-at-once output field(s): "
            + ", ".join(sorted(missing_treatment_outputs))
        )
    if "treatment_mode" in LOG_COLUMNS or "cs_treatment_mode" in LOG_COLUMNS:
        raise ValueError("Treatment mode must remain response-level metadata")
    if values.get("cs_log_format_version") != "csv-v3":
        raise ValueError("Fixed-slot decision logs must use csv-v3")
    if values.get("cs_layout_version") != "fixed-slots-v1":
        raise ValueError("Fixed-slot layout version metadata is missing")
    if "generated_position" not in LOG_COLUMNS:
        raise ValueError("csv-v3 must preserve the certified generated position")
    if "cs_show_side_points" in names:
        raise ValueError("The removed side-only points counter field is still present")
    expected_chunks = [
        f"cs_log_chunk_{index:03d}" for index in range(1, LOG_CHUNK_COUNT + 1)
    ]
    actual_chunks = [name for name in names if name in expected_chunks]
    if actual_chunks != expected_chunks:
        raise ValueError("Expected exactly 64 ordered log chunk fields")
    expected_environment_chunks = [
        f"cs_environment_chunk_{index:03d}"
        for index in range(1, LOG_CHUNK_COUNT + 1)
    ]
    actual_environment_chunks = [
        name for name in names if name in expected_environment_chunks
    ]
    if actual_environment_chunks != expected_environment_chunks:
        raise ValueError("Expected exactly 64 ordered environment chunk fields")
    bank_count_field = next(
        field for field in embedded if field["Field"] == "cs_bank_chunk_count"
    )
    bank_count = int(bank_count_field["Value"])
    expected_bank_chunks = [
        f"cs_bank_chunk_{index:03d}" for index in range(1, bank_count + 1)
    ]
    actual_bank_chunks = [name for name in names if name in expected_bank_chunks]
    if actual_bank_chunks != expected_bank_chunks:
        raise ValueError("Certified bank chunk fields are missing or out of order")
    bank_values = {
        field["Field"]: field.get("Value", "") for field in embedded
    }
    if any(
        len(bank_values[name].encode("utf-8")) > BANK_CHUNK_MAX_BYTES
        for name in expected_bank_chunks
    ):
        raise ValueError("A certified bank chunk exceeds 18,000 UTF-8 bytes")
    rebuilt_bank = "".join(bank_values[name] for name in expected_bank_chunks)
    if json.loads(rebuilt_bank) != load_environment_bank():
        raise ValueError("Certified bank chunks do not round-trip exactly")
    if fl["Payload"]["Properties"]["Count"] != len(flow) + 1:
        raise ValueError("Survey Flow Properties.Count is inconsistent")
    if any(
        len(node.get("EmbeddedData", [])) > BANK_CHUNKS_PER_FLOW_NODE
        for node in embedded_nodes[1:]
    ):
        raise ValueError("A bank Embedded Data flow node is too large")
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
