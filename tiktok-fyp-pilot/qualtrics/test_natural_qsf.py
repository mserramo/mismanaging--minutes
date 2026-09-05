#!/usr/bin/env python3
"""Structural tests for the separate natural TikTok QSF."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import build_natural_qsf


HERE = Path(__file__).resolve().parent


class NaturalTikTokQsfTests(unittest.TestCase):
    def test_fresh_build_validates(self) -> None:
        qsf = build_natural_qsf.build_qsf()
        build_natural_qsf.validate_qsf(qsf)
        self.assertEqual(qsf["SurveyEntry"]["SurveyStatus"], "Inactive")

    def test_generated_artifact_matches_builder(self) -> None:
        generated = json.loads((HERE / "TikTok_FYP_Natural_Session.qsf").read_text())
        self.assertEqual(generated, build_natural_qsf.build_qsf())

    def test_runtime_uses_natural_mode_and_chunked_data(self) -> None:
        javascript = build_natural_qsf.JAVASCRIPT_PATH.read_text()
        self.assertIn("request('start_natural'", javascript)
        self.assertIn("const EXTENSION_ID = 'pjcgejllbdjbhegipdkagnafileoecpo'", javascript)
        self.assertIn("chrome.runtime.connect(EXTENSION_ID", javascript)
        self.assertIn("MIN_BRIDGE_VERSION = 5", javascript)
        self.assertIn("CHUNK_SIZE = 12000", javascript)
        self.assertIn("MAX_CHUNKS = 6", javascript)
        self.assertIn("ttfp_natural_payload_truncated", javascript)
        self.assertIn("ttfp_natural_summary_json", javascript)
        self.assertIn("ttfp_natural_summary_truncated", javascript)
        self.assertIn("SUMMARY_MAX_CHARS = 12000", javascript)
        self.assertIn("question.hideNextButton()", javascript)
        self.assertIn("question.showNextButton()", javascript)
        self.assertIn("question.clickNextButton()", javascript)
        self.assertIn("document.visibilityState === 'visible'", javascript)
        self.assertNotIn("event.key", javascript)
        self.assertNotIn("event.code", javascript)
        self.assertNotIn("document.write", javascript)
        self.assertNotIn("extensionInput", javascript)
        self.assertNotIn("Chrome extension ID", javascript)
        self.assertIn("Check extension again", javascript)

    def test_report_is_a_separate_second_page(self) -> None:
        qsf = build_natural_qsf.build_qsf()
        block = qsf["SurveyElements"][0]["Payload"]["1"]
        self.assertEqual(
            block["BlockElements"],
            [
                {"Type": "Question", "QuestionID": "QID1"},
                {"Type": "Page Break"},
                {"Type": "Question", "QuestionID": "QID2"},
            ],
        )
        javascript = build_natural_qsf.REPORT_JAVASCRIPT_PATH.read_text()
        self.assertIn("Qualtrics.SurveyEngine.getEmbeddedData", javascript)
        self.assertIn("ttfp_natural_summary_json", javascript)
        self.assertIn("Recorded session data", javascript)
        self.assertIn("appendLine(output, 'Clicks'", javascript)
        self.assertNotIn("ttfpnr-metric", javascript)
        self.assertNotIn("Your TikTok", javascript)
        self.assertNotIn("innerHTML", javascript)
        self.assertNotIn("document.write", javascript)

    def test_survey_does_not_inherit_a_redirect(self) -> None:
        qsf = build_natural_qsf.build_qsf()
        serialized = json.dumps(qsf).lower()
        self.assertNotIn("prolific", serialized)
        options = next(
            element for element in qsf["SurveyElements"] if element["Element"] == "SO"
        )["Payload"]
        self.assertEqual(options["SurveyTermination"], "DefaultMessage")
        self.assertIsNone(options["EOSRedirectURL"])


if __name__ == "__main__":
    unittest.main()
