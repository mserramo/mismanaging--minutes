/* global TikTokPilotCore, TikTokPilotDom */
(function () {
    'use strict';

    if (globalThis.__TIKTOK_FYP_NATURAL_SESSION__) {
        return;
    }
    globalThis.__TIKTOK_FYP_NATURAL_SESSION__ = true;

    const Core = TikTokPilotCore;
    const Dom = TikTokPilotDom;
    const SAMPLE_INTERVAL_MS = 250;
    const REPORT_INTERVAL_MS = 750;
    const SEEN_THRESHOLD_MS = 500;
    const POINTER_BURST_GAP_MS = 750;
    const BANNER_HOST_ID = 'ttfp-natural-session-host';

    const sourceId = crypto.randomUUID();
    let sourceSequence = 0;
    let outboundQueue = Promise.resolve();
    let session = null;
    let destroyed = false;
    let sampleTimer = null;
    let reportTimer = null;
    let observer = null;
    let bannerHost = null;
    let banner = null;
    let lastSampleAt = Date.now();
    let lastReportAt = Date.now();
    let lastPointerAt = 0;
    let lastDominantVideoId = null;
    let lastPlayingState = null;
    let nextFeedOrder = 0;
    let progress = null;
    let authoritativeTabFocused = false;
    let lastQualificationReason = 'preparing';

    const discoveryOrders = new Map();
    const mediaTimes = new WeakMap();
    const exposures = new Map();
    const pendingSamples = [];
    const pendingMarkers = [];
    const pendingActivity = {
        pointerMoveBursts: 0,
        clicks: 0,
        wheelEvents: 0,
        keyEvents: 0,
    };
    const pendingDurations = { tabAwayMs: 0, windowBlurMs: 0 };
    const pendingCounters = {
        tabAwayCount: 0,
        windowBlurCount: 0,
        videoTransitions: 0,
        pauseCount: 0,
        resumeCount: 0,
    };
    const pendingReasons = {};

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

    function queueSequencedMessage(type, payload) {
        const message = {
            ...payload,
            type,
            sourceId,
            sequence: ++sourceSequence,
        };
        const operation = outboundQueue.then(() => runtimeMessage(message));
        outboundQueue = operation.catch(() => undefined);
        return operation;
    }

    function shadowElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text !== undefined) {
            element.textContent = text;
        }
        return element;
    }

    function mountBanner() {
        if (bannerHost || !session) {
            return;
        }
        const host = document.createElement('div');
        host.id = BANNER_HOST_ID;
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
            :host {
                all: initial;
                color-scheme: light;
                display: block;
                position: fixed;
                right: 16px;
                top: 16px;
                width: auto;
                z-index: 2147483647;
            }
            * { box-sizing: border-box; }
            .panel {
                background: rgba(255, 255, 255, .96);
                border: 1px solid #d8deea;
                border-radius: 12px;
                box-shadow: 0 8px 28px rgba(16, 24, 40, .16);
                color: #172033;
                font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                min-width: 250px;
                padding: 12px;
            }
            .top { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
            .label { color: #595ee8; font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
            .time { display: block; font-size: 15px; margin-top: 3px; }
            .status { color: #56627a; margin: 7px 0 0; max-width: 280px; }
            .track { background: #e7eaf2; border-radius: 99px; height: 5px; margin-top: 9px; overflow: hidden; }
            .fill { background: #595ee8; height: 100%; transition: width .2s ease; width: 0; }
            button {
                background: #fff;
                border: 1px solid #c6cede;
                border-radius: 8px;
                color: #172033;
                cursor: pointer;
                font: 700 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                padding: 7px 9px;
            }
            button:disabled { cursor: default; opacity: .55; }
        `;
        const panel = shadowElement('section', 'panel');
        panel.setAttribute('aria-live', 'polite');
        const top = shadowElement('div', 'top');
        const copy = shadowElement('div');
        const label = shadowElement('span', 'label', 'Research session');
        const time = shadowElement('strong', 'time', 'Preparing timer…');
        const stop = shadowElement('button', null, 'Stop');
        stop.type = 'button';
        stop.addEventListener('click', (event) => {
            if (!event.isTrusted || destroyed) {
                return;
            }
            stop.disabled = true;
            stop.textContent = 'Stopping…';
            flushReport().finally(() => {
                runtimeMessage({
                    type: Core.MESSAGE_TYPES.STOP_SESSION,
                    sessionId: session.id,
                }).catch(() => {
                    stop.disabled = false;
                    stop.textContent = 'Stop';
                });
            });
        });
        copy.append(label, time);
        top.append(copy, stop);
        const status = shadowElement('p', 'status', 'Keep this TikTok tab in front and browse normally.');
        const track = shadowElement('div', 'track');
        const fill = shadowElement('div', 'fill');
        track.appendChild(fill);
        panel.append(top, status, track);
        shadow.append(style, panel);
        document.documentElement.appendChild(host);
        bannerHost = host;
        banner = { time, status, fill, stop };
        updateBanner('preparing');
    }

    function updateBanner(reason) {
        if (!banner || !progress) {
            return;
        }
        const requiredMs = Math.max(1, progress.naturalSessionSeconds * 1000);
        const elapsedMs = Math.min(requiredMs, progress.qualifiedMs || 0);
        const remainingSeconds = Math.max(0, Math.ceil((requiredMs - elapsedMs) / 1000));
        banner.time.textContent = `${Math.floor(elapsedMs / 1000)} / ${progress.naturalSessionSeconds}s qualified`;
        banner.fill.style.width = `${Math.min(100, elapsedMs / requiredMs * 100)}%`;
        const messages = {
            counting: `Counting now · about ${remainingSeconds}s remaining`,
            open_fyp: 'Timer paused. Return to the For You feed.',
            tab_hidden: 'Timer paused. Keep this TikTok tab in front.',
            window_unfocused: 'Timer paused. Keep Chrome and this TikTok tab focused.',
            no_active_video: 'Timer paused. Scroll until one video is clearly visible.',
            multiple_active_videos: 'Timer paused while the active video is ambiguous.',
            video_not_visible: 'Timer paused. Bring one video fully into view.',
            video_paused: 'Timer paused while the video is paused.',
            video_buffering: 'Timer paused while the video is loading.',
            preparing: 'Preparing the natural browsing timer…',
        };
        banner.status.textContent = messages[reason] || 'Browse the For You feed normally.';
    }

    function ensureFeedOrder(videoId) {
        if (!discoveryOrders.has(videoId)) {
            nextFeedOrder += 1;
            discoveryOrders.set(videoId, nextFeedOrder);
        }
        return discoveryOrders.get(videoId);
    }

    function dominantVideoSample() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const candidates = [];
        Dom.snapshotFeed(document, location.href).forEach((record) => {
            if (!record.videoId || record.occurrenceCount !== 1) {
                return;
            }
            const best = Dom.bestVideoForRecord(record, width, height);
            if (!best || best.ratio < 0.6) {
                return;
            }
            const previousTime = mediaTimes.get(best.video);
            const currentTime = Number(best.video.currentTime);
            const mediaAdvancing = Number.isFinite(previousTime) &&
                Number.isFinite(currentTime) && currentTime > previousTime + 0.01;
            if (Number.isFinite(currentTime)) {
                mediaTimes.set(best.video, currentTime);
            }
            candidates.push({
                videoId: record.videoId,
                visibleRatio: best.ratio,
                playing: Dom.videoIsPlaying(best.video),
                mediaAdvancing,
                feedOrder: ensureFeedOrder(record.videoId),
            });
        });
        const primary = candidates.length === 1 ? candidates[0] : null;
        return {
            primary,
            evaluation: Core.evaluateQualifiedSample({
                pathname: location.pathname,
                documentVisible: document.visibilityState === 'visible',
                windowFocused: authoritativeTabFocused,
                primaryCount: candidates.length,
                videoId: primary && primary.videoId,
                visibleRatio: primary && primary.visibleRatio,
                playing: Boolean(primary && primary.playing),
                mediaAdvancing: Boolean(primary && primary.mediaAdvancing),
            }),
        };
    }

    function addMarker(type, videoId) {
        const marker = { type, at: Date.now() };
        if (Core.isVideoId(videoId)) {
            marker.videoId = videoId;
        }
        pendingMarkers.push(marker);
    }

    function observeVideoState(primary) {
        const currentId = primary && primary.videoId;
        if (currentId && lastDominantVideoId && currentId !== lastDominantVideoId) {
            pendingCounters.videoTransitions += 1;
            addMarker('video_transition', currentId);
        }
        if (currentId) {
            lastDominantVideoId = currentId;
        }
        const playing = primary ? Boolean(primary.playing) : null;
        if (playing !== null && lastPlayingState !== null && playing !== lastPlayingState) {
            if (playing) {
                pendingCounters.resumeCount += 1;
                addMarker('video_resume', currentId);
            } else {
                pendingCounters.pauseCount += 1;
                addMarker('video_pause', currentId);
            }
        }
        if (playing !== null) {
            lastPlayingState = playing;
        }
    }

    function sample() {
        if (destroyed || !session) {
            return;
        }
        const now = Date.now();
        const deltaMs = Core.clampTickDelta(now - lastSampleAt);
        lastSampleAt = now;
        if (document.visibilityState !== 'visible') {
            pendingDurations.tabAwayMs += deltaMs;
        } else if (!authoritativeTabFocused) {
            pendingDurations.windowBlurMs += deltaMs;
        }
        const snapshot = dominantVideoSample();
        const reason = snapshot.evaluation.reason;
        lastQualificationReason = reason;
        pendingReasons[reason] = (pendingReasons[reason] || 0) + 1;
        observeVideoState(snapshot.primary);
        if (snapshot.evaluation.qualified && deltaMs > 0) {
            const videoId = snapshot.primary.videoId;
            const exposure = exposures.get(videoId) || {
                totalMs: 0,
                reported: false,
                firstSeenAt: now - deltaMs,
            };
            exposure.totalMs += deltaMs;
            let watchDeltaMs = 0;
            if (exposure.reported) {
                watchDeltaMs = deltaMs;
            } else if (exposure.totalMs >= SEEN_THRESHOLD_MS) {
                exposure.reported = true;
                watchDeltaMs = exposure.totalMs;
            }
            exposures.set(videoId, exposure);
            pendingSamples.push({
                videoId,
                qualifiedDeltaMs: deltaMs,
                watchDeltaMs,
                firstSeenAt: exposure.firstSeenAt,
                feedOrder: snapshot.primary.feedOrder,
            });
        }
        updateBanner(reason);
        if (now - lastReportAt >= REPORT_INTERVAL_MS) {
            flushReport();
        }
        sampleTimer = setTimeout(sample, SAMPLE_INTERVAL_MS);
    }

    function drainPending() {
        const payload = {
            samples: pendingSamples.splice(0),
            markers: pendingMarkers.splice(0),
            activity: { ...pendingActivity },
            durationDeltas: { ...pendingDurations },
            counterDeltas: { ...pendingCounters },
            reasonCounts: { ...pendingReasons },
        };
        Object.keys(pendingActivity).forEach((key) => { pendingActivity[key] = 0; });
        Object.keys(pendingDurations).forEach((key) => { pendingDurations[key] = 0; });
        Object.keys(pendingCounters).forEach((key) => { pendingCounters[key] = 0; });
        Object.keys(pendingReasons).forEach((key) => { delete pendingReasons[key]; });
        return payload;
    }

    function flushReport() {
        if (destroyed || !session) {
            return Promise.resolve();
        }
        clearTimeout(reportTimer);
        lastReportAt = Date.now();
        const payload = drainPending();
        const hasContent = payload.samples.length || payload.markers.length ||
            Object.values(payload.activity).some(Boolean) ||
            Object.values(payload.durationDeltas).some(Boolean) ||
            Object.values(payload.counterDeltas).some(Boolean) ||
            Object.values(payload.reasonCounts).some(Boolean);
        if (!hasContent) {
            return Promise.resolve();
        }
        return queueSequencedMessage(Core.MESSAGE_TYPES.NATURAL_ACTIVITY, {
            sessionId: session.id,
            ...payload,
        }).then((response) => {
            if (response && typeof response.tabFocused === 'boolean') {
                authoritativeTabFocused = response.tabFocused;
                if (!authoritativeTabFocused && document.visibilityState === 'visible') {
                    lastQualificationReason = 'window_unfocused';
                }
            }
            if (response && response.progress) {
                progress = response.progress;
                updateBanner(lastQualificationReason);
            }
            if (response && response.completed) {
                teardown();
            }
        }).catch(() => {
            if (banner) {
                banner.status.textContent = 'Saving paused. Keep this tab open while the extension reconnects.';
            }
        });
    }

    function onPointerMove(event) {
        if (!event.isTrusted) {
            return;
        }
        const now = Date.now();
        if (now - lastPointerAt >= POINTER_BURST_GAP_MS) {
            pendingActivity.pointerMoveBursts += 1;
        }
        lastPointerAt = now;
    }

    function onClick(event) {
        if (event.isTrusted) {
            pendingActivity.clicks += 1;
        }
    }

    function onWheel(event) {
        if (event.isTrusted) {
            pendingActivity.wheelEvents += 1;
        }
    }

    function onKeydown(event) {
        if (event.isTrusted) {
            // Count only. Never inspect or persist the key or code properties.
            pendingActivity.keyEvents += 1;
        }
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            authoritativeTabFocused = false;
            lastQualificationReason = 'tab_hidden';
            pendingCounters.tabAwayCount += 1;
            addMarker('tab_away');
        } else {
            addMarker('tab_return');
        }
        flushReport();
    }

    function onWindowBlur() {
        authoritativeTabFocused = false;
        lastQualificationReason = 'window_unfocused';
        pendingCounters.windowBlurCount += 1;
        addMarker('window_blur');
        updateBanner(lastQualificationReason);
        flushReport();
    }

    function onWindowFocus() {
        addMarker('window_focus');
        flushReport();
    }

    function teardown() {
        if (destroyed) {
            return;
        }
        destroyed = true;
        clearTimeout(sampleTimer);
        clearTimeout(reportTimer);
        if (observer) {
            observer.disconnect();
        }
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('wheel', onWheel, true);
        window.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('focus', onWindowFocus);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        if (bannerHost) {
            bannerHost.remove();
            bannerHost = null;
            banner = null;
        }
    }

    function onRuntimeMessage(message) {
        if (message && message.type === Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR) {
            teardown();
            return;
        }
        if (message && message.type === Core.MESSAGE_TYPES.STATE_UPDATED && message.progress) {
            progress = message.progress;
            updateBanner(lastQualificationReason);
        }
    }

    async function begin(context) {
        if (
            destroyed ||
            !context ||
            !context.active ||
            !context.session ||
            context.mode !== 'collecting' ||
            context.session.collectionMode !== Core.COLLECTION_MODE.NATURAL_FYP_SESSION ||
            context.session.boundTab !== true
        ) {
            return;
        }
        session = { ...context.session };
        progress = {
            naturalSessionSeconds: session.lockedSettings.naturalSessionSeconds,
            qualifiedMs: session.qualifiedMs || 0,
        };
        nextFeedOrder = session.maxFeedOrder || 0;
        (session.feedOrders || []).forEach((entry) => {
            discoveryOrders.set(entry.videoId, entry.feedOrder);
        });
        mountBanner();
        observer = new MutationObserver(() => {
            if (!destroyed && bannerHost && !bannerHost.isConnected) {
                document.documentElement.appendChild(bannerHost);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('click', onClick, true);
        window.addEventListener('wheel', onWheel, { capture: true, passive: true });
        window.addEventListener('keydown', onKeydown, true);
        window.addEventListener('blur', onWindowBlur);
        window.addEventListener('focus', onWindowFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);
        const ready = await queueSequencedMessage(Core.MESSAGE_TYPES.NATURAL_COLLECTOR_READY, {
            sessionId: session.id,
        }).catch(() => null);
        if (!ready || !ready.ok) {
            if (banner) {
                banner.status.textContent = 'The extension could not bind this TikTok tab. Return to Qualtrics and retry.';
            }
            return;
        }
        if (typeof ready.tabFocused === 'boolean') {
            authoritativeTabFocused = ready.tabFocused;
            lastQualificationReason = authoritativeTabFocused
                ? 'no_active_video'
                : 'window_unfocused';
            updateBanner(lastQualificationReason);
        }
        lastSampleAt = Date.now();
        sampleTimer = setTimeout(sample, SAMPLE_INTERVAL_MS);
    }

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    runtimeMessage({ type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT })
        .then(begin)
        .catch(() => undefined);
})();
