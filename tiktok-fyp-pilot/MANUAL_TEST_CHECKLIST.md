# Logged-in Chrome validation checklist

Use a research-development TikTok account/profile. Record date, Chrome version, extension commit, TikTok page state, duration, diagnostics, and result for every trial. Automated advancement may affect the account's future recommendations.

## 1. Clean installation and consent

- [ ] Load this directory from `chrome://extensions` and confirm version 0.4.5.
- [ ] Confirm required permissions are `alarms`, `storage`, and `scripting`; confirm only TikTok access is optional.
- [ ] Before consent, open TikTok and confirm there is no injected overlay or collector.
- [ ] Leave consent unchecked and confirm the permission action is disabled.
- [ ] Deny the optional TikTok request once and confirm no session is created.
- [ ] Grant on a second attempt and confirm access is only `https://www.tiktok.com/*` and no session starts merely from granting access.
- [ ] After permission is granted, confirm the popup tells the participant to return to Qualtrics and exposes no standalone Start action.
- [ ] Confirm the disclosure explains the Qualtrics data boundary and recommendation effects from automatic skipping/watch time.

## 2. Overlay and tab flow

- [ ] Start from a neutral experiment tab.
- [ ] Confirm `/foryou` opens or reloads with an opaque full-page cover before TikTok content becomes visible.
- [ ] Confirm no sound is audible while the page is covered.
- [ ] Confirm pointer, wheel, touch, and keyboard input do not reach TikTok; overlay controls still work.
- [ ] Confirm TikTok stays foregrounded but fully covered until the first video is confirmed, then focus automatically returns to the originating experiment tab.
- [ ] Confirm the inspector never stores the experiment tab's URL or title.
- [ ] Select **Stop session** during a run; confirm the overlay is removed and prior media mute/pause state is restored.

## 3. Locked settings and migration

- [ ] Set a 30-second harvest window before starting.
- [ ] Change settings after Start and confirm the active session retains its original locked window.
- [ ] Reload the bound TikTok tab and confirm phase, confirmed count, classifications, and tombstones restore.
- [ ] If old fixture data is available, confirm completed schema-1/manual and schema-2/schema-3 background sessions remain readable and an old collecting session stops with `collection_rule_replaced`.

## 4. Automated harvesting safety

- [ ] Confirm each traversed card has one numeric ID and is retained with `captureMethod=covered_feed_item` while the opaque overlay is mounted and its media is muted.
- [ ] In the inspector, confirm each card first appears as a persisted reservation and is then confirmed only after the overlay/media/identity recheck and concealment.
- [ ] Confirm the structural target node remains mounted but removed from layout/accessibility.
- [ ] Confirm advancement occurs only after reservation confirmation, with already-hydrated successors limited to a four-item burst and a 250 ms settle before hydration fallback.
- [ ] Confirm a replacement hydrates automatically or the relevant scroll container advances programmatically.
- [ ] Confirm visibility, timer delay, hydration latency, phase, attempt number, and driver ID appear in bounded harvest diagnostics.
- [ ] Confirm duplicate IDs and ambiguous multi-ID cards are never reserved.
- [ ] Force or observe a DOM recycle of a tombstoned ID and confirm it is concealed again.
- [ ] Open a second `/foryou` tab and confirm it applies tombstones without collecting or showing an overlay.

## 5. Background behavior and bounded failure

- [ ] Leave the TikTok tab hidden and confirm it continues collecting until the locked deadline rather than stopping at five videos.
- [ ] Repeat the hidden-tab run several times; record success rate and timer/hydration delays rather than treating one success as a guarantee.
- [ ] Force a hydration stall and confirm no more than three advancement attempts occur for an eight-second stage.
- [ ] Confirm the deadline opens a viewer containing every confirmed reservation, even when the count is below five.
- [ ] Confirm a zero-video window opens no viewer. If TikTok stalls after at least one confirmed video, confirm the extension keeps that pool until the deadline and returns it to the viewer rather than rejecting it.
- [ ] Confirm failure focuses the still-covered TikTok tab and shows retry plus uncover controls.
- [ ] Confirm the failure screen shows the exact failure code and a recent diagnostic log with phase, visibility, timer delay, hydration latency, and attempt number.
- [ ] Select **Try a fresh session** and confirm a new session ID, seed, deadline, and empty bank are created.
- [ ] While logged out or at a login/CAPTCHA/rate-limit/unsupported page, confirm the extension fails without attempting to bypass it.
- [ ] Select **Stop and uncover TikTok** after failure and confirm the participant can address login or leave normally.

