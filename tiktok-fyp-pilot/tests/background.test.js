'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Core = require('../lib/core.js');

const root = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const extensionId = 'test-extension-id';

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function eventSlot() {
    const listeners = [];
    return {
        listeners,
        addListener(listener) {
            listeners.push(listener);
        },
    };
}

function urlMatches(pattern, value) {
    if (typeof value !== 'string') {
        return false;
    }
    const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(value);
}

function createHarness(options = {}) {
    let stored = clone(options.state || Core.createDefaultState());
    let sessionStored = options.browserInitialized === false
        ? {}
        : { viewerLeaseEpochInitialized: true };
    let permissionGranted = options.permissionGranted !== false;
    let nextTabId = 100;
    const registered = clone(options.registered || []);
    const tabs = clone(options.tabs || []);
    const log = [];
    const runtimeMessage = eventSlot();
    const runtimeInstalled = eventSlot();
    const runtimeStartup = eventSlot();
    const permissionRemoved = eventSlot();
    const tabRemoved = eventSlot();
    const alarmEvent = eventSlot();
    const alarms = new Map();

    const chrome = {
        runtime: {
            id: extensionId,
            lastError: null,
            getURL(relativePath) {
                return `chrome-extension://${extensionId}/${relativePath}`;
            },
            onMessage: runtimeMessage,
            onInstalled: runtimeInstalled,
            onStartup: runtimeStartup,
        },
        storage: {
            local: {
                async get(key) {
                    return key === 'pilotState' ? { pilotState: clone(stored) } : {};
                },
                async set(value) {
                    stored = clone(value.pilotState);
                    log.push('storage.set');
                },
                async setAccessLevel() {
                    log.push('storage.trusted');
                },
            },
            session: {
                async get(key) {
                    return Object.prototype.hasOwnProperty.call(sessionStored, key)
                        ? { [key]: clone(sessionStored[key]) }
                        : {};
                },
                async set(value) {
                    sessionStored = { ...sessionStored, ...clone(value) };
                    log.push('storage.session.set');
                },
                async setAccessLevel() {
                    log.push('storage.session.trusted');
                },
            },
        },
        permissions: {
            async contains() {
                return permissionGranted;
            },
            async remove() {
                log.push('permissions.remove');
                const removed = permissionGranted;
                permissionGranted = false;
                return removed;
            },
            onRemoved: permissionRemoved,
        },
        alarms: {
            async create(name, details) {
                alarms.set(name, { name, scheduledTime: details.when });
                log.push(`alarms.create:${name}`);
            },
            async clear(name) {
                const existed = alarms.delete(name);
                log.push(`alarms.clear:${name}`);
                return existed;
            },
            async getAll() {
                return clone(Array.from(alarms.values()));
            },
            onAlarm: alarmEvent,
        },
        scripting: {
            async getRegisteredContentScripts() {
                return clone(registered);
            },
            async registerContentScripts(scripts) {
                if (registered.length) {
                    throw new Error('duplicate_script_id');
                }
                registered.push(...clone(scripts));
                log.push('scripting.register');
            },
            async unregisterContentScripts() {
                registered.splice(0);
                log.push('scripting.unregister');
            },
            async executeScript(details) {
                log.push(`scripting.execute:${details.target.tabId}`);
                return [];
            },
        },
        tabs: {
            async query(query = {}) {
                return clone(tabs.filter((tab) => {
                    if (query.currentWindow && tab.windowId !== 1) {
                        return false;
                    }
                    if (query.active === true && tab.active !== true) {
                        return false;
                    }
                    return !query.url || urlMatches(query.url, tab.url);
                }));
            },
            async create(createProperties) {
                const tab = {
                    id: nextTabId,
                    windowId: 1,
                    active: Boolean(createProperties.active),
                    url: createProperties.url,
                };
                nextTabId += 1;
                tabs.push(tab);
                log.push(`tabs.create:${createProperties.url}`);
                return clone(tab);
            },
            async update(tabId, updateProperties) {
                const tab = tabs.find((item) => item.id === tabId);
                if (!tab) {
                    throw new Error('tab_not_found');
                }
                Object.assign(tab, updateProperties);
                log.push(`tabs.update:${tabId}`);
                return clone(tab);
            },
            async reload(tabId) {
                if (!tabs.some((tab) => tab.id === tabId)) {
                    throw new Error('tab_not_found');
                }
                log.push(`tabs.reload:${tabId}`);
            },
            async remove(tabId) {
                const index = tabs.findIndex((tab) => tab.id === tabId);
                if (index !== -1) {
                    tabs.splice(index, 1);
                }
                log.push(`tabs.remove:${tabId}`);
            },
            async sendMessage(tabId, message) {
                log.push(`tabs.sendMessage:${tabId}:${message.type}`);
                return { ok: true };
            },
            async get(tabId) {
                const tab = tabs.find((item) => item.id === tabId);
                if (!tab) {
                    throw new Error('tab_not_found');
                }
                const result = clone(tab);
                if (options.scrubTabUrlOnGet) {
                    delete result.url;
                }
                return result;
            },
            onRemoved: tabRemoved,
        },
        windows: {
            async update(windowId) {
                log.push(`windows.focus:${windowId}`);
            },
        },
    };

    const context = vm.createContext({
        URL,
        URLSearchParams,
        console,
        crypto: webcrypto,
        chrome,
        setTimeout: options.immediateTimers
            ? (callback) => {
                callback();
                return 1;
            }
            : setTimeout,
        clearTimeout,
    });
    context.globalThis = context;
    context.importScripts = () => {
        context.TikTokPilotCore = Core;
    };
    vm.runInContext(backgroundSource, context, { filename: 'background.js' });

    function dispatch(message, sender) {
        const listener = runtimeMessage.listeners[0];
        return new Promise((resolve) => {
            listener(message, sender, resolve);
        });
    }

    return {
        dispatch,
        async emitStartup() {
            await Promise.all(runtimeStartup.listeners.map((listener) => listener()));
        },
        async emitAlarm(name) {
            await Promise.all(alarmEvent.listeners.map((listener) => listener({ name })));
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
        getState: () => clone(stored),
        getPermission: () => permissionGranted,
        registered,
        tabs,
        log,
        alarms,
    };
}

function popupSender() {
    return {
        id: extensionId,
        url: `chrome-extension://${extensionId}/popup/popup.html`,
    };
}

function inspectorSender() {
    return {
        id: extensionId,
        url: `chrome-extension://${extensionId}/inspector/inspector.html`,
    };
}

function collectorSender(tabId = 42) {
    return {
        id: extensionId,
        url: 'https://www.tiktok.com/foryou',
        tab: { id: tabId },
        frameId: 0,
    };
}

function tiktokSender(url, tabId = 42) {
    return {
        id: extensionId,
        url,
        tab: { id: tabId },
        frameId: 0,
    };
}

function viewerSender(sessionId, tabId) {
    return {
        id: extensionId,
        url: `chrome-extension://${extensionId}/viewer/viewer.html?session=${sessionId}`,
        tab: { id: tabId },
        frameId: 0,
    };
}

function collectingState() {
    const state = Core.createDefaultState();
    const session = Core.createSession({ harvestTimeoutSeconds: 90, targetUnseenCount: 5 }, {
        id: 'session-background-test',
        seed: 123,
        startedAt: Date.now(),
        targetTabId: 42,
    });
    state.sessions.push(session);
    state.activeSessionId = session.id;
    return state;
}

function reserveOne(session, videoId = '7311111111111111111') {
    const prepared = Core.reserveVideo(session, {
        videoId,
        batchId: 'batch-1',
        batchNumber: 1,
        at: Date.now(),
        evidence: {
            feedOrder: 2,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    });
    if (prepared.applied) {
        Core.confirmReservation(session, videoId, Date.now());
    }
    return prepared;
}

function completeState() {
    const state = Core.createDefaultState();
    const session = Core.createSession({ harvestTimeoutSeconds: 90, targetUnseenCount: 1 }, {
        id: 'session-viewer-test',
        seed: 456,
        startedAt: Date.now(),
        targetTabId: 42,
    });
    reserveOne(session);
    Core.evaluateCompletion(session, Date.now());
    session.viewerTabOpenedAt = 0;
    state.sessions.push(session);
    state.activeSessionId = session.id;
    return state;
}

test('concurrent starts serialize registration and create only one session', async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([
        harness.dispatch({ type: Core.MESSAGE_TYPES.START_SESSION }, popupSender()),
        harness.dispatch({ type: Core.MESSAGE_TYPES.START_SESSION }, popupSender()),
    ]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
    assert.equal(harness.registered.length, 1);
    assert.equal(harness.getState().sessions.length, 1);
    assert.equal(
        harness.tabs.filter((tab) => tab.url === Core.TIKTOK_FYP_URL).length,
        1
    );
});

test('collector updates are tab-bound and clear wins after queued activity', async () => {
    const state = collectingState();
    const harness = createHarness({
        state,
        tabs: [{ id: 42, windowId: 1, active: true, url: Core.TIKTOK_FYP_URL }],
    });
    const wrong = await harness.dispatch({
        type: Core.MESSAGE_TYPES.ACTIVITY_TICK,
        sessionId: state.activeSessionId,
        sourceId: 'source-wrong-tab',
        sequence: 1,
        qualifiedDeltaMs: 250,
    }, collectorSender(99));
    assert.equal(wrong.ok, false);

    await Promise.all([
        harness.dispatch({
            type: Core.MESSAGE_TYPES.ACTIVITY_TICK,
            sessionId: state.activeSessionId,
            sourceId: 'source-correct-tab',
            sequence: 1,
            qualifiedDeltaMs: 250,
        }, collectorSender(42)),
        harness.dispatch({ type: Core.MESSAGE_TYPES.CLEAR_DATA }, inspectorSender()),
    ]);
    assert.equal(harness.getState().sessions.length, 0);
    assert.equal(harness.getState().activeSessionId, null);
});

test('ambiguous-card exclusion persists and blocks a later reservation', async () => {
    const state = collectingState();
    const firstHarness = createHarness({ state });
    const excluded = await firstHarness.dispatch({
        type: Core.MESSAGE_TYPES.EXCLUDE_VIDEO,
        sessionId: state.activeSessionId,
        sourceId: 'source-ambiguous-card',
        sequence: 1,
        videoId: '7311111111111111111',
        classification: 'ambiguous_card',
        feedOrder: 3,
    }, collectorSender(42));
    assert.equal(excluded.ok, true);
    const restored = firstHarness.getState();
    assert.equal(restored.sessions[0].excluded[0].classification, 'ambiguous_card');

    const secondHarness = createHarness({ state: restored });
    const reservation = await secondHarness.dispatch({
        type: Core.MESSAGE_TYPES.RESERVE_VIDEO,
        sessionId: state.activeSessionId,
        sourceId: 'source-after-restore',
        sequence: 1,
        videoId: '7311111111111111111',
        batchId: 'batch-after-restore',
        batchNumber: 1,
        evidence: {
            feedOrder: 4,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    }, collectorSender(42));
    assert.equal(reservation.ok, false);
    assert.equal(reservation.error, 'already_exposed');
});

test('a closed target never silently rebinds and resumes only through the popup', async () => {
    const state = collectingState();
    state.sessions[0].targetTabId = null;
    const harness = createHarness({ state });
    const context = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT },
        collectorSender(77)
    );
    assert.equal(context.active, false);
    assert.equal(harness.getState().sessions[0].targetTabId, null);

    const resumed = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.RESUME_SESSION },
        popupSender()
    );
    assert.equal(resumed.ok, true);
    const targetTabId = harness.getState().sessions[0].targetTabId;
    assert.equal(Number.isInteger(targetTabId), true);
    assert.equal(
        harness.tabs.find((tab) => tab.id === targetTabId).url,
        Core.TIKTOK_FYP_URL
    );
});

