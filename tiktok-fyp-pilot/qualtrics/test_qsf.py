#!/usr/bin/env python3
"""Structural regression tests for the minimal TikTok Qualtrics QSF."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import build_qsf


HERE = Path(__file__).resolve().parent


class TikTokQualtricsQsfTests(unittest.TestCase):
    def test_fresh_build_validates(self) -> None:
        qsf = build_qsf.build_qsf()
        build_qsf.validate_qsf(qsf)
        self.assertEqual(qsf["SurveyEntry"]["SurveyStatus"], "Inactive")

    def test_generated_artifact_matches_builder(self) -> None:
        path = HERE / "TikTok_FYP_Qualtrics_Pilot.qsf"
        generated = json.loads(path.read_text())
        self.assertEqual(generated, build_qsf.build_qsf())

    def test_runtime_and_data_contract_are_embedded(self) -> None:
        qsf = build_qsf.build_qsf()
        question = next(
            element for element in qsf["SurveyElements"] if element["Element"] == "SQ"
        )["Payload"]
        javascript = question["QuestionJS"]
        self.assertIn("chrome.runtime.connect(extensionId", javascript)
        self.assertIn("tiktok-fyp-qualtrics-v1", javascript)
        self.assertIn("MIN_BRIDGE_VERSION = 2", javascript)
        self.assertIn("standalone extension session is active", javascript)
        self.assertIn("ttfp_video_ids_json", javascript)
        self.assertIn("ttfp_test_bypass", javascript)
        self.assertIn("question.showNextButton()", javascript)
        self.assertIn("event.source !== currentIframe.contentWindow", javascript)
        self.assertIn(".ttfpq-player-mount { position: absolute; inset: 0;", javascript)
        self.assertIn("element('div', 'ttfpq-player-mount')", javascript)
        self.assertIn("Open chrome://extensions", javascript)
        self.assertIn("select Load unpacked", javascript)
        self.assertIn("copy the 32-letter ID", javascript)
        self.assertIn("select Connect, and then select Start harvest", javascript)
        self.assertIn("Keep both tabs open", javascript)
        self.assertIn("The collected videos will appear here automatically", javascript)
        self.assertIn("player.addEventListener('click', togglePlayback)", javascript)
        self.assertIn("player.setAttribute('role', 'button')", javascript)
        self.assertIn("controls.append(previousButton, controlCopy, nextButton)", javascript)
        self.assertNotIn("const playButton", javascript)
        self.assertNotIn("ttfpq-counter", javascript)
        self.assertNotIn("addEventListener('wheel'", javascript)
        self.assertNotIn("WHEEL_DEBOUNCE_MS", javascript)
        self.assertNotIn("document.write", javascript)
        self.assertEqual(javascript.count("${"), 2)
        self.assertEqual(javascript.count("${e://Field/ttfp_"), 2)

    def test_survey_does_not_inherit_template_prolific_redirect(self) -> None:
        qsf = build_qsf.build_qsf()
        options = next(
            element for element in qsf["SurveyElements"] if element["Element"] == "SO"
        )["Payload"]
        self.assertEqual(options["SurveyTermination"], "DefaultMessage")
        self.assertIsNone(options["EOSRedirectURL"])
        self.assertNotIn("prolific", json.dumps(qsf).lower())


if __name__ == "__main__":
    unittest.main()
