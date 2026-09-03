/* global TikTokPilotCore, TikTokPilotDom */
'use strict';

const Core = TikTokPilotCore;
const Dom = TikTokPilotDom;
const feed = document.getElementById('feed');
const log = document.getElementById('log');
const controls = {
    reset: document.getElementById('reset'),
    addBatch: document.getElementById('add-batch'),
    addFragmented: document.getElementById('add-fragmented'),
    advanceCard: document.getElementById('advance-card'),
    togglePlaying: document.getElementById('toggle-playing'),
    toggleFocus: document.getElementById('toggle-focus'),
    advance499: document.getElementById('advance-499'),
    advance1: document.getElementById('advance-1'),
    rerender: document.getElementById('rerender'),
    runBackground: document.getElementById('run-background'),
    run: document.getElementById('run'),
};
const displays = {
    playing: document.getElementById('playing-state'),
    focus: document.getElementById('focus-state'),
    exposure: document.getElementById('exposure-state'),
    seen: document.getElementById('seen-state'),
    reserved: document.getElementById('reserved-state'),
    gate: document.getElementById('gate-state'),
};

const ids = Array.from({ length: 40 }, (_value, index) =>
    `731111111111111${String(index + 100).padStart(3, '0')}`
);
let nextId = 0;
let feedOrder = 0;
let simulatedPlaying = true;
let simulatedFocused = true;
let exposureMs = 0;
let seen = false;
let observer = null;
const orders = new Map();
const tombstones = new Set();
const reserved = [];

function writeLog(text, passed) {
    const item = document.createElement('li');
    item.textContent = `${passed === true ? 'PASS · ' : passed === false ? 'FAIL · ' : ''}${text}`;
    if (passed === true) {
        item.style.color = '#067647';
    } else if (passed === false) {
        item.style.color = '#b42318';
    }
    log.prepend(item);
}

function createCard(videoId, active) {
    const card = document.createElement('article');
    card.className = 'synthetic-card';
    card.dataset.e2e = 'recommend-list-item-container';
    card.dataset.active = active ? 'true' : 'false';
    const video = document.createElement('video');
    video.dataset.syntheticPlaying = simulatedPlaying && active ? 'true' : 'false';
    video.muted = true;
    const anchor = document.createElement('a');
    anchor.href = `https://www.tiktok.com/@synthetic/video/${videoId}`;
    anchor.textContent = `Synthetic post ${videoId}`;
    anchor.addEventListener('click', (event) => event.preventDefault());
    card.append(video, anchor);
    return card;
}

function ensureOrder(record) {
    if (!orders.has(record.videoId)) {
        feedOrder += 1;
        orders.set(record.videoId, feedOrder);
    }
    return orders.get(record.videoId);
}

function sweepTombstones(records) {
    records.forEach((record) => {
        if (record.ids.some((id) => tombstones.has(id))) {
            record.element.classList.add('ttfp-reserved-card');
            record.element.setAttribute('aria-hidden', 'true');
            writeLog(`tombstone guard concealed ${record.ids[0]}`);
        }
    });
}

function processAdded(records) {
    const snapshot = Dom.snapshotFeed(document, location.href);
    sweepTombstones(snapshot);
    const added = Dom.addedVideoIds(records, location.href);
    const connected = Dom.snapshotFeed(document, location.href);
    const active = connected.find((record) => record.element.dataset.active === 'true');
    if (!active || !added.size) {
        updateState();
        return;
    }
    const candidates = connected
        .filter((record) => added.has(record.videoId))
        .map((record) => {
            const rect = record.element.getBoundingClientRect();
            return {
                videoId: record.videoId,
                feedOrder: ensureOrder(record),
                aheadBy: record.liveIndex - active.liveIndex,
                intersectionRatio: Dom.rectOverlapsViewport(rect, innerWidth, innerHeight) ? 1 : 0,
                belowViewport: Dom.isBelowViewport(rect, innerHeight),
                everIntersected: false,
                connected: record.element.isConnected,
                occurrenceCount: record.occurrenceCount,
            };
        });
    const selected = Core.selectSafeCandidate(20260901, `harness-${feedOrder}`, candidates);
    if (selected) {
        const record = connected.find((item) => item.videoId === selected.videoId);
        tombstones.add(selected.videoId);
        reserved.push(selected.videoId);
        record.element.classList.add('ttfp-reserved-card');
        record.element.setAttribute('aria-hidden', 'true');
        writeLog(`reserved safe-ahead ID ${selected.videoId}`);
    }
    updateState();
}

