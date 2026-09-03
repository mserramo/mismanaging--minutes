/* global TikTokPilotCore */
'use strict';

importScripts('lib/core.js');

const Core = TikTokPilotCore;
const STATE_KEY = 'pilotState';
const BROWSER_SESSION_MARKER = 'viewerLeaseEpochInitialized';
const RETURN_TABS_KEY = 'harvestReturnTabs';
const HARVEST_ALARM_PREFIX = 'harvest-deadline:';
const STARTUP_VIEWER_RECOVERY_MS = 1500;
const QUALTRICS_BRIDGE_NAME = 'tiktok-fyp-qualtrics-v1';
const QUALTRICS_BRIDGE_VERSION = 4;
const QUALTRICS_HOST = 'stanforduniversity.qualtrics.com';
let mutationQueue = Promise.resolve();
let registrationQueue = Promise.resolve();

function extensionPagePath(sender, expectedPath) {
    if (
        !sender ||
        sender.id !== chrome.runtime.id ||
        typeof sender.url !== 'string'
    ) {
        return false;
    }
    try {
        const url = new URL(sender.url);
        return (
            url.protocol === 'chrome-extension:' &&
            url.host === chrome.runtime.id &&
            url.pathname === expectedPath
        );
    } catch (_error) {
        return false;
    }
}

function isPopup(sender) {
    return extensionPagePath(sender, '/popup/popup.html');
}

function isOptions(sender) {
    return extensionPagePath(sender, '/options/options.html');
}

function isInspector(sender) {
    return extensionPagePath(sender, '/inspector/inspector.html');
}

function isViewer(sender) {
    return extensionPagePath(sender, '/viewer/viewer.html');
}

function isViewerForSession(sender, sessionId) {
    if (!isViewer(sender) || typeof sessionId !== 'string') {
        return false;
    }
    try {
        const url = new URL(sender.url);
        return url.searchParams.get('session') === sessionId;
    } catch (_error) {
        return false;
    }
}

function isTrustedExtensionPage(sender) {
    return isPopup(sender) || isOptions(sender) || isInspector(sender) || isViewer(sender);
}

function isTikTokCollector(sender) {
    if (
        !sender ||
        sender.id !== chrome.runtime.id ||
        !sender.tab ||
        sender.frameId !== 0 ||
        typeof sender.url !== 'string'
    ) {
        return false;
    }
    try {
        const url = new URL(sender.url);
        return url.origin === Core.TIKTOK_ORIGIN;
    } catch (_error) {
        return false;
    }
}

function isTikTokFypCollector(sender) {
    if (!isTikTokCollector(sender)) {
        return false;
    }
    try {
        return Core.isFypPath(new URL(sender.url).pathname);
    } catch (_error) {
        return false;
    }
}

function isAllowedQualtricsSender(sender) {
    if (!sender || !sender.tab || !Number.isInteger(sender.tab.id) ||
        !Number.isInteger(sender.frameId) || sender.frameId < 0 ||
        typeof sender.url !== 'string') {
        return false;
    }
    try {
        const url = new URL(sender.url);
        return url.protocol === 'https:' && url.hostname === QUALTRICS_HOST;
    } catch (_error) {
        return false;
    }
}

async function readState() {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return Core.normalizeState(stored[STATE_KEY]);
}

async function writeState(state) {
    await chrome.storage.local.set({ [STATE_KEY]: state });
}

function mutateState(mutator) {
    const operation = mutationQueue.then(async () => {
        const state = await readState();
        const result = await mutator(state);
        await writeState(state);
        return { state, result };
    });
    mutationQueue = operation.catch(() => undefined);
    return operation;
}

async function initializeBrowserLifetime() {
    const marker = await chrome.storage.session.get(BROWSER_SESSION_MARKER);
    if (marker[BROWSER_SESSION_MARKER] === true) {
        return { freshBrowserLifetime: false };
    }
    await mutateState((state) => {
        state.sessions.forEach((session) => {
            // Target and viewer tab IDs are capabilities scoped to one browser
            // lifetime. Collection must be explicitly rebound from the popup.
            session.targetTabId = null;
            session.viewerTabId = null;
            if (session.viewerTabOpenedAt === -1) {
                session.viewerTabOpenedAt = 0;
            }
        });
        return { ok: true };
    });
    await chrome.storage.session.set({
        [BROWSER_SESSION_MARKER]: true,
        [RETURN_TABS_KEY]: {},
    });
    return { freshBrowserLifetime: true };
}

async function readReturnTabs() {
    const stored = await chrome.storage.session.get(RETURN_TABS_KEY);
    const input = stored[RETURN_TABS_KEY];
    return input && typeof input === 'object' ? input : {};
}

async function rememberReturnTab(sessionId, tabId) {
    if (!Number.isInteger(tabId)) {
        return;
    }
    const tabs = await readReturnTabs();
    tabs[sessionId] = tabId;
    await chrome.storage.session.set({ [RETURN_TABS_KEY]: tabs });
}

async function forgetReturnTab(sessionId) {
    const tabs = await readReturnTabs();
    delete tabs[sessionId];
    await chrome.storage.session.set({ [RETURN_TABS_KEY]: tabs });
}

async function forgetReturnTabs() {
    await chrome.storage.session.set({ [RETURN_TABS_KEY]: {} });
}

async function focusTab(tabId) {
    if (!Number.isInteger(tabId)) {
        return false;
    }
    try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (tab && Number.isInteger(tab.windowId)) {
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
        }
        return true;
    } catch (_error) {
        return false;
    }
}

function harvestAlarmName(sessionId) {
    return `${HARVEST_ALARM_PREFIX}${sessionId}`;
}

async function scheduleHarvestAlarm(session) {
    if (
        !session ||
        session.collectionMode !== Core.COLLECTION_MODE.AUTOMATED_BACKGROUND ||
        session.status !== Core.SESSION_STATUS.COLLECTING
    ) {
        return;
    }
    await chrome.alarms.create(harvestAlarmName(session.id), {
        when: Math.max(Date.now(), session.harvestDeadlineAt),
    });
}

async function clearHarvestAlarm(sessionId) {
    if (typeof sessionId === 'string') {
        await chrome.alarms.clear(harvestAlarmName(sessionId));
    }
}

