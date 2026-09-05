#!/usr/bin/env python3
"""Build the minimal TikTok FYP extension-to-Qualtrics pilot survey."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any


PILOT_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = PILOT_ROOT.parent
TEMPLATE_PATH = (
    PROJECT_ROOT / "qualtrics-examples" / "Misperceived_Discrimination_Pilot_1.qsf"
)
JAVASCRIPT_PATH = Path(__file__).with_name("tiktok_fyp_qualtrics.js")
DEFAULT_OUTPUT = Path(__file__).with_name("TikTok_FYP_Qualtrics_Pilot.qsf")
SURVEY_NAME = "TikTok FYP Qualtrics Bridge Pilot v0.5.2 - QSF r6"
QUESTION_ID = "QID1"
BLOCK_ID = "BL_ttfp_task"

EMBEDDED_FIELDS: dict[str, str | None] = {
    "ttfp_bridge_version": None,
    "ttfp_session_id": None,
    "ttfp_harvest_status": None,
    "ttfp_failure_reason": None,
    "ttfp_video_count": None,
    "ttfp_video_ids_json": None,
    "ttfp_playback_events_json": None,
    "ttfp_test_bypass": "0",
    "ttfp_completed": "0",
}


def embedded_data_field(name: str, value: str | None) -> dict[str, Any]:
    field: dict[str, Any] = {
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


def block(block_id: str, description: str, question_id: str | None, block_type: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "Type": block_type,
        "Description": description,
        "ID": block_id,
        "BlockElements": [] if question_id is None else [
            {"Type": "Question", "QuestionID": question_id}
        ],
        "Options": {
            "BlockLocking": "false",
            "RandomizeQuestions": "false",
            "BlockVisibility": "Expanded",
        },
    }
    if block_type == "Standard":
        payload["SubType"] = ""
    return payload


def question(survey_id: str, question_js: str) -> dict[str, Any]:
    description = "TikTok FYP extension bridge and embedded video viewer"
    payload = {
        "QuestionText": (
            '<div id="ttfp-qualtrics-root">Loading the TikTok video task…</div>'
            "<noscript>This task requires JavaScript and desktop Chrome.</noscript>"
        ),
        "DataExportTag": "ttfp_video_task",
        "QuestionID": QUESTION_ID,
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
        "QuestionJS": question_js,
    }
    return {
        "SurveyID": survey_id,
        "Element": "SQ",
        "PrimaryAttribute": QUESTION_ID,
        "SecondaryAttribute": description,
        "TertiaryAttribute": None,
        "Payload": payload,
    }


def build_qsf() -> dict[str, Any]:
    template = json.loads(TEMPLATE_PATH.read_text())
    question_js = JAVASCRIPT_PATH.read_text()
    entry = copy.deepcopy(template["SurveyEntry"])
    entry["SurveyName"] = SURVEY_NAME
    entry["SurveyStatus"] = "Inactive"
    entry["LastActivated"] = "0000-00-00 00:00:00"
    survey_id = entry["SurveyID"]

    originals = {
        element["Element"]: copy.deepcopy(element)
        for element in template["SurveyElements"]
        if element.get("Element") in {"PL", "PROJ", "QC", "RS", "SCO", "SO", "STAT"}
    }
    required = {"PL", "PROJ", "QC", "RS", "SCO", "SO", "STAT"}
    if required - originals.keys():
        raise ValueError("The known-good template is missing required survey elements")

    blocks = {
        "0": block("BL_ttfp_trash", "Trash / Unused Questions", None, "Trash"),
        "1": block(BLOCK_ID, "TikTok FYP Qualtrics Pilot", QUESTION_ID, "Standard"),
    }
    bl = {
        "SurveyID": survey_id,
        "Element": "BL",
        "PrimaryAttribute": "Survey Blocks",
        "SecondaryAttribute": None,
        "TertiaryAttribute": None,
        "Payload": blocks,
    }
    fields = [embedded_data_field(name, value) for name, value in EMBEDDED_FIELDS.items()]
    flow = [
        {"Type": "EmbeddedData", "FlowID": "FL_2", "EmbeddedData": fields},
        {"Type": "Standard", "FlowID": "FL_3", "ID": BLOCK_ID, "Autofill": []},
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
            "Flow": flow,
            "Properties": {"Count": len(flow) + 1},
        },
    }

    originals["QC"]["SecondaryAttribute"] = "1"
    options = originals["SO"]["Payload"]
    options.update({
        "BackButton": "false",
        "SaveAndContinue": "false",
        "Header": "",
        "Footer": "",
        "SurveyName": SURVEY_NAME,
        "SurveyTitle": SURVEY_NAME,
        "ProgressBarDisplay": "None",
        "SurveyTermination": "DefaultMessage",
        "EOSRedirectURL": None,
        "EOSMessage": None,
        "UseCustomSurveyLinkCompletedMessage": None,
        "SurveyLinkCompletedMessage": None,
        "SurveyLinkCompletedMessageLibrary": None,
    })
    elements = [
        bl,
        fl,
        originals["PL"],
        originals["PROJ"],
        originals["QC"],
        originals["RS"],
        originals["SCO"],
        originals["SO"],
        question(survey_id, question_js),
        originals["STAT"],
    ]
    qsf = {"SurveyEntry": entry, "SurveyElements": elements}
    validate_qsf(qsf)
    return qsf


def validate_qsf(qsf: dict[str, Any]) -> None:
    if set(qsf) != {"SurveyEntry", "SurveyElements"}:
        raise ValueError("QSF must have exactly SurveyEntry and SurveyElements")
    elements = qsf["SurveyElements"]
    types = [element.get("Element") for element in elements]
    expected = ["BL", "FL", "PL", "PROJ", "QC", "RS", "SCO", "SO", "SQ", "STAT"]
    if types != expected:
        raise ValueError(f"Unexpected SurveyElements order: {types}")
    survey_id = qsf["SurveyEntry"]["SurveyID"]
    if any(element.get("SurveyID") != survey_id for element in elements):
        raise ValueError("Every SurveyElement must use SurveyEntry.SurveyID")
    response_set = next(element for element in elements if element["Element"] == "RS")
    if response_set["PrimaryAttribute"] != qsf["SurveyEntry"]["SurveyActiveResponseSet"]:
        raise ValueError("Response-set ID is inconsistent")
    question_element = next(element for element in elements if element["Element"] == "SQ")
    payload = question_element["Payload"]
    if payload["QuestionID"] != QUESTION_ID or payload["QuestionType"] != "DB":
        raise ValueError("The pilot must use one numeric-ID descriptive-text question")
    if payload.get("QuestionJS") != JAVASCRIPT_PATH.read_text():
        raise ValueError("Generated QuestionJS differs from the reviewed source file")
    if 'id="ttfp-qualtrics-root"' not in payload["QuestionText"]:
        raise ValueError("The Qualtrics runtime mount is missing")
    flow_payload = next(element for element in elements if element["Element"] == "FL")["Payload"]
    if flow_payload["Properties"]["Count"] != len(flow_payload["Flow"]) + 1:
        raise ValueError("Survey Flow Properties.Count is inconsistent")
    embedded = flow_payload["Flow"][0]["EmbeddedData"]
    names = [field["Field"] for field in embedded]
    if names != list(EMBEDDED_FIELDS):
        raise ValueError("Embedded-data fields are missing or out of order")
    serialized = json.dumps(qsf)
    if "ChoiceTextEntry" in serialized:
        raise ValueError("ChoiceTextEntry is a known QSF import hazard")
    if "tiktok-fyp-qualtrics-v1" not in payload["QuestionJS"]:
        raise ValueError("The extension bridge name is missing")
    if "event.origin !== TIKTOK_ORIGIN" not in payload["QuestionJS"]:
        raise ValueError("Strict TikTok player-origin validation is missing")
    piped_text_tokens = [
        token for token in payload["QuestionJS"].split("${")[1:]
    ]
    if len(piped_text_tokens) != 1 or any(
        not token.startswith("e://Field/ttfp_") for token in piped_text_tokens
    ):
        raise ValueError(
            "Qualtrics would reinterpret JavaScript template interpolation as piped text"
        )
    if "pjcgejllbdjbhegipdkagnafileoecpo" not in payload["QuestionJS"]:
        raise ValueError("The fixed development extension ID is missing")
    if "extensionInput" in payload["QuestionJS"] or "Chrome extension ID" in payload["QuestionJS"]:
        raise ValueError("The survey must not request an extension ID from participants")
    options = next(element for element in elements if element["Element"] == "SO")["Payload"]
    if options.get("SurveyTermination") != "DefaultMessage":
        raise ValueError("The pilot must use Qualtrics' default completion message")
    if options.get("EOSRedirectURL") not in {None, ""}:
        raise ValueError("The pilot must not inherit an end-of-survey redirect")
    if "prolific" in serialized.lower():
        raise ValueError("The pilot QSF must not inherit a Prolific redirect or identifier")


def serialize(qsf: dict[str, Any]) -> str:
    return json.dumps(qsf, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = serialize(build_qsf())
    if args.check:
        if not args.output.exists() or args.output.read_text() != rendered:
            raise SystemExit(f"generated QSF is missing or stale: {args.output}")
        print(f"OK: {args.output} matches a fresh deterministic build")
        return
    args.output.write_text(rendered)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
