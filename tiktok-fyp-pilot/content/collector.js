/* global TikTokPilotCore, TikTokPilotDom */
(function () {
    'use strict';

    if (globalThis.__TIKTOK_FYP_PILOT_COLLECTOR__) {
        return;
    }
    globalThis.__TIKTOK_FYP_PILOT_COLLECTOR__ = true;

    const Core = TikTokPilotCore;
    const Dom = TikTokPilotDom;
    const RECONCILE_DELAY_MS = 350;
    const REPLACEMENT_WAIT_MS = 2000;
    const SETTLE_DELAY_MS = 750;
    const STAGE_TIMEOUT_MS = 8000;
    const MAX_ADVANCE_ATTEMPTS = 3;
    const RESERVED_CARD_CLASS = 'ttfp-reserved-card';
    const OVERLAY_HOST_ID = 'ttfp-harvest-overlay-host';

    const sourceId = crypto.randomUUID();
    let sourceSequence = 0;
    let outboundQueue = Promise.resolve();
    let destroyed = false;
    let mode = 'inactive';
    let session = null;
    let observer = null;
    let harvestTimer = null;
    let harvestBusy = false;
    let expectedTickAt = 0;
    let validUnseenCount = 0;
    let nextFeedOrder = 0;
    let batchSequence = 0;
    let stageStartedAt = Date.now();
    let advanceAttempts = 0;
    let lastAdvanceAt = 0;
    let awaitingDriverChange = false;
    let lastDriverId = null;
    let lastReportedPhase = null;
    let overlayHost = null;
    let overlay = null;
    let failurePending = false;
    let contextRequestInFlight = false;

    const seenIds = new Set();
    const excludedIds = new Set();
    const tombstones = new Set();
    const pendingReservations = new Set();
    const discoveryOrders = new Map();
    const mutedMedia = new Map();
    const concealedElements = new Map();

    document.documentElement.classList.add('ttfp-booting');

    function runtimeMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
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

    function wait(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

    function ensureFeedOrder(record) {
        return record && record.videoId
            ? ensureVideoFeedOrder(record.videoId)
            : null;
    }

    function snapshot() {
        const records = Dom.snapshotFeed(document, location.href);
        records.forEach(ensureFeedOrder);
        return records;
    }

    function muteAllMedia() {
        document.querySelectorAll('video, audio').forEach((media) => {
            if (!mutedMedia.has(media)) {
                mutedMedia.set(media, {
                    muted: Boolean(media.muted),
                    paused: Boolean(media.paused),
                });
            }
            media.muted = true;
        });
    }

    function restoreMedia() {
        mutedMedia.forEach((priorState, media) => {
            try {
                media.muted = priorState.muted;
                if (priorState.paused) {
                    media.pause();
                } else {
                    media.play().catch(() => undefined);
                }
            } catch (_error) {
                // A recycled TikTok media node can disappear during teardown.
            }
        });
        mutedMedia.clear();
    }

    function blockInteraction(event) {
        if (
            event.type === 'keydown' &&
            overlayHost &&
            event.composedPath().includes(overlayHost)
        ) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function installInteractionBlockers() {
        window.addEventListener('wheel', blockInteraction, { capture: true, passive: false });
        window.addEventListener('touchmove', blockInteraction, { capture: true, passive: false });
        window.addEventListener('keydown', blockInteraction, true);
    }

    function removeInteractionBlockers() {
        window.removeEventListener('wheel', blockInteraction, true);
        window.removeEventListener('touchmove', blockInteraction, true);
        window.removeEventListener('keydown', blockInteraction, true);
    }

    function createShadowElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text !== undefined) {
            element.textContent = text;
        }
        return element;
    }

    function mountOverlay() {
        if (overlayHost || !session || !session.boundTab) {
            return;
        }
        const host = document.createElement('div');
        host.id = OVERLAY_HOST_ID;
        host.setAttribute('role', 'presentation');
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
            :host { color-scheme: light; }
            * { box-sizing: border-box; }
            .screen {
                align-items: center;
                background: #f4f6fb;
                color: #172033;
                display: flex;
                font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                inset: 0;
                justify-content: center;
                position: absolute;
            }
            .panel {
                background: #fff;
                border: 1px solid #d7deeb;
                border-radius: 20px;
                box-shadow: 0 20px 60px rgba(23, 32, 51, .13);
                max-width: 520px;
                padding: 32px;
                text-align: center;
                width: calc(100% - 40px);
            }
            .eyebrow {
                color: #595ee8;
                font-size: 12px;
                font-weight: 800;
                letter-spacing: .1em;
                margin: 0 0 12px;
                text-transform: uppercase;
            }
            h1 { font-size: 28px; line-height: 1.15; margin: 0 0 12px; }
            .progress { font-size: 18px; font-weight: 750; margin: 22px 0 8px; }
            .status { color: #56627a; min-height: 46px; margin: 0; }
            .track { background: #e8ebf4; border-radius: 999px; height: 8px; margin: 18px 0 0; overflow: hidden; }
            .fill { background: #595ee8; height: 100%; transition: width .2s ease; width: 0; }
            .actions { display: flex; gap: 10px; justify-content: center; margin-top: 22px; }
            button {
                background: #fff;
                border: 1px solid #c6cede;
                border-radius: 10px;
                color: #172033;
                cursor: pointer;
                font: inherit;
                font-weight: 700;
                padding: 10px 16px;
            }
            button.primary { background: #595ee8; border-color: #595ee8; color: #fff; }
            button[hidden] { display: none; }
        `;
        const screen = createShadowElement('div', 'screen');
        const panel = createShadowElement('section', 'panel');
        panel.setAttribute('aria-live', 'polite');
        const eyebrow = createShadowElement('p', 'eyebrow', 'Research pilot');
        const title = createShadowElement('h1', null, 'Preparing personalized videos');
        const progress = createShadowElement('div', 'progress');
        const status = createShadowElement(
            'p',
            'status',
            'TikTok is covered while the extension sources recommendations.'
        );
        const track = createShadowElement('div', 'track');
        const fill = createShadowElement('div', 'fill');
        track.appendChild(fill);
        const actions = createShadowElement('div', 'actions');
        const retry = createShadowElement('button', 'primary', 'Try a fresh session');
        retry.type = 'button';
        retry.hidden = true;
        retry.addEventListener('click', (event) => {
            if (!event.isTrusted || mode !== 'failed') {
                return;
            }
            retry.disabled = true;
            retry.textContent = 'Restarting…';
            runtimeMessage({
                type: Core.MESSAGE_TYPES.RETRY_HARVEST,
                sessionId: session.id,
            }).catch(() => {
                retry.disabled = false;
                retry.textContent = 'Try a fresh session';
            });
        });
        const stop = createShadowElement('button', null, 'Stop session');
        stop.type = 'button';
        stop.addEventListener('click', (event) => {
            if (!event.isTrusted || !['collecting', 'failed'].includes(mode)) {
                return;
            }
            stop.disabled = true;
            runtimeMessage({
                type: Core.MESSAGE_TYPES.STOP_SESSION,
                sessionId: session.id,
            }).then((response) => {
                if (response && response.ok) {
                    teardown();
                    return;
                }
                stop.disabled = false;
            }).catch(() => {
                stop.disabled = false;
            });
        });
        actions.append(retry, stop);
        panel.append(eyebrow, title, progress, status, track, actions);
        screen.appendChild(panel);
        shadow.append(style, screen);
        document.documentElement.appendChild(host);
        overlayHost = host;
        overlay = { title, progress, status, fill, retry, stop };
        installInteractionBlockers();
        updateOverlay();
    }

    function keepOverlayMounted() {
        if (overlayHost && !overlayHost.isConnected) {
            document.documentElement.appendChild(overlayHost);
        }
    }

    function phaseLabel(phase) {
        const labels = {
            starting: 'Starting the protected collector…',
            waiting_driver: 'Waiting for TikTok to load the current feed card…',
            waiting_candidate: 'Waiting for the next recommendation…',
            reserving: 'Saving an unseen recommendation locally…',
            settling: 'Waiting for the feed to replenish…',
            advancing: 'Advancing the covered feed…',
            waiting_hydration: 'Waiting for TikTok to hydrate another recommendation…',
            complete: 'Collection complete. Opening the viewer…',
        };
        return labels[phase] || 'Collecting personalized recommendations…';
    }

    function updateOverlay() {
        if (!overlay || !session) {
            return;
        }
        const target = session.lockedSettings.targetUnseenCount;
        const fraction = target > 0 ? Math.min(1, validUnseenCount / target) : 0;
        const remaining = session.harvestDeadlineAt
            ? Math.max(0, Math.ceil((session.harvestDeadlineAt - Date.now()) / 1000))
            : 0;
        overlay.progress.textContent = `${validUnseenCount} of ${target} videos sourced · ${remaining}s remaining`;
        overlay.fill.style.width = `${fraction * 100}%`;
        if (mode === 'failed') {
            overlay.title.textContent = 'Collection could not finish';
            overlay.status.textContent =
                'No partial viewer was opened. Try a fresh session or stop and return to the experiment.';
            overlay.retry.hidden = false;
            overlay.stop.textContent = 'Stop and uncover TikTok';
            overlay.stop.hidden = false;
            return;
        }
        if (mode === 'guard') {
            overlay.title.textContent = 'Collection complete';
            overlay.status.textContent = 'Opening the research viewer…';
            overlay.retry.hidden = true;
            overlay.stop.hidden = true;
            return;
        }
        overlay.title.textContent = 'Preparing personalized videos';
        overlay.status.textContent = phaseLabel(session.harvestPhase);
        overlay.retry.hidden = true;
        overlay.stop.textContent = 'Stop session';
        overlay.stop.hidden = false;
    }

    function concealReservedRecord(record) {
        if (!record || !record.element || !record.element.isConnected) {
            return false;
        }
        if (!concealedElements.has(record.element)) {
            concealedElements.set(record.element, {
                hadAriaHidden: record.element.hasAttribute('aria-hidden'),
                ariaHidden: record.element.getAttribute('aria-hidden'),
            });
        }
        record.element.classList.add(RESERVED_CARD_CLASS);
        record.element.setAttribute('aria-hidden', 'true');
        return true;
    }

    function restoreConcealedCards() {
        concealedElements.forEach((priorState, element) => {
            element.classList.remove(RESERVED_CARD_CLASS);
            if (priorState.hadAriaHidden) {
                element.setAttribute('aria-hidden', priorState.ariaHidden);
            } else {
                element.removeAttribute('aria-hidden');
            }
        });
        concealedElements.clear();
    }

    function sweepTombstones(records) {
        Dom.recordsWithAnyId(records, tombstones).forEach((record) => {
            if (record.removable !== false) {
                concealReservedRecord(record);
            }
        });
    }

    function excludeAmbiguousRecords(records) {
        const ids = new Set();
        records.forEach((record) => {
            if (record.ambiguous && Array.isArray(record.ids)) {
                record.ids.forEach((videoId) => ids.add(videoId));
            }
        });
        ids.forEach((videoId) => {
            if (seenIds.has(videoId) || excludedIds.has(videoId) || tombstones.has(videoId)) {
                return;
            }
            excludedIds.add(videoId);
            queueSequencedMessage(Core.MESSAGE_TYPES.EXCLUDE_VIDEO, {
                sessionId: session.id,
                videoId,
                classification: 'ambiguous_card',
                feedOrder: ensureVideoFeedOrder(videoId),
            }, 3).catch(() => failClosed('local_storage_error'));
        });
    }

    function visibleRecords(records) {
        return records
            .filter((record) =>
                record.videoId &&
                record.occurrenceCount === 1 &&
                !tombstones.has(record.videoId)
            )
            .map((record) => {
                const visible = Dom.bestVideoForRecord(record, innerWidth, innerHeight);
                return visible ? { record, ...visible } : null;
            })
            .filter((entry) => entry && entry.ratio >= 0.6);
    }

    function currentDriver(records) {
        const visible = visibleRecords(records);
        const playing = visible.filter((entry) => Dom.videoIsPlaying(entry.video));
        if (playing.length === 1) {
            return playing[0].record;
        }
        return visible.length === 1 ? visible[0].record : null;
    }

    function safeCandidate(records, driver) {
        const eligibleRecords = records
            .filter((record) =>
                record.videoId &&
                record.videoId !== driver.videoId &&
                !seenIds.has(record.videoId) &&
                !excludedIds.has(record.videoId) &&
                !tombstones.has(record.videoId) &&
                !pendingReservations.has(record.videoId)
            );
        const candidates = eligibleRecords
            .map((record) => {
                const rect = record.element.getBoundingClientRect();
                return {
                    videoId: record.videoId,
                    feedOrder: ensureFeedOrder(record),
                    aheadBy: record.liveIndex - driver.liveIndex,
                    intersectionRatio: Dom.rectOverlapsViewport(rect, innerWidth, innerHeight) ? 1 : 0,
                    belowViewport: Dom.isBelowViewport(rect, innerHeight),
                    everIntersected: false,
                    connected: record.element.isConnected,
                    occurrenceCount: record.occurrenceCount,
                };
            });
        const batchId = `batch-${batchSequence + 1}`;
        return Core.selectImmediateSafeCandidate(session.seed, batchId, candidates);
    }

    function recheckCandidate(videoId, driverVideoId) {
        const records = snapshot();
        sweepTombstones(records);
        const driver = records.find((record) => record.videoId === driverVideoId);
        const candidate = records.find((record) => record.videoId === videoId);
        if (!driver || !candidate || !candidate.element.isConnected) {
            return null;
        }
        const rect = candidate.element.getBoundingClientRect();
        const evidence = {
            feedOrder: ensureFeedOrder(candidate),
            aheadBy: candidate.liveIndex - driver.liveIndex,
            intersectionRatio: Dom.rectOverlapsViewport(rect, innerWidth, innerHeight) ? 1 : 0,
            belowViewport: Dom.isBelowViewport(rect, innerHeight),
            everIntersected: false,
            connected: true,
            occurrenceCount: records.filter((record) => record.videoId === videoId).length,
        };
        return Core.selectSafeCandidate(session.seed, 'final-recheck', [{ videoId, ...evidence }])
            ? { record: candidate, evidence }
            : null;
    }

    function phaseChanged(phase, driverVideoId, detail) {
        const signature = `${phase}:${driverVideoId || ''}:${detail && detail.advanceAttempt || 0}`;
        if (signature === lastReportedPhase) {
            return Promise.resolve({ ok: true, duplicate: true });
        }
        lastReportedPhase = signature;
        session.harvestPhase = phase;
        updateOverlay();
        return queueSequencedMessage(Core.MESSAGE_TYPES.HARVEST_STEP, {
            sessionId: session.id,
            phase,
            driverVideoId: driverVideoId || null,
            feedOrder: driverVideoId ? ensureVideoFeedOrder(driverVideoId) : null,
            visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
            timerDelayMs: detail && detail.timerDelayMs || 0,
            hydrationLatencyMs: detail && detail.hydrationLatencyMs || 0,
            advanceAttempt: detail && detail.advanceAttempt || 0,
        }, 3);
    }

    function recordDiagnostic(code, detail) {
        if (!session || destroyed) {
            return;
        }
        queueSequencedMessage(Core.MESSAGE_TYPES.RECORD_DIAGNOSTIC, {
            sessionId: session.id,
            code,
            detail: detail || {},
        }, 1).catch(() => undefined);
    }

    function applyProgress(progress) {
        if (!progress) {
            return;
        }
        validUnseenCount = progress.unseenCount || 0;
        if (progress.harvestPhase) {
            session.harvestPhase = progress.harvestPhase;
        }
        if (progress.status === Core.SESSION_STATUS.COMPLETE) {
            mode = 'guard';
            stopHarvestTimer();
            muteAllMedia();
        } else if (progress.status === Core.SESSION_STATUS.FAILED) {
            mode = 'failed';
            stopHarvestTimer();
        }
        updateOverlay();
    }

    function stopHarvestTimer() {
        if (harvestTimer) {
            clearTimeout(harvestTimer);
            harvestTimer = null;
        }
    }

    function scheduleHarvest(delay) {
        if (destroyed || mode !== 'collecting' || harvestTimer) {
            return;
        }
        const waitMs = Math.max(0, Number(delay) || 0);
        expectedTickAt = Date.now() + waitMs;
        harvestTimer = setTimeout(() => {
            harvestTimer = null;
            harvestTick(Math.max(0, Date.now() - expectedTickAt)).catch(() => {
                failClosed('collector_exception');
            });
        }, waitMs);
    }

    function findScrollableAncestor(element) {
        let node = element && element.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            const style = getComputedStyle(node);
            if (
                /(auto|scroll)/.test(style.overflowY) &&
                node.scrollHeight > node.clientHeight + 4
            ) {
                return node;
            }
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function advanceFeed(records, driver) {
        const next = records.find((record) =>
            record.videoId &&
            !tombstones.has(record.videoId) &&
            !excludedIds.has(record.videoId) &&
            record.liveIndex > driver.liveIndex &&
            record.element.isConnected
        );
        if (next) {
            next.element.scrollIntoView({ behavior: 'auto', block: 'center' });
            return true;
        }
        const scroller = findScrollableAncestor(driver.element);
        const distance = Math.max(
            320,
            Math.round((scroller.clientHeight || innerHeight || 600) * 0.9)
        );
        if (typeof scroller.scrollBy === 'function') {
            scroller.scrollBy({ top: distance, behavior: 'auto' });
        } else {
            scroller.scrollTop += distance;
        }
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
    }

    async function reserveCandidate(candidate, driver, timerDelayMs) {
        const checked = recheckCandidate(candidate.videoId, driver.videoId);
        if (!checked) {
            recordDiagnostic('candidate_failed_final_recheck', { reasonCode: 'unsafe_final_state' });
            stageStartedAt = Date.now();
            return;
        }
        const videoId = candidate.videoId;
        batchSequence += 1;
        pendingReservations.add(videoId);
        session.harvestPhase = 'reserving';
        updateOverlay();
        const prepared = await queueSequencedMessage(Core.MESSAGE_TYPES.RESERVE_VIDEO, {
            sessionId: session.id,
            videoId,
            batchId: `batch-${batchSequence}`,
            batchNumber: batchSequence,
            evidence: checked.evidence,
        }, 3);
        if (!prepared || !prepared.ok) {
            pendingReservations.delete(videoId);
            await failClosed(
                prepared && prepared.error === 'harvest_timeout'
                    ? 'harvest_timeout'
                    : 'reservation_persist_failed'
            );
            return;
        }
        applyProgress(prepared.progress);

        // The first message durably prepares the ID while its card is still
        // offscreen. Only after a second safety check do we conceal the node
        // and confirm it as viewer-eligible.
        const persistedCheck = recheckCandidate(videoId, driver.videoId);
        if (!persistedCheck) {
            pendingReservations.delete(videoId);
            excludedIds.add(videoId);
            const invalidated = await queueSequencedMessage(
                Core.MESSAGE_TYPES.INVALIDATE_VIDEO,
                {
                    sessionId: session.id,
                    videoId,
                    reason: 'unsafe_after_persist',
                },
                3
            );
            applyProgress(invalidated && invalidated.progress);
            recordDiagnostic('candidate_changed_after_persist', {
                reasonCode: 'unsafe_after_persist',
            });
            stageStartedAt = Date.now();
            return;
        }
        if (!concealReservedRecord(persistedCheck.record)) {
            pendingReservations.delete(videoId);
            await queueSequencedMessage(Core.MESSAGE_TYPES.INVALIDATE_VIDEO, {
                sessionId: session.id,
                videoId,
                reason: 'concealment_failed',
            }, 3).catch(() => undefined);
            await failClosed('concealment_failed');
            return;
        }
        tombstones.add(videoId);
        const confirmed = await queueSequencedMessage(
            Core.MESSAGE_TYPES.CONFIRM_RESERVATION,
            { sessionId: session.id, videoId },
            3
        );
        pendingReservations.delete(videoId);
        if (!confirmed || !confirmed.ok) {
            await failClosed('reservation_confirm_failed');
            return;
        }
        (confirmed.tombstones || []).forEach((id) => tombstones.add(id));
        applyProgress(confirmed.progress);
        stageStartedAt = Date.now();
        advanceAttempts = 0;
        if (mode !== 'collecting') {
            return;
        }
        await phaseChanged('settling', driver.videoId, {
            timerDelayMs,
            hydrationLatencyMs: 0,
            advanceAttempt: 0,
        });
        await wait(SETTLE_DELAY_MS);
        if (mode !== 'collecting') {
            return;
        }
        const settledRecords = snapshot();
        sweepTombstones(settledRecords);
        const replacementDriver = currentDriver(settledRecords);
        if (replacementDriver && replacementDriver.videoId !== driver.videoId) {
            awaitingDriverChange = false;
            return;
        }
        advanceAttempts = 1;
        lastAdvanceAt = Date.now();
        awaitingDriverChange = true;
        await phaseChanged('advancing', driver.videoId, {
            timerDelayMs,
            hydrationLatencyMs: lastAdvanceAt - stageStartedAt,
            advanceAttempt: advanceAttempts,
        });
        advanceFeed(settledRecords, driver);
        await phaseChanged('waiting_hydration', driver.videoId, {
            timerDelayMs,
            hydrationLatencyMs: Date.now() - stageStartedAt,
            advanceAttempt: advanceAttempts,
        });
    }

    async function harvestTick(timerDelayMs) {
        if (destroyed || mode !== 'collecting' || harvestBusy || !session) {
            return;
        }
        harvestBusy = true;
        try {
            keepOverlayMounted();
            muteAllMedia();
            updateOverlay();
            const now = Date.now();
            if (now >= session.harvestDeadlineAt) {
                await failClosed('harvest_timeout', { elapsedMs: now - session.harvestStartedAt });
                return;
            }
            if (!Core.isFypPath(location.pathname)) {
                if (now - stageStartedAt >= STAGE_TIMEOUT_MS) {
                    await failClosed('unsupported_page_state', { pathCode: 'not_foryou' });
                    return;
                }
                await phaseChanged('waiting_driver', null, { timerDelayMs });
                return;
            }

            const records = snapshot();
            excludeAmbiguousRecords(records);
            sweepTombstones(records);
            const driver = currentDriver(records);
            if (!driver) {
                if (now - stageStartedAt >= STAGE_TIMEOUT_MS) {
                    await failClosed('login_or_fyp_absent', { elapsedMs: now - stageStartedAt });
                    return;
                }
                await phaseChanged('waiting_driver', null, { timerDelayMs });
                return;
            }

            if (driver.videoId !== lastDriverId) {
                lastDriverId = driver.videoId;
                awaitingDriverChange = false;
                lastAdvanceAt = 0;
                excludedIds.add(driver.videoId);
                const response = await phaseChanged('waiting_candidate', driver.videoId, {
                    timerDelayMs,
                    hydrationLatencyMs: now - stageStartedAt,
                    advanceAttempt: 0,
                });
                if (!response || !response.ok) {
                    await failClosed('driver_persist_failed');
                    return;
                }
                stageStartedAt = Date.now();
                advanceAttempts = 0;
            }

            if (!awaitingDriverChange) {
                const candidate = safeCandidate(records, driver);
                if (candidate) {
                    await reserveCandidate(candidate, driver, timerDelayMs);
                    return;
                }
            }

            const stageElapsed = Date.now() - stageStartedAt;
            const sinceAdvance = lastAdvanceAt ? Date.now() - lastAdvanceAt : stageElapsed;
            if (stageElapsed < REPLACEMENT_WAIT_MS || sinceAdvance < REPLACEMENT_WAIT_MS) {
                await phaseChanged(awaitingDriverChange ? 'waiting_hydration' : 'waiting_candidate', driver.videoId, {
                    timerDelayMs,
                    hydrationLatencyMs: stageElapsed,
                    advanceAttempt: advanceAttempts,
                });
                return;
            }
            if (advanceAttempts >= MAX_ADVANCE_ATTEMPTS || stageElapsed >= STAGE_TIMEOUT_MS) {
                await failClosed('harvest_stalled', { elapsedMs: stageElapsed });
                return;
            }
            advanceAttempts += 1;
            lastAdvanceAt = Date.now();
            awaitingDriverChange = true;
            await phaseChanged('advancing', driver.videoId, {
                timerDelayMs,
                hydrationLatencyMs: stageElapsed,
                advanceAttempt: advanceAttempts,
            });
            advanceFeed(records, driver);
            await phaseChanged('waiting_hydration', driver.videoId, {
                timerDelayMs,
                hydrationLatencyMs: Date.now() - stageStartedAt,
                advanceAttempt: advanceAttempts,
            });
            await wait(SETTLE_DELAY_MS);
        } finally {
            harvestBusy = false;
            if (mode === 'collecting') {
                scheduleHarvest(RECONCILE_DELAY_MS);
            }
        }
    }

    async function failClosed(reason, detail) {
        if (failurePending || destroyed || mode !== 'collecting' || !session) {
            return;
        }
        failurePending = true;
        stopHarvestTimer();
        session.harvestPhase = 'failed';
        updateOverlay();
        try {
            const response = await queueSequencedMessage(Core.MESSAGE_TYPES.HARVEST_FAIL, {
                sessionId: session.id,
                reason,
                detail: detail || {},
            }, 3);
            if (response && response.ok) {
                mode = 'failed';
                applyProgress(response.progress);
                return;
            }
        } catch (_error) {
            // The covered page remains blocked when persistence is unavailable.
        }
        mode = 'failed';
        updateOverlay();
    }

    function reconcileGuard() {
        if (destroyed || !session || !Core.isFypPath(location.pathname)) {
            return;
        }
        const records = snapshot();
        sweepTombstones(records);
        if (mode === 'collecting') {
            scheduleHarvest(0);
        }
    }

    function processMutationBatch() {
        keepOverlayMounted();
        muteAllMedia();
        reconcileGuard();
    }

    function teardown() {
        if (destroyed) {
            return;
        }
        destroyed = true;
        stopHarvestTimer();
        if (observer) {
            observer.disconnect();
        }
        removeInteractionBlockers();
        if (overlayHost) {
            overlayHost.remove();
            overlayHost = null;
            overlay = null;
        }
        restoreConcealedCards();
        restoreMedia();
        document.documentElement.classList.remove('ttfp-booting');
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    }

    function onRuntimeMessage(message) {
        if (message && message.type === Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR) {
            teardown();
            return;
        }
        if (message && message.type === Core.MESSAGE_TYPES.STATE_UPDATED) {
            if (message.progress) {
                applyProgress(message.progress);
            }
            reconcileGuard();
        }
    }

    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    async function begin(context) {
        if (destroyed || !context || !context.active || !context.session) {
            document.documentElement.classList.remove('ttfp-booting');
            return;
        }
        session = { ...context.session };
        mode = context.mode;
        validUnseenCount = context.session.validUnseenCount || 0;
        nextFeedOrder = context.session.maxFeedOrder || 0;
        batchSequence = context.session.batchCounter || 0;
        stageStartedAt = Date.now();
        (context.session.seenIds || []).forEach((id) => seenIds.add(id));
        (context.session.exposedIds || []).forEach((id) => excludedIds.add(id));
        (context.session.tombstones || []).forEach((id) => tombstones.add(id));
        (context.session.feedOrders || []).forEach((entry) => {
            discoveryOrders.set(entry.videoId, entry.feedOrder);
        });

        observer = new MutationObserver(processMutationBatch);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'id'],
        });
        reconcileGuard();

        if (context.session.boundTab) {
            mountOverlay();
            muteAllMedia();
        }
        document.documentElement.classList.remove('ttfp-booting');

        if (mode === 'failed') {
            updateOverlay();
            return;
        }
        if (mode !== 'collecting') {
            return;
        }
        const ready = await queueSequencedMessage(Core.MESSAGE_TYPES.COLLECTOR_READY, {
            sessionId: session.id,
            visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
            timerDelayMs: 0,
        }, 3).catch(() => null);
        if (!ready || !ready.ok) {
            await failClosed('collector_ready_failed');
            return;
        }
        scheduleHarvest(0);
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
