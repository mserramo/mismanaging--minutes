# TikTok FYP Capture Pilot

An unpacked Chrome Manifest V3 research prototype that locally records numeric TikTok post IDs seen on a participant's desktop For You feed, intercepts safely ahead posts before they enter the viewport, and presents the reserved posts in a minimalist extension viewer.

This directory is standalone. It has no oTree integration, backend, upload endpoint, external JavaScript dependency, or build step.

## Current status

- The extension, local interfaces, synthetic fixture, and dependency-free automated tests are implemented.
- Automated syntax, core, service-worker, storage, permission, DOM-adapter, and manifest tests pass.
- The collector deliberately fails closed when it cannot identify a one-post card boundary.
- Live TikTok DOM compatibility is **not certified yet**. A logged-in desktop Chrome pass using [MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md) is required before describing the collector as functional on the current TikTok site.

## Install as an unpacked extension

1. Open `chrome://extensions` in desktop Chrome.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `tiktok-fyp-pilot/` directory—the directory that contains `manifest.json`.
5. Pin **TikTok FYP Research Pilot** from Chrome's Extensions menu.

No package installation is needed to run the extension.

## Pilot flow

1. Open the extension popup.
2. Optionally open **Pilot settings** and set required qualified seconds `N` and unseen target `K`. Defaults are 60 seconds and 5 posts.
3. Read and accept the local privacy explanation.
4. Select **Allow access and start**. Chrome then requests the optional `https://www.tiktok.com/*` site permission from that click gesture.
5. The extension opens or reuses a `/foryou` tab in the current Chrome window. Sign-in remains entirely between the browser and TikTok.
6. Browse normally while the status banner reports qualified time, reserved progress, and the current pause reason.
7. When both locked gates pass, collection stops and the viewer opens automatically.
8. In the viewer, press **Play video** for each item. **Next video** unlocks only after ended, a validated player error, a 15-second readiness failure, or 45 seconds without progress after Play. Pausing or hiding the viewer suspends that watchdog and exposes a Resume action; persistent buffering remains bounded by it.

TikTok access remains granted until **Revoke access** is used. Ending or clearing a session does not silently change the participant's Chrome site-permission choice.

## Operational definitions

Qualified time advances only when all of these are true:

- the bound page is exactly `/foryou`;
- the document is visible and its Chrome window is focused;
- exactly one identified playing feed video occupies at least 60% of its own area in the viewport; and
- the media's playback time advances between samples.

The timer samples every 250 ms and clamps a delayed tick to 350 ms. An identified post becomes `seen` after 500 ms of cumulative qualified exposure. Any positive card overlap is recorded sooner as `ever_exposed`; that durable classification prevents even a sub-500-ms exposure from later entering the unseen bank.

An unseen reservation must:

- be newly discovered in the current insertion group;
- be at least one complete feed-card position ahead of the playing primary post;
- be fully below and have no overlap with the viewport;
- never have been exposed or seen;
- resolve to exactly one numeric post ID and one bounded feed card; and
- still pass the same checks immediately before synchronous concealment.

Current desktop TikTok hydrates only the playing card and one complete card
below it. The pilot therefore accepts that first offscreen card, but never a
card with any viewport overlap. This narrower buffer is recorded explicitly as
`aheadBy: 1`; the final synchronous recheck, exposure guard, and tombstone rules
remain unchanged. The reserved card stays mounted for TikTok's virtual scroller
but is synchronously removed from layout and the accessibility tree; deleting
the mounted node causes current TikTok builds to discard the rest of the feed.

Every numeric ID inside a bounded but ambiguous multi-ID card is immediately and durably classified as `ambiguous_card`, making it reservation-ineligible even if a later DOM rewrite leaves that ID in an apparently unique card.

One candidate is selected per eligible insertion group using the stored session seed, a persisted batch ordinal, and a sorted candidate signature. Here, “batch” means one collector discovery group produced by the initial post-boot snapshot or a DOM mutation/reconciliation pass. It is not claimed to be TikTok's internal server-side recommendation batch.

Reserved IDs remain tombstoned for the session, so a safe rerender of the same card is concealed again before paint. A card that cannot be bounded safely is never concealed or banked. A heuristic multi-ID boundary is recorded only as non-removable ambiguity: its IDs are excluded, but the extension does not risk hiding a broad container.

While an active session has tombstones, any other exact `/foryou` tab receives a guard-only context so a rerender cannot expose a reserved ID. Only the explicitly bound session tab can send timing, exposure, reservation, or diagnostic writes; guard-only tabs perform no collection and show no pilot banner.

Safety-critical exposure and reservation writes fail closed: if the collector cannot persist one after bounded retries, it stops timing and interception, reports a local-storage error, and attempts to stop the session rather than continue with an uncertain unseen bank.

## Local data and privacy boundary

Collected state is stored only in `chrome.storage.local` under schema version 1. Extension storage is restricted to trusted extension contexts. A separate `chrome.storage.session` boolean marks that browser-lifetime tab leases were initialized; it contains no session or TikTok data. On a Chrome restart, stale collection/viewer tab IDs are cleared before any extension message is accepted: collection requires an explicit **Return to FYP**, while a restored viewer claims itself or one replacement opens after a short grace period. Stored records can contain:

