(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.TikTokPilotCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SCHEMA_VERSION = 1;
    const TIKTOK_ORIGIN = 'https://www.tiktok.com';
    const TIKTOK_FYP_URL = `${TIKTOK_ORIGIN}/foryou`;
    const CONTENT_SCRIPT_ID = 'tiktok-fyp-pilot-collector';
    const MIN_SAFE_AHEAD = 1;

    const DEFAULT_SETTINGS = Object.freeze({
        durationSeconds: 60,
        targetUnseenCount: 5,
    });

    const SETTING_LIMITS = Object.freeze({
        durationSeconds: Object.freeze({ min: 1, max: 3600 }),
        targetUnseenCount: Object.freeze({ min: 1, max: 50 }),
    });

    const MESSAGE_TYPES = Object.freeze({
        GET_STATE: 'GET_STATE',
        GET_CONTENT_CONTEXT: 'GET_CONTENT_CONTEXT',
        SAVE_SETTINGS: 'SAVE_SETTINGS',
        START_SESSION: 'START_SESSION',
        RESUME_SESSION: 'RESUME_SESSION',
        STOP_SESSION: 'STOP_SESSION',
        ACTIVITY_TICK: 'ACTIVITY_TICK',
        MARK_EXPOSED: 'MARK_EXPOSED',
        EXCLUDE_VIDEO: 'EXCLUDE_VIDEO',
        RESERVE_VIDEO: 'RESERVE_VIDEO',
        INVALIDATE_VIDEO: 'INVALIDATE_VIDEO',
        RECORD_DIAGNOSTIC: 'RECORD_DIAGNOSTIC',
        GET_VIEWER_SESSION: 'GET_VIEWER_SESSION',
        OPEN_VIEWER: 'OPEN_VIEWER',
        VIEWER_EVENT: 'VIEWER_EVENT',
        VIEWER_FINISH: 'VIEWER_FINISH',
        CLEAR_DATA: 'CLEAR_DATA',
        REVOKE_ACCESS: 'REVOKE_ACCESS',
        SHUTDOWN_COLLECTOR: 'SHUTDOWN_COLLECTOR',
        STATE_UPDATED: 'STATE_UPDATED',
    });

    const SESSION_STATUS = Object.freeze({
        COLLECTING: 'collecting',
        COMPLETE: 'complete',
        VIEWING: 'viewing',
        VIEWED: 'viewed',
        STOPPED: 'stopped',
    });

    const PLAYER_MESSAGE_TYPES = new Set([
        'onPlayerReady',
        'onStateChange',
        'onCurrentTime',
        'onPlayerError',
        'onError',
    ]);

    const VIEWER_EVENT_TYPES = new Set([
        'ready',
        'iframe_loaded',
        'init',
        'playing',
        'paused',
        'buffering',
        'ended',
        'current_time',
        'player_error',
        'ready_timeout',
        'playback_timeout',
        'play_command',
    ]);

    const EXCLUSION_CLASSIFICATIONS = new Set([
        'ever_exposed',
        'ambiguous_card',
    ]);

    function toBoundedInteger(value, minimum, maximum, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return fallback;
        }
        return Math.min(maximum, Math.max(minimum, Math.round(number)));
    }

    function sanitizeSettings(value) {
        const input = value && typeof value === 'object' ? value : {};
        return {
            durationSeconds: toBoundedInteger(
                input.durationSeconds,
                SETTING_LIMITS.durationSeconds.min,
                SETTING_LIMITS.durationSeconds.max,
                DEFAULT_SETTINGS.durationSeconds
            ),
            targetUnseenCount: toBoundedInteger(
                input.targetUnseenCount,
                SETTING_LIMITS.targetUnseenCount.min,
                SETTING_LIMITS.targetUnseenCount.max,
                DEFAULT_SETTINGS.targetUnseenCount
            ),
        };
    }

    function createDefaultState() {
        return {
            schemaVersion: SCHEMA_VERSION,
            settings: { ...DEFAULT_SETTINGS },
            activeSessionId: null,
            sessions: [],
        };
    }

    function persistedNumber(value, minimum, maximum, fallback) {
        return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
            ? value
            : fallback;
    }

    function normalizePersistedSession(raw) {
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const id = sanitizeToken(raw.id, null);
        if (!id || !Object.values(SESSION_STATUS).includes(raw.status)) {
            return null;
        }
        const startedAt = persistedNumber(raw.startedAt, 0, 1e15, null);
        if (startedAt === null) {
            return null;
        }

        const seen = [];
        const seenIds = new Set();
        for (const record of Array.isArray(raw.seen) ? raw.seen : []) {
            if (!record || !isVideoId(record.videoId) || seenIds.has(record.videoId)) {
                return null;
            }
            seenIds.add(record.videoId);
            seen.push({
                videoId: record.videoId,
                firstSeenAt: persistedNumber(record.firstSeenAt, 0, 1e15, startedAt),
                lastSeenAt: persistedNumber(record.lastSeenAt, 0, 1e15, startedAt),
                activeWatchMs: persistedNumber(record.activeWatchMs, 0, 86400000, 0),
                order: toBoundedInteger(record.order, 1, 1000000, seen.length + 1),
                feedOrder: Number.isInteger(record.feedOrder) && record.feedOrder >= 1
                    ? record.feedOrder
                    : null,
            });
        }

        const excluded = [];
        const excludedIds = new Set();
        for (const record of Array.isArray(raw.excluded) ? raw.excluded : []) {
            if (
                !record ||
                !isVideoId(record.videoId) ||
                seenIds.has(record.videoId) ||
                excludedIds.has(record.videoId)
            ) {
                return null;
            }
            if (!EXCLUSION_CLASSIFICATIONS.has(record.classification)) {
                return null;
            }
            excludedIds.add(record.videoId);
            excluded.push({
                videoId: record.videoId,
                classification: record.classification,
                classifiedAt: persistedNumber(
                    record.classifiedAt,
                    0,
                    1e15,
                    persistedNumber(record.firstExposedAt, 0, 1e15, startedAt)
                ),
                feedOrder: Number.isInteger(record.feedOrder) && record.feedOrder >= 1
                    ? record.feedOrder
                    : null,
            });
        }

        const reserved = [];
        const reservedIds = new Set();
        const viewerStatuses = new Set([
            'pending',
            'ready',
            'play_requested',
            'playing',
            'ended',
            'unavailable',
        ]);
        for (const record of Array.isArray(raw.reserved) ? raw.reserved : []) {
            if (
                !record ||
                !isVideoId(record.videoId) ||
                seenIds.has(record.videoId) ||
                excludedIds.has(record.videoId) ||
                reservedIds.has(record.videoId) ||
                !['reserved', 'invalidated'].includes(record.state)
            ) {
                return null;
            }
            reservedIds.add(record.videoId);
            const clean = {
                videoId: record.videoId,
                state: record.state,
                order: toBoundedInteger(record.order, 1, 1000000, reserved.length + 1),
                batchId: sanitizeToken(record.batchId, `batch-${reserved.length + 1}`),
                interceptedAt: persistedNumber(record.interceptedAt, 0, 1e15, startedAt),
                feedOrder: toBoundedInteger(record.feedOrder, 1, 1000000, reserved.length + 1),
                aheadBy: toBoundedInteger(
                    record.aheadBy,
                    MIN_SAFE_AHEAD,
                    1000000,
                    MIN_SAFE_AHEAD
                ),
                intersectionRatio: 0,
                belowViewport: true,
                everIntersected: false,
                viewerStatus: viewerStatuses.has(record.viewerStatus)
                    ? record.viewerStatus
                    : 'pending',
            };
            if (record.state === 'invalidated') {
                clean.invalidatedAt = persistedNumber(record.invalidatedAt, 0, 1e15, startedAt);
                clean.invalidReason = sanitizeToken(record.invalidReason, 'ambiguous_exposure');
            }
            if (clean.viewerStatus === 'ended') {
                clean.viewerEndedAt = persistedNumber(record.viewerEndedAt, 0, 1e15, startedAt);
                clean.viewerTerminalType = 'ended';
            }
            if (clean.viewerStatus === 'unavailable') {
                clean.viewerErrorAt = persistedNumber(record.viewerErrorAt, 0, 1e15, startedAt);
                clean.viewerTerminalType = sanitizeToken(
                    record.viewerTerminalType,
                    'player_error'
                );
            }
            reserved.push(clean);
        }

        const diagnostics = (Array.isArray(raw.diagnostics) ? raw.diagnostics : [])
            .slice(-200)
            .map((record) => ({
                code: sanitizeToken(record && record.code, null),
                at: persistedNumber(record && record.at, 0, 1e15, startedAt),
                detail: safeDiagnosticDetail(record && record.detail),
            }))
            .filter((record) => record.code);

        const viewerEvents = [];
        for (const event of (Array.isArray(raw.viewerEvents) ? raw.viewerEvents : []).slice(-1000)) {
            if (
                !event ||
                !reservedIds.has(event.videoId) ||
                !VIEWER_EVENT_TYPES.has(event.type)
            ) {
                continue;
            }
            const clean = {
                videoId: event.videoId,
                type: event.type,
                at: persistedNumber(event.at, 0, 1e15, startedAt),
            };
            const value = sanitizeViewerValue(event.type, event.value);
            if (value !== null) {
                clean.value = value;
            }
            viewerEvents.push(clean);
        }

        const sourceSequences = {};
        Object.entries(raw.sourceSequences && typeof raw.sourceSequences === 'object'
            ? raw.sourceSequences
            : {})
            .slice(-12)
            .forEach(([sourceId, sequence]) => {
                const safeSource = sanitizeToken(sourceId, null);
                if (safeSource && Number.isInteger(sequence) && sequence >= 1) {
                    sourceSequences[safeSource] = sequence;
                }
            });

        const session = {
            id,
            seed: sanitizeSeed(raw.seed),
            startedAt,
            updatedAt: persistedNumber(raw.updatedAt, 0, 1e15, startedAt),
            completedAt: persistedNumber(raw.completedAt, 0, 1e15, null),
            stoppedAt: persistedNumber(raw.stoppedAt, 0, 1e15, null),
            viewerStartedAt: persistedNumber(raw.viewerStartedAt, 0, 1e15, null),
            viewerFinishedAt: persistedNumber(raw.viewerFinishedAt, 0, 1e15, null),
            viewerTabOpenedAt:
                raw.viewerTabOpenedAt === -1 || raw.viewerTabOpenedAt === 0
                    ? raw.viewerTabOpenedAt
                    : persistedNumber(raw.viewerTabOpenedAt, 0, 1e15, null),
            status: raw.status,
            targetTabId: Number.isInteger(raw.targetTabId) ? raw.targetTabId : null,
            lockedSettings: sanitizeSettings(raw.lockedSettings),
            qualifiedMs: persistedNumber(raw.qualifiedMs, 0, 86400000, 0),
            batchCounter: toBoundedInteger(raw.batchCounter, 0, 1000000, 0),
            seen,
            excluded,
            reserved,
            invalidated: reserved
                .filter((record) => record.state === 'invalidated')
                .map((record) => ({
                    videoId: record.videoId,
                    at: record.invalidatedAt,
                    reason: record.invalidReason,
                })),
            tombstones: reserved.map((record) => record.videoId),
            diagnostics,
            viewerEvents,
            sourceSequences,
        };
        if (Number.isInteger(raw.viewerTabId)) {
            session.viewerTabId = raw.viewerTabId;
        }
        const stopReason = sanitizeToken(raw.stopReason, null);
        if (stopReason) {
            session.stopReason = stopReason;
        }
        if ([SESSION_STATUS.COMPLETE, SESSION_STATUS.VIEWING, SESSION_STATUS.VIEWED].includes(session.status)) {
            const progress = sessionProgress(session);
            if (!progress.timeComplete || !progress.unseenComplete) {
                return null;
            }
        }
        return session;
    }

    function normalizeState(raw) {
        if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION) {
            return createDefaultState();
        }
        const sessions = [];
        for (const rawSession of Array.isArray(raw.sessions) ? raw.sessions : []) {
            const session = normalizePersistedSession(rawSession);
            if (!session || sessions.some((existing) => existing.id === session.id)) {
                return createDefaultState();
            }
            sessions.push(session);
        }
        const state = {
            schemaVersion: SCHEMA_VERSION,
            settings: sanitizeSettings(raw.settings),
            activeSessionId:
                typeof raw.activeSessionId === 'string' ? raw.activeSessionId : null,
            sessions,
        };
        if (!state.sessions.some((session) => session.id === state.activeSessionId)) {
            state.activeSessionId = null;
        }
        return state;
    }

    function isVideoId(value) {
        return typeof value === 'string' && /^[1-9][0-9]{14,24}$/.test(value);
    }

    function parseTikTokVideoId(href, baseUrl) {
        if (typeof href !== 'string' || href.length > 2048) {
            return null;
        }
        let url;
        try {
            url = new URL(href, baseUrl || TIKTOK_ORIGIN);
        } catch (_error) {
            return null;
        }
        if (url.protocol !== 'https:') {
            return null;
        }
        const host = url.hostname.toLowerCase();
        if (host !== 'www.tiktok.com' && host !== 'tiktok.com') {
            return null;
        }
        const match = url.pathname.match(/^\/@[^/]+\/video\/([1-9][0-9]{14,24})\/?$/);
        return match && isVideoId(match[1]) ? match[1] : null;
    }

    function sanitizeToken(value, fallback) {
        return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(value)
            ? value
            : fallback;
    }

    function sanitizeTimestamp(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
    }

    function sanitizeSeed(value) {
        const number = Number(value);
        return Number.isInteger(number) ? number >>> 0 : 1;
    }

    function createSession(settings, metadata) {
        const now = sanitizeTimestamp(metadata && metadata.startedAt, Date.now());
        return {
            id: sanitizeToken(metadata && metadata.id, `session-${now}`),
            seed: sanitizeSeed(metadata && metadata.seed),
            startedAt: now,
            updatedAt: now,
            completedAt: null,
            stoppedAt: null,
            viewerStartedAt: null,
            viewerFinishedAt: null,
            viewerTabOpenedAt: null,
            status: SESSION_STATUS.COLLECTING,
            targetTabId: Number.isInteger(metadata && metadata.targetTabId)
                ? metadata.targetTabId
                : null,
            lockedSettings: sanitizeSettings(settings),
            qualifiedMs: 0,
            batchCounter: 0,
            seen: [],
            excluded: [],
            reserved: [],
            invalidated: [],
            tombstones: [],
            diagnostics: [],
            viewerEvents: [],
            sourceSequences: {},
        };
    }

    function getSession(state, sessionId) {
        if (!state || !Array.isArray(state.sessions)) {
            return null;
        }
        return state.sessions.find((session) => session.id === sessionId) || null;
    }

    function getActiveSession(state) {
        return state && state.activeSessionId
            ? getSession(state, state.activeSessionId)
            : null;
    }

    function validReservedVideos(session) {
        return session.reserved.filter((record) => record.state !== 'invalidated');
    }

    function sessionProgress(session) {
        if (!session) {
            return null;
        }
        const targetMs = session.lockedSettings.durationSeconds * 1000;
        return {
            id: session.id,
            status: session.status,
            durationSeconds: session.lockedSettings.durationSeconds,
            targetUnseenCount: session.lockedSettings.targetUnseenCount,
            qualifiedMs: session.qualifiedMs,
            qualifiedSeconds: Math.floor(session.qualifiedMs / 1000),
            timeComplete: session.qualifiedMs >= targetMs,
            unseenCount: validReservedVideos(session).length,
            unseenComplete:
                validReservedVideos(session).length >=
                session.lockedSettings.targetUnseenCount,
            seenCount: session.seen.length,
            excludedCount: session.excluded.length,
        };
    }

    function isFypPath(pathname) {
        return pathname === '/foryou' || pathname === '/foryou/';
    }

    function visibleRatio(rect, viewportWidth, viewportHeight) {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return 0;
        }
        const left = Math.max(0, rect.left);
        const right = Math.min(viewportWidth, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(viewportHeight, rect.bottom);
        const visibleWidth = Math.max(0, right - left);
        const visibleHeight = Math.max(0, bottom - top);
        return (visibleWidth * visibleHeight) / (rect.width * rect.height);
    }

    function evaluateQualifiedSample(sample) {
        const input = sample && typeof sample === 'object' ? sample : {};
        if (!isFypPath(input.pathname)) {
            return { qualified: false, reason: 'open_fyp' };
        }
        if (!input.documentVisible) {
            return { qualified: false, reason: 'tab_hidden' };
        }
        if (!input.windowFocused) {
            return { qualified: false, reason: 'window_unfocused' };
        }
        if (input.primaryCount !== 1 || !isVideoId(input.videoId)) {
            return {
                qualified: false,
                reason: input.primaryCount > 1 ? 'multiple_active_videos' : 'no_active_video',
            };
        }
        if (!Number.isFinite(input.visibleRatio) || input.visibleRatio < 0.6) {
            return { qualified: false, reason: 'video_not_visible' };
        }
        if (!input.playing || !input.mediaAdvancing) {
            return {
                qualified: false,
                reason: input.playing ? 'video_buffering' : 'video_paused',
            };
        }
        return { qualified: true, reason: 'counting' };
    }

    function clampTickDelta(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) {
            return 0;
        }
        return Math.min(350, Math.round(number));
    }

    function advanceExposure(previousMs, deltaMs, thresholdMs) {
        const previous = Math.max(0, Number(previousMs) || 0);
        const delta = clampTickDelta(deltaMs);
        const threshold = Math.max(1, Number(thresholdMs) || 500);
        const totalMs = previous + delta;
        return {
            previousMs: previous,
            deltaMs: delta,
            totalMs,
            seen: totalMs >= threshold,
            crossedThreshold: previous < threshold && totalMs >= threshold,
        };
    }

    function acceptSourceEvent(session, sourceId, sequence) {
        const safeSourceId = sanitizeToken(sourceId, null);
        const safeSequence = Number(sequence);
        if (!safeSourceId || !Number.isInteger(safeSequence) || safeSequence < 1) {
            return false;
        }
        const previous = Number(session.sourceSequences[safeSourceId] || 0);
        if (safeSequence <= previous) {
            return false;
        }
        session.sourceSequences[safeSourceId] = safeSequence;
        const sourceIds = Object.keys(session.sourceSequences);
        if (sourceIds.length > 12) {
            delete session.sourceSequences[sourceIds[0]];
        }
        return true;
    }

    function findSeen(session, videoId) {
        return session.seen.find((record) => record.videoId === videoId) || null;
    }

    function findReserved(session, videoId) {
        return session.reserved.find((record) => record.videoId === videoId) || null;
    }

    function findExcluded(session, videoId) {
        return session.excluded.find((record) => record.videoId === videoId) || null;
    }

    function invalidateReservation(session, videoId, reason, at) {
        const record = findReserved(session, videoId);
        if (!record || record.state === 'invalidated') {
            return false;
        }
        const timestamp = sanitizeTimestamp(at, Date.now());
        record.state = 'invalidated';
        record.invalidatedAt = timestamp;
        record.invalidReason = sanitizeToken(reason, 'ambiguous_exposure');
        session.invalidated.push({
            videoId,
            at: timestamp,
            reason: record.invalidReason,
        });
        session.updatedAt = timestamp;
        return true;
    }

    function excludeVideo(session, payload) {
        if (!session || session.status !== SESSION_STATUS.COLLECTING) {
            return { applied: false, reason: 'not_collecting' };
        }
        const videoId = payload && payload.videoId;
        if (!isVideoId(videoId)) {
            return { applied: false, reason: 'invalid_video_id' };
        }
        const classification = payload && payload.classification;
        if (!EXCLUSION_CLASSIFICATIONS.has(classification)) {
            return { applied: false, reason: 'invalid_classification' };
        }
        if (findSeen(session, videoId)) {
            return { applied: true, duplicate: true };
        }
        const now = sanitizeTimestamp(payload.at, Date.now());
        const existing = findExcluded(session, videoId);
        if (existing) {
            if (
                classification === 'ever_exposed' &&
                existing.classification !== 'ever_exposed'
            ) {
                existing.classification = 'ever_exposed';
                existing.classifiedAt = Math.min(existing.classifiedAt, now);
                session.updatedAt = now;
                return { applied: true, updated: true };
            }
            return { applied: true, duplicate: true };
        }
        const reserved = findReserved(session, videoId);
        if (reserved && reserved.state !== 'invalidated') {
            const applied = invalidateReservation(
                session,
                videoId,
                classification === 'ambiguous_card'
                    ? 'ambiguous_card_after_reservation'
                    : 'viewport_exposure_after_reservation',
                now
            );
            return { applied, invalidated: applied };
        }
        if (reserved) {
            return { applied: true, duplicate: true };
        }
        session.excluded.push({
            videoId,
            classification,
            classifiedAt: now,
            feedOrder: Number.isInteger(payload.feedOrder) ? payload.feedOrder : null,
        });
        session.updatedAt = now;
        return { applied: true };
    }

    function markExposed(session, payload) {
        return excludeVideo(session, {
            ...payload,
            classification: 'ever_exposed',
        });
    }

    function applyActivity(session, payload) {
        if (!session || session.status !== SESSION_STATUS.COLLECTING) {
            return { applied: false, reason: 'not_collecting' };
        }
        const now = sanitizeTimestamp(payload && payload.at, Date.now());
        const qualifiedDeltaMs = clampTickDelta(payload && payload.qualifiedDeltaMs);
        session.qualifiedMs += qualifiedDeltaMs;

        const videoId = payload && payload.videoId;
        let seenApplied = false;
        if (isVideoId(videoId)) {
            const reserved = findReserved(session, videoId);
            if (reserved && reserved.state !== 'invalidated') {
                invalidateReservation(session, videoId, 'reported_seen_after_reservation', now);
            } else if (!reserved) {
                const watchDeltaMs = Math.min(
                    1000,
                    Math.max(0, Math.round(Number(payload.seenDeltaMs) || 0))
                );
                if (watchDeltaMs > 0) {
                    let seen = findSeen(session, videoId);
                    if (!seen) {
                        seen = {
                            videoId,
                            firstSeenAt: sanitizeTimestamp(payload.firstSeenAt, now),
                            lastSeenAt: now,
                            activeWatchMs: 0,
                            order: session.seen.length + 1,
                            feedOrder: Number.isInteger(payload.feedOrder)
                                ? payload.feedOrder
                                : null,
                        };
                        session.seen.push(seen);
                    }
                    session.excluded = session.excluded.filter(
                        (record) => record.videoId !== videoId
                    );
                    seen.lastSeenAt = now;
                    seen.activeWatchMs += watchDeltaMs;
                    seenApplied = true;
                }
            }
        }
        session.updatedAt = now;
        return { applied: qualifiedDeltaMs > 0 || seenApplied, seenApplied };
    }

    function hashString(value) {
        let hash = 2166136261;
        const string = String(value);
        for (let index = 0; index < string.length; index += 1) {
            hash ^= string.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function selectSafeCandidate(seed, batchId, candidates) {
        const eligible = (Array.isArray(candidates) ? candidates : [])
            .filter((candidate) => {
                return (
                    candidate &&
                    isVideoId(candidate.videoId) &&
                    Number.isInteger(candidate.feedOrder) &&
                    Number.isInteger(candidate.aheadBy) &&
                    candidate.aheadBy >= MIN_SAFE_AHEAD &&
                    Number(candidate.intersectionRatio) === 0 &&
                    candidate.belowViewport === true &&
                    candidate.everIntersected === false &&
                    candidate.connected === true &&
                    candidate.occurrenceCount === 1
                );
            })
            .sort((left, right) => {
                if (left.feedOrder !== right.feedOrder) {
                    return left.feedOrder - right.feedOrder;
                }
                return left.videoId.localeCompare(right.videoId);
            });
        if (!eligible.length) {
            return null;
        }
        const signature = eligible.map((candidate) => candidate.videoId).join(',');
        const hash = hashString(`${sanitizeSeed(seed)}:${batchId}:${signature}`);
        return eligible[hash % eligible.length];
    }

    function reserveVideo(session, payload) {
        if (!session || session.status !== SESSION_STATUS.COLLECTING) {
            return { applied: false, reason: 'not_collecting' };
        }
        const videoId = payload && payload.videoId;
        if (!isVideoId(videoId)) {
            return { applied: false, reason: 'invalid_video_id' };
        }
        if (findSeen(session, videoId)) {
            return { applied: false, reason: 'already_seen' };
        }
        if (findExcluded(session, videoId)) {
            return { applied: false, reason: 'already_exposed' };
        }
        if (findReserved(session, videoId) || session.tombstones.includes(videoId)) {
            return { applied: false, reason: 'duplicate_reservation' };
        }
        const evidence = payload.evidence && typeof payload.evidence === 'object'
            ? payload.evidence
            : {};
        if (
            !Number.isInteger(evidence.aheadBy) ||
            evidence.aheadBy < MIN_SAFE_AHEAD ||
            Number(evidence.intersectionRatio) !== 0 ||
            evidence.belowViewport !== true ||
            evidence.everIntersected !== false ||
            evidence.connected !== true ||
            evidence.occurrenceCount !== 1 ||
            !Number.isInteger(evidence.feedOrder)
        ) {
            return { applied: false, reason: 'unsafe_evidence' };
        }
        const now = sanitizeTimestamp(payload.at, Date.now());
        session.tombstones.push(videoId);
        session.reserved.push({
            videoId,
            state: 'reserved',
            order: session.reserved.length + 1,
            batchId: sanitizeToken(payload.batchId, `batch-${session.reserved.length + 1}`),
            interceptedAt: now,
            feedOrder: evidence.feedOrder,
            aheadBy: evidence.aheadBy,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            viewerStatus: 'pending',
        });
        session.batchCounter = Math.max(
            session.batchCounter,
            toBoundedInteger(payload.batchNumber, 1, 1000000, session.batchCounter + 1)
        );
        session.updatedAt = now;
        return { applied: true };
    }

    function evaluateCompletion(session, at) {
        if (!session || session.status !== SESSION_STATUS.COLLECTING) {
            return false;
        }
        const progress = sessionProgress(session);
        if (!progress.timeComplete || !progress.unseenComplete) {
            return false;
        }
        const now = sanitizeTimestamp(at, Date.now());
        session.status = SESSION_STATUS.COMPLETE;
        session.completedAt = now;
        session.updatedAt = now;
        return true;
    }

    function stopSession(session, at, reason) {
        if (!session || session.status !== SESSION_STATUS.COLLECTING) {
            return false;
        }
        const now = sanitizeTimestamp(at, Date.now());
        session.status = SESSION_STATUS.STOPPED;
        session.stoppedAt = now;
        session.stopReason = sanitizeToken(reason, 'participant_stopped');
        session.updatedAt = now;
        return true;
    }

    function safeDiagnosticDetail(detail) {
        if (!detail || typeof detail !== 'object') {
            return {};
        }
        const allowedKeys = new Set([
            'count',
            'elapsedMs',
            'aheadBy',
            'feedOrder',
            'tabBound',
            'reasonCode',
            'pathCode',
        ]);
        const output = {};
        Object.entries(detail).forEach(([key, value]) => {
            if (!allowedKeys.has(key)) {
                return;
            }
            if (typeof value === 'boolean' || Number.isFinite(value)) {
                output[key] = value;
                return;
            }
            if (typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value)) {
                output[key] = value;
            }
        });
        return output;
    }

    function recordDiagnostic(session, code, at, detail) {
        if (!session) {
            return false;
        }
        const safeCode = sanitizeToken(code, null);
        if (!safeCode) {
            return false;
        }
        session.diagnostics.push({
            code: safeCode,
            at: sanitizeTimestamp(at, Date.now()),
            detail: safeDiagnosticDetail(detail),
        });
        if (session.diagnostics.length > 200) {
            session.diagnostics.splice(0, session.diagnostics.length - 200);
        }
        return true;
    }

    function sanitizeViewerValue(type, value) {
        if (type === 'current_time') {
            if (!value || typeof value !== 'object') {
                return null;
            }
            const currentTime = value.currentTime;
            const duration = value.duration;
            if (
                typeof currentTime !== 'number' ||
                typeof duration !== 'number' ||
                !Number.isFinite(currentTime) ||
                !Number.isFinite(duration) ||
                currentTime < 0 ||
                duration < 0 ||
                currentTime > 86400 ||
                duration > 86400
            ) {
                return null;
            }
            return { currentTime, duration };
        }
        if (type === 'player_error') {
            const input = value && typeof value === 'object' ? value : {};
            if (
                typeof input.code !== 'number' ||
                !Number.isInteger(input.code) ||
                input.code < 1 ||
                input.code > 9999
            ) {
                return null;
            }
            if (
                input.category !== null &&
                input.category !== undefined &&
                (
                    typeof input.category !== 'string' ||
                    !/^[A-Za-z0-9 _-]{1,80}$/.test(input.category)
                )
            ) {
                return null;
            }
            return {
                code: input.code,
                category: input.category || null,
            };
        }
        return null;
    }

    function applyViewerEvent(session, payload) {
        if (!session || !isVideoId(payload && payload.videoId)) {
            return false;
        }
        const record = findReserved(session, payload.videoId);
        if (!record || record.state === 'invalidated') {
            return false;
        }
        const type = payload.type;
        if (!VIEWER_EVENT_TYPES.has(type)) {
            return false;
        }
        const now = sanitizeTimestamp(payload.at, Date.now());
        if (['ended', 'unavailable'].includes(record.viewerStatus)) {
            return record.viewerTerminalType === type;
        }

        if (type === 'ready' || type === 'iframe_loaded') {
            if (record.viewerStatus === 'ready') {
                return true;
            }
            if (record.viewerStatus !== 'pending') {
                return false;
            }
        }
        if (type === 'play_command') {
            if (['play_requested', 'playing'].includes(record.viewerStatus)) {
                return true;
            }
            if (record.viewerStatus !== 'ready') {
                return false;
            }
        }
        if (type === 'ready_timeout' && record.viewerStatus !== 'pending') {
            return false;
        }
        if (
            type === 'playback_timeout' &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return false;
        }
        if (
            ['playing', 'paused', 'buffering', 'current_time', 'ended'].includes(type) &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return false;
        }
        const event = { videoId: payload.videoId, type, at: now };
        const value = sanitizeViewerValue(type, payload.value);
        if (type === 'current_time' && value === null) {
            return false;
        }
        if (type === 'player_error' && value === null) {
            return false;
        }
        if (value !== null) {
            event.value = value;
        }
        session.viewerEvents.push(event);
        if (session.viewerEvents.length > 1000) {
            session.viewerEvents.splice(0, session.viewerEvents.length - 1000);
        }
        if (type === 'ready' || type === 'iframe_loaded') {
            record.viewerStatus = 'ready';
        } else if (type === 'play_command') {
            record.viewerStatus = 'play_requested';
        } else if (type === 'playing') {
            record.viewerStatus = 'playing';
        } else if (type === 'ended') {
            record.viewerStatus = 'ended';
            record.viewerEndedAt = now;
            record.viewerTerminalType = type;
        } else if (
            type === 'player_error' ||
            type === 'ready_timeout' ||
            type === 'playback_timeout'
        ) {
            record.viewerStatus = 'unavailable';
            record.viewerErrorAt = now;
            record.viewerTerminalType = type;
        }
        if (session.status === SESSION_STATUS.COMPLETE) {
            session.status = SESSION_STATUS.VIEWING;
            session.viewerStartedAt = now;
        }
        session.updatedAt = now;
        return true;
    }

    function finishViewer(session, at) {
        if (session && session.status === SESSION_STATUS.VIEWED) {
            return true;
        }
        if (!session || ![SESSION_STATUS.COMPLETE, SESSION_STATUS.VIEWING].includes(session.status)) {
            return false;
        }
        const now = sanitizeTimestamp(at, Date.now());
        session.status = SESSION_STATUS.VIEWED;
        session.viewerFinishedAt = now;
        session.updatedAt = now;
        return true;
    }

    function viewerQueue(session) {
        if (!session) {
            return [];
        }
        return validReservedVideos(session)
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((record) => ({
                videoId: record.videoId,
                order: record.order,
                viewerStatus: record.viewerStatus,
            }));
    }

    function validateTikTokPlayerMessage(origin, sourceMatches, data) {
        if (origin !== TIKTOK_ORIGIN || sourceMatches !== true) {
            return null;
        }
        if (
            !data ||
            typeof data !== 'object' ||
            data['x-tiktok-player'] !== true ||
            !PLAYER_MESSAGE_TYPES.has(data.type)
        ) {
            return null;
        }
        if (data.type === 'onPlayerReady') {
            return { type: 'ready', value: null };
        }
        if (data.type === 'onStateChange') {
            const state = data.value;
            const names = { '-1': 'init', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering' };
            return typeof state === 'number' && Number.isInteger(state) &&
                Object.prototype.hasOwnProperty.call(names, state)
                ? { type: names[state], value: null }
                : null;
        }
        if (data.type === 'onCurrentTime') {
            const value = sanitizeViewerValue('current_time', data.value);
            return value ? { type: 'current_time', value } : null;
        }
        if (data.type === 'onPlayerError' || data.type === 'onError') {
            const input = data.value && typeof data.value === 'object'
                ? data.value
                : { code: data.value };
            const value = sanitizeViewerValue('player_error', {
                code: input.errorCode ?? input.code,
                category: input.errorType ?? input.category,
            });
            return value === null ? null : { type: 'player_error', value };
        }
        return null;
    }

    function clearCollectedData(state) {
        return {
            schemaVersion: SCHEMA_VERSION,
            settings: sanitizeSettings(state && state.settings),
            activeSessionId: null,
            sessions: [],
        };
    }

    return Object.freeze({
        SCHEMA_VERSION,
        TIKTOK_ORIGIN,
        TIKTOK_FYP_URL,
        CONTENT_SCRIPT_ID,
        MIN_SAFE_AHEAD,
        DEFAULT_SETTINGS,
        SETTING_LIMITS,
        MESSAGE_TYPES,
        SESSION_STATUS,
        sanitizeSettings,
        createDefaultState,
        normalizeState,
        isVideoId,
        parseTikTokVideoId,
        createSession,
        getSession,
        getActiveSession,
        validReservedVideos,
        sessionProgress,
        isFypPath,
        visibleRatio,
        evaluateQualifiedSample,
        clampTickDelta,
        advanceExposure,
        acceptSourceEvent,
        findSeen,
        findReserved,
        findExcluded,
        excludeVideo,
        markExposed,
        applyActivity,
        hashString,
        selectSafeCandidate,
        reserveVideo,
        invalidateReservation,
        evaluateCompletion,
        stopSession,
        recordDiagnostic,
        applyViewerEvent,
        finishViewer,
        viewerQueue,
        validateTikTokPlayerMessage,
        clearCollectedData,
    });
});
