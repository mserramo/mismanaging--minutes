'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../lib/core.js');

const IDS = Object.freeze({
    a: '7311111111111111111',
    b: '7311111111111111112',
    c: '7311111111111111113',
    d: '7311111111111111114',
});

function makeSession(settings) {
    return Core.createSession(settings || Core.DEFAULT_SETTINGS, {
        id: 'session-test-1',
        seed: 123456,
        startedAt: 1000,
        targetTabId: 42,
    });
}

function reserve(session, videoId, order, aheadBy) {
    const prepared = Core.reserveVideo(session, {
        videoId,
        batchId: `batch-${order}`,
        batchNumber: order,
        at: 2000 + order,
        evidence: {
            feedOrder: order,
            aheadBy: aheadBy ?? 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    });
    if (prepared.applied) {
        const confirmed = Core.confirmReservation(session, videoId, 2100 + order);
        assert.equal(confirmed.applied, true);
    }
    return prepared;
}

test('buffered harvest telemetry is bounded, sanitized and cannot alter safety state', () => {
    const session = makeSession();
    const entries = Array.from({ length: 60 }, (_unused, index) => ({
        kind: 'diagnostic', at: 2000 + index, code: 'synthetic_step',
        detail: { count: index, username: 'not-stored', url: 'not-stored' },
    }));
    Core.applyBufferedHarvestTelemetry(session, entries, 2100);
    assert.equal(session.diagnostics.length, 32);
    assert.deepEqual(session.diagnostics[0].detail, { count: 28 });
    Core.applyBufferedHarvestTelemetry(session, [
        { kind: 'step', at: 999999, step: { phase: 'advancing', driverVideoId: IDS.a,
            retainDriver: false, visibility: 'hidden', timerDelayMs: 1000 } },
        { kind: 'step', step: { phase: 'complete' } },
        { kind: 'step', step: { phase: 'failed' } },
    ], 2200);
    assert.equal(session.status, Core.SESSION_STATUS.COLLECTING);
    assert.equal(session.harvestPhase, 'advancing');
    assert.equal(session.excluded.length, 0);
    assert.equal(session.harvestSteps.length, 1);
    assert.equal(session.harvestSteps[0].at, 2200);
    Core.stopSession(session, 2300);
    const stopped = JSON.stringify(session);
    Core.applyBufferedHarvestTelemetry(session, entries, 2400);
    assert.equal(JSON.stringify(session), stopped);
});

test('natural sessions ignore buffered harvest telemetry', () => {
    const session = makeSession();
    session.collectionMode = Core.COLLECTION_MODE.NATURAL_FYP_SESSION;
    const before = JSON.stringify(session);
    Core.applyBufferedHarvestTelemetry(session, [{ kind: 'diagnostic', code: 'capture_batch' }], 2100);
    assert.equal(JSON.stringify(session), before);
});

test('defaults and settings bounds are stable', () => {
    assert.deepEqual(Core.DEFAULT_SETTINGS, {
        harvestDurationSeconds: 30,
        naturalSessionSeconds: 60,
    });
    assert.deepEqual(Core.sanitizeSettings({
        harvestDurationSeconds: 0,
    }), {
        harvestDurationSeconds: 15,
        naturalSessionSeconds: 60,
    });
    assert.deepEqual(Core.sanitizeSettings({
        harvestDurationSeconds: '120',
    }), {
        harvestDurationSeconds: 120,
        naturalSessionSeconds: 60,
    });
});

test('TikTok IDs stay strings and extraction is conservative', () => {
    const url = `https://www.tiktok.com/@creator/video/${IDS.a}?lang=en`;
    assert.equal(Core.parseTikTokVideoId(url), IDS.a);
    assert.equal(typeof Core.parseTikTokVideoId(url), 'string');
    assert.equal(Core.parseTikTokVideoId(`https://evil.example/@x/video/${IDS.a}`), null);
    assert.equal(Core.parseTikTokVideoId(`${Core.TIKTOK_ORIGIN}/player/v1/${IDS.a}`), null);
    assert.equal(Core.parseTikTokVideoId(`${Core.TIKTOK_ORIGIN}/@x/photo/${IDS.a}`), null);
    assert.equal(Core.parseTikTokVideoId(`${Core.TIKTOK_ORIGIN}/@x/video/123`), null);
    assert.equal(Core.parseTikTokVideoId(`${Core.TIKTOK_ORIGIN}/@x/video/0${IDS.a}`), null);
    assert.equal(Core.parseTikTokVideoId(`${Core.TIKTOK_ORIGIN}/@x/video/${IDS.a}x`), null);
    assert.equal(Core.parseTikTokVideoId(`${Core.TIKTOK_ORIGIN}/@x/video/${IDS.a}/extra`), null);
});

test('visible ratio is relative to the video element', () => {
    assert.equal(Core.visibleRatio({
        left: 0,
        right: 100,
        top: -40,
        bottom: 60,
        width: 100,
        height: 100,
    }, 1000, 800), 0.6);
    assert.equal(Core.visibleRatio({
        left: 0,
        right: 100,
        top: -41,
        bottom: 59,
        width: 100,
        height: 100,
    }, 1000, 800), 0.59);
});

test('qualified-time gates pause independently and exact 0.60 qualifies', () => {
    const valid = {
        pathname: '/foryou',
        documentVisible: true,
        windowFocused: true,
        primaryCount: 1,
        videoId: IDS.a,
        visibleRatio: 0.6,
        playing: true,
        mediaAdvancing: true,
    };
    assert.deepEqual(Core.evaluateQualifiedSample(valid), {
        qualified: true,
        reason: 'counting',
    });
    const cases = [
        ['pathname', '/profile', 'open_fyp'],
        ['documentVisible', false, 'tab_hidden'],
        ['windowFocused', false, 'window_unfocused'],
        ['primaryCount', 0, 'no_active_video'],
        ['primaryCount', 2, 'multiple_active_videos'],
        ['visibleRatio', 0.599, 'video_not_visible'],
        ['playing', false, 'video_paused'],
        ['mediaAdvancing', false, 'video_buffering'],
    ];
    cases.forEach(([key, value, reason]) => {
        assert.equal(Core.evaluateQualifiedSample({ ...valid, [key]: value }).reason, reason);
    });
});

test('timer gaps are clamped and seen transition occurs at 500ms', () => {
    assert.equal(Core.clampTickDelta(2000), 350);
    assert.equal(Core.clampTickDelta(-1), 0);
    const first = Core.advanceExposure(0, 350, 500);
    const second = Core.advanceExposure(first.totalMs, 149, 500);
    const third = Core.advanceExposure(second.totalMs, 1, 500);
    assert.equal(second.totalMs, 499);
    assert.equal(second.seen, false);
    assert.equal(third.totalMs, 500);
    assert.equal(third.crossedThreshold, true);
});

test('starting a session snapshots settings', () => {
    const settings = { harvestDurationSeconds: 120 };
    const session = makeSession(settings);
    settings.harvestDurationSeconds = 15;
    assert.deepEqual(session.lockedSettings, {
        harvestDurationSeconds: 120,
    });
    assert.equal(session.captureStrategy, Core.CAPTURE_STRATEGY.COVERED_EVERY_ITEM);
    assert.equal(session.deliveryTarget, Core.DELIVERY_TARGET.LOCAL_VIEWER);
    assert.equal(session.harvestDeadlineAt, 121000);
});

test('source sequences reject duplicates and out-of-order messages', () => {
    const session = makeSession();
    assert.equal(Core.acceptSourceEvent(session, 'source-12345678', 1), true);
    assert.equal(Core.acceptSourceEvent(session, 'source-12345678', 1), false);
    assert.equal(Core.acceptSourceEvent(session, 'source-12345678', 0), false);
    assert.equal(Core.acceptSourceEvent(session, 'source-12345678', 3), true);
    assert.equal(Core.acceptSourceEvent(session, 'source-12345678', 2), false);
});

test('safe-ahead selection is deterministic and rejects unsafe candidates', () => {
    const candidates = [
        {
            videoId: IDS.a,
            feedOrder: 2,
            aheadBy: 1,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
        {
            videoId: IDS.b,
            feedOrder: 3,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
        {
            videoId: IDS.c,
            feedOrder: 4,
            aheadBy: 3,
            intersectionRatio: 0.01,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
        {
            videoId: IDS.d,
            feedOrder: 5,
            aheadBy: 4,
            intersectionRatio: 0,
            belowViewport: false,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    ];
    const first = Core.selectSafeCandidate(123, 'batch-1', candidates);
    const replay = Core.selectSafeCandidate(123, 'batch-1', candidates.slice().reverse());
    assert.ok([IDS.a, IDS.b].includes(first.videoId));
    assert.equal(replay.videoId, first.videoId);
    assert.equal(
        Core.selectSafeCandidate(123, 'batch-2', [{
            ...candidates[0],
            aheadBy: 0,
        }]),
        null
    );
});

test('one fully offscreen card ahead is eligible but overlap still fails closed', () => {
    const candidate = {
        videoId: IDS.a,
        feedOrder: 2,
        aheadBy: 1,
        intersectionRatio: 0,
        belowViewport: true,
        everIntersected: false,
        connected: true,
        occurrenceCount: 1,
    };
    assert.equal(
        Core.selectSafeCandidate(456, 'one-ahead', [candidate]).videoId,
        IDS.a
    );
    assert.equal(
        Core.selectSafeCandidate(456, 'overlap', [{
            ...candidate,
            intersectionRatio: 0.001,
        }]),
        null
    );

    const session = makeSession();
    assert.equal(reserve(session, IDS.a, 2, 1).applied, true);
    assert.equal(session.reserved[0].aheadBy, 1);
    assert.equal(reserve(makeSession(), IDS.b, 2, 0).applied, false);
});

test('automated selection considers only the immediate surviving successor', () => {
    const immediate = {
        videoId: IDS.a,
        feedOrder: 2,
        aheadBy: 1,
        intersectionRatio: 0,
        belowViewport: true,
        everIntersected: false,
        connected: true,
        occurrenceCount: 1,
    };
    const later = { ...immediate, videoId: IDS.b, feedOrder: 3, aheadBy: 2 };
    assert.equal(
        Core.selectImmediateSafeCandidate(123, 'successor', [later, immediate]).videoId,
        IDS.a
    );
    assert.equal(
        Core.selectImmediateSafeCandidate(123, 'unsafe-successor', [
            { ...immediate, intersectionRatio: 0.01 },
            later,
        ]),
        null
    );
});

test('seen and reserved classifications are mutually exclusive', () => {
    const session = makeSession();
    Core.applyActivity(session, {
        at: 2000,
        qualifiedDeltaMs: 250,
        videoId: IDS.a,
        seenDeltaMs: 500,
        firstSeenAt: 1500,
        feedOrder: 1,
    });
    assert.equal(reserve(session, IDS.a, 2).applied, false);
    assert.equal(reserve(session, IDS.b, 2).applied, true);
    assert.equal(Core.findSeen(session, IDS.b), null);
    Core.applyActivity(session, {
        at: 2200,
        qualifiedDeltaMs: 250,
        videoId: IDS.b,
        seenDeltaMs: 250,
    });
    assert.equal(Core.findReserved(session, IDS.b).state, 'invalidated');
    assert.equal(Core.findSeen(session, IDS.b), null);
});

test('any viewport exposure durably excludes an ID from unseen selection', () => {
    const session = makeSession();
    assert.equal(Core.markExposed(session, {
        videoId: IDS.a,
        feedOrder: 1,
        at: 1500,
    }).applied, true);
    assert.equal(Core.findExcluded(session, IDS.a).classification, 'ever_exposed');
    assert.equal(reserve(session, IDS.a, 2).reason, 'already_exposed');

    Core.applyActivity(session, {
        at: 2000,
        qualifiedDeltaMs: 250,
        videoId: IDS.a,
        seenDeltaMs: 500,
        firstSeenAt: 1500,
        feedOrder: 1,
    });
    assert.equal(Core.findExcluded(session, IDS.a), null);
    assert.notEqual(Core.findSeen(session, IDS.a), null);

    assert.equal(reserve(session, IDS.b, 2).applied, true);
    const invalidation = Core.markExposed(session, {
        videoId: IDS.b,
        feedOrder: 2,
        at: 2200,
    });
    assert.equal(invalidation.invalidated, true);
    assert.equal(Core.findReserved(session, IDS.b).state, 'invalidated');
});

test('an ambiguous-card ID remains ineligible after storage restoration', () => {
    const session = makeSession();
    const excluded = Core.excludeVideo(session, {
        videoId: IDS.a,
        classification: 'ambiguous_card',
        feedOrder: 2,
        at: 1600,
    });
    assert.equal(excluded.applied, true);
    assert.equal(Core.findExcluded(session, IDS.a).classification, 'ambiguous_card');
    assert.equal(reserve(session, IDS.a, 3).reason, 'already_exposed');

    const state = Core.createDefaultState();
    state.sessions.push(session);
    state.activeSessionId = session.id;
    const restored = Core.normalizeState(JSON.parse(JSON.stringify(state))).sessions[0];
    assert.equal(Core.findExcluded(restored, IDS.a).classification, 'ambiguous_card');
    assert.equal(reserve(restored, IDS.a, 3).reason, 'already_exposed');
});

test('stored seed and batch ordinal reproduce the same safe choice after restore', () => {
    const session = makeSession();
    reserve(session, IDS.a, 1);
    const state = Core.createDefaultState();
    state.sessions.push(session);
    state.activeSessionId = session.id;
    const restored = Core.normalizeState(JSON.parse(JSON.stringify(state))).sessions[0];
    const candidates = [
        {
            videoId: IDS.b,
            feedOrder: 2,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
        {
            videoId: IDS.c,
            feedOrder: 3,
            aheadBy: 3,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    ];
    const batchId = `batch-${restored.batchCounter + 1}`;
    assert.deepEqual(
        Core.selectSafeCandidate(restored.seed, batchId, candidates),
        Core.selectSafeCandidate(session.seed, batchId, candidates.slice().reverse())
    );
});

test('automated completion waits for the full window and keeps every confirmed video', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    reserve(session, IDS.a, 1);
    assert.equal(Core.evaluateCompletion(session, 2000), false);
    reserve(session, IDS.b, 2);
    assert.equal(Core.evaluateCompletion(session, 15999), false);
    assert.equal(Core.evaluateCompletion(session, 16000), true);
    assert.equal(Core.evaluateCompletion(session, 16001), false);
    assert.deepEqual(Core.viewerQueue(session).map((item) => item.videoId), [IDS.a, IDS.b]);
    assert.equal(session.status, Core.SESSION_STATUS.COMPLETE);
});

test('reservation is persisted before concealment confirmation and cannot enter viewer early', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    const prepared = Core.reserveVideo(session, {
        videoId: IDS.a,
        batchId: 'batch-1',
        batchNumber: 1,
        at: 1500,
        evidence: {
            feedOrder: 2,
            aheadBy: 1,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    });
    assert.equal(prepared.applied, true);
    assert.equal(Core.findReserved(session, IDS.a).state, 'prepared');
    assert.deepEqual(session.tombstones, []);
    assert.deepEqual(Core.viewerQueue(session), []);
    assert.equal(Core.evaluateCompletion(session, 1600), false);

    assert.equal(Core.confirmReservation(session, IDS.a, 1700).applied, true);
    assert.equal(Core.findReserved(session, IDS.a).state, 'reserved');
    assert.deepEqual(session.tombstones, [IDS.a]);
    assert.equal(Core.evaluateCompletion(session, 15999), false);
    assert.equal(Core.finalizeHarvestWindow(session, 16000).outcome, 'complete');
});

test('an opaque covered and muted current feed item is eligible despite viewport intersection', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    const prepared = Core.reserveVideo(session, {
        videoId: IDS.a,
        batchId: 'covered-1',
        batchNumber: 1,
        at: 1500,
        evidence: {
            captureMethod: 'covered_feed_item',
            feedOrder: 1,
            aheadBy: 0,
            intersectionRatio: 0.92,
            belowViewport: false,
            everIntersected: true,
            connected: true,
            occurrenceCount: 1,
            overlayOpaque: true,
            mediaMuted: true,
        },
    });
    assert.equal(prepared.applied, true);
    assert.equal(Core.findReserved(session, IDS.a).captureMethod, 'covered_feed_item');
    assert.equal(Core.findReserved(session, IDS.a).state, 'prepared');
    assert.equal(Core.confirmReservation(session, IDS.a, 1600).applied, true);
    assert.deepEqual(Core.viewerQueue(session).map((record) => record.videoId), [IDS.a]);

    const unsafe = Core.reserveVideo(session, {
        videoId: IDS.b,
        batchId: 'covered-2',
        batchNumber: 2,
        at: 1700,
        evidence: {
            captureMethod: 'covered_feed_item',
            feedOrder: 2,
            aheadBy: 0,
            intersectionRatio: 0.8,
            belowViewport: false,
            everIntersected: true,
            connected: true,
            occurrenceCount: 1,
            overlayOpaque: false,
            mediaMuted: true,
        },
    });
    assert.equal(unsafe.reason, 'unsafe_evidence');
});

test('harvest diagnostics capture hidden timer delay and automation drivers', () => {
    const session = makeSession();
    const result = Core.recordHarvestStep(session, {
        phase: 'advancing',
        visibility: 'hidden',
        timerDelayMs: 1700,
        hydrationLatencyMs: 820,
        advanceAttempt: 2,
        driverVideoId: IDS.a,
        feedOrder: 1,
    }, 2000);
    assert.equal(result.applied, true);
    assert.equal(session.harvestSteps[0].visibility, 'hidden');
    assert.equal(session.harvestSteps[0].timerDelayMs, 1700);
    assert.equal(Core.findExcluded(session, IDS.a).classification, 'automation_driver');
    assert.equal(reserve(session, IDS.a, 2).reason, 'already_exposed');
});

test('waiting for the deadline is a valid partial-pool harvest phase', () => {
    const session = makeSession();
    reserve(session, IDS.a, 1);
    const result = Core.recordHarvestStep(session, {
        phase: 'waiting_deadline',
        visibility: 'hidden',
        timerDelayMs: 700,
        hydrationLatencyMs: 8200,
        advanceAttempt: 3,
        driverVideoId: IDS.a,
        feedOrder: 1,
        retainDriver: true,
    }, 9000);
    assert.equal(result.applied, true);
    assert.equal(session.status, Core.SESSION_STATUS.COLLECTING);
    assert.equal(session.harvestPhase, 'waiting_deadline');
    assert.equal(Core.viewerQueue(session).length, 1);
});

test('window progress is wall-clock based and a partial bank becomes the completed pool', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    reserve(session, IDS.a, 1);
    assert.equal(Core.sessionProgress(session, 15999).timedOut, false);
    assert.equal(Core.sessionProgress(session, 16000).timedOut, true);
    assert.deepEqual(Core.finalizeHarvestWindow(session, 16000), {
        applied: true,
        outcome: 'complete',
    });
    assert.equal(session.status, Core.SESSION_STATUS.COMPLETE);
    assert.equal(Core.findReserved(session, IDS.a).state, 'reserved');
    assert.equal(Core.viewerQueue(session).length, 1);
});

test('an empty harvest window fails without opening a viewer', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    assert.deepEqual(Core.finalizeHarvestWindow(session, 15999), {
        applied: false,
        outcome: 'not_due',
    });
    assert.deepEqual(Core.finalizeHarvestWindow(session, 16000), {
        applied: true,
        outcome: 'failed',
    });
    assert.equal(session.status, Core.SESSION_STATUS.FAILED);
    assert.equal(session.stopReason, 'harvest_empty');
    assert.equal(Core.sessionProgress(session, 16000).stopReason, 'harvest_empty');
});

test('schema 1 migration preserves completed sessions and stops collecting sessions', () => {
    const completed = makeSession({ harvestDurationSeconds: 15 });
    reserve(completed, IDS.a, 1);
    completed.status = Core.SESSION_STATUS.COMPLETE;
    completed.completedAt = 2500;
    completed.lockedSettings = { durationSeconds: 1, targetUnseenCount: 1 };
    completed.qualifiedMs = 1000;
    const collecting = makeSession();
    collecting.id = 'legacy-collecting';
    collecting.lockedSettings = { durationSeconds: 60, targetUnseenCount: 5 };
    const migrated = Core.normalizeState({
        schemaVersion: 1,
        settings: { durationSeconds: 60, targetUnseenCount: 5 },
        activeSessionId: collecting.id,
        sessions: [completed, collecting],
    });
    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migrated.sessions[0].collectionMode, Core.COLLECTION_MODE.LEGACY_MANUAL);
    assert.equal(migrated.sessions[0].status, Core.SESSION_STATUS.COMPLETE);
    assert.equal(migrated.sessions[1].status, Core.SESSION_STATUS.STOPPED);
    assert.equal(migrated.sessions[1].stopReason, 'collection_rule_replaced');
    assert.equal(migrated.activeSessionId, null);
});

test('schema 2 migration preserves completed pools and stops the old target-based collector', () => {
    const completed = makeSession({ harvestDurationSeconds: 15 });
    reserve(completed, IDS.a, 1);
    completed.status = Core.SESSION_STATUS.COMPLETE;
    completed.completedAt = 2500;
    completed.lockedSettings = { harvestTimeoutSeconds: 90, targetUnseenCount: 1 };
    completed.harvestDeadlineAt = 91000;
    const collecting = makeSession({ harvestDurationSeconds: 15 });
    collecting.id = 'schema-2-collecting';
    collecting.lockedSettings = { harvestTimeoutSeconds: 90, targetUnseenCount: 5 };
    collecting.harvestDeadlineAt = 91000;
    const migrated = Core.normalizeState({
        schemaVersion: 2,
        settings: { harvestTimeoutSeconds: 90, targetUnseenCount: 5 },
        activeSessionId: collecting.id,
        sessions: [completed, collecting],
    });
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(migrated.settings, {
        harvestDurationSeconds: 30,
        naturalSessionSeconds: 60,
    });
    assert.equal(migrated.sessions[0].status, Core.SESSION_STATUS.COMPLETE);
    assert.deepEqual(migrated.sessions[0].lockedSettings, { harvestDurationSeconds: 90 });
    assert.equal(migrated.sessions[1].status, Core.SESSION_STATUS.STOPPED);
    assert.equal(migrated.sessions[1].stopReason, 'collection_rule_replaced');
    assert.equal(migrated.activeSessionId, null);
});

test('schema 3 completion keeps its one-ahead interpretation while collection is stopped', () => {
    const completed = makeSession({ harvestDurationSeconds: 15 });
    reserve(completed, IDS.a, 1);
    completed.status = Core.SESSION_STATUS.COMPLETE;
    completed.completedAt = 16000;
    delete completed.captureStrategy;
    delete completed.deliveryTarget;
    completed.reserved.forEach((record) => delete record.captureMethod);
    const collecting = makeSession({ harvestDurationSeconds: 30 });
    collecting.id = 'schema-3-collecting';
    delete collecting.captureStrategy;
    delete collecting.deliveryTarget;
    const migrated = Core.normalizeState({
        schemaVersion: 3,
        settings: { harvestDurationSeconds: 45 },
        activeSessionId: collecting.id,
        sessions: [completed, collecting],
    });
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(migrated.settings, {
        harvestDurationSeconds: 45,
        naturalSessionSeconds: 60,
    });
    assert.equal(
        migrated.sessions[0].captureStrategy,
        Core.CAPTURE_STRATEGY.OFFSCREEN_SUCCESSOR
    );
    assert.equal(migrated.sessions[0].reserved[0].captureMethod, 'offscreen_successor');
    assert.equal(migrated.sessions[1].status, Core.SESSION_STATUS.STOPPED);
    assert.equal(migrated.sessions[1].stopReason, 'collection_rule_replaced');
});

test('participant navigation can terminally skip an unfinished viewer item', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    reserve(session, IDS.a, 1);
    Core.finalizeHarvestWindow(session, 16000);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'participant_skip',
        at: 17000,
    }), true);
    assert.equal(Core.findReserved(session, IDS.a).viewerStatus, 'skipped');
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'participant_skip',
        at: 17001,
    }), true);
    assert.equal(Core.viewerQueue(session).length, 1);
});