test('collector readiness records hidden state and restores the originating tab', async () => {
    const harness = createHarness({
        tabs: [
            { id: 7, windowId: 1, active: true, url: 'https://experiment.test/task' },
            { id: 42, windowId: 1, active: false, url: Core.TIKTOK_FYP_URL },
        ],
    });
    const started = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.START_SESSION },
        popupSender()
    );
    assert.equal(started.ok, true);
    const ready = await harness.dispatch({
        type: Core.MESSAGE_TYPES.COLLECTOR_READY,
        sessionId: started.sessionId,
        sourceId: 'source-ready-hidden',
        sequence: 1,
        visibility: 'hidden',
        timerDelayMs: 1300,
    }, collectorSender(42));
    assert.equal(ready.ok, true);
    assert.equal(ready.returned, true);
    assert.equal(harness.log.includes('tabs.update:7'), true);
    const step = harness.getState().sessions[0].harvestSteps[0];
    assert.equal(step.visibility, 'hidden');
});

test('timeout rejects a partial bank, opens no viewer, and focuses the covered tab', async () => {
    const state = collectingState();
    reserveOne(state.sessions[0]);
    state.sessions[0].startedAt = Date.now() - 100000;
    state.sessions[0].harvestStartedAt = state.sessions[0].startedAt;
    state.sessions[0].harvestDeadlineAt = Date.now() - 1;
    const harness = createHarness({
        state,
        tabs: [{ id: 42, windowId: 1, active: false, url: Core.TIKTOK_FYP_URL }],
    });
    const response = await harness.dispatch({
        type: Core.MESSAGE_TYPES.HARVEST_STEP,
        sessionId: state.activeSessionId,
        sourceId: 'source-timeout',
        sequence: 1,
        phase: 'waiting_hydration',
        visibility: 'hidden',
        timerDelayMs: 2000,
        hydrationLatencyMs: 8000,
        advanceAttempt: 3,
    }, collectorSender(42));
    assert.equal(response.failed, true);
    assert.equal(harness.getState().sessions[0].status, Core.SESSION_STATUS.FAILED);
    assert.equal(harness.getState().sessions[0].reserved[0].state, 'invalidated');
    assert.equal(
        harness.tabs.some((tab) => tab.url.includes('/viewer/viewer.html?session=')),
        false
    );
    assert.equal(harness.log.includes('tabs.update:42'), true);
});