function updateState() {
    const evaluation = Core.evaluateQualifiedSample({
        pathname: '/foryou',
        documentVisible: true,
        windowFocused: simulatedFocused,
        primaryCount: 1,
        videoId: ids[0],
        visibleRatio: 0.6,
        playing: simulatedPlaying,
        mediaAdvancing: simulatedPlaying,
    });
    displays.playing.textContent = simulatedPlaying ? 'Yes' : 'No';
    displays.focus.textContent = simulatedFocused ? 'Yes' : 'No';
    displays.exposure.textContent = `${exposureMs}ms`;
    displays.seen.textContent = seen ? 'Yes' : 'No';
    displays.reserved.textContent = String(reserved.length);
    displays.gate.textContent = evaluation.qualified ? 'Counting' : evaluation.reason;
    controls.togglePlaying.textContent = simulatedPlaying
        ? 'Pause synthetic video'
        : 'Play synthetic video';
    controls.toggleFocus.textContent = simulatedFocused ? 'Simulate blur' : 'Simulate focus';
}

function addBatch(count) {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
        const videoId = ids[nextId];
        nextId += 1;
        fragment.appendChild(createCard(videoId, feed.children.length === 0 && index === 0));
    }
    feed.appendChild(fragment);
}

function reset() {
    if (observer) {
        observer.disconnect();
    }
    feed.replaceChildren();
    log.replaceChildren();
    nextId = 0;
    feedOrder = 0;
    exposureMs = 0;
    seen = false;
    simulatedPlaying = true;
    simulatedFocused = true;
    orders.clear();
    tombstones.clear();
    reserved.splice(0);
    window.scrollTo({ top: 0, behavior: 'auto' });
    observer = new MutationObserver(processAdded);
    observer.observe(feed, { childList: true, subtree: true });
    updateState();
}

controls.reset.addEventListener('click', reset);
controls.addBatch.addEventListener('click', () => addBatch(6));
controls.addFragmented.addEventListener('click', () => {
    addBatch(3);
    setTimeout(() => addBatch(3), 80);
});
controls.advanceCard.addEventListener('click', () => {
    const cards = Array.from(feed.querySelectorAll('.synthetic-card'));
    const currentIndex = cards.findIndex((card) => card.dataset.active === 'true');
    const next = cards[currentIndex + 1];
    if (!next) {
        writeLog('Insert another batch before advancing.', false);
        return;
    }
    cards.forEach((card) => {
        card.dataset.active = 'false';
        const video = card.querySelector('video');
        if (video) {
            video.dataset.syntheticPlaying = 'false';
        }
    });
    next.dataset.active = 'true';
    const nextVideo = next.querySelector('video');
    if (nextVideo) {
        nextVideo.dataset.syntheticPlaying = simulatedPlaying ? 'true' : 'false';
    }
    next.scrollIntoView({ behavior: 'auto', block: 'center' });
    writeLog('viewport and active playback moved to the next surviving card');
    updateState();
});
controls.togglePlaying.addEventListener('click', () => {
    simulatedPlaying = !simulatedPlaying;
    const activeVideo = feed.querySelector('[data-active="true"] video');
    if (activeVideo) {
        activeVideo.dataset.syntheticPlaying = simulatedPlaying ? 'true' : 'false';
    }
    updateState();
});
controls.toggleFocus.addEventListener('click', () => {
    simulatedFocused = !simulatedFocused;
    updateState();
});
controls.advance499.addEventListener('click', () => {
    const first = Core.advanceExposure(0, 350, 500);
    const second = Core.advanceExposure(first.totalMs, 149, 500);
    exposureMs = second.totalMs;
    seen = second.seen;
    updateState();
});
controls.advance1.addEventListener('click', () => {
    const result = Core.advanceExposure(exposureMs, 1, 500);
    exposureMs = result.totalMs;
    seen = result.seen;
    updateState();
});
controls.rerender.addEventListener('click', () => {
    if (!reserved.length) {
        writeLog('No tombstone exists yet.', false);
        return;
    }
    feed.appendChild(createCard(reserved[0], false));
});