async function clearAllHarvestAlarms() {
    const alarms = await chrome.alarms.getAll();
    await Promise.all(
        alarms
            .filter((alarm) => alarm.name.startsWith(HARVEST_ALARM_PREFIX))
            .map((alarm) => chrome.alarms.clear(alarm.name))
    );
}

async function ensureActiveHarvestAlarm() {
    const state = await readState();
    const active = Core.getActiveSession(state);
    if (active && active.status === Core.SESSION_STATUS.COLLECTING) {
        await scheduleHarvestAlarm(active);
    }
}

// Every message waits for this once-per-browser-lifetime reset. storage.session
// survives service-worker suspension but clears when Chrome restarts, preventing
// a restored viewer from claiming just before a late startup reset erases it.
const browserLifetimeInitialization = initializeBrowserLifetime();

function publicState(state) {
    const active = Core.getActiveSession(state);
    return {
        schemaVersion: state.schemaVersion,
        settings: state.settings,
        activeSession: active
            ? {
                id: active.id,
                status: active.status,
                startedAt: active.startedAt,
                deliveryTarget: active.deliveryTarget,
                progress: Core.sessionProgress(active),
            }
            : null,
        sessionCount: state.sessions.length,
    };
}

function inspectorState(state) {
    return {
        schemaVersion: state.schemaVersion,
        settings: state.settings,
        activeSessionId: state.activeSessionId,
        sessions: state.sessions,
    };
}

async function hasTikTokPermission() {
    return chrome.permissions.contains({ origins: ['https://www.tiktok.com/*'] });
}

function queueRegistration(operation) {
    const queued = registrationQueue.then(operation);
    registrationQueue = queued.catch(() => undefined);
    return queued;
}

function unregisterCollector() {
    return queueRegistration(async () => {
        const registered = await chrome.scripting.getRegisteredContentScripts({
            ids: [Core.CONTENT_SCRIPT_ID],
        });
        if (registered.length) {
            await chrome.scripting.unregisterContentScripts({ ids: [Core.CONTENT_SCRIPT_ID] });
        }
        return true;
    });
}

function registerCollector(force) {
    return queueRegistration(async () => {
        const state = await readState();
        const active = Core.getActiveSession(state);
        const needsCollector = Boolean(active && [
            Core.SESSION_STATUS.COLLECTING,
            Core.SESSION_STATUS.COMPLETE,
            Core.SESSION_STATUS.VIEWING,
            Core.SESSION_STATUS.FAILED,
        ].includes(active.status));
        if (!(await hasTikTokPermission()) || (!force && !needsCollector)) {
            const registered = await chrome.scripting.getRegisteredContentScripts({
                ids: [Core.CONTENT_SCRIPT_ID],
            });
            if (registered.length) {
                await chrome.scripting.unregisterContentScripts({
                    ids: [Core.CONTENT_SCRIPT_ID],
                });
            }
            return false;
        }
        const registered = await chrome.scripting.getRegisteredContentScripts({
            ids: [Core.CONTENT_SCRIPT_ID],
        });
        if (registered.length) {
            return true;
        }
        await chrome.scripting.registerContentScripts([
            {
                id: Core.CONTENT_SCRIPT_ID,
                matches: ['https://www.tiktok.com/*'],
                js: ['lib/core.js', 'content/dom-adapter.js', 'content/collector.js'],
                css: ['content/banner.css'],
                runAt: 'document_start',
                allFrames: false,
                world: 'ISOLATED',
                persistAcrossSessions: true,
            },
        ]);
        return true;
    });
}

async function findReusableTikTokTab() {
    const tabs = await chrome.tabs.query({
        url: 'https://www.tiktok.com/*',
        currentWindow: true,
    });
    return tabs.find((tab) => {
        try {
            return Core.isFypPath(new URL(tab.url).pathname);
        } catch (_error) {
            return false;
        }
    }) || null;
}

async function createOrReuseTargetTab(preferredTabId) {
    if (Number.isInteger(preferredTabId)) {
        try {
            await chrome.tabs.get(preferredTabId);
            return { tabId: preferredTabId, created: false };
        } catch (_error) {
            // A failed-session lease may refer to a tab the participant closed.
        }
    }
    const existing = await findReusableTikTokTab();
    if (existing && Number.isInteger(existing.id)) {
        return { tabId: existing.id, created: false };
    }
    const created = await chrome.tabs.create({ url: 'about:blank', active: false });
    return { tabId: created.id, created: true };
}

function randomSeed() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] || 1;
}

async function startSession(options = {}) {
    if (!(await hasTikTokPermission())) {
        return { ok: false, error: 'tiktok_permission_required' };
    }
    await registerCollector(true);
    const initialState = await readState();
    const initialActive = Core.getActiveSession(initialState);
    if (initialActive && [
        Core.SESSION_STATUS.COLLECTING,
        Core.SESSION_STATUS.COMPLETE,
        Core.SESSION_STATUS.VIEWING,
    ].includes(initialActive.status)) {
        return { ok: false, error: 'active_session_exists', sessionId: initialActive.id };
    }
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const previousFailed = initialActive && initialActive.status === Core.SESSION_STATUS.FAILED
        ? initialActive
        : null;
    const returnTabs = await readReturnTabs();
    const currentReturnTabId = Number.isInteger(options.returnTabId)
        ? options.returnTabId
        : activeTabs.length && Number.isInteger(activeTabs[0].id)
            ? activeTabs[0].id
            : null;
    // A survey-owned start must bind to the tab that made this request. Reusing
    // a failed session's old lease can send progress and completion to an older
    // Preview—or even to a different survey with different end settings.
    const returnTabId = Number.isInteger(options.returnTabId)
        ? options.returnTabId
        : previousFailed && Number.isInteger(returnTabs[previousFailed.id])
            ? returnTabs[previousFailed.id]
            : currentReturnTabId;
    const target = await createOrReuseTargetTab(
        previousFailed && previousFailed.targetTabId
    );
    const tabId = target.tabId;
    const metadata = {
        id: crypto.randomUUID(),
        seed: randomSeed(),
        startedAt: Date.now(),
        targetTabId: tabId,
        deliveryTarget: options.deliveryTarget,
    };
    const mutation = await mutateState((state) => {
        const active = Core.getActiveSession(state);
        if (active && [
            Core.SESSION_STATUS.COLLECTING,
            Core.SESSION_STATUS.COMPLETE,
            Core.SESSION_STATUS.VIEWING,
        ].includes(active.status)) {
            return { ok: false, error: 'active_session_exists', sessionId: active.id };
        }
        const session = Core.createSession(state.settings, metadata);
        state.sessions.push(session);
        state.activeSessionId = session.id;
        return { ok: true, sessionId: session.id };
    });
    if (!mutation.result.ok) {
        if (target.created) {
            await chrome.tabs.remove(tabId).catch(() => undefined);
        }
        return mutation.result;
    }
    if (previousFailed) {
        await forgetReturnTab(previousFailed.id);
        await clearHarvestAlarm(previousFailed.id);
    }
    await rememberReturnTab(mutation.result.sessionId, returnTabId);
    await scheduleHarvestAlarm(Core.getSession(mutation.state, mutation.result.sessionId));
    if (target.created || previousFailed) {
        await chrome.tabs.update(tabId, { url: Core.TIKTOK_FYP_URL, active: true });
    } else {
        await chrome.tabs.reload(tabId);
        await chrome.tabs.update(tabId, { active: true });
    }
    return mutation.result;
}