test('deadline alarm fails a fully throttled hidden collector and reports to its overlay', async () => {
    const state = collectingState();
    reserveOne(state.sessions[0]);
    state.sessions[0].startedAt = Date.now() - 100000;
    state.sessions[0].harvestStartedAt = state.sessions[0].startedAt;
    state.sessions[0].harvestDeadlineAt = Date.now() - 1;
    const harness = createHarness({
        state,
        tabs: [{ id: 42, windowId: 1, active: false, url: Core.TIKTOK_FYP_URL }],
    });
    await harness.emitAlarm(`harvest-deadline:${state.activeSessionId}`);
    assert.equal(harness.getState().sessions[0].status, Core.SESSION_STATUS.FAILED);
    assert.equal(harness.getState().sessions[0].reserved[0].state, 'invalidated');
    assert.equal(
        harness.log.includes('tabs.sendMessage:42:STATE_UPDATED'),
        true
    );
    assert.equal(harness.log.includes('tabs.update:42'), true);
});

test('unsupported TikTok state may fail bound collection without bypassing the page', async () => {
    const state = collectingState();
    const harness = createHarness({
        state,
        tabs: [{ id: 42, windowId: 1, active: false, url: 'https://www.tiktok.com/login' }],
    });
    const response = await harness.dispatch({
        type: Core.MESSAGE_TYPES.HARVEST_FAIL,
        sessionId: state.activeSessionId,
        sourceId: 'source-login',
        sequence: 1,
        reason: 'login_or_unsupported_page',
        detail: { pathCode: 'not_fyp' },
    }, tiktokSender('https://www.tiktok.com/login'));
    assert.equal(response.ok, true);
    assert.equal(harness.getState().sessions[0].status, Core.SESSION_STATUS.FAILED);
});

