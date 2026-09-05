#!/usr/bin/env python3
"""Build the separate natural TikTok FYP session Qualtrics survey."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any

import build_qsf as base


JAVASCRIPT_PATH = Path(__file__).with_name("tiktok_fyp_natural_qualtrics.js")
REPORT_JAVASCRIPT_PATH = Path(__file__).with_name("tiktok_fyp_natural_report.js")
DEFAULT_OUTPUT = Path(__file__).with_name("TikTok_FYP_Natural_Session.qsf")
SURVEY_NAME = "TikTok FYP Natural Session Pilot v0.5.2 - QSF r4"
SETUP_QUESTION_ID = "QID1"
REPORT_QUESTION_ID = "QID2"
BLOCK_ID = "BL_ttfp_natural"

EMBEDDED_FIELDS: dict[str, str | None] = {
    "ttfp_natural_bridge_version": None,
    "ttfp_natural_session_id": None,
    "ttfp_natural_status": None,
    "ttfp_natural_stop_reason": None,
    "ttfp_natural_required_ms": None,
    "ttfp_natural_qualified_ms": None,
    "ttfp_natural_video_count": None,
    "ttfp_natural_video_ids_json": None,
    "ttfp_natural_summary_json": None,
    "ttfp_natural_summary_truncated": "0",
    "ttfp_natural_payload_chunks": None,
    "ttfp_natural_payload_truncated": "0",
    "ttfp_natural_payload_1": None,
    "ttfp_natural_payload_2": None,
    "ttfp_natural_payload_3": None,
    "ttfp_natural_payload_4": None,
    "ttfp_natural_payload_5": None,
    "ttfp_natural_payload_6": None,
    "ttfp_natural_completed": "0",
}


def question(
    survey_id: str,
    question_id: str,
    description: str,
    root_id: str,
    export_tag: str,
    loading_text: str,
    question_js: str,
) -> dict[str, Any]:
    payload = {
        "QuestionText": (
            f'<div id="{root_id}">{loading_text}</div>'
            "<noscript>This task requires JavaScript and desktop Chrome.</noscript>"
        ),
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
        "QuestionJS": question_js,
    }
    return {
        "SurveyID": survey_id,
        "Element": "SQ",
        "PrimaryAttribute": question_id,
        "SecondaryAttribute": description,
        "TertiaryAttribute": None,
        "Payload": payload,
    }


def build_qsf() -> dict[str, Any]:
    template = json.loads(base.TEMPLATE_PATH.read_text())
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
        "0": base.block("BL_ttfp_natural_trash", "Trash / Unused Questions", None, "Trash"),
        "1": {
            "Type": "Standard",
            "SubType": "",
            "Description": "Natural TikTok FYP Session",
            "ID": BLOCK_ID,
            "BlockElements": [
                {"Type": "Question", "QuestionID": SETUP_QUESTION_ID},
                {"Type": "Page Break"},
                {"Type": "Question", "QuestionID": REPORT_QUESTION_ID},
            ],
            "Options": {
                "BlockLocking": "false",
                "RandomizeQuestions": "false",
                "BlockVisibility": "Expanded",
            },
        },
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
        base.embedded_data_field(name, value)
        for name, value in EMBEDDED_FIELDS.items()
    ]
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

    originals["QC"]["SecondaryAttribute"] = "2"
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
    qsf = {
        "SurveyEntry": entry,
        "SurveyElements": [
            bl,
            fl,
            originals["PL"],
            originals["PROJ"],
            originals["QC"],
            originals["RS"],
            originals["SCO"],
            originals["SO"],
            question(
                survey_id,
                SETUP_QUESTION_ID,
                "Natural TikTok FYP session extension bridge",
                "ttfp-natural-root",
                "ttfp_natural_session",
                "Loading the natural TikTok session…",
                question_js,
            ),
            question(
                survey_id,
                REPORT_QUESTION_ID,
                "Natural TikTok FYP activity record",
                "ttfp-natural-report-root",
                "ttfp_natural_report",
                "Loading your TikTok activity record…",
                REPORT_JAVASCRIPT_PATH.read_text(),
            ),
            originals["STAT"],
        ],
    }
    validate_qsf(qsf)
    return qsf


def validate_qsf(qsf: dict[str, Any]) -> None:
    elements = qsf.get("SurveyElements", [])
    expected = ["BL", "FL", "PL", "PROJ", "QC", "RS", "SCO", "SO", "SQ", "SQ", "STAT"]
    if [element.get("Element") for element in elements] != expected:
        raise ValueError("Unexpected SurveyElements order")
    survey_id = qsf["SurveyEntry"]["SurveyID"]
    if any(element.get("SurveyID") != survey_id for element in elements):
        raise ValueError("Every SurveyElement must use SurveyEntry.SurveyID")
    question_payloads = {
        element["Payload"]["QuestionID"]: element["Payload"]
        for element in elements
        if element["Element"] == "SQ"
    }
    if set(question_payloads) != {SETUP_QUESTION_ID, REPORT_QUESTION_ID}:
        raise ValueError("The natural pilot must contain setup and report questions")
    if any(payload["QuestionType"] != "DB" for payload in question_payloads.values()):
        raise ValueError("Natural pilot questions must use descriptive text")
    question_payload = question_payloads[SETUP_QUESTION_ID]
    report_payload = question_payloads[REPORT_QUESTION_ID]
    if question_payload.get("QuestionJS") != JAVASCRIPT_PATH.read_text():
        raise ValueError("Generated setup QuestionJS differs from the reviewed source")
    if report_payload.get("QuestionJS") != REPORT_JAVASCRIPT_PATH.read_text():
        raise ValueError("Generated report QuestionJS differs from the reviewed source")
    block_elements = qsf["SurveyElements"][0]["Payload"]["1"]["BlockElements"]
    if block_elements != [
        {"Type": "Question", "QuestionID": SETUP_QUESTION_ID},
        {"Type": "Page Break"},
        {"Type": "Question", "QuestionID": REPORT_QUESTION_ID},
    ]:
        raise ValueError("The activity report must be on the page after setup")
    flow_payload = next(
        element for element in elements if element["Element"] == "FL"
    )["Payload"]
    if flow_payload["Properties"]["Count"] != len(flow_payload["Flow"]) + 1:
        raise ValueError("Survey Flow Properties.Count is inconsistent")
    names = [field["Field"] for field in flow_payload["Flow"][0]["EmbeddedData"]]
    if names != list(EMBEDDED_FIELDS):
        raise ValueError("Natural embedded-data fields are missing or out of order")
    serialized = json.dumps(qsf)
    if "ChoiceTextEntry" in serialized:
        raise ValueError("ChoiceTextEntry is a known QSF import hazard")
    if "start_natural" not in question_payload["QuestionJS"]:
        raise ValueError("The natural bridge command is missing")
    if "ttfp_natural_summary_json" not in question_payload["QuestionJS"]:
        raise ValueError("The setup page does not save the one-field activity summary")
    if "ttfp_natural_summary_json" not in report_payload["QuestionJS"]:
        raise ValueError("The report page does not read the activity summary")
    if "pjcgejllbdjbhegipdkagnafileoecpo" not in question_payload["QuestionJS"]:
        raise ValueError("The fixed development extension ID is missing")
    if "extensionInput" in question_payload["QuestionJS"] or "Chrome extension ID" in question_payload["QuestionJS"]:
        raise ValueError("The natural survey must not request an extension ID")
    if "prolific" in serialized.lower():
        raise ValueError("The natural QSF must not inherit a Prolific redirect")
    options = next(element for element in elements if element["Element"] == "SO")["Payload"]
    if options.get("SurveyTermination") != "DefaultMessage" or options.get("EOSRedirectURL") not in {None, ""}:
        raise ValueError("The natural QSF must use the default non-redirect termination")


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