async function resumeSession() {
    if (!(await hasTikTokPermission())) {
        return { ok: false, error: 'tiktok_permission_required' };
    }
    await registerCollector(true);
    const target = await createOrReuseTargetTab();
    const tabId = target.tabId;
    let oldTabId = null;
    const mutation = await mutateState((state) => {
        const session = Core.getActiveSession(state);
        if (!session || session.status !== Core.SESSION_STATUS.COLLECTING) {
            return { ok: false, error: 'no_collecting_session' };
        }
        oldTabId = session.targetTabId;
        session.targetTabId = tabId;
        session.updatedAt = Date.now();
        Core.recordDiagnostic(session, 'session_rebound', Date.now(), { tabBound: true });
        return { ok: true, sessionId: session.id };
    });
    if (!mutation.result.ok) {
        if (target.created) {
            await chrome.tabs.remove(tabId).catch(() => undefined);
        }
        return mutation.result;
    }
    await scheduleHarvestAlarm(Core.getSession(mutation.state, mutation.result.sessionId));
    if (Number.isInteger(oldTabId) && oldTabId !== tabId) {
        await chrome.tabs.sendMessage(oldTabId, {
            type: Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR,
        }).catch(() => undefined);
    }
    if (target.created) {
        await chrome.tabs.update(tabId, { url: Core.TIKTOK_FYP_URL, active: true });
    } else {
        await chrome.tabs.reload(tabId);
        await chrome.tabs.update(tabId, { active: true });
    }
    return mutation.result;
}

async function sendShutdownToInjectedCollectors() {
    const state = await readState();
    const tabIds = new Set();
    state.sessions.forEach((session) => {
        if (Number.isInteger(session.targetTabId)) {
            tabIds.add(session.targetTabId);
        }
    });
    if (await hasTikTokPermission()) {
        const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
        tabs.forEach((tab) => {
            if (Number.isInteger(tab.id)) {
                tabIds.add(tab.id);
            }
        });
    }
    await Promise.all(
        Array.from(tabIds, (tabId) =>
            chrome.tabs.sendMessage(tabId, {
                type: Core.MESSAGE_TYPES.SHUTDOWN_COLLECTOR,
            }).catch(() => undefined)
        )
    );
}

async function activateTombstoneGuards() {
    if (!(await hasTikTokPermission())) {
        return;
    }
    const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
    const fypTabs = tabs.filter((tab) => {
        try {
            return Number.isInteger(tab.id) && Core.isFypPath(new URL(tab.url).pathname);
        } catch (_error) {
            return false;
        }
    });
    await Promise.all(fypTabs.map(async (tab) => {
        try {
            // Registered scripts affect future document loads. executeScript also
            // reaches a FYP tab that was already open when consent was granted.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, frameIds: [0] },
                files: ['lib/core.js', 'content/dom-adapter.js', 'content/collector.js'],
                world: 'ISOLATED',
            });
        } catch (_error) {
            // A navigation or closed tab is harmless; final rechecks still bind
            // all collection writes to the designated target tab.
        }
        await chrome.tabs.sendMessage(tab.id, {
            type: Core.MESSAGE_TYPES.STATE_UPDATED,
        }).catch(() => undefined);
    }));
}

function boundTikTokSessionForMessage(state, sender, sessionId, allowedStatuses) {
    if (!isTikTokCollector(sender)) {
        return null;
    }
    const session = Core.getSession(state, sessionId);
    if (
        !session ||
        session.targetTabId !== sender.tab.id ||
        !allowedStatuses.includes(session.status)
    ) {
        return null;
    }
    return session;
}

function collectorSessionForMessage(state, sender, sessionId, allowedStatuses) {
    if (!isTikTokFypCollector(sender)) {
        return null;
    }
    return boundTikTokSessionForMessage(state, sender, sessionId, allowedStatuses);
}

function currentViewerRecord(session) {
    return session.reserved
        .filter((record) => record.state === 'reserved')
        .slice()
        .sort((left, right) => left.order - right.order)
        .find((record) => !['ended', 'unavailable', 'skipped'].includes(record.viewerStatus)) || null;
}

function viewerUrl(sessionId) {
    return chrome.runtime.getURL(
        `viewer/viewer.html?session=${encodeURIComponent(sessionId)}`
    );
}

async function focusViewerTab(tab, sessionId) {
    if (!tab || !Number.isInteger(tab.id)) {
        return false;
    }
    // The manifest deliberately omits the broad `tabs` permission, so Chrome may
    // redact Tab.url. The stored tab ID is the lease; navigating that exact tab
    // back to the local viewer both restores it and avoids URL inspection.
    await chrome.tabs.update(tab.id, {
        url: viewerUrl(sessionId),
        active: true,
    });
    if (Number.isInteger(tab.windowId)) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
    return true;
}