test('popup retry reuses the failed bound tab but creates a fresh empty session', async () => {
    const state = collectingState();
    reserveOne(state.sessions[0]);
    Core.failHarvest(state.sessions[0], Date.now(), 'harvest_stalled');
    const harness = createHarness({
        state,
        tabs: [
            { id: 7, windowId: 1, active: true, url: 'https://experiment.test/task' },
            { id: 42, windowId: 1, active: false, url: 'https://www.tiktok.com/login' },
        ],
    });
    const response = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.START_SESSION },
        popupSender()
    );
    assert.equal(response.ok, true);
    const nextState = harness.getState();
    assert.equal(nextState.sessions.length, 2);
    assert.equal(nextState.sessions[0].status, Core.SESSION_STATUS.FAILED);
    assert.equal(nextState.sessions[1].status, Core.SESSION_STATUS.COLLECTING);
    assert.equal(nextState.sessions[1].reserved.length, 0);
    assert.equal(nextState.sessions[1].targetTabId, 42);
    assert.equal(harness.tabs.find((tab) => tab.id === 42).url, Core.TIKTOK_FYP_URL);
});

test('browser restart invalidates the old collection-tab capability until explicit resume', async () => {
    const state = collectingState();
    reserveOne(state.sessions[0]);
    const harness = createHarness({
        state,
        browserInitialized: false,
    });
    const staleContext = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT },
        collectorSender(42)
    );
    assert.equal(staleContext.active, true);
    assert.equal(staleContext.mode, 'guard');
    assert.deepEqual(staleContext.session.tombstones, ['7311111111111111111']);
    assert.equal(harness.getState().sessions[0].targetTabId, null);

    const staleActivity = await harness.dispatch({
        type: Core.MESSAGE_TYPES.ACTIVITY_TICK,
        sessionId: state.activeSessionId,
        sourceId: 'source-stale-restart',
        sequence: 1,
        qualifiedDeltaMs: 250,
    }, collectorSender(42));
    assert.equal(staleActivity.ok, false);

    const resumed = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.RESUME_SESSION },
        popupSender()
    );
    assert.equal(resumed.ok, true);
    assert.equal(Number.isInteger(harness.getState().sessions[0].targetTabId), true);
});

