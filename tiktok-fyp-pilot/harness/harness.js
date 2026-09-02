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