test('viewer ordering, terminal dedupe, and completion are stable', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    reserve(session, IDS.b, 2);
    reserve(session, IDS.a, 1);
    Core.evaluateCompletion(session, 16000);
    assert.deepEqual(Core.viewerQueue(session).map((item) => item.videoId), [IDS.b, IDS.a]);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.b,
        type: 'ended',
        at: 3000,
    }), false);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.b,
        type: 'iframe_loaded',
        at: 3001,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.b,
        type: 'play_command',
        at: 3002,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.b,
        type: 'playing',
        at: 3003,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.b,
        type: 'ended',
        at: 3004,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.b,
        type: 'ended',
        at: 3005,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'player_error',
        at: 3100,
        value: { code: 1001, category: 'INVALID_VIDEO' },
    }), true);
    assert.equal(Core.finishViewer(session, 3200), true);
    assert.equal(Core.finishViewer(session, 3201), true);
    assert.equal(session.status, Core.SESSION_STATUS.VIEWED);
});

test('a playback progress stall is terminal only after readiness and Play', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    reserve(session, IDS.a, 1);
    Core.evaluateCompletion(session, 16000);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'playback_timeout',
        at: 3000,
    }), false);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'ready',
        at: 3001,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'play_command',
        at: 3002,
    }), true);
    assert.equal(Core.applyViewerEvent(session, {
        videoId: IDS.a,
        type: 'playback_timeout',
        at: 3003,
    }), true);
    assert.equal(Core.findReserved(session, IDS.a).viewerStatus, 'unavailable');
});

