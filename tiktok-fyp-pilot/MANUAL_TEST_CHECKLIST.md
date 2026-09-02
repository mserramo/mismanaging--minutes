# Logged-in Chrome validation checklist

Use a research-development TikTok account/profile. Record date, Chrome version, extension commit, TikTok page state, duration, diagnostics, and result for every trial. Automated advancement may affect the account's future recommendations.

## 1. Clean installation and consent

- [ ] Load this directory from `chrome://extensions` and confirm version 0.3.0.
- [ ] Confirm required permissions are `alarms`, `storage`, and `scripting`; confirm only TikTok access is optional.
- [ ] Before consent, open TikTok and confirm there is no injected overlay or collector.
- [ ] Leave consent unchecked and confirm Start is disabled.
- [ ] Deny the optional TikTok request once and confirm no session is created.
- [ ] Grant on a second attempt and confirm access is only `https://www.tiktok.com/*`.
- [ ] Confirm the disclosure explains local-only data and recommendation effects from automatic skipping/watch time.

## 2. Overlay and tab flow

- [ ] Start from a neutral experiment tab.
- [ ] Confirm `/foryou` opens or reloads with an opaque full-page cover before TikTok content becomes visible.
- [ ] Confirm no sound is audible while the page is covered.
- [ ] Confirm pointer, wheel, touch, and keyboard input do not reach TikTok; overlay controls still work.
- [ ] Confirm focus automatically returns to the originating experiment tab after collector readiness.
- [ ] Confirm the inspector never stores the experiment tab's URL or title.
- [ ] Select **Stop session** during a run; confirm the overlay is removed and prior media mute/pause state is restored.

## 3. Locked settings and migration

- [ ] Set a 30-second harvest window before starting.
- [ ] Change settings after Start and confirm the active session retains its original locked window.
- [ ] Reload the bound TikTok tab and confirm phase, confirmed count, classifications, and tombstones restore.
- [ ] If old fixture data is available, confirm completed schema-1/manual and schema-2/background sessions remain readable and an old collecting session stops with `collection_rule_replaced`.

## 4. Automated harvesting safety

- [ ] Confirm each driver is stored as `automation_driver` and never enters the viewer queue.
- [ ] Confirm each target has one numeric ID, is at least one complete feed position ahead, is fully below the viewport, and has zero overlap.
- [ ] In the inspector, confirm each target first appears as a persisted reservation and is then confirmed only after concealment.
- [ ] Confirm the structural target node remains mounted but removed from layout/accessibility.
- [ ] Confirm at least 750 ms separates confirmation from the next advancement attempt.
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
- [ ] Confirm a zero-video window or explicit stall opens no viewer; an explicit failure invalidates its partial reservation set.
- [ ] Confirm failure focuses the still-covered TikTok tab and shows retry plus uncover controls.
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
- [ ] Confirm the participant must select **Play** once; subsequent videos attempt autoplay and expose Play again if autoplay is blocked.
- [ ] Confirm **Pause/Resume** and Space work without changing videos.
- [ ] Confirm a genuine end advances automatically to the next video.
- [ ] Confirm previous/next buttons, arrow keys, up/down keys, Page Up/Page Down, and mouse-wheel directions move backward and forward.
- [ ] Confirm navigating away early records `participant_skip`, and returning backward replays without adding the video to the queue twice.
- [ ] Confirm an unavailable/private/deleted embed records a local error or bounded timeout and allows Next.
- [ ] Confirm a copied second viewer cannot claim or mutate the session.
- [ ] Confirm viewer progress and terminal events survive reload.

## 7. Clear and revoke

- [ ] During collection, use **Clear collected data** and confirm the overlay disappears and all session records are gone while settings/permission remain.
- [ ] Start again, use **Revoke TikTok access**, and confirm collectors shut down, the dynamic script unregisters, and Chrome reports no TikTok access.
- [ ] Confirm Revoke preserves stored records.
- [ ] Clear after Revoke and confirm no records, active session, injected collector, or TikTok permission remain.

## 8. Result record

- [ ] `npm run check` result recorded.
- [ ] `npm test` result and test count recorded.
- [ ] Synthetic **Run background-harvest assertions** result recorded.
- [ ] At least three live hidden-tab trials recorded.
- [ ] Any selector, overlay, embed, focus, hydration, or throttling deviations documented before pilot use.