async function openOrFocusViewer(sessionId) {
    const claim = await mutateState((state) => {
        const session = Core.getSession(state, sessionId);
        if (!session || ![
            Core.SESSION_STATUS.COMPLETE,
            Core.SESSION_STATUS.VIEWING,
            Core.SESSION_STATUS.VIEWED,
        ].includes(session.status)) {
            return { ok: false, error: 'viewer_not_available' };
        }
        if (session.deliveryTarget === Core.DELIVERY_TARGET.QUALTRICS) {
            return { ok: true, action: 'qualtrics' };
        }
        if (Number.isInteger(session.viewerTabId)) {
            return { ok: true, action: 'focus', tabId: session.viewerTabId };
        }
        if (session.viewerTabOpenedAt === -1) {
            return { ok: true, action: 'opening' };
        }
        session.viewerTabOpenedAt = -1;
        session.updatedAt = Date.now();
        return { ok: true, action: 'create' };
    });
    if (!claim.result.ok) {
        return claim.result;
    }
    if (claim.result.action === 'qualtrics') {
        const returnTabs = await readReturnTabs();
        const tabId = returnTabs[sessionId];
        const focused = await focusTab(tabId);
        return { ok: true, deliveredTo: 'qualtrics', tabId, focused };
    }
    if (claim.result.action === 'focus') {
        try {
            const tab = await chrome.tabs.get(claim.result.tabId);
            await focusViewerTab(tab, sessionId);
            return { ok: true, tabId: tab.id, reused: true };
        } catch (_error) {
            await mutateState((state) => {
                const session = Core.getSession(state, sessionId);
                if (session && session.viewerTabId === claim.result.tabId) {
                    session.viewerTabId = null;
                    session.viewerTabOpenedAt = 0;
                }
                return { ok: true };
            });
            return openOrFocusViewer(sessionId);
        }
    }
    if (claim.result.action === 'opening') {
        // Another invocation owns the atomic creation claim. It will publish the
        // tab ID after chrome.tabs.create resolves.
        return { ok: true, opening: true };
    }
    try {
        const tab = await chrome.tabs.create({ url: viewerUrl(sessionId), active: true });
        await mutateState((latestState) => {
            const latest = Core.getSession(latestState, sessionId);
            if (latest && latest.viewerTabOpenedAt === -1) {
                latest.viewerTabOpenedAt = Date.now();
                latest.viewerTabId = Number.isInteger(tab.id) ? tab.id : null;
                latest.updatedAt = Date.now();
            }
            return { ok: true };
        });
        return { ok: true, tabId: tab.id, created: true };
    } catch (_error) {
        await mutateState((latestState) => {
            const latest = Core.getSession(latestState, sessionId);
            if (latest && latest.viewerTabOpenedAt === -1) {
                latest.viewerTabOpenedAt = 0;
                Core.recordDiagnostic(latest, 'viewer_tab_open_failed', Date.now());
            }
            return { ok: false };
        });
        return { ok: false, error: 'viewer_tab_open_failed' };
    }
}

