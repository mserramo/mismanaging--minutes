# Qualtrics bridge pilots

This package contains two independent Qualtrics surveys. The covered-harvest survey receives a finalized numeric post-ID queue and displays official TikTok embeds. The two-page natural-session survey sends the participant to a visible foreground TikTok tab, saves exposure/activity summaries when the qualified-time task ends, and displays the registered activity on the following survey page. No research backend is involved.

## Files

- `TikTok_FYP_Qualtrics_Pilot.qsf` — generated survey import.
- `tiktok_fyp_qualtrics.js` — reviewed source embedded as QID1 `QuestionJS`.
- `build_qsf.py` — deterministic builder using the known-good Stanford export in `qualtrics-examples/`.
- `test_qsf.py` — structural and bridge-contract checks.
- `TikTok_FYP_Natural_Session.qsf` — separate generated natural-session import.
- `tiktok_fyp_natural_qualtrics.js` — reviewed natural-session setup runtime embedded in QID1.
- `tiktok_fyp_natural_report.js` — read-only activity-report runtime embedded in QID2.
- `build_natural_qsf.py` and `test_natural_qsf.py` — deterministic natural QSF builder and checks.

## Local pilot

1. Remove any older unpacked installation once, load `tiktok-fyp-pilot/` on `chrome://extensions`, and confirm Chrome shows version **0.5.2** and ID **`pjcgejllbdjbhegipdkagnafileoecpo`**. The manifest public key makes this development ID identical across computers.
2. Open the extension popup, accept the disclosure, and select **Grant TikTok access**. This popup no longer exposes a standalone Start action; collection can begin only from the survey. A normal website cannot trigger that permission prompt on the extension's behalf.
3. Import the freshly generated `TikTok_FYP_Qualtrics_Pilot.qsf` into Stanford Qualtrics as a new survey and keep it inactive. Confirm its name is **TikTok FYP Qualtrics Bridge Pilot v0.5.2 - QSF r6**. This build deliberately uses Qualtrics-safe JavaScript, Qualtrics' default completion message, no Prolific redirect, a full-height iframe mount for the 9:16 player, and participant setup instructions.
4. Preview the survey in desktop Chrome. It connects automatically to the fixed extension ID; there is no ID field or Connect button. If the extension is missing, outdated, or has not received TikTok access, correct that condition and select **Check extension again**.
5. Select **Start harvest**. TikTok opens covered, the survey regains focus, and the survey polls the extension every 500 ms.
6. After the configured harvest window, click the video surface to play or pause and use the arrow buttons or keyboard arrows to navigate. Mouse-wheel scrolling does not change videos. The normal Qualtrics Next button appears only after **Finish**.

If covered collection opens an extension viewer tab, the session was not started by that survey. Stop and clear the old session from the extension, reload version 0.5.2, and restart using the survey's **Start harvest** button. The survey rejects old bridge builds and standalone-session conflicts with an explicit message.

## Natural-session pilot

1. Import `TikTok_FYP_Natural_Session.qsf` as a distinct inactive survey. Confirm its name is **TikTok FYP Natural Session Pilot v0.5.2 - QSF r4** and its end setting has no redirect.
2. Preview in desktop Chrome. The survey checks the fixed extension automatically; no ID entry is required.
3. Select **Start natural session**. A newly created TikTok tab opens in front with a compact timer. Browse normally; the survey remains in the original tab.
4. The timer advances only for a visible, focused, identifiable, substantially visible, actively playing FYP video. It pauses on tab/window blur, unsupported pages, pause, buffering, or ambiguous video state.
5. At completion, the extension closes only its dedicated TikTok tab and restores the exact survey tab. The first page saves the result, finalizes the bridge session, and automatically advances to a second page. That page displays the registered video IDs, active watch time per video, and aggregate browsing measures. It contains no video viewer because the participant already watched the videos directly on TikTok.

The natural payload is split into up to six 12,000-character fields. Reassemble `ttfp_natural_payload_1` through the number in `ttfp_natural_payload_chunks`; `ttfp_natural_payload_truncated=1` flags an over-limit pilot record. A compact, valid JSON record is also saved directly in `ttfp_natural_summary_json`; `ttfp_natural_summary_truncated=1` indicates that its video array was shortened to remain within the one-field size budget. The chunked payload retains the more detailed record.

For test runs, a failed harvest exposes **Continue to Qualtrics (testing)** on the covered TikTok page. Returning to the survey records the failure and an empty queue, sets `ttfp_test_bypass=1`, and makes Qualtrics Next available. This bypass does not relabel the extension session as successful and should not be used as a production completion rule.

The manifest permits bridge connections only from `https://stanforduniversity.qualtrics.com/*`. A vanity domain or a different Qualtrics data center must be reviewed and added explicitly to both the manifest and the runtime hostname check.

## Response fields

- `ttfp_bridge_version`
- `ttfp_session_id`
- `ttfp_harvest_status`
- `ttfp_failure_reason`
- `ttfp_video_count`
- `ttfp_video_ids_json`
- `ttfp_playback_events_json`
- `ttfp_test_bypass` (`1` when the testing-only failed-harvest continuation is enabled)
- `ttfp_completed`

The natural-session survey uses the separately prefixed fields:

- `ttfp_natural_bridge_version` and `ttfp_natural_session_id`
- `ttfp_natural_status`, `ttfp_natural_stop_reason`, `ttfp_natural_required_ms`, and `ttfp_natural_qualified_ms`
- `ttfp_natural_video_count` and `ttfp_natural_video_ids_json`
- `ttfp_natural_summary_json` and `ttfp_natural_summary_truncated`
- `ttfp_natural_payload_chunks`, `ttfp_natural_payload_truncated`, and `ttfp_natural_payload_1` through `ttfp_natural_payload_6`
- `ttfp_natural_completed`

This minimal version deliberately records numeric post IDs and a bounded playback/navigation log in the Qualtrics response. That is a different privacy boundary from the extension-only viewer and must be covered by the study's consent, retention, IRB, and platform review. The TikTok iframe also communicates directly with TikTok.

## Rebuild and check

```sh
python3 tiktok-fyp-pilot/qualtrics/build_qsf.py
python3 tiktok-fyp-pilot/qualtrics/build_qsf.py --check
python3 tiktok-fyp-pilot/qualtrics/build_natural_qsf.py --check
python3 -m unittest discover -s tiktok-fyp-pilot/qualtrics -p 'test_*.py'
node --check tiktok-fyp-pilot/qualtrics/tiktok_fyp_qualtrics.js
```

These checks establish deterministic structure and JavaScript syntax. They cannot prove account-specific Qualtrics import behavior or live TikTok embed availability; run an imported Preview and anonymous-link trial before deployment.