controls.runBackground.addEventListener('click', async () => {
    reset();
    observer.disconnect();
    addBatch(6);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const testSession = Core.createSession(
        { harvestDurationSeconds: 15 },
        { id: 'synthetic-background', seed: 20260902, startedAt: 1000, targetTabId: 1 }
    );
    const records = Dom.snapshotFeed(document, location.href);
    const driver = records[0];
    const nextDriver = records[1];
    const step = Core.recordHarvestStep(testSession, {
        phase: 'waiting_candidate',
        visibility: 'hidden',
        timerDelayMs: 1400,
        hydrationLatencyMs: 0,
        advanceAttempt: 0,
        driverVideoId: driver.videoId,
        retainDriver: true,
        feedOrder: 1,
    }, 1100);
    writeLog(
        'hidden-tab timing is recorded without excluding the covered driver',
        step.applied &&
            testSession.harvestSteps[0].visibility === 'hidden' &&
            Core.findExcluded(testSession, driver.videoId) === null
    );

    const prepared = Core.reserveVideo(testSession, {
        videoId: driver.videoId,
        batchId: 'synthetic-covered-1',
        batchNumber: 1,
        at: 1200,
        evidence: {
            captureMethod: 'covered_feed_item',
            feedOrder: 1,
            aheadBy: 0,
            intersectionRatio: 1,
            belowViewport: false,
            everIntersected: true,
            connected: true,
            occurrenceCount: 1,
            overlayOpaque: true,
            mediaMuted: true,
        },
    });
    writeLog(
        'covered current card is persisted before tombstone or concealment',
        prepared.applied &&
            Core.findReserved(testSession, driver.videoId).state === 'prepared' &&
            testSession.tombstones.length === 0 &&
            !driver.element.classList.contains('ttfp-reserved-card')
    );
    driver.element.classList.add('ttfp-reserved-card');
    driver.element.setAttribute('aria-hidden', 'true');
    tombstones.add(driver.videoId);
    const confirmed = Core.confirmReservation(testSession, driver.videoId, 1300);
    reserved.push(driver.videoId);
    writeLog(
        'concealed current card confirms and remains viewer-eligible',
        confirmed.applied &&
            Core.viewerQueue(testSession).length === 1 &&
            Core.findExcluded(testSession, driver.videoId) === null
    );

    const preparedNext = Core.reserveVideo(testSession, {
        videoId: nextDriver.videoId,
        batchId: 'synthetic-covered-2',
        batchNumber: 2,
        at: 1400,
        evidence: {
            captureMethod: 'covered_feed_item',
            feedOrder: 2,
            aheadBy: 0,
            intersectionRatio: 1,
            belowViewport: false,
            everIntersected: true,
            connected: true,
            occurrenceCount: 1,
            overlayOpaque: true,
            mediaMuted: true,
        },
    });
    nextDriver.element.classList.add('ttfp-reserved-card');
    nextDriver.element.setAttribute('aria-hidden', 'true');
    tombstones.add(nextDriver.videoId);
    const confirmedNext = Core.confirmReservation(testSession, nextDriver.videoId, 1500);
    reserved.push(nextDriver.videoId);
    writeLog(
        'the next covered card is also retained rather than used only as a driver',
        preparedNext.applied && confirmedNext.applied && Core.viewerQueue(testSession).length === 2
    );

    Core.recordHarvestStep(testSession, {
        phase: 'waiting_hydration',
        visibility: 'hidden',
        timerDelayMs: 900,
        hydrationLatencyMs: 780,
        advanceAttempt: 1,
        driverVideoId: driver.videoId,
        feedOrder: 1,
    }, 2100);
    addBatch(2);
    writeLog(
        'replacement hydration after a scroll-fallback attempt is recorded',
        testSession.harvestSteps.some((item) =>
            item.phase === 'waiting_hydration' &&
            item.advanceAttempt === 1 &&
            item.hydrationLatencyMs === 780
        )
    );

    const recycled = createCard(driver.videoId, false);
    feed.appendChild(recycled);
    sweepTombstones(Dom.snapshotFeed(document, location.href));
    writeLog(
        'DOM recycling cannot resurrect a tombstoned recommendation',
        recycled.classList.contains('ttfp-reserved-card')
    );
    const completedWindow = Core.finalizeHarvestWindow(testSession, 16000);
    writeLog(
        'the fixed window keeps every safely confirmed video collected before its deadline',
        completedWindow.outcome === 'complete' &&
            testSession.status === Core.SESSION_STATUS.COMPLETE &&
            Core.viewerQueue(testSession).length === 2
    );

    const stalled = Core.createSession(
        { harvestDurationSeconds: 15 },
        { id: 'synthetic-stall', seed: 7, startedAt: 1000, targetTabId: 1 }
    );
    const partialId = ids[20];
    Core.reserveVideo(stalled, {
        videoId: partialId,
        batchId: 'partial',
        batchNumber: 1,
        at: 1200,
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
    Core.confirmReservation(stalled, partialId, 1300);
    [1, 2, 3].forEach((attempt) => Core.recordHarvestStep(stalled, {
        phase: 'advancing',
        visibility: 'hidden',
        timerDelayMs: 1000,
        hydrationLatencyMs: 8000,
        advanceAttempt: attempt,
        driverVideoId: ids[21],
        feedOrder: 1,
    }, 2000 + attempt));
    Core.recordHarvestStep(stalled, {
        phase: 'waiting_deadline',
        visibility: 'hidden',
        timerDelayMs: 1000,
        hydrationLatencyMs: 8000,
        advanceAttempt: 3,
        driverVideoId: ids[21],
        feedOrder: 1,
    }, 9000);
    const stalledWindow = Core.finalizeHarvestWindow(stalled, 16000);
    writeLog(
        'a hydration stall preserves the confirmed partial pool until the deadline',
        stalledWindow.outcome === 'complete' &&
            stalled.status === Core.SESSION_STATUS.COMPLETE &&
            Core.viewerQueue(stalled).length === 1 &&
            Core.findReserved(stalled, partialId).state === 'reserved'
    );
    const retried = Core.createSession(
        stalled.lockedSettings,
        { id: 'synthetic-retry', seed: 8, startedAt: 17000, targetTabId: 1 }
    );
    writeLog(
        'retry starts with a fresh empty bank and a new deadline',
        retried.status === Core.SESSION_STATUS.COLLECTING &&
            retried.reserved.length === 0 &&
            retried.harvestDeadlineAt === 32000
    );
    updateState();
});
controls.run.addEventListener('click', async () => {
    reset();
    addBatch(8);
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeLog('exactly one safe-ahead card reserved from one insertion group', reserved.length === 1);
    const beforeSecondBatch = reserved.length;
    addBatch(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeLog(
        'a later insertion group reserves at most one additional card',
        reserved.length - beforeSecondBatch === 1
    );
    const reservedId = reserved[0];
    feed.appendChild(createCard(reservedId, false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rerendered = Dom.snapshotFeed(document, location.href)
        .find((record) => record.ids.includes(reservedId));
    writeLog(
        'rerendered tombstone is concealed again',
        Boolean(rerendered && rerendered.element.classList.contains('ttfp-reserved-card'))
    );
    const before = Core.advanceExposure(0, 350, 500);
    const at499 = Core.advanceExposure(before.totalMs, 149, 500);
    const at500 = Core.advanceExposure(at499.totalMs, 1, 500);
    writeLog('499ms remains unseen', at499.seen === false);
    writeLog('500ms becomes seen', at500.seen === true && at500.crossedThreshold === true);
    const blurred = Core.evaluateQualifiedSample({
        pathname: '/foryou',
        documentVisible: true,
        windowFocused: false,
        primaryCount: 1,
        videoId: ids[0],
        visibleRatio: 0.6,
        playing: true,
        mediaAdvancing: true,
    });
    writeLog('blur pauses qualified time', blurred.reason === 'window_unfocused');
});

reset();