test('only collecting sessions can be stopped', () => {
    const session = makeSession({ harvestDurationSeconds: 15 });
    reserve(session, IDS.a, 1);
    Core.evaluateCompletion(session, 16000);
    assert.equal(Core.stopSession(session, 2100, 'participant_stopped'), false);
    assert.equal(session.status, Core.SESSION_STATUS.COMPLETE);

    const collecting = makeSession();
    assert.equal(Core.stopSession(collecting, 2200, 'participant_stopped'), true);
    assert.equal(collecting.status, Core.SESSION_STATUS.STOPPED);
});

test('TikTok player messages are strictly origin, source, and type checked', () => {
    const ready = {
        type: 'onPlayerReady',
        value: null,
        'x-tiktok-player': true,
    };
    assert.deepEqual(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, ready), {
        type: 'ready',
        value: null,
    });
    assert.equal(Core.validateTikTokPlayerMessage('https://www.tiktok.com.evil.test', true, ready), null);
    assert.equal(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, false, ready), null);
    assert.equal(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, {
        ...ready,
        'x-tiktok-player': 'true',
    }), null);
    assert.equal(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, {
        type: 'onStateChange',
        value: '0',
        'x-tiktok-player': true,
    }), null);
    assert.deepEqual(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, {
        type: 'onStateChange',
        value: 0,
        'x-tiktok-player': true,
    }), { type: 'ended', value: null });
    assert.equal(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, {
        type: 'onCurrentTime',
        value: { currentTime: '1', duration: 10 },
        'x-tiktok-player': true,
    }), null);
    assert.equal(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, {
        type: 'onPlayerError',
        value: { errorType: 'INVALID_VIDEO' },
        'x-tiktok-player': true,
    }), null);
    assert.deepEqual(Core.validateTikTokPlayerMessage(Core.TIKTOK_ORIGIN, true, {
        type: 'onPlayerError',
        value: { errorCode: 1001, errorType: 'INVALID_VIDEO' },
        'x-tiktok-player': true,
    }), {
        type: 'player_error',
        value: { code: 1001, category: 'INVALID_VIDEO' },
    });
});

