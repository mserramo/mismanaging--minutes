/* global TikTokPilotCore, TikTokPilotDom */
(function () {
    'use strict';

    if (globalThis.__TIKTOK_FYP_PILOT_COLLECTOR__) {
        return;
    }
    globalThis.__TIKTOK_FYP_PILOT_COLLECTOR__ = true;

    const Core = TikTokPilotCore;
    const Dom = TikTokPilotDom;
    const RECONCILE_DELAY_MS = 200;
    const REPLACEMENT_WAIT_MS = 1000;
    const MIN_ADVANCE_GAP_MS = 300;
    const STAGE_TIMEOUT_MS = 8000;
    const MAX_ADVANCE_ATTEMPTS = 3;
    const MAX_BURST_ITEMS = 12;
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
    let wakeRequested = false;
    let mutationWakeQueued = false;
    let lastDriverId = null;
    let lastReportedPhase = null;
    let overlayHost = null;
    let overlay = null;
    let failurePending = false;
    let contextRequestInFlight = false;
    let collectorReadyReported = false;
    let lastHarvestTelemetry = null;

    const seenIds = new Set();
    const excludedIds = new Set();
    const tombstones = new Set();
    const pendingReservations = new Set();
    const discoveryOrders = new Map();
    const mutedMedia = new Map();
    const concealedElements = new Map();

    // The static fragment is not sent to TikTok. It lets the document-start
    // bootstrap avoid even a brief opaque cover for the separate natural mode.
    const naturalModeHint = location.hash === '#ttfp-natural-session';
    if (!naturalModeHint) {
        document.documentElement.classList.add('ttfp-booting');
    }

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
            .failure-code { color: #b42318; font: 700 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 10px 0 0; }
            .diagnostics { margin: 12px 0 0; text-align: left; }
            .diagnostics summary { color: #475467; cursor: pointer; font-size: 12px; font-weight: 700; text-align: center; }
            .diagnostics pre { background: #f7f8fb; border: 1px solid #e2e6ee; border-radius: 9px; color: #344054; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 8px 0 0; max-height: 150px; overflow: auto; padding: 10px; white-space: pre-wrap; }
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
        const failureCode = createShadowElement('p', 'failure-code');
        failureCode.hidden = true;
        const diagnostics = createShadowElement('details', 'diagnostics');
        diagnostics.hidden = true;
        const diagnosticsSummary = createShadowElement('summary', null, 'Recent diagnostic log');
        const diagnosticsLog = createShadowElement('pre');
        diagnostics.append(diagnosticsSummary, diagnosticsLog);
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
        const continueToQualtrics = createShadowElement(
            'button',
            null,
            'Continue to Qualtrics (testing)'
        );
        continueToQualtrics.type = 'button';
        continueToQualtrics.hidden = true;
        continueToQualtrics.addEventListener('click', (event) => {
            if (!event.isTrusted || mode !== 'failed') {
                return;
            }
            continueToQualtrics.disabled = true;
            continueToQualtrics.textContent = 'Returning to Qualtrics…';
            runtimeMessage({
                type: Core.MESSAGE_TYPES.CONTINUE_TO_QUALTRICS,
                sessionId: session.id,
            }).then((response) => {
                if (response && response.ok) {
                    return;
                }
                continueToQualtrics.disabled = false;
                continueToQualtrics.textContent = 'Continue to Qualtrics (testing)';
                status.textContent = `Could not return to Qualtrics: ${
                    response && response.error ? response.error : 'unknown_error'
                }.`;
            }).catch(() => {
                continueToQualtrics.disabled = false;
                continueToQualtrics.textContent = 'Continue to Qualtrics (testing)';
                status.textContent = 'Could not contact the extension to return to Qualtrics.';
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
        actions.append(retry, continueToQualtrics, stop);
        panel.append(
            eyebrow,
            title,
            progress,
            status,
            failureCode,
            diagnostics,
            track,
            actions
        );
        screen.appendChild(panel);
        shadow.append(style, screen);
        document.documentElement.appendChild(host);
        overlayHost = host;
        overlay = {
            title,
            progress,
            status,
            failureCode,
            diagnostics,
            diagnosticsLog,
            fill,
            retry,
            continueToQualtrics,
            stop,
        };
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
            waiting_candidate: 'Checking the current covered recommendation…',
            reserving: 'Saving the covered recommendation locally…',
            settling: 'Waiting for the feed to replenish…',
            advancing: 'Advancing the covered feed…',
            waiting_hydration: 'Waiting for TikTok to hydrate another recommendation…',
            waiting_deadline: 'TikTok paused new recommendations. Keeping the confirmed pool until the collection window ends…',
            complete: 'Collection complete. Opening the viewer…',
        };
        return labels[phase] || 'Collecting personalized recommendations…';
    }

    function failureExplanation(reason) {
        const explanations = {
            harvest_empty: 'TikTok did not yield a safely confirmed video before the collection window ended.',
            login_or_fyp_absent: 'No unique current FYP video was detected before the stage timed out.',
            unsupported_page_state: 'The covered TikTok tab was no longer on a supported For You page.',
            harvest_stalled: 'TikTok did not hydrate a replacement card after three advancement attempts.',
            reservation_persist_failed: 'The video ID could not be safely persisted before concealment.',
            reservation_confirm_failed: 'The concealed video could not be confirmed in extension storage.',
            concealment_failed: 'The identified TikTok card changed before it could be concealed.',
            collector_ready_failed: 'The collector could not establish its return-to-experiment handshake.',
            local_storage_error: 'The extension could not persist its collection state.',
            collector_exception: 'The collector encountered an unexpected internal error.',
        };
        return explanations[reason] || 'Collection stopped before a usable video pool was created.';
    }

    function formatFailureDiagnostics() {
        const lines = [];
        const recentSteps = session.recentHarvestSteps || [];
        const telemetry = lastHarvestTelemetry || recentSteps[recentSteps.length - 1];
        if (telemetry) {
            lines.push(`last phase: ${telemetry.phase || 'unknown'}`);
            lines.push(`tab visibility: ${telemetry.visibility || 'unknown'}`);
            lines.push(`timer delay: ${Number(telemetry.timerDelayMs) || 0}ms`);
            lines.push(`hydration latency: ${Number(telemetry.hydrationLatencyMs) || 0}ms`);
            lines.push(`advance attempt: ${Number(telemetry.advanceAttempt) || 0}`);
        }
        if (session.failureDetail && Object.keys(session.failureDetail).length) {
            lines.push(`failure detail: ${JSON.stringify(session.failureDetail)}`);
        }
        (session.recentDiagnostics || []).slice(-3).forEach((entry) => {
            lines.push(`diagnostic: ${entry.code}${
                entry.detail && Object.keys(entry.detail).length
                    ? ` ${JSON.stringify(entry.detail)}`
                    : ''
            }`);
        });
        return lines.length ? lines.join('\n') : 'No additional diagnostic fields were recorded.';
    }

    function updateOverlay() {
        if (!overlay || !session) {
            return;
        }
        const durationMs = session.lockedSettings.harvestDurationSeconds * 1000;
        const elapsedMs = session.harvestStartedAt
            ? Math.max(0, Date.now() - session.harvestStartedAt)
            : 0;
        const fraction = durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 0;
        const remaining = session.harvestDeadlineAt
            ? Math.max(0, Math.ceil((session.harvestDeadlineAt - Date.now()) / 1000))
            : 0;
        overlay.progress.textContent = `${validUnseenCount} videos sourced · ${remaining}s remaining`;
        overlay.fill.style.width = `${fraction * 100}%`;
        if (mode === 'failed') {
            const reason = session.stopReason || 'unknown_failure';
            overlay.title.textContent = 'Collection could not finish';
            overlay.status.textContent = failureExplanation(reason);
            overlay.failureCode.textContent = `Failure code: ${reason}`;
            overlay.failureCode.hidden = false;
            overlay.diagnosticsLog.textContent = formatFailureDiagnostics();
            overlay.diagnostics.hidden = false;
            overlay.retry.hidden = false;
            overlay.continueToQualtrics.hidden =
                session.deliveryTarget !== Core.DELIVERY_TARGET.QUALTRICS;
            overlay.stop.textContent = 'Stop and uncover TikTok';
            overlay.stop.hidden = false;
            return;
        }
        overlay.failureCode.hidden = true;
        overlay.diagnostics.hidden = true;
        overlay.continueToQualtrics.hidden = true;
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
        if (session && session.boundTab && overlayHost && overlayHost.isConnected) {
            record.element.classList.add('ttfp-reserved-slot');
        }
        record.element.setAttribute('aria-hidden', 'true');
        return true;
    }

    function restoreConcealedCards() {
        concealedElements.forEach((priorState, element) => {
            element.classList.remove(RESERVED_CARD_CLASS, 'ttfp-reserved-slot');
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

    function phaseChanged(phase, driverVideoId, detail) {
        const telemetry = {
            phase,
            driverVideoId: driverVideoId || null,
            retainDriver: Boolean(detail && detail.retainDriver),
            feedOrder: driverVideoId ? ensureVideoFeedOrder(driverVideoId) : null,
            visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
            timerDelayMs: detail && detail.timerDelayMs || 0,
            hydrationLatencyMs: detail && detail.hydrationLatencyMs || 0,
            advanceAttempt: detail && detail.advanceAttempt || 0,
        };
        lastHarvestTelemetry = telemetry;
        const signature = `${phase}:${driverVideoId || ''}:${detail && detail.advanceAttempt || 0}`;
        if (signature === lastReportedPhase) {
            return Promise.resolve({ ok: true, duplicate: true });
        }
        lastReportedPhase = signature;
        session.harvestPhase = phase;
        updateOverlay();
        return queueSequencedMessage(Core.MESSAGE_TYPES.HARVEST_STEP, {
            sessionId: session.id,
            ...telemetry,
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
        if (progress.stopReason) {
            session.stopReason = progress.stopReason;
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

    async function reportCollectorReady(timerDelayMs) {
        if (collectorReadyReported) {
            return { ok: true, duplicate: true };
        }
        const ready = await queueSequencedMessage(Core.MESSAGE_TYPES.COLLECTOR_READY, {
            sessionId: session.id,
            visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
            timerDelayMs: Math.max(0, Number(timerDelayMs) || 0),
        }, 3).catch(() => null);
        if (ready && ready.ok) {
            collectorReadyReported = true;
        }
        return ready;
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

    function advanceFeed(position) {
        const scroller = findScrollableAncestor(position.current);
        const before = scroller.scrollTop;
        const currentRect = position.current.getBoundingClientRect();
        const scrollerTop = scroller === document.scrollingElement
            ? 0
            : scroller.getBoundingClientRect().top;
        const top = position.next
            ? before + position.next.getBoundingClientRect().top - scrollerTop
            : before + Math.max(currentRect.height, scroller.clientHeight, 320);
        // "auto" inherits TikTok's CSS scroll-behavior:smooth. In a hidden tab
        // that animation may not finish; explicit instant scroll is synchronous.
        scroller.scrollTo({ top, behavior: 'instant' });
        const moved = Math.abs(scroller.scrollTop - before) > 2;
        if (moved) {
            // Native scroll-event delivery can wait for a hidden rendering
            // opportunity. Notify the feed's existing scroll listeners now.
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        recordDiagnostic('automated_advance', {
            elapsedMs: Date.now() - session.startedAt,
            reasonCode: moved ? 'instant_scroll' : 'scroll_no_movement',
            count: validUnseenCount,
        });
        return moved;
    }

    function recheckCoveredDriver(videoId) {
        const records = snapshot();
        sweepTombstones(records);
        const matches = records.filter((record) => record.videoId === videoId);
        if (matches.length !== 1 || !matches[0].element.isConnected) {
            return null;
        }
        const record = matches[0];
        const rect = record.element.getBoundingClientRect();
        const visible = Dom.bestVideoForRecord(record, innerWidth, innerHeight);
        const overlayRect = overlayHost && overlayHost.getBoundingClientRect();
        const overlayOpaque = Boolean(overlayHost && overlayHost.isConnected && overlay &&
            overlayRect.left <= 0 && overlayRect.top <= 0 &&
            overlayRect.right >= innerWidth && overlayRect.bottom >= innerHeight);
        const mediaMuted = record.videos.length > 0 &&
            record.videos.every((media) => media.muted === true);
        if (!overlayOpaque || !mediaMuted) {
            return null;
        }
        return {
            record,
            evidence: {
                captureMethod: 'covered_feed_item',
                feedOrder: ensureFeedOrder(record),
                aheadBy: 0,
                intersectionRatio: visible ? visible.ratio : 0,
                belowViewport: Dom.isBelowViewport(rect, innerHeight),
                everIntersected: Dom.rectOverlapsViewport(rect, innerWidth, innerHeight),
                connected: true,
                occurrenceCount: matches.length,
                overlayOpaque: true,
                mediaMuted: true,
            },
        };
    }

    async function reserveCoveredDriver(driver, timerDelayMs) {
        if (destroyed || mode !== 'collecting' || Date.now() >= session.harvestDeadlineAt) {
            return;
        }
        muteAllMedia();
        const checked = recheckCoveredDriver(driver.videoId);
        if (!checked) {
            recordDiagnostic('covered_driver_failed_recheck', {
                reasonCode: 'overlay_media_or_identity_changed',
            });
            // Never repeatedly retry an unchanged unsafe candidate from a
            // microtask wakeup: that would starve Stop and deadline handling.
            excludedIds.add(driver.videoId);
            return;
        }
        const videoId = driver.videoId;
        batchSequence += 1;
        pendingReservations.add(videoId);
        session.harvestPhase = 'reserving';
        updateOverlay();
        const prepared = await queueSequencedMessage(Core.MESSAGE_TYPES.RESERVE_VIDEO, {
            sessionId: session.id,
            videoId,
            batchId: `covered-${batchSequence}`,
            batchNumber: batchSequence,
            evidence: checked.evidence,
        }, 3);
        if (!prepared || !prepared.ok) {
            pendingReservations.delete(videoId);
            await failClosed('reservation_persist_failed');
            return;
        }
        applyProgress(prepared.progress);

        // Persist first, then recheck the opaque overlay, muted media, exact ID,
        // and unique structural card before concealing it without resizing it.
        if (destroyed || mode !== 'collecting') {
            pendingReservations.delete(videoId);
            return;
        }
        muteAllMedia();
        const persistedCheck = recheckCoveredDriver(videoId);
        if (!persistedCheck) {
            pendingReservations.delete(videoId);
            excludedIds.add(videoId);
            const invalidated = await queueSequencedMessage(
                Core.MESSAGE_TYPES.INVALIDATE_VIDEO,
                {
                    sessionId: session.id,
                    videoId,
                    reason: 'covered_state_changed_after_persist',
                },
                3
            );
            applyProgress(invalidated && invalidated.progress);
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
        if (mode === 'collecting' && !collectorReadyReported) {
            const ready = await reportCollectorReady(timerDelayMs);
            if (!ready || !ready.ok) {
                await failClosed('collector_ready_failed');
                return;
            }
        }
        stageStartedAt = Date.now();
        advanceAttempts = 0;
    }

    function eligibleCoveredRecords(records) {
        return records.filter((record) =>
            record.videoId && record.occurrenceCount === 1 && !record.ambiguous &&
            record.element.isConnected && !tombstones.has(record.videoId) &&
            !excludedIds.has(record.videoId) && !seenIds.has(record.videoId) &&
            !pendingReservations.has(record.videoId)
        );
    }

    async function harvestTick(timerDelayMs) {
        if (harvestBusy) {
            wakeRequested = true;
            return;
        }
        if (destroyed || mode !== 'collecting' || !session) {
            return;
        }
        harvestBusy = true;
        try {
            keepOverlayMounted();
            muteAllMedia();
            updateOverlay();
            let now = Date.now();
            if (now >= session.harvestDeadlineAt) {
                const response = await phaseChanged('complete', lastDriverId, {
                    timerDelayMs,
                    hydrationLatencyMs: now - stageStartedAt,
                    advanceAttempt: advanceAttempts,
                    retainDriver: true,
                });
                applyProgress(response && response.progress);
                return;
            }
            if (!Core.isFypPath(location.pathname)) {
                if (now - stageStartedAt >= STAGE_TIMEOUT_MS) {
                    await failClosed('unsupported_page_state', { pathCode: 'not_foryou' });
                }
                return;
            }

            let records = snapshot();
            excludeAmbiguousRecords(records);
            sweepTombstones(records);
            const candidates = eligibleCoveredRecords(records).slice(0, MAX_BURST_ITEMS);
            const captureStartedAt = Date.now();
            for (const candidate of candidates) {
                if (destroyed || mode !== 'collecting' || Date.now() >= session.harvestDeadlineAt) {
                    return;
                }
                // All hydrated IDs are usable under the opaque, muted cover.
                // They do not need to play or occupy the viewport first.
                await reserveCoveredDriver(candidate, timerDelayMs);
                lastDriverId = candidate.videoId;
            }
            if (candidates.length) {
                recordDiagnostic('capture_batch', {
                    count: candidates.length,
                    elapsedMs: Date.now() - captureStartedAt,
                    reasonCode: document.hidden ? 'hidden' : 'visible',
                });
            }
            if (destroyed || mode !== 'collecting') {
                return;
            }
            now = Date.now();
            if (now >= session.harvestDeadlineAt) {
                wakeRequested = true;
                return;
            }
            records = snapshot();
            sweepTombstones(records);
            if (eligibleCoveredRecords(records).length) {
                wakeRequested = true;
                return;
            }
            const position = Dom.coveredFeedPosition(document, records, innerWidth, innerHeight);
            const currentIdentified = position.current && records.some((record) =>
                record.videoId && (record.element === position.current ||
                    position.current.contains(record.element))
            );
            const elapsed = now - stageStartedAt;
            const sinceAdvance = lastAdvanceAt ? now - lastAdvanceAt : Infinity;
            // Wait for the slot just entered to hydrate. Do not rush through
            // unidentified placeholders, which would lose recommendations.
            if (!currentIdentified) {
                await phaseChanged(validUnseenCount ? 'waiting_hydration' : 'waiting_driver', lastDriverId, {
                    timerDelayMs, hydrationLatencyMs: elapsed, advanceAttempt: advanceAttempts,
                    retainDriver: true,
                });
                if (!validUnseenCount && elapsed >= STAGE_TIMEOUT_MS) {
                    await failClosed('login_or_fyp_absent', { elapsedMs: elapsed });
                }
                return;
            }
            // A newly captured replacement proves hydration completed. It can
            // advance immediately; the gap applies only to timer-based retries.
            if (sinceAdvance < MIN_ADVANCE_GAP_MS && !candidates.length) {
                return;
            }
            if (advanceAttempts >= MAX_ADVANCE_ATTEMPTS || elapsed >= STAGE_TIMEOUT_MS) {
                await phaseChanged('waiting_deadline', lastDriverId, {
                    timerDelayMs, hydrationLatencyMs: elapsed, advanceAttempt: advanceAttempts,
                    retainDriver: true,
                });
                return;
            }
            if (advanceAttempts > 0 && sinceAdvance < REPLACEMENT_WAIT_MS && !candidates.length) {
                return;
            }
            advanceAttempts += 1;
            lastAdvanceAt = now;
            await phaseChanged('advancing', lastDriverId, {
                timerDelayMs, hydrationLatencyMs: elapsed, advanceAttempt: advanceAttempts,
                retainDriver: true,
            });
            if (destroyed || mode !== 'collecting' || Date.now() >= session.harvestDeadlineAt) {
                return;
            }
            advanceFeed(position);
            await phaseChanged('waiting_hydration', lastDriverId, {
                timerDelayMs, hydrationLatencyMs: Date.now() - stageStartedAt,
                advanceAttempt: advanceAttempts, retainDriver: true,
            });
        } finally {
            harvestBusy = false;
            if (mode === 'collecting' && !destroyed) {
                if (wakeRequested) {
                    wakeRequested = false;
                    wakeHarvest();
                } else {
                    scheduleHarvest(RECONCILE_DELAY_MS);
                }
            }
        }
    }

    function wakeHarvest() {
        if (destroyed || mode !== 'collecting') {
            return;
        }
        if (harvestBusy) {
            wakeRequested = true;
            return;
        }
        if (mutationWakeQueued) {
            return;
        }
        mutationWakeQueued = true;
        stopHarvestTimer();
        // A DOM hydration event is already a browser task. Do not insert a new
        // hidden-tab timer between that event and reserving the hydrated IDs.
        Promise.resolve().then(() => {
            mutationWakeQueued = false;
            return harvestTick(0);
        }).catch(() => failClosed('collector_exception'));
    }

    async function failClosed(reason, detail) {
        if (failurePending || destroyed || mode !== 'collecting' || !session) {
            return;
        }
        failurePending = true;
        stopHarvestTimer();
        session.harvestPhase = 'failed';
        session.stopReason = reason;
        session.failureDetail = detail && typeof detail === 'object' ? detail : {};
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
            wakeHarvest();
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
        document.documentElement.classList.remove('ttfp-booting', 'ttfp-covered-harvesting');
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
        if (context.session.collectionMode === Core.COLLECTION_MODE.NATURAL_FYP_SESSION) {
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
        const restoredSteps = context.session.recentHarvestSteps || [];
        lastHarvestTelemetry = restoredSteps[restoredSteps.length - 1] || null;

        if (context.session.boundTab) {
            document.documentElement.classList.add('ttfp-covered-harvesting');
        }
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
        if (validUnseenCount > 0) {
            const ready = await reportCollectorReady(0);
            if (!ready || !ready.ok) {
                await failClosed('collector_ready_failed');
                return;
            }
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
