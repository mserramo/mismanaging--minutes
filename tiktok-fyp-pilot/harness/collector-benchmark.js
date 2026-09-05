/* global TikTokPilotCore */
'use strict';

// Runs the actual content collector against a local virtual feed and an
// in-memory extension-message adapter. No TikTok requests or account data.
(function () {
    const Core = TikTokPilotCore;
    const parameters = new URLSearchParams(location.search);
    const timerFloorMs = Math.max(0, Number(parameters.get('timerFloor') || 1000));
    const hydrationMs = Math.max(0, Number(parameters.get('hydration') || 100));
    const durationMs = Math.max(1000, Number(parameters.get('duration') || 10000));
    const stallAfter = parameters.has('stallAfter') ? Number(parameters.get('stallAfter')) : Infinity;
    const invalidateFirst = parameters.get('invalidateFirst') === '1';
    const stopAfterMs = Math.max(0, Number(parameters.get('stopAfterMs') || 0));
    const nativeTimeout = window.setTimeout.bind(window);
    const feed = document.getElementById('benchmark-feed');
    const output = document.getElementById('benchmark-result');
    const session = Core.createSession({ harvestDurationSeconds: 15 }, {
        id: 'synthetic-benchmark', seed: 42, startedAt: Date.now(), targetTabId: 1,
    });
    session.harvestDeadlineAt = session.startedAt + durationMs;
    const listeners = new Set();
    const violations = [];
    let advancements = 0;
    let stopped = false;
    let ready = false;
    let lastPosition = 0;
    let invalidatedFirst = false;
    let hiddenCaptureCount = 0;
    const slots = Array.from({ length: 120 }, (_unused, index) => {
        const card = document.createElement('article');
        card.dataset.e2e = 'recommend-list-item-container';
        card.dataset.slot = String(index);
        feed.appendChild(card);
        return card;
    });

    function hydrate(index) {
        if (stopped || index >= stallAfter) { return; }
        [index, index + 1].forEach((slotIndex) => {
            const card = slots[slotIndex];
            if (!card || card.querySelector('video')) { return; }
            const wrapper = document.createElement('div');
            wrapper.id = 'xgwrapper-0-' + String(7311111111111111000n + BigInt(slotIndex));
            const video = document.createElement('video');
            video.dataset.syntheticPlaying = slotIndex === index ? 'true' : 'false';
            video.muted = true;
            wrapper.appendChild(video);
            card.appendChild(wrapper);
        });
        slots.forEach((card, slotIndex) => {
            if (slotIndex < index - 1 || slotIndex > index + 1) {
                card.replaceChildren();
            }
        });
    }
    hydrate(0);
    feed.addEventListener('scroll', () => {
        const index = Math.min(slots.length - 1, Math.round(feed.scrollTop / feed.clientHeight));
        if (index !== lastPosition) {
            advancements += 1;
            lastPosition = index;
            nativeTimeout(() => hydrate(index), hydrationMs);
        }
    });

    function respond(message) {
        const type = message.type;
        if (type === Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT) {
            return { ok: true, active: true, mode: 'collecting', session: {
                ...session, boundTab: true, validUnseenCount: 0,
                seenIds: [], exposedIds: [], tombstones: [], feedOrders: [],
            } };
        }
        if (type === Core.MESSAGE_TYPES.COLLECTOR_READY) { ready = true; }
        let result = { applied: true };
        if (type === Core.MESSAGE_TYPES.RESERVE_VIDEO) {
            result = Core.reserveVideo(session, { ...message, at: Date.now() });
            if (!message.evidence.overlayOpaque || !message.evidence.mediaMuted) {
                violations.push('missing_cover_or_mute');
            }
            if (invalidateFirst && !invalidatedFirst) {
                invalidatedFirst = true;
                const wrapper = document.getElementById('xgwrapper-0-' + message.videoId);
                if (wrapper) { wrapper.id = 'unidentified-after-persist'; }
            }
        } else if (type === Core.MESSAGE_TYPES.CONFIRM_RESERVATION) {
            const prepared = Core.findReserved(session, message.videoId);
            const wrapper = document.getElementById('xgwrapper-0-' + message.videoId);
            if (!prepared || prepared.state !== 'prepared') { violations.push('confirm_before_prepare'); }
            if (!wrapper || !wrapper.closest('.ttfp-reserved-card')) { violations.push('confirm_without_concealment'); }
            result = Core.confirmReservation(session, message.videoId, Date.now());
            if (result.applied && document.hidden) { hiddenCaptureCount += 1; }
        } else if (type === Core.MESSAGE_TYPES.HARVEST_STEP) {
            result = Core.recordHarvestStep(session, message, Date.now());
        } else if (type === Core.MESSAGE_TYPES.INVALIDATE_VIDEO) {
            Core.invalidateReservation(session, message.videoId, message.reason, Date.now());
        } else if (type === Core.MESSAGE_TYPES.HARVEST_FAIL) {
            Core.failHarvest(session, Date.now(), message.reason);
        } else if (type === Core.MESSAGE_TYPES.RECORD_DIAGNOSTIC) {
            Core.recordDiagnostic(session, message.code, Date.now(), message.detail);
        }
        return { ok: result.applied !== false, progress: Core.sessionProgress(session), tombstones: session.tombstones.slice() };
    }
    // The bridge is simulated only on this local test page. Message callbacks
    // are independent of the collector's clamped timers, like worker replies.
    window.chrome = { runtime: {
        sendMessage(message, callback) { queueMicrotask(() => callback(respond(message))); },
        onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    } };
    window.TikTokPilotCore = { ...Core, isFypPath: () => true };
    window.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, Math.max(timerFloorMs, delay || 0), ...args);
    const script = document.createElement('script');
    script.src = '../content/collector.js';
    document.body.appendChild(script);

    if (stopAfterMs) {
        nativeTimeout(() => {
            stopped = true;
            Core.stopSession(session, Date.now(), 'synthetic_stop');
            listeners.forEach((listener) => listener({ type: Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR }));
        }, stopAfterMs);
    }

    nativeTimeout(() => {
        stopped = true;
        Core.finalizeHarvestWindow(session, Date.now());
        const heights = slots.filter((card) => card.classList.contains('ttfp-reserved-card'))
            .map((card) => card.getBoundingClientRect().height);
        listeners.forEach((listener) => listener({ type: Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR }));
        const ids = Core.validReservedVideos(session).map((record) => record.videoId);
        if (new Set(ids).size !== ids.length) { violations.push('duplicate_ids'); }
        if (invalidateFirst && ids.includes('7311111111111111000')) { violations.push('invalid_id_banked'); }
        output.textContent = JSON.stringify({
            status: session.status, count: ids.length, durationMs, timerFloorMs, hydrationMs,
            ready, advancements, violations,
            hiddenCaptureCount,
            reservedSlotsRetainHeight: heights.every((height) => height > 0),
            excludedDrivers: session.excluded.length,
            invalidated: session.reserved.filter((record) => record.state === 'invalidated').length,
            stopReason: session.stopReason,
            diagnostics: session.diagnostics,
        }, null, 2);
        feed.hidden = true;
        window.setTimeout = nativeTimeout;
    }, durationMs + 100);
})();