## 6. Success and viewer

- [ ] Confirm the deadline focuses one viewer tab when at least one reservation was confirmed.
- [ ] Confirm no additional harvesting occurs after success.
- [ ] Confirm only confirmed `reserved` IDs appear, once each, in interception order.
- [ ] Confirm one iframe is created at a time using `https://www.tiktok.com/player/v1/{numeric_id}`.
- [ ] Confirm the video is centered and the status/transport interface is a compact bar immediately below it.
- [ ] Confirm description, music information, progress UI, and native controls are hidden.
- [ ] Confirm the participant clicks the video surface to start; subsequent videos attempt autoplay and another video-surface click remains available if autoplay is blocked.
- [ ] Confirm clicking the video toggles pause/resume and Space provides the same behavior without changing videos; confirm there is no separate Play/Pause button.
- [ ] Confirm a genuine end advances automatically to the next video.
- [ ] Confirm previous/next buttons, arrow keys, up/down keys, and Page Up/Page Down move backward and forward; confirm mouse-wheel scrolling never changes the video.
- [ ] Confirm navigating away early records `participant_skip`, and returning backward replays without adding the video to the queue twice.
- [ ] Confirm an unavailable/private/deleted embed records a local error or bounded timeout and allows Next.
- [ ] Confirm a copied second viewer cannot claim or mutate the session.
- [ ] Confirm viewer progress and terminal events survive reload.

## 7. Clear and revoke

- [ ] During collection, use **Clear collected data** and confirm the overlay disappears and all session records are gone while settings/permission remain.
- [ ] Start again, use **Revoke TikTok access**, and confirm collectors shut down, the dynamic script unregisters, and Chrome reports no TikTok access.
- [ ] Confirm Revoke preserves stored records.
- [ ] Clear after Revoke and confirm no records, active session, injected collector, or TikTok permission remain.

## 8. Qualtrics bridge

- [ ] Import `qualtrics/TikTok_FYP_Qualtrics_Pilot.qsf` into the Stanford brand and keep it inactive.
- [ ] Confirm the imported survey name ends in `v0.4.5 - QSF r5`, shows the five setup/collection/viewing steps above the extension-ID field, uses Qualtrics' default completion message, and has no Prolific redirect.
- [ ] Confirm a non-Qualtrics page cannot connect and the Stanford Qualtrics respondent hostname can connect only when given the exact installed extension ID.
- [ ] Confirm both an anonymous survey top frame and the same-origin iframe used by Qualtrics Preview can connect.
- [ ] Confirm TikTok access must already have been granted from the extension popup.
- [ ] Confirm granting access does not create a competing standalone session before the survey starts its own session.
- [ ] After a failed Preview run, start again from a newly opened Preview tab and confirm progress, completion return, and testing continuation bind to the new requesting tab rather than the prior Preview.
- [ ] Confirm an older extension build is rejected with an instruction to reload it, and any legacy standalone session is reported as a conflict rather than claimed by the survey.
- [ ] Start from the survey and confirm focus returns to the same survey tab after the covered collector initializes.
- [ ] Confirm live count/time progress updates and no extension viewer opens at the deadline.
- [ ] Force a failed run, select **Continue to Qualtrics (testing)**, and confirm the survey regains focus, records `ttfp_test_bypass=1`, preserves the failure code, and permits Next with an empty queue.
- [ ] Confirm the finalized numeric ID queue appears once in traversal order in the survey viewer, without a video-count label or separate Play/Pause button.
- [ ] Confirm player messages from the wrong origin or iframe source do not affect the survey.
- [ ] Finish the task and confirm `ttfp_video_ids_json`, the bounded playback log, count, session ID, and completion status are present in the Qualtrics response.
- [ ] Exercise an anonymous survey link in addition to Preview; document any Stanford Qualtrics CSP or custom-JavaScript restriction.

## 9. Result record

- [ ] `npm run check` result recorded.
- [ ] `npm test` result and test count recorded.
- [ ] Synthetic **Run background-harvest assertions** result recorded.
- [ ] At least three live hidden-tab trials recorded.
- [ ] Any selector, overlay, embed, focus, hydration, or throttling deviations documented before pilot use.
