/* global TikTokPilotCore, TikTokPilotDom */
(function () {
    'use strict';

    if (globalThis.__TIKTOK_FYP_PILOT_COLLECTOR__) {
        return;
    }
    globalThis.__TIKTOK_FYP_PILOT_COLLECTOR__ = true;

    const Core = TikTokPilotCore;
    const Dom = TikTokPilotDom;
    const SAMPLE_INTERVAL_MS = 250;
    const SEEN_THRESHOLD_MS = 500;
    const NO_CONTENT_DIAGNOSTIC_MS = 15000;
    const STALLED_DIAGNOSTIC_MS = 30000;
    const RESERVED_CARD_CLASS = 'ttfp-reserved-card';

    const sourceId = crypto.randomUUID();
    let sourceSequence = 0;
    let outboundQueue = Promise.resolve();
    let destroyed = false;
    let mode = 'inactive';
    let session = null;
    let observer = null;
    let intersectionObserver = null;
    let sampleTimer = null;
    let diagnosticsTimer = null;
    let banner = null;
    let lastSampleAt = performance.now();
    let previousMediaSample = null;
    let previousBaseEligible = false;
    let lastPauseReason = 'starting';
    let localQualifiedMs = 0;
    let validUnseenCount = 0;
    let lastReservationAt = Date.now();
    let nextFeedOrder = 0;
    let batchSequence = 0;
    let ambiguousDiagnosticSent = false;
    let multipleActiveDiagnosticSent = false;
    let noContentDiagnosticAt = 0;
    let stalledDiagnosticAt = 0;
    let unsupportedDiagnosticAt = 0;
    let selectorDiagnosticAt = 0;
    let duplicateDiagnosticAt = 0;
    let reconcileFrame = null;
    let persistenceFailure = false;
    let contextRequestInFlight = false;

    const seenIds = new Set();
    const exposedIds = new Set();
    const tombstones = new Set();
    const pendingReservations = new Set();
    const knownDiscoveredIds = new Set();
    const observedCardElements = new WeakSet();
    const discoveryOrders = new Map();
    const exposures = new Map();

    document.documentElement.classList.add('ttfp-booting');

    function runtimeMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                const runtimeError = chrome.runtime.lastError;
                if (runtimeError) {
                    reject(new Error('extension_message_failed'));
                    return;
                }
                resolve(response);
            });
        });
    }

    function queueSequencedMessage(type, payload, attempts) {
        const message = {
            ...payload,
            type,
            sourceId,
            sequence: ++sourceSequence,
        };
        const maxAttempts = Math.max(1, attempts || 1);
        const operation = outboundQueue.then(async () => {
            let lastError = null;
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                try {
                    return await runtimeMessage(message);
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError || new Error('extension_message_failed');
        });
        outboundQueue = operation.catch(() => undefined);
        return operation;
    }

    function ensureFeedOrder(record) {
        if (!record || !record.videoId) {
            return null;
        }
        return ensureVideoFeedOrder(record.videoId);
    }

    function ensureVideoFeedOrder(videoId) {
        if (!videoId) {
            return null;
        }
        if (!discoveryOrders.has(videoId)) {
            nextFeedOrder += 1;
            discoveryOrders.set(videoId, nextFeedOrder);
        }
        return discoveryOrders.get(videoId);
    }

    function snapshot() {
        const records = Dom.snapshotFeed(document, location.href);
        records.forEach(ensureFeedOrder);
        return records;
    }

    function stopCollectionTimers() {
        if (sampleTimer) {
            clearInterval(sampleTimer);
            sampleTimer = null;
        }
        if (diagnosticsTimer) {
            clearInterval(diagnosticsTimer);
            diagnosticsTimer = null;
        }
    }

    function wait(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function failClosedAfterSafetyWrite() {
        if (destroyed || persistenceFailure) {
            return;
        }
        try {
            const context = await runtimeMessage({
                type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT,
            });
            if (context && context.active && context.mode === 'guard') {
                mode = 'guard';
                stopCollectionTimers();
                updateBanner();
                return;
            }
        } catch (_error) {
            // Continue into the local fail-closed state below.
        }

        persistenceFailure = true;
        mode = 'error';
        lastPauseReason = 'local_storage_error';
        stopCollectionTimers();
        updateBanner();

        for (const delay of [0, 150, 500]) {
            if (delay) {
                await wait(delay);
            }
            try {
                const response = await runtimeMessage({
                    type: Core.MESSAGE_TYPES.STOP_SESSION,
                    sessionId: session.id,
                });
                if (response && response.ok) {
                    teardown();
                    return;
                }
                if (response && response.error === 'not_collecting') {
                    mode = 'guard';
                    updateBanner();
                    return;
                }
                if (response && response.error === 'session_not_found') {
                    teardown();
                    return;
                }
            } catch (_error) {
                // Retry. The banner remains in a non-collecting error state.
            }
        }
    }

    function canRecordExposure() {
        return (
            mode === 'collecting' &&
            session &&
            Core.isFypPath(location.pathname) &&
            document.visibilityState === 'visible' &&
            document.hasFocus() &&
            !document.documentElement.classList.contains('ttfp-booting')
        );
    }

    function markExposed(record) {
        if (
            !canRecordExposure() ||
            !record ||
            !record.videoId ||
            !Dom.connected(record) ||
            seenIds.has(record.videoId) ||
            exposedIds.has(record.videoId)
        ) {
            return;
        }
        const videoId = record.videoId;
        exposedIds.add(videoId);
        queueSequencedMessage(
            Core.MESSAGE_TYPES.MARK_EXPOSED,
            {
                sessionId: session.id,
                videoId,
                feedOrder: ensureFeedOrder(record),
                at: Date.now(),
            },
            3
        )
            .then((response) => {
                if (!response || !response.ok) {
                    failClosedAfterSafetyWrite();
                    return;
                }
                if (response && response.progress) {
                    applyProgress(response.progress);
                }
            })
            .catch(() => failClosedAfterSafetyWrite());
    }

    function observeCards(records) {
        if (!intersectionObserver) {
            return;
        }
        records.forEach((record) => {
            if (!record.element || observedCardElements.has(record.element)) {
                return;
            }
            observedCardElements.add(record.element);
            intersectionObserver.observe(record.element);
        });
    }

    function reconcileExposures(records) {
        if (!canRecordExposure()) {
            return;
        }
        records.forEach((record) => {
            if (!record.videoId || !Dom.connected(record)) {
                return;
            }
            const rect = record.element.getBoundingClientRect();
            if (Dom.rectOverlapsViewport(rect, innerWidth, innerHeight)) {
                markExposed(record);
            }
        });
    }

    function excludeAmbiguousRecords(records) {
        if (destroyed || mode !== 'collecting' || !session) {
            return;
        }
        const ambiguous = records.filter(
            (record) => record.ambiguous && Array.isArray(record.ids) && record.ids.length > 0
        );
        if (ambiguous.length > 0 && !ambiguousDiagnosticSent) {
            ambiguousDiagnosticSent = true;
            recordDiagnostic('ambiguous_feed_card', { count: ambiguous.length });
        }
        const ids = new Set();
        ambiguous.forEach((record) => record.ids.forEach((videoId) => ids.add(videoId)));
        ids.forEach((videoId) => {
            if (seenIds.has(videoId) || exposedIds.has(videoId)) {
                return;
            }
            exposedIds.add(videoId);
            knownDiscoveredIds.add(videoId);
            queueSequencedMessage(
                Core.MESSAGE_TYPES.EXCLUDE_VIDEO,
                {
                    sessionId: session.id,
                    videoId,
                    classification: 'ambiguous_card',
                    feedOrder: ensureVideoFeedOrder(videoId),
                    at: Date.now(),
                },
                3
            )
                .then((response) => {
                    if (!response || !response.ok) {
                        failClosedAfterSafetyWrite();
                        return;
                    }
                    if (response.progress) {
                        applyProgress(response.progress);
                    }
                })
                .catch(() => failClosedAfterSafetyWrite());
        });
    }

    function sweepTombstones(records) {
        Dom.recordsWithAnyId(records, tombstones).forEach((record) => {
            if (!Dom.connected(record) || record.removable === false) {
                return;
            }
            concealReservedRecord(record);
        });
    }

    function concealReservedRecord(record) {
        if (!record || !record.element || !Dom.connected(record)) {
            return false;
        }
        // TikTok's current virtual scroller loses its remaining feed when a
        // mounted card node is removed directly. Keep the structural node so
        // React can advance its window, while synchronously taking the entire
        // reserved card out of layout and accessibility exposure.
        record.element.classList.add(RESERVED_CARD_CLASS);
        record.element.setAttribute('aria-hidden', 'true');
        return true;
    }

    function visibleRecords(records) {
        return records
            .filter((record) => record.videoId && record.occurrenceCount === 1)
            .map((record) => {
                const visible = Dom.bestVideoForRecord(record, innerWidth, innerHeight);
                return visible ? { record, ...visible } : null;
            })
            .filter((entry) => entry && entry.ratio >= 0.6);
    }

    function activeRecords(records) {
        return visibleRecords(records).filter((entry) => Dom.videoIsPlaying(entry.video));
    }

    function currentActiveRecord(records) {
        const active = activeRecords(records);
        return active.length === 1 ? active[0].record : null;
    }

    function recheckCandidate(videoId, activeVideoId) {
        const records = snapshot();
        sweepTombstones(records);
        const active = records.find((record) => record.videoId === activeVideoId);
        const candidate = records.find((record) => record.videoId === videoId);
        if (!active || !candidate || !Dom.connected(candidate)) {
            return null;
        }
        const occurrenceCount = records.filter(
            (record) => record.videoId === videoId
        ).length;
        const aheadBy = candidate.liveIndex - active.liveIndex;
        const rect = candidate.element.getBoundingClientRect();
        const overlap = Dom.rectOverlapsViewport(rect, innerWidth, innerHeight);
        const belowViewport = Dom.isBelowViewport(rect, innerHeight);
        if (
            occurrenceCount !== 1 ||
            aheadBy < Core.MIN_SAFE_AHEAD ||
            overlap ||
            !belowViewport ||
            exposedIds.has(videoId) ||
            seenIds.has(videoId) ||
            tombstones.has(videoId) ||
            pendingReservations.has(videoId)
        ) {
            return null;
        }
        return {
            record: candidate,
            evidence: {
                feedOrder: ensureFeedOrder(candidate),
                aheadBy,
                intersectionRatio: 0,
                belowViewport: true,
                everIntersected: false,
                connected: true,
                occurrenceCount: 1,
            },
        };
    }

    function processCandidateBatch(records) {
        if (
            destroyed ||
            mode !== 'collecting' ||
            !session ||
            !Core.isFypPath(location.pathname) ||
            document.visibilityState !== 'visible' ||
            !document.hasFocus()
        ) {
            return;
        }

        if (
            validUnseenCount + pendingReservations.size >=
            session.lockedSettings.targetUnseenCount
        ) {
            return;
        }

        const active = currentActiveRecord(records);
        if (!active || !active.videoId) {
            return;
        }

        const addedIds = new Set();
        records.forEach((record) => {
            if (record.videoId && !knownDiscoveredIds.has(record.videoId)) {
                addedIds.add(record.videoId);
            }
        });
        if (!addedIds.size) {
            return;
        }
        addedIds.forEach((videoId) => knownDiscoveredIds.add(videoId));

        const candidates = records
            .filter((record) => addedIds.has(record.videoId))
            .map((record) => {
                const rect = record.element.getBoundingClientRect();
                return {
                    videoId: record.videoId,
                    feedOrder: ensureFeedOrder(record),
                    aheadBy: record.liveIndex - active.liveIndex,
                    intersectionRatio: Dom.rectOverlapsViewport(
                        rect,
                        innerWidth,
                        innerHeight
                    ) ? 1 : 0,
                    belowViewport: Dom.isBelowViewport(rect, innerHeight),
                    everIntersected: exposedIds.has(record.videoId),
                    connected: Dom.connected(record),
                    occurrenceCount: record.occurrenceCount,
                };
            })
            .filter((candidate) => {
                return (
                    candidate.videoId &&
                    !seenIds.has(candidate.videoId) &&
                    !exposedIds.has(candidate.videoId) &&
                    !tombstones.has(candidate.videoId) &&
                    !pendingReservations.has(candidate.videoId)
                );
            });

        batchSequence += 1;
        const batchId = `batch-${batchSequence}`;
        const selected = Core.selectSafeCandidate(session.seed, batchId, candidates);
        if (!selected) {
            return;
        }

        const checked = recheckCandidate(selected.videoId, active.videoId);
        if (!checked) {
            recordDiagnostic('candidate_failed_final_recheck', {
                reasonCode: 'unsafe_final_state',
            });
            return;
        }

        const videoId = selected.videoId;
        tombstones.add(videoId);
        pendingReservations.add(videoId);
        if (!concealReservedRecord(checked.record)) {
            pendingReservations.delete(videoId);
            tombstones.delete(videoId);
            recordDiagnostic('candidate_failed_final_recheck', {
                reasonCode: 'concealment_failed',
            });
            return;
        }

        queueSequencedMessage(
            Core.MESSAGE_TYPES.RESERVE_VIDEO,
            {
                sessionId: session.id,
                videoId,
                batchId,
                batchNumber: batchSequence,
                at: Date.now(),
                evidence: checked.evidence,
            },
            3
        )
            .then((response) => {
                pendingReservations.delete(videoId);
                if (!response || !response.ok) {
                    recordDiagnostic('reservation_persist_failed', {
                        reasonCode: response && response.error
                            ? String(response.error).replace(/[^a-z0-9_-]/g, '').slice(0, 40)
                            : 'no_response',
                    });
                    failClosedAfterSafetyWrite();
                    return;
                }
                lastReservationAt = Date.now();
                (response.tombstones || []).forEach((id) => tombstones.add(id));
                if (response.progress) {
                    applyProgress(response.progress);
                }
            })
            .catch(() => {
                pendingReservations.delete(videoId);
                recordDiagnostic('reservation_persist_failed', {
                    reasonCode: 'message_failure',
                });
                failClosedAfterSafetyWrite();
            });
    }

    function reconcileFeed() {
        if (destroyed || !session) {
            return [];
        }
        const records = snapshot();
        if (!Core.isFypPath(location.pathname)) {
            return records;
        }
        excludeAmbiguousRecords(records);
        sweepTombstones(records);
        observeCards(records);
        reconcileExposures(records);
        processCandidateBatch(records);
        return records;
    }

    function processMutationBatch() {
        reconcileFeed();
    }

    function scheduleReconcile() {
        if (destroyed || reconcileFrame !== null) {
            return;
        }
        reconcileFrame = requestAnimationFrame(() => {
            reconcileFrame = null;
            reconcileFeed();
        });
    }

    function baseSample(records) {
        const active = activeRecords(records);
        const visible = visibleRecords(records);
        if (active.length !== 1) {
            if (active.length === 0 && visible.length === 1) {
                const entry = visible[0];
                const currentTime = Number(entry.video.currentTime);
                return {
                    primaryCount: 1,
                    videoId: entry.record.videoId,
                    visibleRatio: entry.ratio,
                    playing: false,
                    currentTime: Number.isFinite(currentTime) ? currentTime : null,
                    record: entry.record,
                };
            }
            return {
                primaryCount: active.length,
                videoId: null,
                visibleRatio: active.length ? active[0].ratio : 0,
                playing: false,
                currentTime: null,
                record: null,
            };
        }
        const entry = active[0];
        const currentTime = Number(entry.video.currentTime);
        return {
            primaryCount: 1,
            videoId: entry.record.videoId,
            visibleRatio: entry.ratio,
            playing: Dom.videoIsPlaying(entry.video),
            currentTime: Number.isFinite(currentTime) ? currentTime : null,
            record: entry.record,
        };
    }

    function sampleTick() {
        if (destroyed || mode !== 'collecting' || !session) {
            return;
        }
        const nowPerformance = performance.now();
        const rawDelta = nowPerformance - lastSampleAt;
        lastSampleAt = nowPerformance;

        const records = reconcileFeed();
        const base = baseSample(records);
        const sameMedia =
            previousMediaSample &&
            previousMediaSample.videoId === base.videoId &&
            Number.isFinite(base.currentTime) &&
            base.currentTime > previousMediaSample.currentTime + 0.001;
        const baseEligible =
            Core.isFypPath(location.pathname) &&
            document.visibilityState === 'visible' &&
            document.hasFocus() &&
            base.primaryCount === 1 &&
            base.visibleRatio >= 0.6 &&
            base.playing;
        const evaluation = Core.evaluateQualifiedSample({
            pathname: location.pathname,
            documentVisible: document.visibilityState === 'visible',
            windowFocused: document.hasFocus(),
            primaryCount: base.primaryCount,
            videoId: base.videoId,
            visibleRatio: base.visibleRatio,
            playing: base.playing,
            mediaAdvancing: Boolean(previousBaseEligible && sameMedia),
        });

        if (base.primaryCount > 1 && !multipleActiveDiagnosticSent) {
            multipleActiveDiagnosticSent = true;
            recordDiagnostic('multiple_active_videos', { count: base.primaryCount });
        }

        lastPauseReason = evaluation.reason;
        if (evaluation.qualified) {
            const delta = Core.clampTickDelta(rawDelta);
            const exposure = exposures.get(base.videoId) || {
                totalMs: 0,
                firstAt: Date.now(),
                reported: seenIds.has(base.videoId),
            };
            const advancedExposure = Core.advanceExposure(
                exposure.totalMs,
                delta,
                SEEN_THRESHOLD_MS
            );
            exposure.totalMs = advancedExposure.totalMs;
            exposures.set(base.videoId, exposure);
            localQualifiedMs += delta;

            let seenDeltaMs = 0;
            let videoId = null;
            let firstSeenAt = null;
            if (exposure.reported) {
                videoId = base.videoId;
                seenDeltaMs = delta;
            } else if (exposure.totalMs >= SEEN_THRESHOLD_MS) {
                exposure.reported = true;
                seenIds.add(base.videoId);
                videoId = base.videoId;
                seenDeltaMs = exposure.totalMs;
                firstSeenAt = exposure.firstAt;
            }

            queueSequencedMessage(
                Core.MESSAGE_TYPES.ACTIVITY_TICK,
                {
                    sessionId: session.id,
                    at: Date.now(),
                    qualifiedDeltaMs: delta,
                    videoId,
                    seenDeltaMs,
                    firstSeenAt,
                    feedOrder: ensureFeedOrder(base.record),
                },
                2
            )
                .then((response) => {
                    if (!response || !response.ok) {
                        failClosedAfterSafetyWrite();
                        return;
                    }
                    if (response.progress) {
                        applyProgress(response.progress);
                    }
                })
                .catch(() => failClosedAfterSafetyWrite());
        }

        previousMediaSample = base.videoId && Number.isFinite(base.currentTime)
            ? { videoId: base.videoId, currentTime: base.currentTime }
            : null;
        previousBaseEligible = baseEligible;
        updateBanner();
    }

    function recordDiagnostic(code, detail) {
        if (!session || destroyed) {
            return;
        }
        queueSequencedMessage(
            Core.MESSAGE_TYPES.RECORD_DIAGNOSTIC,
            {
                sessionId: session.id,
                code,
                at: Date.now(),
                detail: detail || {},
            },
            1
        ).catch(() => undefined);
    }

    function diagnosticsTick() {
        if (destroyed || mode !== 'collecting' || !session) {
            return;
        }
        const now = Date.now();
        const records = snapshot();
        const identified = records.filter((record) => record.videoId).length;
        const elapsed = now - session.startedAt;
        if (
            !Core.isFypPath(location.pathname) &&
            elapsed >= NO_CONTENT_DIAGNOSTIC_MS &&
            now - unsupportedDiagnosticAt >= STALLED_DIAGNOSTIC_MS
        ) {
            unsupportedDiagnosticAt = now;
            recordDiagnostic('unsupported_page_state', { pathCode: 'not_foryou' });
        }
        if (
            Core.isFypPath(location.pathname) &&
            identified === 0 &&
            elapsed >= NO_CONTENT_DIAGNOSTIC_MS &&
            now - noContentDiagnosticAt >= STALLED_DIAGNOSTIC_MS
        ) {
            noContentDiagnosticAt = now;
            recordDiagnostic('login_or_fyp_absent', { elapsedMs: elapsed });
        }
        const rawPostLinkCount = document.querySelectorAll('a[href*="/video/"]').length;
        if (
            rawPostLinkCount > 0 &&
            identified === 0 &&
            elapsed >= NO_CONTENT_DIAGNOSTIC_MS &&
            now - selectorDiagnosticAt >= STALLED_DIAGNOSTIC_MS
        ) {
            selectorDiagnosticAt = now;
            recordDiagnostic('selector_failure', { count: rawPostLinkCount });
        }
        const duplicateCount = records.filter(
            (record) => record.videoId && record.occurrenceCount > 1
        ).length;
        if (
            duplicateCount > 0 &&
            now - duplicateDiagnosticAt >= STALLED_DIAGNOSTIC_MS
        ) {
            duplicateDiagnosticAt = now;
            recordDiagnostic('duplicate_video_ids', { count: duplicateCount });
        }
        if (
            localQualifiedMs >= STALLED_DIAGNOSTIC_MS &&
            validUnseenCount < session.lockedSettings.targetUnseenCount &&
            now - lastReservationAt >= STALLED_DIAGNOSTIC_MS &&
            now - stalledDiagnosticAt >= STALLED_DIAGNOSTIC_MS
        ) {
            stalledDiagnosticAt = now;
            recordDiagnostic('unseen_collection_stalled', {
                elapsedMs: now - lastReservationAt,
            });
        }
    }

    function formatSeconds(milliseconds) {
        return Math.floor(Math.max(0, milliseconds) / 1000);
    }

    function createElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text !== undefined) {
            element.textContent = text;
        }
        return element;
    }

    function createBanner() {
        if (banner || !document.body || !session) {
            return;
        }
        const shell = createElement('aside', 'ttfp-banner');
        shell.setAttribute('aria-live', 'polite');
        const title = createElement('div', 'ttfp-banner__title', 'Research pilot');
        const progress = createElement('div', 'ttfp-banner__progress');
        progress.dataset.role = 'progress';
        const reason = createElement('div', 'ttfp-banner__reason');
        reason.dataset.role = 'reason';
        const stop = createElement('button', 'ttfp-banner__stop', 'Stop session');
        stop.type = 'button';
        stop.addEventListener('click', (event) => {
            if (!event.isTrusted || mode !== 'collecting') {
                return;
            }
            stop.disabled = true;
            runtimeMessage({
                type: Core.MESSAGE_TYPES.STOP_SESSION,
                sessionId: session.id,
            })
                .then((response) => {
                    if (response && response.ok) {
                        teardown();
                        return;
                    }
                    stop.disabled = false;
                })
                .catch(() => {
                    stop.disabled = false;
                });
        });
        shell.append(title, progress, reason, stop);
        document.body.appendChild(shell);
        banner = shell;
        updateBanner();
    }

    function updateBanner() {
        if (!banner || !session) {
            return;
        }
        const progress = banner.querySelector('[data-role="progress"]');
        const reason = banner.querySelector('[data-role="reason"]');
        const stop = banner.querySelector('.ttfp-banner__stop');
        if (progress) {
            progress.textContent =
                `${Math.min(formatSeconds(localQualifiedMs), session.lockedSettings.durationSeconds)}` +
                ` / ${session.lockedSettings.durationSeconds}s · ` +
                `${validUnseenCount} / ${session.lockedSettings.targetUnseenCount} reserved`;
        }
        if (reason) {
            reason.textContent = mode === 'guard'
                ? 'Collection complete. Opening the viewer…'
                : mode === 'error'
                    ? 'Collection stopped: a safety record could not be saved locally.'
                    : pauseLabel(lastPauseReason);
        }
        if (stop) {
            stop.hidden = mode !== 'collecting';
        }
    }

    function pauseLabel(reason) {
        const labels = {
            counting: 'Qualified viewing time is counting.',
            starting: 'Preparing the FYP collector…',
            open_fyp: 'Return to the For You page to continue.',
            tab_hidden: 'Return to this tab to continue.',
            window_unfocused: 'Focus this Chrome window to continue.',
            no_active_video: 'Scroll until one video is clearly visible.',
            multiple_active_videos: 'Only one feed video can be active.',
            video_not_visible: 'Keep at least 60% of one video visible.',
            video_paused: 'Play the visible video to continue.',
            video_buffering: 'Waiting for the video to advance.',
        };
        return labels[reason] || 'Viewing is paused.';
    }

    function applyProgress(progress) {
        if (!progress) {
            return;
        }
        localQualifiedMs = Math.max(localQualifiedMs, progress.qualifiedMs || 0);
        validUnseenCount = progress.unseenCount || 0;
        if (progress.status !== Core.SESSION_STATUS.COLLECTING && mode === 'collecting') {
            mode = 'guard';
            stopCollectionTimers();
        }
        updateBanner();
    }

    function teardown() {
        if (destroyed) {
            return;
        }
        destroyed = true;
        if (observer) {
            observer.disconnect();
        }
        if (intersectionObserver) {
            intersectionObserver.disconnect();
        }
        if (reconcileFrame !== null) {
            cancelAnimationFrame(reconcileFrame);
            reconcileFrame = null;
        }
        if (sampleTimer) {
            clearInterval(sampleTimer);
        }
        if (diagnosticsTimer) {
            clearInterval(diagnosticsTimer);
        }
        if (banner) {
            banner.remove();
            banner = null;
        }
        document.documentElement.classList.remove('ttfp-booting');
        window.removeEventListener('focus', scheduleReconcile);
        window.removeEventListener('scroll', scheduleReconcile, true);
        window.removeEventListener('resize', scheduleReconcile);
        document.removeEventListener('visibilitychange', scheduleReconcile);
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    }

    function onRuntimeMessage(message) {
        if (message && message.type === Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR) {
            teardown();
            return;
        }
        if (message && message.type === Core.MESSAGE_TYPES.STATE_UPDATED) {
            requestContentContext();
        }
    }

    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    function begin(context) {
        if (destroyed || !context || !context.active || !context.session) {
            document.documentElement.classList.remove('ttfp-booting');
            return;
        }
        session = { ...context.session };
        mode = context.mode;
        localQualifiedMs = context.session.qualifiedMs;
        validUnseenCount = context.session.validUnseenCount;
        nextFeedOrder = context.session.maxFeedOrder || 0;
        batchSequence = context.session.batchCounter || 0;
        (context.session.seenIds || []).forEach((id) => seenIds.add(id));
        (context.session.exposedIds || []).forEach((id) => exposedIds.add(id));
        (context.session.tombstones || []).forEach((id) => tombstones.add(id));
        (context.session.feedOrders || []).forEach((entry) => {
            discoveryOrders.set(entry.videoId, entry.feedOrder);
        });
        seenIds.forEach((id) => knownDiscoveredIds.add(id));
        exposedIds.forEach((id) => knownDiscoveredIds.add(id));
        tombstones.forEach((id) => knownDiscoveredIds.add(id));

        intersectionObserver = new IntersectionObserver((entries) => {
            if (!canRecordExposure()) {
                return;
            }
            entries.forEach((entry) => {
                if (!entry.isIntersecting || entry.intersectionRatio <= 0) {
                    return;
                }
                const record = snapshot().find((item) => item.element === entry.target);
                if (record) {
                    markExposed(record);
                }
            });
        }, { threshold: [0, 0.000001] });
        observer = new MutationObserver(processMutationBatch);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href'],
        });
        const initial = snapshot();
        if (Core.isFypPath(location.pathname)) {
            excludeAmbiguousRecords(initial);
            sweepTombstones(initial);
            observeCards(initial);
        }
        document.documentElement.classList.remove('ttfp-booting');
        window.addEventListener('focus', scheduleReconcile);
        window.addEventListener('scroll', scheduleReconcile, true);
        window.addEventListener('resize', scheduleReconcile);
        document.addEventListener('visibilitychange', scheduleReconcile);
        scheduleReconcile();

        if (context.session.boundTab) {
            const mountBanner = () => {
                if (document.body) {
                    createBanner();
                } else {
                    requestAnimationFrame(mountBanner);
                }
            };
            mountBanner();
        }

        if (mode === 'collecting') {
            sampleTimer = setInterval(sampleTick, SAMPLE_INTERVAL_MS);
            diagnosticsTimer = setInterval(diagnosticsTick, 5000);
        }
    }

    function requestContentContext() {
        if (destroyed || session || contextRequestInFlight) {
            return;
        }
        contextRequestInFlight = true;
        runtimeMessage({ type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT })
            .then(begin)
            .catch(() => {
                document.documentElement.classList.remove('ttfp-booting');
            })
            .finally(() => {
                contextRequestInFlight = false;
            });
    }

    requestContentContext();
})();
