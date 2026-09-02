# Logged-in Chrome validation checklist

Run this checklist before calling the live TikTok collector functional. Record the date, Chrome version, extension commit/archive, TikTok page state, and any diagnostic codes. Use a test TikTok account and Chrome profile appropriate for research development.

## 1. Clean installation and consent

- [ ] Remove any earlier unpacked copy, then load this directory from `chrome://extensions`.
- [ ] Confirm Chrome shows only `storage` and `scripting` as required extension permissions.
- [ ] Open TikTok before accepting consent and confirm there is no registered/injected pilot banner.
- [ ] Open the popup and verify the privacy text distinguishes local pilot records from ordinary TikTok network traffic.
- [ ] While logged out, attempt `/foryou` and confirm collection remains paused with only `login_or_fyp_absent` or `unsupported_page_state` code diagnostics—no page content.
- [ ] Leave consent unchecked and confirm Start is disabled.
- [ ] Check consent, select Start, and confirm Chrome requests only `https://www.tiktok.com/*` access.
- [ ] Deny once and confirm no session is created; then grant on a second attempt.
- [ ] Confirm a `/foryou` tab in the current Chrome window opens or reloads and shows the pilot banner.

## 2. Locked settings and restoration

- [ ] Before starting, set a short manual-test target such as `N = 10`, `K = 2`.
- [ ] Start, then change the settings page to different values.
- [ ] Confirm the banner and popup retain the session's original locked values.
- [ ] Reload the FYP tab and confirm qualified time, reserved count, exposed/seen classifications, and tombstones restore.
- [ ] Restart Chrome, choose **Return to FYP**, and confirm the same session resumes only after that explicit action.

## 3. Qualified-time gates

- [ ] With one identified video playing and at least 60% visible, confirm the banner reports counting after media begins advancing.
- [ ] Pause the TikTok video and confirm time stops.
- [ ] Resume and confirm time continues without a large catch-up jump.
- [ ] Switch tabs and confirm time stops.
- [ ] Blur the Chrome window and confirm time stops.
- [ ] Navigate away from exact `/foryou` and confirm time stops and no cards are removed.
- [ ] Return to `/foryou` and confirm collection resumes.
- [ ] Position the feed so no video is 60% visible and confirm time stops.
- [ ] If two playing videos can be made 60% visible, confirm the multiple-primary diagnostic/pause behavior.

## 4. Unseen interception safety

- [ ] Watch DevTools only if needed, without editing the page. Confirm a newly loaded multi-card group reserves no more than one post.
- [ ] Confirm each reserved card was at least one complete live feed position ahead of the playing primary card.
- [ ] Confirm a reserved card had zero viewport overlap and was below the viewport immediately before removal.
- [ ] Confirm the reserved card disappears before scrolling can reveal it.
- [ ] Confirm scrolling through a card—even for less than 500 ms—classifies it as ever exposed and prevents later reservation.
- [ ] Confirm 500 ms of qualified exposure promotes a post to seen and accumulates active watch milliseconds.
- [ ] Confirm duplicate IDs and ambiguous multi-ID cards are not reserved.
- [ ] If an ambiguous A+B card can be simulated, rewrite it to A-only and confirm A remains locally classified as `ambiguous_card` and cannot be reserved, including after reload.
- [ ] Force or observe a safe rerender of a tombstoned ID and confirm it is removed again.
- [ ] Open a second `/foryou` tab and confirm it enforces existing tombstones without showing a banner, advancing time, or creating reservations.
- [ ] Confirm the inspector never displays a username, caption, description, profile/account URL, credential, cookie, or participant ID.

## 5. Dual completion gate

- [ ] Reach `N` while below `K`; confirm collection continues for unseen posts.
- [ ] In a fresh session, reach `K` while below `N`; confirm qualified timing continues.
- [ ] Confirm the viewer opens automatically exactly once only after both gates pass.
- [ ] Simulate a browser close/crash immediately as the final gate passes; on restart, confirm a restored viewer claims itself or exactly one replacement viewer opens after the short recovery grace period.
- [ ] Confirm timing and new selection stop at completion while the tombstone guard remains effective until viewer completion/stop.
- [ ] Race the banner Stop button against the final gate if practical and confirm a completed/viewing session cannot become stopped.

## 6. Viewer

- [ ] Confirm only one reserved ID is embedded at a time and future IDs are not preloaded.
- [ ] Confirm the iframe URL is `https://www.tiktok.com/player/v1/{numeric_id}`.
- [ ] Confirm TikTok description, music information, progress UI, native controls, and autoplay are hidden/disabled as configured.
- [ ] Confirm the participant must press the extension's Play button.
- [ ] Confirm an early player `ended` state before Play does not unlock Next.
- [ ] Confirm Next unlocks after a genuine ended state.
- [ ] Confirm a private/deleted/restricted post records a local error or readiness timeout and then unlocks Next.
- [ ] Confirm a long, normally advancing video is not rejected at a fixed duration; hiding or pausing suspends the progress watchdog and offers Resume, while persistent buffering eventually records a bounded local stall and unlocks Next.
- [ ] Confirm reloading mid-item returns to the same unfinished post and requires Play again.
- [ ] Confirm every valid reserved ID is presented once in interception order.
- [ ] Confirm a second copied viewer tab is rejected and cannot mutate the session.
- [ ] Confirm the final viewer state survives reload and the inspector shows the ordered playback events.

## 7. Clear and revoke

- [ ] During a collection, use **Clear collected data** and confirm the banner disappears and every session record is gone while settings remain.
- [ ] Confirm Clear alone leaves TikTok permission granted, as disclosed.
- [ ] Start again, then use **Revoke TikTok access** and confirm the banner disappears, dynamic collector registration is removed, and Chrome reports no TikTok site access for the extension.
- [ ] Confirm Revoke preserves existing local records.
- [ ] Use Clear after Revoke and confirm no records, active session, active TikTok collector, or TikTok permission remains.

## 8. Result record

- [ ] Automated command: `npm run check` — pass/fail recorded.
- [ ] Automated command: `npm test` — pass/fail and test count recorded.
- [ ] Synthetic harness built-in assertions — pass/fail recorded.
- [ ] Live Chrome/TikTok checklist — pass/fail recorded.
- [ ] Any selector failures or behavior deviations are documented before pilot use.