test('a second FYP tab receives tombstone guard but cannot collect', async () => {
    const state = collectingState();
    reserveOne(state.sessions[0]);
    const harness = createHarness({ state });
    const bound = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT },
        collectorSender(42)
    );
    const second = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT },
        collectorSender(99)
    );
    assert.equal(bound.mode, 'collecting');
    assert.equal(bound.session.boundTab, true);
    assert.equal(second.mode, 'guard');
    assert.equal(second.session.boundTab, false);
    assert.deepEqual(second.session.tombstones, ['7311111111111111111']);

    const activity = await harness.dispatch({
        type: Core.MESSAGE_TYPES.ACTIVITY_TICK,
        sessionId: state.activeSessionId,
        sourceId: 'source-second-tab',
        sequence: 1,
        qualifiedDeltaMs: 250,
    }, collectorSender(99));
    assert.equal(activity.ok, false);
});

test('the first confirmed concealment activates guards in FYP tabs already open', async () => {
    const state = collectingState();
    const harness = createHarness({
        state,
        tabs: [
            { id: 42, windowId: 1, active: true, url: Core.TIKTOK_FYP_URL },
            { id: 99, windowId: 1, active: false, url: Core.TIKTOK_FYP_URL },
        ],
    });
    const prepared = await harness.dispatch({
        type: Core.MESSAGE_TYPES.RESERVE_VIDEO,
        sessionId: state.activeSessionId,
        sourceId: 'source-first-tombstone',
        sequence: 1,
        videoId: '7311111111111111111',
        batchId: 'batch-first-tombstone',
        batchNumber: 1,
        evidence: {
            feedOrder: 3,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    }, collectorSender(42));
    assert.equal(prepared.ok, true);
    assert.equal(harness.log.includes('scripting.execute:99'), false);
    const response = await harness.dispatch({
        type: Core.MESSAGE_TYPES.CONFIRM_RESERVATION,
        sessionId: state.activeSessionId,
        sourceId: 'source-first-tombstone',
        sequence: 2,
        videoId: '7311111111111111111',
    }, collectorSender(42));
    assert.equal(response.ok, true);
    assert.equal(harness.log.includes('scripting.execute:99'), true);
    assert.equal(harness.log.includes('tabs.sendMessage:99:STATE_UPDATED'), true);
});

test('concurrent viewer opens use one claimed extension tab', async () => {
    const state = completeState();
    const harness = createHarness({ state });
    const [first, second] = await Promise.all([
        harness.dispatch({
            type: Core.MESSAGE_TYPES.OPEN_VIEWER,
            sessionId: state.activeSessionId,
        }, popupSender()),
        harness.dispatch({
            type: Core.MESSAGE_TYPES.OPEN_VIEWER,
            sessionId: state.activeSessionId,
        }, popupSender()),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const viewerTabs = harness.tabs.filter((tab) => tab.url.includes('/viewer/viewer.html?session='));
    assert.equal(viewerTabs.length, 1);
    assert.equal(harness.getState().sessions[0].viewerTabId, viewerTabs[0].id);
});

test('tracked viewer tab is restored without reading its redacted URL', async () => {
    const state = completeState();
    state.sessions[0].viewerTabId = 90;
    state.sessions[0].viewerTabOpenedAt = Date.now();
    const harness = createHarness({
        state,
        scrubTabUrlOnGet: true,
        tabs: [{ id: 90, windowId: 1, active: false, url: 'https://example.test/' }],
    });
    const response = await harness.dispatch({
        type: Core.MESSAGE_TYPES.OPEN_VIEWER,
        sessionId: state.activeSessionId,
    }, popupSender());
    assert.equal(response.ok, true);
    assert.equal(response.reused, true);
    assert.equal(harness.tabs.length, 1);
    assert.equal(
        harness.tabs[0].url,
        `chrome-extension://${extensionId}/viewer/viewer.html?session=${state.activeSessionId}`
    );
    assert.equal(harness.log.some((entry) => entry.startsWith('tabs.create:')), false);
});

test('startup clears stale leases and recreates one missing active viewer', async () => {
    const state = completeState();
    state.sessions[0].viewerTabId = 90;
    state.sessions[0].viewerTabOpenedAt = -1;
    const harness = createHarness({
        state,
        browserInitialized: false,
        immediateTimers: true,
    });
    await harness.emitStartup();
    const viewerTabs = harness.tabs.filter(
        (tab) => tab.url.includes('/viewer/viewer.html?session=')
    );
    assert.equal(viewerTabs.length, 1);
    assert.equal(harness.getState().sessions[0].viewerTabId, viewerTabs[0].id);
});

test('a restored viewer claim cannot be erased by the startup reset', async () => {
    const state = completeState();
    state.sessions[0].viewerTabId = 90;
    state.sessions[0].viewerTabOpenedAt = Date.now();
    const harness = createHarness({
        state,
        browserInitialized: false,
        immediateTimers: true,
        tabs: [{
            id: 91,
            windowId: 1,
            active: true,
            url: `chrome-extension://${extensionId}/viewer/viewer.html?session=${state.activeSessionId}`,
        }],
    });
    const claim = harness.dispatch({
        type: Core.MESSAGE_TYPES.GET_VIEWER_SESSION,
        sessionId: state.activeSessionId,
    }, viewerSender(state.activeSessionId, 91));
    const response = await claim;
    assert.equal(response.ok, true);
    assert.equal(harness.getState().sessions[0].viewerTabId, 91);
    await harness.emitStartup();
    assert.equal(harness.getState().sessions[0].viewerTabId, 91);
    assert.equal(
        harness.tabs.filter((tab) => tab.url.includes('/viewer/viewer.html?session=')).length,
        1
    );
    assert.equal(harness.log.some((entry) => entry.startsWith('tabs.create:')), false);
});

test('a prepared reservation cannot complete collection or open a viewer', async () => {
    const state = collectingState();
    const session = state.sessions[0];
    session.lockedSettings = { harvestTimeoutSeconds: 90, targetUnseenCount: 1 };
    const harness = createHarness({ state });
    const response = await harness.dispatch({
        type: Core.MESSAGE_TYPES.RESERVE_VIDEO,
        sessionId: session.id,
        sourceId: 'source-prepared-only',
        sequence: 1,
        videoId: '7311111111111111111',
        batchId: 'batch-1',
        batchNumber: 1,
        evidence: {
            feedOrder: 3,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    }, collectorSender(42));
    assert.equal(response.ok, true);
    assert.equal(harness.getState().sessions[0].reserved[0].state, 'prepared');
    assert.equal(harness.getState().sessions[0].status, Core.SESSION_STATUS.COLLECTING);
    assert.equal(
        harness.tabs.filter((tab) => tab.url.includes('/viewer/viewer.html?session=')).length,
        0
    );
});

test('the final concealment confirmation completes collection and opens exactly one viewer', async () => {
    const state = collectingState();
    const session = state.sessions[0];
    session.lockedSettings = { harvestTimeoutSeconds: 90, targetUnseenCount: 1 };
    const harness = createHarness({ state });
    const prepared = await harness.dispatch({
        type: Core.MESSAGE_TYPES.RESERVE_VIDEO,
        sessionId: session.id,
        sourceId: 'source-final-unseen',
        sequence: 1,
        videoId: '7311111111111111111',
        batchId: 'batch-1',
        batchNumber: 1,
        evidence: {
            feedOrder: 3,
            aheadBy: 2,
            intersectionRatio: 0,
            belowViewport: true,
            everIntersected: false,
            connected: true,
            occurrenceCount: 1,
        },
    }, collectorSender(42));
    assert.equal(prepared.ok, true);
    const confirmationMessage = {
        type: Core.MESSAGE_TYPES.CONFIRM_RESERVATION,
        sessionId: session.id,
        sourceId: 'source-final-unseen',
        sequence: 2,
        videoId: '7311111111111111111',
    };
    const response = await harness.dispatch(confirmationMessage, collectorSender(42));
    assert.equal(response.ok, true);
    const retriedResponse = await harness.dispatch(confirmationMessage, collectorSender(42));
    assert.equal(retriedResponse.ok, true);
    assert.equal(retriedResponse.duplicate, true);
    assert.equal(harness.getState().sessions[0].status, Core.SESSION_STATUS.COMPLETE);
    assert.equal(
        harness.tabs.filter((tab) => tab.url.includes('/viewer/viewer.html?session=')).length,
        1
    );
});

test('viewer events require the claimed tab and terminal retries are idempotent', async () => {
    const state = completeState();
    state.sessions[0].viewerTabId = 90;
    state.sessions[0].viewerTabOpenedAt = Date.now();
    const harness = createHarness({
        state,
        tabs: [{
            id: 90,
            windowId: 1,
            active: true,
            url: `chrome-extension://${extensionId}/viewer/viewer.html?session=${state.activeSessionId}`,
        }],
    });
    const wrong = await harness.dispatch({
        type: Core.MESSAGE_TYPES.VIEWER_EVENT,
        sessionId: state.activeSessionId,
        videoId: '7311111111111111111',
        eventType: 'player_error',
        value: { code: 1001, category: 'INVALID_VIDEO' },
    }, viewerSender(state.activeSessionId, 91));
    assert.equal(wrong.error, 'wrong_viewer_tab');

    const message = {
        type: Core.MESSAGE_TYPES.VIEWER_EVENT,
        sessionId: state.activeSessionId,
        videoId: '7311111111111111111',
        eventType: 'player_error',
        value: { code: 1001, category: 'INVALID_VIDEO' },
    };
    assert.equal((await harness.dispatch(message, viewerSender(state.activeSessionId, 90))).ok, true);
    assert.equal((await harness.dispatch(message, viewerSender(state.activeSessionId, 90))).ok, true);
});

test('revoke shuts collectors down before unregistering and removing permission', async () => {
    const state = collectingState();
    const harness = createHarness({
        state,
        registered: [{ id: Core.CONTENT_SCRIPT_ID }],
        tabs: [{ id: 42, windowId: 1, active: true, url: Core.TIKTOK_FYP_URL }],
    });
    const response = await harness.dispatch(
        { type: Core.MESSAGE_TYPES.REVOKE_ACCESS },
        inspectorSender()
    );
    assert.equal(response.ok, true);
    assert.equal(harness.getPermission(), false);
    assert.equal(harness.registered.length, 0);
    assert.equal(harness.getState().activeSessionId, null);
    const shutdownIndex = harness.log.findIndex((entry) => entry.includes('SHUTDOWN_COLLECTOR'));
    const unregisterIndex = harness.log.indexOf('scripting.unregister');
    const removeIndex = harness.log.indexOf('permissions.remove');
    assert.equal(shutdownIndex >= 0, true);
    assert.equal(shutdownIndex < unregisterIndex, true);
    assert.equal(unregisterIndex < removeIndex, true);
});