- random local session ID and 32-bit selection seed;
- locked `N` and `K`, timestamps, session status, and local tab leases;
- numeric post ID, feed order, classification, and active-watch milliseconds;
- durable `ever_exposed`, `ambiguous_card`, seen, reserved, invalidated, and tombstone state;
- code-only diagnostics with bounded numeric or enumerated details;
- validated viewer playback events; and
- local sequencing fields used for idempotent writes and deterministic selection.

The collector necessarily reads TikTok post links in the page DOM to extract numeric IDs. It does **not store** usernames, creator names, account URLs, captions, descriptions, messages, cookies, credentials, Prolific IDs, or participant identifiers. There is no record upload or export path. Normal use of TikTok and the official embedded player still sends ordinary page/player traffic to TikTok.

The **Local data** inspector is read-only. Its two destructive controls are intentionally separate:

- **Clear collected data** shuts down the active collector and deletes every stored session while keeping settings and the TikTok site permission.
- **Revoke TikTok access** shuts down injected collectors, stops an active collection, unregisters the dynamic collector, and removes the optional TikTok host permission while preserving already stored records.

Use both controls when the desired final state is no records and no TikTok access.

## Diagnostics

Only codes and bounded safe details are stored. The collector can report:

- `unsupported_page_state`;
- `login_or_fyp_absent`;
- `selector_failure`;
- `ambiguous_feed_card`;
- `duplicate_video_ids`;
- `multiple_active_videos`;
- `candidate_failed_final_recheck`;
- `reservation_persist_failed`;
- `unseen_collection_stalled`;
- `target_tab_closed`; and
- `viewer_tab_open_failed`.

The viewer prefers TikTok's validated `onPlayerReady` message, but current
players sometimes omit it on extension pages. A successful iframe load therefore
enables the participant-clicked Play path without classifying the post as
unavailable. Private, deleted, or failed embeds advance only after a validated
`player_error` or a post-Play `playback_timeout` event.

## Automated verification

Node 18 or newer is sufficient. There are no test dependencies.

```sh
npm run check
npm test
```

`npm run check` runs `node --check` over every JavaScript file. `npm test` covers:

- focus, visibility, path, playback, 60% visibility, timer clamping, and the 500 ms seen threshold;
- deterministic safe-ahead selection and restoration from the stored seed/batch ordinal;
- seen/exposed/ambiguous/reserved exclusion, deduplication, invalidation, and tombstones;
- settings locking, schema restoration, unknown-field stripping, and clearing;
- pure viewer-reducer order and transition rules, terminal idempotency, strict player-message validation, and static viewer-control/watchdog wiring;
- concurrent service-worker registration/session starts, serialized storage mutation, both automatic completion paths, wrong-tab rejection, redacted-URL-safe single viewer-tab claiming, startup lease recovery, and revoke order; and
- narrow manifest permissions, dynamic `document_start` registration, CSP, and unsafe-rendering checks.

## Synthetic harness

Open **Local data → Open synthetic harness**. The fixture uses the production core and DOM adapter without loading TikTok or making network requests. It supports:

- single and split batch insertion;
- active-card/viewport advancement;
- playback and focus changes;
- 499 ms versus 500 ms exposure checks;
- deterministic safe-ahead removal; and
- tombstone rerender/removal.

Select **Run built-in assertions** for an on-page PASS/FAIL log. This is a deterministic component fixture, not an end-to-end substitute for current live TikTok selectors.

## Main files

- `manifest.json` — MV3 permissions, entry points, and extension CSP.
- `background.js` — serialized local state, dynamic registration, session/tab leases, permission lifecycle, and message authorization.
- `lib/core.js` — versioned state model and pure selection, timing, classification, completion, viewer, and validation logic.
- `content/dom-adapter.js` — conservative post-ID parsing and bounded feed-card discovery.
- `content/collector.js` — FYP timing, exposure observation, batch selection, immediate removal, tombstones, banner, and diagnostics.
- `viewer/` — official TikTok iframe player and sequential participant controls.
- `popup/`, `options/`, and `inspector/` — consent/session controls, locked settings, and local read-only records.
- `harness/` and `tests/` — synthetic fixture and dependency-free automated coverage.

## Research/deployment boundary

This is a local desktop research pilot, not a Chrome Web Store package or a Prolific-ready data pipeline. TikTok DOM selectors and embedding behavior can change without notice. Before field use, complete the live checklist, document browser/site versions, and obtain the appropriate IRB/platform review.

Any later transmission of records requires a separate data minimization, consent, security, retention, and identity-risk design. In particular, Prolific's current policy lists social-media usernames or links as disallowed personal identifiers; this pilot avoids storing those fields, but that does not itself approve a future deployment.

## Current platform references

- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [TikTok Embed Player](https://developers.tiktok.com/doc/embed-player)
- [Prolific personal-information policy](https://researcher-help.prolific.com/en/articles/445117-can-i-ask-participants-for-their-personal-information-identifiers)