async function maybeOpenViewer(mutation) {
    const sessionId = mutation && mutation.result && mutation.result.viewerSessionId;
    if (sessionId) {
        await openOrFocusViewer(sessionId);
    }
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function recoverViewerAfterBrowserStart() {
    const initialization = await browserLifetimeInitialization;
    if (!initialization.freshBrowserLifetime) {
        return { ok: true, skipped: true };
    }
    // Give a Chrome-restored viewer page time to claim its own tab. If none does,
    // recreate exactly one viewer for the one active completed/viewing session.
    await wait(STARTUP_VIEWER_RECOVERY_MS);
    const state = await readState();
    const active = Core.getActiveSession(state);
    if (
        !active ||
        Number.isInteger(active.viewerTabId) ||
        ![Core.SESSION_STATUS.COMPLETE, Core.SESSION_STATUS.VIEWING].includes(active.status)
    ) {
        return { ok: true, skipped: true };
    }
    return openOrFocusViewer(active.id);
}

async function qualtricsSessionStatus(sender, requestedSessionId) {
    if (!isAllowedQualtricsSender(sender)) {
        return { ok: false, error: 'untrusted_sender' };
    }
    const state = await readState();
    const returnTabs = await readReturnTabs();
    const requested = typeof requestedSessionId === 'string'
        ? Core.getSession(state, requestedSessionId)
        : Core.getActiveSession(state);
    const tabBound = requested && returnTabs[requested.id] === sender.tab.id;
    const session = tabBound && requested.deliveryTarget === Core.DELIVERY_TARGET.QUALTRICS
        ? requested
        : null;
    return {
        ok: true,
        bridgeVersion: QUALTRICS_BRIDGE_VERSION,
        extensionVersion: chrome.runtime.getManifest().version,
        permissionGranted: await hasTikTokPermission(),
        conflict: tabBound && !session
            ? {
                sessionId: requested.id,
                status: requested.status,
                reason: 'standalone_session_active',
            }
            : null,
        session: session
            ? {
                id: session.id,
                status: session.status,
                stopReason: session.stopReason || null,
                deliveryTarget: session.deliveryTarget,
                progress: Core.sessionProgress(session),
                queue: Core.viewerQueue(session).map((record) => ({
                    videoId: record.videoId,
                    order: record.order,
                })),
            }
            : null,
    };
}

async function finishQualtricsSession(sender, sessionId) {
    if (!isAllowedQualtricsSender(sender)) {
        return { ok: false, error: 'untrusted_sender' };
    }
    const returnTabs = await readReturnTabs();
    if (returnTabs[sessionId] !== sender.tab.id) {
        return { ok: false, error: 'wrong_qualtrics_tab' };
    }
    const mutation = await mutateState((state) => {
        const session = Core.getSession(state, sessionId);
        if (!session || session.deliveryTarget !== Core.DELIVERY_TARGET.QUALTRICS) {
            return { ok: false, error: 'session_not_found' };
        }
        if (!Core.finishViewer(session, Date.now())) {
            return { ok: false, error: 'session_not_ready' };
        }
        if (state.activeSessionId === session.id) {
            state.activeSessionId = null;
        }
        return { ok: true, sessionId: session.id };
    });
    if (mutation.result.ok) {
        await sendShutdownToInjectedCollectors();
        await clearHarvestAlarm(sessionId);
        await unregisterCollector();
        await forgetReturnTab(sessionId);
    }
    return mutation.result;
}

async function dispatchQualtricsMessage(message, sender) {
    await browserLifetimeInitialization;
    if (!isAllowedQualtricsSender(sender) || !message || typeof message !== 'object') {
        return { ok: false, error: 'untrusted_sender' };
    }
    if (message.type === 'hello' || message.type === 'status') {
        return qualtricsSessionStatus(sender, message.sessionId);
    }
    if (message.type === 'start') {
        const started = await startSession({
            returnTabId: sender.tab.id,
            deliveryTarget: Core.DELIVERY_TARGET.QUALTRICS,
        });
        if (!started.ok) {
            return started;
        }
        return {
            ...started,
            bridgeVersion: QUALTRICS_BRIDGE_VERSION,
            extensionVersion: chrome.runtime.getManifest().version,
        };
    }
    if (message.type === 'finish') {
        return finishQualtricsSession(sender, message.sessionId);
    }
    return { ok: false, error: 'unknown_bridge_message' };
}

async function getContentContext(sender) {
    if (!isTikTokCollector(sender)) {
        return { ok: false, active: false };
    }
    const mutation = await mutateState((state) => {
        const session = Core.getActiveSession(state);
        if (!session || ![
            Core.SESSION_STATUS.COLLECTING,
            Core.SESSION_STATUS.COMPLETE,
            Core.SESSION_STATUS.VIEWING,
            Core.SESSION_STATUS.FAILED,
        ].includes(session.status)) {
            return { ok: true, active: false };
        }
        const boundTab = session.targetTabId === sender.tab.id;
        const tombstoneGuard =
            isTikTokFypCollector(sender) && session.tombstones.length > 0;
        if (!boundTab && !tombstoneGuard) {
            return { ok: true, active: false };
        }
        const feedOrders = session.seen
            .concat(session.excluded, session.reserved)
            .map((record) => record.feedOrder)
            .filter(Number.isInteger);
        return {
            ok: true,
            active: true,
            mode:
                boundTab && session.status === Core.SESSION_STATUS.COLLECTING
                    ? 'collecting'
                    : boundTab && session.status === Core.SESSION_STATUS.FAILED
                        ? 'failed'
                    : 'guard',
            session: {
                id: session.id,
                collectionMode: session.collectionMode,
                seed: session.seed,
                startedAt: session.startedAt,
                harvestStartedAt: session.harvestStartedAt,
                harvestDeadlineAt: session.harvestDeadlineAt,
                harvestPhase: session.harvestPhase,
                status: session.status,
                stopReason: session.stopReason || null,
                deliveryTarget: session.deliveryTarget,
                boundTab,
                lockedSettings: session.lockedSettings,
                qualifiedMs: session.qualifiedMs,
                batchCounter: session.batchCounter,
                seenIds: session.seen.map((record) => record.videoId),
                exposedIds: session.excluded.map((record) => record.videoId),
                tombstones: session.tombstones.slice(),
                validUnseenCount: Core.validReservedVideos(session).length,
                maxFeedOrder: feedOrders.length ? Math.max(...feedOrders) : 0,
                feedOrders: session.seen
                    .concat(session.excluded, session.reserved)
                    .filter((record) => Number.isInteger(record.feedOrder))
                    .map((record) => ({
                        videoId: record.videoId,
                        feedOrder: record.feedOrder,
                    })),
                recentDiagnostics: session.diagnostics.slice(-5),
                recentHarvestSteps: session.harvestSteps.slice(-5),
            },
        };
    });
    return mutation.result;
}

async function dispatchMessage(message, sender) {
    await browserLifetimeInitialization;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        return { ok: false, error: 'invalid_message' };
    }

    if (message.type === Core.MESSAGE_TYPES.GET_STATE) {
        if (!isTrustedExtensionPage(sender)) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const state = await readState();
        return {
            ok: true,
            state: isInspector(sender) ? inspectorState(state) : publicState(state),
            permissionGranted: await hasTikTokPermission(),
        };
    }

    if (message.type === Core.MESSAGE_TYPES.GET_CONTENT_CONTEXT) {
        return getContentContext(sender);
    }

    if (message.type === Core.MESSAGE_TYPES.SAVE_SETTINGS) {
        if (!isOptions(sender)) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const mutation = await mutateState((state) => {
            state.settings = Core.sanitizeSettings(message.settings);
            return { ok: true, settings: state.settings };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.START_SESSION) {
        return isPopup(sender)
            ? startSession()
            : { ok: false, error: 'untrusted_sender' };
    }

    if (message.type === Core.MESSAGE_TYPES.RESUME_SESSION) {
        return isPopup(sender)
            ? resumeSession()
            : { ok: false, error: 'untrusted_sender' };
    }

    if (message.type === Core.MESSAGE_TYPES.COLLECTOR_READY) {
        const mutation = await mutateState((state) => {
            const session = boundTikTokSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true };
            }
            const step = Core.recordHarvestStep(session, {
                phase: 'starting',
                visibility: message.visibility,
                timerDelayMs: message.timerDelayMs,
                hydrationLatencyMs: 0,
                advanceAttempt: 0,
            }, Date.now());
            return { ok: step.applied, error: step.reason || null };
        });
        if (!mutation.result.ok) {
            return mutation.result;
        }
        const returnTabs = await readReturnTabs();
        const returnTabId = returnTabs[message.sessionId];
        const returned = returnTabId === sender.tab.id
            ? false
            : await focusTab(returnTabId);
        return { ok: true, returned };
    }

    if (message.type === Core.MESSAGE_TYPES.RETRY_HARVEST) {
        if (!isTikTokCollector(sender) || !sender.tab) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const returnTabs = await readReturnTabs();
        const returnTabId = returnTabs[message.sessionId];
        const mutation = await mutateState((state) => {
            const previous = Core.getSession(state, message.sessionId);
            if (
                !previous ||
                previous.status !== Core.SESSION_STATUS.FAILED ||
                previous.targetTabId !== sender.tab.id
            ) {
                return { ok: false, error: 'retry_not_available' };
            }
            const session = Core.createSession(state.settings, {
                id: crypto.randomUUID(),
                seed: randomSeed(),
                startedAt: Date.now(),
                targetTabId: sender.tab.id,
                deliveryTarget: previous.deliveryTarget,
            });
            state.sessions.push(session);
            state.activeSessionId = session.id;
            return { ok: true, sessionId: session.id };
        });
        if (!mutation.result.ok) {
            return mutation.result;
        }
        await forgetReturnTab(message.sessionId);
        await rememberReturnTab(mutation.result.sessionId, returnTabId);
        await clearHarvestAlarm(message.sessionId);
        await scheduleHarvestAlarm(Core.getSession(mutation.state, mutation.result.sessionId));
        await chrome.tabs.update(sender.tab.id, {
            url: Core.TIKTOK_FYP_URL,
            active: true,
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.CONTINUE_TO_QUALTRICS) {
        if (!isTikTokCollector(sender) || !sender.tab) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const mutation = await mutateState((state) => {
            const session = Core.getSession(state, message.sessionId);
            if (
                !session ||
                session.targetTabId !== sender.tab.id ||
                session.status !== Core.SESSION_STATUS.FAILED ||
                session.deliveryTarget !== Core.DELIVERY_TARGET.QUALTRICS
            ) {
                return { ok: false, error: 'qualtrics_return_not_available' };
            }
            Core.recordDiagnostic(session, 'testing_continue_to_qualtrics', Date.now(), {
                tabBound: true,
            });
            return { ok: true, sessionId: session.id };
        });
        if (!mutation.result.ok) {
            return mutation.result;
        }
        const returnTabs = await readReturnTabs();
        const returned = await focusTab(returnTabs[mutation.result.sessionId]);
        return returned
            ? { ok: true, returned: true }
            : { ok: false, error: 'qualtrics_tab_unavailable' };
    }

    if (message.type === Core.MESSAGE_TYPES.STOP_SESSION) {
        const fromPopup = isPopup(sender);
        const fromCollector = isTikTokCollector(sender);
        if (!fromPopup && !fromCollector) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const mutation = await mutateState((state) => {
            const session = Core.getSession(state, message.sessionId || state.activeSessionId);
            if (!session) {
                return { ok: false, error: 'session_not_found' };
            }
            if (![Core.SESSION_STATUS.COLLECTING, Core.SESSION_STATUS.FAILED]
                .includes(session.status)) {
                return { ok: false, error: 'not_collecting' };
            }
            if (fromCollector && session.targetTabId !== sender.tab.id) {
                return { ok: false, error: 'wrong_tab' };
            }
            if (session.status === Core.SESSION_STATUS.COLLECTING) {
                if (!Core.stopSession(session, Date.now(), 'participant_stopped')) {
                    return { ok: false, error: 'not_collecting' };
                }
            }
            if (state.activeSessionId === session.id) {
                state.activeSessionId = null;
            }
            return { ok: true, sessionId: session.id };
        });
        await sendShutdownToInjectedCollectors();
        await unregisterCollector();
        if (mutation.result.sessionId) {
            await forgetReturnTab(mutation.result.sessionId);
            await clearHarvestAlarm(mutation.result.sessionId);
        }
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.MARK_EXPOSED) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const result = Core.markExposed(session, {
                videoId: message.videoId,
                feedOrder: message.feedOrder,
                at: Date.now(),
            });
            return {
                ok: result.applied,
                error: result.applied ? null : result.reason,
                progress: Core.sessionProgress(session),
            };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.EXCLUDE_VIDEO) {
        const mutation = await mutateState((state) => {
            const session = boundTikTokSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const result = Core.excludeVideo(session, {
                videoId: message.videoId,
                classification: message.classification,
                feedOrder: message.feedOrder,
                at: Date.now(),
            });
            return {
                ok: result.applied,
                error: result.applied ? null : result.reason,
                progress: Core.sessionProgress(session),
            };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.ACTIVITY_TICK) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const receiptAt = Date.now();
            const proposedFirstSeenAt = Number(message.firstSeenAt);
            Core.applyActivity(session, {
                ...message,
                at: receiptAt,
                firstSeenAt:
                    Number.isFinite(proposedFirstSeenAt) &&
                    Math.abs(receiptAt - proposedFirstSeenAt) <= 10000
                        ? proposedFirstSeenAt
                        : receiptAt,
            });
            const completed = Core.evaluateCompletion(session, receiptAt);
            if (completed && session.viewerTabOpenedAt === null) {
                session.viewerTabOpenedAt = 0;
            }
            return {
                ok: true,
                progress: Core.sessionProgress(session),
                viewerSessionId: completed ? session.id : null,
            };
        });
        await maybeOpenViewer(mutation);
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.HARVEST_STEP) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const now = Date.now();
            if (now >= session.harvestDeadlineAt) {
                Core.recordDiagnostic(session, 'harvest_window_ended', now, {
                    elapsedMs: now - session.harvestStartedAt,
                });
                const finalization = Core.finalizeHarvestWindow(session, now);
                const completed = finalization.outcome === 'complete';
                if (completed && session.viewerTabOpenedAt === null) {
                    session.viewerTabOpenedAt = 0;
                }
                return {
                    ok: true,
                    finished: true,
                    failed: finalization.outcome === 'failed',
                    progress: Core.sessionProgress(session, now),
                    viewerSessionId: completed ? session.id : null,
                };
            }
            const step = Core.recordHarvestStep(session, message, now);
            return {
                ok: step.applied,
                error: step.reason || null,
                progress: Core.sessionProgress(session, now),
            };
        });
        if (mutation.result.finished) {
            await clearHarvestAlarm(message.sessionId);
        }
        if (mutation.result.failed) {
            await focusTab(sender.tab.id);
        }
        await maybeOpenViewer(mutation);
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.HARVEST_FAIL) {
        const mutation = await mutateState((state) => {
            const session = boundTikTokSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const now = Date.now();
            const reason = typeof message.reason === 'string'
                ? message.reason
                : 'harvest_failed';
            Core.recordDiagnostic(session, reason, now, message.detail);
            const applied = Core.failHarvest(session, now, reason);
            return {
                ok: applied,
                error: applied ? null : 'not_collecting',
                progress: Core.sessionProgress(session, now),
            };
        });
        if (mutation.result.ok) {
            await clearHarvestAlarm(message.sessionId);
            await focusTab(sender.tab.id);
        }
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.RESERVE_VIDEO) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const receiptAt = Date.now();
            const reservation = Core.reserveVideo(session, { ...message, at: receiptAt });
            const automated = session.collectionMode === Core.COLLECTION_MODE.AUTOMATED_BACKGROUND;
            const completed = reservation.applied && !automated &&
                Core.evaluateCompletion(session, receiptAt);
            if (completed && session.viewerTabOpenedAt === null) {
                session.viewerTabOpenedAt = 0;
            }
            return {
                ok: reservation.applied,
                error: reservation.applied ? null : reservation.reason,
                progress: Core.sessionProgress(session),
                tombstones: session.tombstones.slice(),
                shouldActivateGuards:
                    reservation.applied && session.tombstones.length === 1,
                viewerSessionId: completed ? session.id : null,
            };
        });
        if (mutation.result.shouldActivateGuards) {
            await activateTombstoneGuards();
        }
        if (mutation.result.viewerSessionId) {
            await clearHarvestAlarm(mutation.result.viewerSessionId);
        }
        await maybeOpenViewer(mutation);
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.CONFIRM_RESERVATION) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING, Core.SESSION_STATUS.COMPLETE]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const receiptAt = Date.now();
            const confirmation = Core.confirmReservation(
                session,
                message.videoId,
                receiptAt
            );
            const completed = confirmation.applied &&
                Core.evaluateCompletion(session, receiptAt);
            if (completed && session.viewerTabOpenedAt === null) {
                session.viewerTabOpenedAt = 0;
            }
            return {
                ok: confirmation.applied,
                error: confirmation.applied ? null : confirmation.reason,
                progress: Core.sessionProgress(session, receiptAt),
                tombstones: session.tombstones.slice(),
                shouldActivateGuards:
                    confirmation.applied && session.tombstones.length === 1,
                viewerSessionId: completed ? session.id : null,
            };
        });
        if (mutation.result.shouldActivateGuards) {
            await activateTombstoneGuards();
        }
        if (mutation.result.viewerSessionId) {
            await clearHarvestAlarm(mutation.result.viewerSessionId);
        }
        await maybeOpenViewer(mutation);
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.INVALIDATE_VIDEO) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true, progress: Core.sessionProgress(session) };
            }
            const applied = Core.invalidateReservation(
                session,
                message.videoId,
                message.reason,
                Date.now()
            );
            return { ok: applied, progress: Core.sessionProgress(session) };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.RECORD_DIAGNOSTIC) {
        const mutation = await mutateState((state) => {
            const session = collectorSessionForMessage(
                state,
                sender,
                message.sessionId,
                [Core.SESSION_STATUS.COLLECTING, Core.SESSION_STATUS.COMPLETE, Core.SESSION_STATUS.VIEWING]
            );
            if (!session) {
                return { ok: false, error: 'wrong_session_or_tab' };
            }
            if (!Core.acceptSourceEvent(session, message.sourceId, message.sequence)) {
                return { ok: true, duplicate: true };
            }
            return {
                ok: Core.recordDiagnostic(
                    session,
                    message.code,
                    Date.now(),
                    message.detail
                ),
            };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.GET_VIEWER_SESSION) {
        if (!isViewerForSession(sender, message.sessionId) || !sender.tab) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const mutation = await mutateState((state) => {
            const session = Core.getSession(state, message.sessionId);
            if (!session) {
                return { ok: false, error: 'session_not_found' };
            }
            if (![
                Core.SESSION_STATUS.COMPLETE,
                Core.SESSION_STATUS.VIEWING,
                Core.SESSION_STATUS.VIEWED,
            ].includes(session.status)) {
                return {
                    ok: false,
                    error: 'collection_not_complete',
                    progress: Core.sessionProgress(session),
                };
            }
            if (
                Number.isInteger(session.viewerTabId) &&
                session.viewerTabId !== sender.tab.id
            ) {
                return { ok: false, error: 'viewer_already_open' };
            }
            session.viewerTabId = sender.tab.id;
            if (session.viewerTabOpenedAt === -1 || session.viewerTabOpenedAt === 0) {
                session.viewerTabOpenedAt = Date.now();
            }
            const current = currentViewerRecord(session);
            if (current && ['ready', 'play_requested', 'playing'].includes(current.viewerStatus)) {
                current.viewerStatus = 'pending';
                session.updatedAt = Date.now();
            }
            return {
                ok: true,
                session: {
                    id: session.id,
                    status: session.status,
                    queue: Core.viewerQueue(session),
                },
            };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.OPEN_VIEWER) {
        if (!isPopup(sender)) {
            return { ok: false, error: 'untrusted_sender' };
        }
        return openOrFocusViewer(message.sessionId);
    }

    if (message.type === Core.MESSAGE_TYPES.VIEWER_EVENT) {
        if (!isViewerForSession(sender, message.sessionId) || !sender.tab) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const mutation = await mutateState((state) => {
            const session = Core.getSession(state, message.sessionId);
            if (!session) {
                return { ok: false, error: 'session_not_found' };
            }
            if (session.viewerTabId !== sender.tab.id) {
                return { ok: false, error: 'wrong_viewer_tab' };
            }
            const current = currentViewerRecord(session);
            const target = Core.findReserved(session, message.videoId);
            const idempotentTerminalRetry = Boolean(
                target &&
                ['ended', 'unavailable', 'skipped'].includes(target.viewerStatus) &&
                target.viewerTerminalType === message.eventType
            );
            if (
                (!current || current.videoId !== message.videoId) &&
                !idempotentTerminalRetry
            ) {
                return { ok: false, error: 'not_current_video' };
            }
            const applied = Core.applyViewerEvent(session, {
                ...message,
                type: message.eventType,
                at: Date.now(),
            });
            return { ok: applied };
        });
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.VIEWER_FINISH) {
        if (!isViewerForSession(sender, message.sessionId) || !sender.tab) {
            return { ok: false, error: 'untrusted_sender' };
        }
        const mutation = await mutateState((state) => {
            const session = Core.getSession(state, message.sessionId);
            if (!session) {
                return { ok: false, error: 'session_not_found' };
            }
            if (session.viewerTabId !== sender.tab.id) {
                return { ok: false, error: 'wrong_viewer_tab' };
            }
            if (currentViewerRecord(session)) {
                return { ok: false, error: 'viewer_items_remaining' };
            }
            const applied = Core.finishViewer(session, Date.now());
            if (applied && state.activeSessionId === session.id) {
                state.activeSessionId = null;
            }
            return { ok: applied, sessionId: session.id };
        });
        await sendShutdownToInjectedCollectors();
        await clearAllHarvestAlarms();
        await unregisterCollector();
        if (mutation.result.sessionId) {
            await forgetReturnTab(mutation.result.sessionId);
        }
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.CLEAR_DATA) {
        if (!isPopup(sender) && !isInspector(sender)) {
            return { ok: false, error: 'untrusted_sender' };
        }
        await sendShutdownToInjectedCollectors();
        await clearAllHarvestAlarms();
        await unregisterCollector();
        const mutation = await mutateState((state) => {
            const cleared = Core.clearCollectedData(state);
            state.schemaVersion = cleared.schemaVersion;
            state.settings = cleared.settings;
            state.activeSessionId = null;
            state.sessions = [];
            return { ok: true };
        });
        await forgetReturnTabs();
        return mutation.result;
    }

    if (message.type === Core.MESSAGE_TYPES.REVOKE_ACCESS) {
        if (!isPopup(sender) && !isInspector(sender)) {
            return { ok: false, error: 'untrusted_sender' };
        }
        await sendShutdownToInjectedCollectors();
        await clearAllHarvestAlarms();
        await mutateState((state) => {
            const active = Core.getActiveSession(state);
            if (active) {
                Core.stopSession(active, Date.now(), 'access_revoked');
                state.activeSessionId = null;
            }
            return { ok: true };
        });
        await forgetReturnTabs();
        await unregisterCollector();
        const removed = await chrome.permissions.remove({
            origins: ['https://www.tiktok.com/*'],
        });
        const permissionGranted = await hasTikTokPermission();
        const registered = await chrome.scripting.getRegisteredContentScripts({
            ids: [Core.CONTENT_SCRIPT_ID],
        });
        return {
            ok: removed && !permissionGranted && registered.length === 0,
            permissionGranted,
        };
    }

    return { ok: false, error: 'unknown_message_type' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    dispatchMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch(() => sendResponse({ ok: false, error: 'internal_error' }));
    return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
    if (
        !port ||
        port.name !== QUALTRICS_BRIDGE_NAME ||
        !isAllowedQualtricsSender(port.sender)
    ) {
        if (port && typeof port.disconnect === 'function') {
            port.disconnect();
        }
        return;
    }
    port.onMessage.addListener((message) => {
        const requestId = message && typeof message.requestId === 'string'
            ? message.requestId.slice(0, 80)
            : null;
        dispatchQualtricsMessage(message, port.sender)
            .then((response) => {
                port.postMessage({ requestId, ...response });
            })
            .catch(() => {
                port.postMessage({ requestId, ok: false, error: 'internal_error' });
            });
    });
});

chrome.runtime.onInstalled.addListener(() => {
    mutationQueue = mutationQueue.then(async () => {
        const state = await readState();
        await writeState(state);
    }).catch(() => undefined);
    registerCollector().catch(() => undefined);
    ensureActiveHarvestAlarm().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
    const registration = registerCollector().catch(() => undefined);
    const viewerRecovery = recoverViewerAfterBrowserStart().catch(() => undefined);
    const harvestAlarm = ensureActiveHarvestAlarm().catch(() => undefined);
    return Promise.all([registration, viewerRecovery, harvestAlarm]);
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || !alarm.name.startsWith(HARVEST_ALARM_PREFIX)) {
        return;
    }
    const sessionId = alarm.name.slice(HARVEST_ALARM_PREFIX.length);
    mutateState((state) => {
        const session = Core.getSession(state, sessionId);
        if (
            !session ||
            session.status !== Core.SESSION_STATUS.COLLECTING ||
            Date.now() < session.harvestDeadlineAt
        ) {
            return { ok: false, error: 'alarm_not_due' };
        }
        const now = Date.now();
        Core.recordDiagnostic(session, 'harvest_window_ended', now, {
            elapsedMs: now - session.harvestStartedAt,
        });
        const finalization = Core.finalizeHarvestWindow(session, now);
        const completed = finalization.outcome === 'complete';
        if (completed && session.viewerTabOpenedAt === null) {
            session.viewerTabOpenedAt = 0;
        }
        return {
            ok: true,
            tabId: session.targetTabId,
            progress: Core.sessionProgress(session, now),
            failed: finalization.outcome === 'failed',
            viewerSessionId: completed ? session.id : null,
        };
    }).then(async (mutation) => {
        if (!mutation.result.ok) {
            return;
        }
        if (Number.isInteger(mutation.result.tabId)) {
            await chrome.tabs.sendMessage(mutation.result.tabId, {
                type: Core.MESSAGE_TYPES.STATE_UPDATED,
                progress: mutation.result.progress,
            }).catch(() => undefined);
        }
        if (mutation.result.viewerSessionId) {
            await openOrFocusViewer(mutation.result.viewerSessionId);
        } else if (mutation.result.failed && Number.isInteger(mutation.result.tabId)) {
            await focusTab(mutation.result.tabId);
        }
    }).catch(() => undefined);
});

chrome.permissions.onRemoved.addListener((permissions) => {
    const removedTikTok = (permissions.origins || []).includes('https://www.tiktok.com/*');
    if (!removedTikTok) {
        return;
    }
    sendShutdownToInjectedCollectors()
        .then(() => clearAllHarvestAlarms())
        .then(() => unregisterCollector())
        .then(() => mutateState((state) => {
            const active = Core.getActiveSession(state);
            if (active) {
                Core.stopSession(active, Date.now(), 'permission_removed');
                state.activeSessionId = null;
            }
            return { ok: true };
        }))
        .catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    mutateState((state) => {
        state.sessions.forEach((session) => {
            if (session.viewerTabId === tabId) {
                session.viewerTabId = null;
            }
        });
        const active = Core.getActiveSession(state);
        if (
            active &&
            active.status === Core.SESSION_STATUS.COLLECTING &&
            active.targetTabId === tabId
        ) {
            active.targetTabId = null;
            Core.recordDiagnostic(active, 'target_tab_closed', Date.now());
            if (active.collectionMode === Core.COLLECTION_MODE.AUTOMATED_BACKGROUND) {
                Core.failHarvest(active, Date.now(), 'target_tab_closed');
            }
        }
        return {
            ok: true,
            failedSessionId:
                active && active.status === Core.SESSION_STATUS.FAILED
                    ? active.id
                    : null,
        };
    }).then((mutation) => clearHarvestAlarm(mutation.result.failedSessionId))
        .catch(() => undefined);
});

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

// Unpacked-extension reloads do not fire Chrome's browser-startup event. Keep
// the dynamic registration self-healing whenever this worker is instantiated,
// while registerCollector's queue still deduplicates concurrent callers.
registerCollector().catch(() => undefined);
ensureActiveHarvestAlarm().catch(() => undefined);