test('state restoration strips unknown fields and fails closed on corrupt classification', () => {
    const state = Core.createDefaultState();
    const session = makeSession();
    reserve(session, IDS.b, 2);
    Core.markExposed(session, {
        videoId: IDS.c,
        feedOrder: 3,
        at: 2100,
    });
    session.evil = 'https://example.test/@username';
    state.sessions.push(session);
    state.activeSessionId = session.id;
    state.evil = '<html>secret</html>';
    const restored = Core.normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.evil, undefined);
    assert.equal(restored.sessions[0].evil, undefined);
    assert.deepEqual(restored.sessions[0].tombstones, [IDS.b]);
    assert.equal(restored.sessions[0].excluded[0].videoId, IDS.c);

    const invalidClassification = JSON.parse(JSON.stringify(state));
    invalidClassification.sessions[0].excluded[0].classification = 'unknown';
    assert.deepEqual(Core.normalizeState(invalidClassification), Core.createDefaultState());

    const corrupt = JSON.parse(JSON.stringify(state));
    corrupt.sessions[0].seen.push({
        videoId: IDS.b,
        firstSeenAt: 1,
        lastSeenAt: 1,
        activeWatchMs: 500,
        order: 1,
    });
    assert.deepEqual(Core.normalizeState(corrupt), Core.createDefaultState());
    assert.deepEqual(Core.normalizeState({ schemaVersion: 999 }), Core.createDefaultState());
});

