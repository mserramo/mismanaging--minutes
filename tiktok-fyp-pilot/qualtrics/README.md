# Minimal Qualtrics bridge pilot

This package connects the unpacked Chrome extension to one Qualtrics question. The survey shows live harvest progress, receives the finalized numeric post-ID queue, and displays each video through TikTok's official embed player. No research backend is involved.

## Files

- `TikTok_FYP_Qualtrics_Pilot.qsf` — generated survey import.
- `tiktok_fyp_qualtrics.js` — reviewed source embedded as QID1 `QuestionJS`.
- `build_qsf.py` — deterministic builder using the known-good Stanford export in `qualtrics-examples/`.
- `test_qsf.py` — structural and bridge-contract checks.

## Local pilot

1. Reload `tiktok-fyp-pilot/` on `chrome://extensions` after updating the source and confirm Chrome shows version **0.4.5**.
2. Copy the extension's 32-letter ID.
3. Open the extension popup, accept the disclosure, and select **Grant TikTok access**. This popup no longer exposes a standalone Start action; collection can begin only from the survey. A normal website cannot trigger that permission prompt on the extension's behalf.
4. Import the freshly generated `TikTok_FYP_Qualtrics_Pilot.qsf` into Stanford Qualtrics as a new survey and keep it inactive. Confirm its name is **TikTok FYP Qualtrics Bridge Pilot v0.4.5 - QSF r3**. This build deliberately uses Qualtrics-safe JavaScript, Qualtrics' default completion message, no Prolific redirect, and a full-height iframe mount for the 9:16 player.
5. Preview the survey in desktop Chrome. Paste the extension ID into the setup field and select **Connect**. Alternatively, append `ttfp_extension_id=EXTENSION_ID` to the survey link after declaring that Embedded Data field, taking care to use `?` or `&` correctly.
6. Select **Start harvest**. TikTok opens covered, the survey regains focus, and the survey polls the extension every 500 ms.
7. After the configured harvest window, play or navigate through the returned queue. The normal Qualtrics Next button appears only after **Finish**.

If collection opens an extension viewer tab, the session was not started by this survey. Stop and clear the old session from the extension, reload version 0.4.5, and restart using the survey's **Start harvest** button. The survey rejects old bridge builds and standalone-session conflicts with an explicit message.

For test runs, a failed harvest exposes **Continue to Qualtrics (testing)** on the covered TikTok page. Returning to the survey records the failure and an empty queue, sets `ttfp_test_bypass=1`, and makes Qualtrics Next available. This bypass does not relabel the extension session as successful and should not be used as a production completion rule.

The manifest permits bridge connections only from `https://stanforduniversity.qualtrics.com/*`. A vanity domain or a different Qualtrics data center must be reviewed and added explicitly to both the manifest and the runtime hostname check.

## Response fields

- `ttfp_extension_id`
- `ttfp_bridge_version`
- `ttfp_session_id`
- `ttfp_harvest_status`
- `ttfp_failure_reason`
- `ttfp_video_count`
- `ttfp_video_ids_json`
- `ttfp_playback_events_json`
- `ttfp_test_bypass` (`1` when the testing-only failed-harvest continuation is enabled)
- `ttfp_completed`

This minimal version deliberately records numeric post IDs and a bounded playback/navigation log in the Qualtrics response. That is a different privacy boundary from the extension-only viewer and must be covered by the study's consent, retention, IRB, and platform review. The TikTok iframe also communicates directly with TikTok.

## Rebuild and check

```sh
python3 tiktok-fyp-pilot/qualtrics/build_qsf.py
python3 tiktok-fyp-pilot/qualtrics/build_qsf.py --check
python3 -m unittest discover -s tiktok-fyp-pilot/qualtrics -p 'test_*.py'
node --check tiktok-fyp-pilot/qualtrics/tiktok_fyp_qualtrics.js
```

These checks establish deterministic structure and JavaScript syntax. They cannot prove account-specific Qualtrics import behavior or live TikTok embed availability; run an imported Preview and anonymous-link trial before deployment.