test('clear keeps settings but removes every session', () => {
    const state = Core.createDefaultState();
    state.settings = { harvestDurationSeconds: 120 };
    state.sessions.push(makeSession());
    state.activeSessionId = state.sessions[0].id;
    assert.deepEqual(Core.clearCollectedData(state), {
        schemaVersion: Core.SCHEMA_VERSION,
        settings: { harvestDurationSeconds: 120, naturalSessionSeconds: 60 },
        activeSessionId: null,
        sessions: [],
    });
});

test('natural sessions lock their own duration and complete without a reserved queue', () => {
    const session = Core.createSession({
        harvestDurationSeconds: 45,
        naturalSessionSeconds: 15,
    }, {
        id: 'natural-session-test',
        seed: 17,
        startedAt: 1000,
        targetTabId: 77,
        targetTabOwned: true,
        collectionMode: Core.COLLECTION_MODE.NATURAL_FYP_SESSION,
        deliveryTarget: Core.DELIVERY_TARGET.QUALTRICS,
    });
    assert.equal(session.collectionMode, Core.COLLECTION_MODE.NATURAL_FYP_SESSION);
    assert.equal(session.captureStrategy, Core.CAPTURE_STRATEGY.NATURAL_EXPOSURE);
    assert.deepEqual(session.lockedSettings, { naturalSessionSeconds: 15 });
    assert.equal(session.targetTabOwned, true);
    assert.equal(session.harvestDeadlineAt, null);
    assert.equal(Core.sessionProgress(session, 5000).unseenComplete, true);

    for (let index = 0; index < 60; index += 1) {
        const applied = Core.applyNaturalActivity(session, {
            at: 1250 + index * 250,
            samples: [{
                videoId: index < 30 ? IDS.a : IDS.b,
                qualifiedDeltaMs: 250,
                watchDeltaMs: index === 1 || index === 31 ? 500 : index > 1 ? 250 : 0,
                firstSeenAt: 1000,
                feedOrder: index < 30 ? 1 : 2,
            }],
        });
        assert.equal(applied.applied, true);
    }
    assert.equal(session.qualifiedMs, 15000);
    assert.equal(session.seen.length, 2);
    assert.equal(Core.evaluateCompletion(session, 17000), true);
    assert.equal(session.status, Core.SESSION_STATUS.COMPLETE);
    assert.deepEqual(Core.viewerQueue(session), []);
});

test('natural activity stores bounded counts and state markers but no raw inputs', () => {
    const session = Core.createSession({ naturalSessionSeconds: 60 }, {
        id: 'natural-activity-test',
        seed: 18,
        startedAt: 1000,
        collectionMode: Core.COLLECTION_MODE.NATURAL_FYP_SESSION,
    });
    const result = Core.applyNaturalActivity(session, {
        at: 2000,
        activity: {
            pointerMoveBursts: 3,
            clicks: 2,
            wheelEvents: 4,
            keyEvents: 5,
            clientX: 900,
            key: 'Secret',
        },
        durationDeltas: { tabAwayMs: 500, windowBlurMs: 250 },
        counterDeltas: {
            tabAwayCount: 1,
            windowBlurCount: 1,
            videoTransitions: 2,
            pauseCount: 1,
            resumeCount: 1,
        },
        reasonCounts: { counting: 2, 'not allowed!': 99 },
        markers: [
            { type: 'tab_away', at: 1800 },
            { type: 'video_transition', at: 1900, videoId: IDS.b },
            { type: 'raw_key', at: 1950 },
        ],
    });
    assert.equal(result.applied, true);
    assert.equal(session.naturalActivity.pointerMoveBursts, 3);
    assert.equal(session.naturalActivity.keyEvents, 5);
    assert.equal(session.naturalActivity.tabAwayMs, 500);
    assert.equal(session.naturalActivity.events.length, 2);
    assert.equal(session.naturalActivity.qualificationReasonCounts.counting, 2);
    const serialized = JSON.stringify(session.naturalActivity);
    assert.equal(serialized.includes('Secret'), false);
    assert.equal(serialized.includes('clientX'), false);
    assert.equal(serialized.includes('raw_key'), false);
});

test('schema 4 state migrates compatibly and keeps an active background session', () => {
    const session = makeSession({ harvestDurationSeconds: 30 });
    const migrated = Core.normalizeState({
        schemaVersion: 4,
        settings: { harvestDurationSeconds: 45 },
        activeSessionId: session.id,
        sessions: [session],
    });
    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migrated.activeSessionId, session.id);
    assert.equal(migrated.sessions[0].status, Core.SESSION_STATUS.COLLECTING);
    assert.deepEqual(migrated.settings, {
        harvestDurationSeconds: 45,
        naturalSessionSeconds: 60,
    });
});

test('serialized pilot state contains no URL, handle, caption, or HTML fields', () => {
    const session = makeSession();
    reserve(session, IDS.b, 2);
    Core.applyActivity(session, {
        at: 2200,
        qualifiedDeltaMs: 250,
        videoId: IDS.a,
        seenDeltaMs: 500,
        firstSeenAt: 1700,
    });
    const serialized = JSON.stringify(session);
    assert.equal(serialized.includes('http'), false);
    assert.equal(serialized.includes('@'), false);
    assert.equal(serialized.includes('caption'), false);
    assert.equal(serialized.includes('<'), false);
});
