/* global TikTokPilotCore */
'use strict';

const Core = TikTokPilotCore;
const READY_TIMEOUT_MS = 15000;
const IFRAME_LOAD_GRACE_MS = 1000;
const PLAYBACK_STALL_MS = 45000;
const AUTO_ADVANCE_DELAY_MS = 450;
const WHEEL_DEBOUNCE_MS = 650;
const TERMINAL_STATUSES = new Set(['ended', 'unavailable', 'skipped']);
const sessionId = new URLSearchParams(location.search).get('session');
const elements = {
    notice: document.getElementById('notice'),
    counter: document.getElementById('counter'),
    locked: document.getElementById('locked'),
    lockedMessage: document.getElementById('locked-message'),
    viewer: document.getElementById('viewer'),
    complete: document.getElementById('complete'),
    playerMount: document.getElementById('player-mount'),
    placeholder: document.getElementById('player-placeholder'),
    videoNumber: document.getElementById('video-number'),
    videoTitle: document.getElementById('video-title'),
    videoStatus: document.getElementById('video-status'),
    previous: document.getElementById('previous'),
    play: document.getElementById('play'),
    next: document.getElementById('next'),
    retry: document.getElementById('retry'),
    openInspector: document.getElementById('open-inspector'),
};

let session = null;
let currentIndex = -1;
let currentIframe = null;
let readyTimer = null;
let iframeLoadTimer = null;
let playbackTimer = null;
let autoAdvanceTimer = null;
let lastCurrentTimeSecond = -1;
let terminalHandled = false;
let pendingTerminal = null;
let eventQueue = Promise.resolve();
let playbackPhase = 'idle';
let readyHandled = false;
let replayMode = false;
let autoplayUnlocked = false;
let navigationBusy = false;
let lastWheelAt = 0;

function send(message) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: 'extension_message_failed' });
                return;
            }
            resolve(response);
        });
    });
}

function currentRecord() {
    return session && currentIndex >= 0 ? session.queue[currentIndex] : null;
}

function isTerminal(record) {
    return Boolean(record && TERMINAL_STATUSES.has(record.viewerStatus));
}

function queueViewerEvent(type, value) {
    const record = currentRecord();
    if (!session || !record) {
        return Promise.resolve({ ok: false });
    }
    const targetSessionId = session.id;
    const targetVideoId = record.videoId;
    const operation = eventQueue.then(() => send({
        type: Core.MESSAGE_TYPES.VIEWER_EVENT,
        sessionId: targetSessionId,
        videoId: targetVideoId,
        at: Date.now(),
        eventType: type,
        value,
    }));
    eventQueue = operation.catch(() => undefined);
    return operation;
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queueViewerEventWithRetry(type, value) {
    const delays = [0, 150, 500];
    let response = null;
    for (const delay of delays) {
        if (delay) {
            await wait(delay);
        }
        response = await queueViewerEvent(type, value);
        if (response && response.ok) {
            return response;
        }
    }
    return response || { ok: false, error: 'extension_message_failed' };
}

function showNotice(text, kind) {
    elements.notice.textContent = text;
    elements.notice.className = `notice${kind ? ` ${kind}` : ''}`;
    elements.notice.hidden = false;
}

function clearNotice() {
    elements.notice.hidden = true;
    elements.notice.textContent = '';
}

function embedUrl(videoId) {
    const parameters = new URLSearchParams({
        controls: '0',
        progress_bar: '0',
        play_button: '0',
        volume_control: '0',
        fullscreen_button: '0',
        timestamp: '0',
        loop: '0',
        autoplay: autoplayUnlocked ? '1' : '0',
        music_info: '0',
        description: '0',
        rel: '0',
        native_context_menu: '0',
        closed_caption: '0',
    });
    return `${Core.TIKTOK_ORIGIN}/player/v1/${videoId}?${parameters.toString()}`;
}

function clearPlaybackWatchdog() {
    if (playbackTimer) {
        clearTimeout(playbackTimer);
        playbackTimer = null;
    }
}

function clearPlayerTimers() {
    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    if (iframeLoadTimer) {
        clearTimeout(iframeLoadTimer);
        iframeLoadTimer = null;
    }
    if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
    }
    clearPlaybackWatchdog();
}

function removeCurrentPlayer() {
    clearPlayerTimers();
    currentIframe = null;
    playbackPhase = 'idle';
    elements.playerMount.replaceChildren();
}

function updateNavigationControls() {
    if (!session || currentIndex < 0) {
        return;
    }
    elements.previous.disabled = navigationBusy || currentIndex === 0;
    elements.next.disabled = navigationBusy || Boolean(pendingTerminal);
    const onLast = currentIndex === session.queue.length - 1;
    elements.next.textContent = onLast ? '✓' : '→';
    elements.next.setAttribute('aria-label', onLast ? 'Finish viewer' : 'Next video');
}

function setPlaybackUi(phase, detail) {
    playbackPhase = phase;
    if (phase === 'preparing') {
        elements.play.disabled = true;
        elements.play.textContent = 'Play';
        elements.videoTitle.textContent = replayMode ? 'Preparing replay' : 'Preparing video';
        elements.videoStatus.textContent = 'Waiting for the TikTok player.';
    } else if (phase === 'ready') {
        elements.play.disabled = false;
        elements.play.textContent = replayMode ? 'Replay' : 'Play';
        elements.videoTitle.textContent = replayMode ? 'Ready to replay' : 'Ready to watch';
        elements.videoStatus.textContent = detail || 'Press Play to begin.';
    } else if (phase === 'requested' || phase === 'buffering') {
        elements.play.disabled = false;
        elements.play.textContent = 'Pause';
        elements.videoTitle.textContent = phase === 'buffering' ? 'Buffering' : 'Starting';
        elements.videoStatus.textContent = phase === 'buffering'
            ? 'Waiting for TikTok playback.'
            : 'Starting playback…';
    } else if (phase === 'playing') {
        elements.play.disabled = false;
        elements.play.textContent = 'Pause';
        elements.videoTitle.textContent = replayMode ? 'Replaying' : 'Now playing';
        elements.videoStatus.textContent = 'Ends advance automatically.';
    } else if (phase === 'paused') {
        elements.play.disabled = false;
        elements.play.textContent = 'Resume';
        elements.videoTitle.textContent = 'Paused';
        elements.videoStatus.textContent = 'Press Resume or Space.';
    } else if (phase === 'terminal') {
        elements.play.disabled = true;
    }
    updateNavigationControls();
}

function armPlaybackWatchdog() {
    clearPlaybackWatchdog();
    if (
        terminalHandled ||
        !['requested', 'playing', 'buffering'].includes(playbackPhase) ||
        document.visibilityState !== 'visible'
    ) {
        return;
    }
    const iframe = currentIframe;
    playbackTimer = setTimeout(async () => {
        playbackTimer = null;
        if (
            terminalHandled ||
            iframe !== currentIframe ||
            document.visibilityState !== 'visible' ||
            !['requested', 'playing', 'buffering'].includes(playbackPhase)
        ) {
            return;
        }
        elements.videoTitle.textContent = 'Playback stalled';
        elements.videoStatus.textContent = 'Use Next to continue.';
        await handleTerminal('playback_timeout', null);
    }, PLAYBACK_STALL_MS);
}

function postPlayerCommand(type) {
    if (!currentIframe || !currentIframe.contentWindow) {
        return false;
    }
    currentIframe.contentWindow.postMessage(
        { type, value: null, 'x-tiktok-player': true },
        Core.TIKTOK_ORIGIN
    );
    return true;
}

async function requestPlayback(automatic) {
    const iframe = currentIframe;
    const record = currentRecord();
    if (!iframe || !record || terminalHandled || !readyHandled) {
        return false;
    }
    if (!automatic) {
        autoplayUnlocked = true;
        clearNotice();
    }
    setPlaybackUi('requested');
    armPlaybackWatchdog();
    const previousStatus = record.viewerStatus;
    if (!replayMode) {
        record.viewerStatus = 'play_requested';
    }
    const savePlay = replayMode
        ? Promise.resolve({ ok: true })
        : queueViewerEventWithRetry('play_command', null);
    postPlayerCommand('unMute');
    postPlayerCommand('play');
    const response = await savePlay;
    if (iframe !== currentIframe || terminalHandled) {
        return false;
    }
    if (!response || !response.ok) {
        clearPlaybackWatchdog();
        postPlayerCommand('pause');
        if (!replayMode) {
            record.viewerStatus = previousStatus;
        }
        setPlaybackUi('ready');
        showNotice('The Play action could not be saved locally. Please try again.', 'error');
        return false;
    }
    return true;
}

async function pausePlayback() {
    if (!currentIframe || terminalHandled) {
        return;
    }
    postPlayerCommand('pause');
    clearPlaybackWatchdog();
    if (!replayMode) {
        queueViewerEvent('paused', null);
    }
    setPlaybackUi('paused');
}

async function acceptPlayerReady(eventType, detail) {
    const iframe = currentIframe;
    const record = currentRecord();
    if (readyHandled || terminalHandled || !iframe || !record) {
        return;
    }
    readyHandled = true;
    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    if (iframeLoadTimer) {
        clearTimeout(iframeLoadTimer);
        iframeLoadTimer = null;
    }
    elements.placeholder.hidden = true;
    const response = replayMode
        ? { ok: true }
        : await queueViewerEventWithRetry(eventType, null);
    if (iframe !== currentIframe) {
        return;
    }
    if (!response || !response.ok) {
        readyHandled = false;
        elements.placeholder.hidden = false;
        showNotice('Player readiness could not be saved locally. Reload this viewer.', 'error');
        return;
    }
    if (!replayMode) {
        record.viewerStatus = 'ready';
    }
    setPlaybackUi('ready', detail);
    if (autoplayUnlocked) {
        await requestPlayback(true);
    }
}

function loadCurrentVideo() {
    removeCurrentPlayer();
    clearNotice();
    terminalHandled = false;
    pendingTerminal = null;
    readyHandled = false;
    lastCurrentTimeSecond = -1;
    elements.retry.hidden = true;
    elements.retry.disabled = false;
    elements.placeholder.hidden = false;

    const record = currentRecord();
    replayMode = isTerminal(record);
    if (!replayMode) {
        record.viewerStatus = 'pending';
    }
    elements.videoNumber.textContent = String(currentIndex + 1);
    elements.counter.textContent = `${currentIndex + 1} of ${session.queue.length}`;
    setPlaybackUi('preparing');

    const iframe = document.createElement('iframe');
    iframe.title = `Reserved TikTok video ${currentIndex + 1}`;
    iframe.src = embedUrl(record.videoId);
    iframe.allow = 'autoplay; fullscreen';
    iframe.referrerPolicy = 'no-referrer';
    currentIframe = iframe;
    iframe.addEventListener('load', () => {
        if (terminalHandled || iframe !== currentIframe || readyHandled) {
            return;
        }
        iframeLoadTimer = setTimeout(() => {
            if (terminalHandled || iframe !== currentIframe || readyHandled) {
                return;
            }
            acceptPlayerReady('iframe_loaded', 'Play controls are ready.');
        }, IFRAME_LOAD_GRACE_MS);
    }, { once: true });
    elements.playerMount.appendChild(iframe);

    readyTimer = setTimeout(() => {
        if (terminalHandled || iframe !== currentIframe || readyHandled) {
            return;
        }
        acceptPlayerReady('iframe_loaded', 'Press Play to test this embed.');
    }, READY_TIMEOUT_MS);
}

async function persistPendingTerminal() {
    if (!pendingTerminal) {
        return false;
    }
    const record = currentRecord();
    const terminal = pendingTerminal;
    elements.retry.disabled = true;
    const response = await queueViewerEventWithRetry(terminal.type, terminal.value);
    if (!response || !response.ok) {
        elements.retry.hidden = false;
        elements.retry.disabled = false;
        showNotice('The video status was not saved locally. Use Retry save.', 'error');
        updateNavigationControls();
        return false;
    }
    pendingTerminal = null;
    if (terminal.type === 'ended') {
        record.viewerStatus = 'ended';
    } else if (terminal.type === 'participant_skip') {
        record.viewerStatus = 'skipped';
    } else {
        record.viewerStatus = 'unavailable';
    }
    elements.retry.hidden = true;
    elements.retry.disabled = false;
    setPlaybackUi('terminal');
    updateNavigationControls();
    return true;
}

function scheduleAutomaticAdvance() {
    if (!autoplayUnlocked || currentIndex >= session.queue.length - 1) {
        if (currentIndex === session.queue.length - 1) {
            elements.videoStatus.textContent = 'Use ✓ to finish or ← to review.';
        }
        return;
    }
    const fromIndex = currentIndex;
    autoAdvanceTimer = setTimeout(() => {
        autoAdvanceTimer = null;
        if (currentIndex === fromIndex) {
            navigateTo(fromIndex + 1, true);
        }
    }, AUTO_ADVANCE_DELAY_MS);
}

async function handleTerminal(type, value) {
    if (terminalHandled) {
        return false;
    }
    terminalHandled = true;
    clearPlayerTimers();
    playbackPhase = 'terminal';
    elements.play.disabled = true;
    if (replayMode) {
        elements.videoTitle.textContent = type === 'ended' ? 'Replay finished' : 'Replay unavailable';
        elements.videoStatus.textContent = 'Move to another video when ready.';
        updateNavigationControls();
        if (type === 'ended') {
            scheduleAutomaticAdvance();
        }
        return true;
    }
    pendingTerminal = { type, value };
    const saved = await persistPendingTerminal();
    if (saved && type === 'ended') {
        elements.videoTitle.textContent = 'Video finished';
        elements.videoStatus.textContent = 'Advancing automatically…';
        scheduleAutomaticAdvance();
    }
    return saved;
}

async function markCurrentSkipped() {
    const record = currentRecord();
    if (!record || replayMode || isTerminal(record)) {
        return true;
    }
    elements.videoTitle.textContent = 'Skipping video';
    elements.videoStatus.textContent = 'Saving navigation…';
    return handleTerminal('participant_skip', null);
}

function allVideosTerminal() {
    return session && session.queue.every(isTerminal);
}

async function finishViewer() {
    if (!allVideosTerminal()) {
        const unfinished = session.queue.findIndex((record) => !isTerminal(record));
        if (unfinished >= 0) {
            currentIndex = unfinished;
            loadCurrentVideo();
        }
        return;
    }
    removeCurrentPlayer();
    const response = await send({
        type: Core.MESSAGE_TYPES.VIEWER_FINISH,
        sessionId: session.id,
    });
    if (!response || !response.ok) {
        showNotice('The viewer could not be marked complete.', 'error');
        loadCurrentVideo();
        return;
    }
    showComplete();
}

async function navigateTo(targetIndex, automatic) {
    if (!session || navigationBusy || targetIndex < 0 || targetIndex === currentIndex) {
        return;
    }
    navigationBusy = true;
    updateNavigationControls();
    const saved = await markCurrentSkipped();
    if (!saved) {
        navigationBusy = false;
        updateNavigationControls();
        return;
    }
    if (targetIndex >= session.queue.length) {
        navigationBusy = false;
        updateNavigationControls();
        await finishViewer();
        return;
    }
    currentIndex = targetIndex;
    navigationBusy = false;
    loadCurrentVideo();
    if (!automatic) {
        clearNotice();
    }
}

async function handlePlayerMessage(event) {
    const normalized = Core.validateTikTokPlayerMessage(
        event.origin,
        Boolean(currentIframe && event.source === currentIframe.contentWindow),
        event.data
    );
    if (!normalized || !session || currentIndex < 0 || terminalHandled) {
        return;
    }
    const record = currentRecord();

    if (normalized.type === 'ready') {
        await acceptPlayerReady('ready', 'Press Play to begin.');
        return;
    }
    if (normalized.type === 'player_error') {
        if (normalized.value && normalized.value.code === 3002) {
            clearPlaybackWatchdog();
            setPlaybackUi('ready', 'Autoplay was blocked. Press Play to continue.');
            return;
        }
        elements.placeholder.hidden = false;
        elements.videoTitle.textContent = 'Video unavailable';
        elements.videoStatus.textContent = 'Use Next to continue.';
        await handleTerminal('player_error', normalized.value);
        return;
    }

    if (
        !replayMode &&
        record.viewerStatus === 'ready' &&
        (normalized.type === 'playing' || (
            normalized.type === 'current_time' && normalized.value.currentTime > 0
        ))
    ) {
        const response = await queueViewerEventWithRetry('play_command', null);
        if (!response || !response.ok) {
            showNotice('Playback could not be saved locally. Reload this viewer.', 'error');
            return;
        }
        record.viewerStatus = 'play_requested';
    }

    if (normalized.type === 'current_time') {
        if (
            !replayMode &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return;
        }
        const second = Math.floor(normalized.value.currentTime);
        if (second !== lastCurrentTimeSecond) {
            lastCurrentTimeSecond = second;
            if (!replayMode) {
                record.viewerStatus = 'playing';
                queueViewerEvent('current_time', normalized.value);
            }
            setPlaybackUi('playing');
            armPlaybackWatchdog();
        }
        return;
    }
    if (normalized.type === 'ended') {
        if (
            (!replayMode && !['play_requested', 'playing'].includes(record.viewerStatus)) ||
            (replayMode && !['requested', 'playing', 'paused', 'buffering'].includes(playbackPhase))
        ) {
            return;
        }
        await handleTerminal('ended', null);
        return;
    }
    if (normalized.type === 'playing') {
        if (
            !replayMode &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return;
        }
        if (!replayMode) {
            record.viewerStatus = 'playing';
            queueViewerEvent('playing', null);
        }
        setPlaybackUi('playing');
        armPlaybackWatchdog();
        return;
    }
    if (normalized.type === 'paused') {
        if (
            !replayMode &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return;
        }
        if (!replayMode) {
            queueViewerEvent('paused', null);
        }
        clearPlaybackWatchdog();
        setPlaybackUi('paused');
        return;
    }
    if (normalized.type === 'buffering') {
        if (
            !replayMode &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return;
        }
        if (!replayMode) {
            queueViewerEvent('buffering', null);
        }
        setPlaybackUi('buffering');
        armPlaybackWatchdog();
        return;
    }
    if (normalized.type === 'init' && !replayMode) {
        queueViewerEvent('init', null);
    }
}

elements.play.addEventListener('click', () => {
    if (['playing', 'requested', 'buffering'].includes(playbackPhase)) {
        pausePlayback();
    } else {
        requestPlayback(false);
    }
});

elements.previous.addEventListener('click', () => {
    navigateTo(currentIndex - 1, false);
});

elements.next.addEventListener('click', () => {
    navigateTo(currentIndex + 1, false);
});

elements.retry.addEventListener('click', () => {
    persistPendingTerminal();
});

document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
        return;
    }
    const previousKeys = new Set(['ArrowLeft', 'ArrowUp', 'PageUp']);
    const nextKeys = new Set(['ArrowRight', 'ArrowDown', 'PageDown']);
    if (previousKeys.has(event.key)) {
        event.preventDefault();
        navigateTo(currentIndex - 1, false);
    } else if (nextKeys.has(event.key)) {
        event.preventDefault();
        navigateTo(currentIndex + 1, false);
    } else if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        elements.play.click();
    }
});

elements.viewer.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) < 8 && Math.abs(event.deltaX) < 8) {
        return;
    }
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheelAt < WHEEL_DEBOUNCE_MS) {
        return;
    }
    lastWheelAt = now;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
    navigateTo(currentIndex + (delta > 0 ? 1 : -1), false);
}, { passive: false });

function showComplete() {
    elements.viewer.hidden = true;
    elements.locked.hidden = true;
    elements.complete.hidden = false;
    elements.counter.textContent = 'Complete';
}

elements.openInspector.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('inspector/inspector.html') });
});

window.addEventListener('message', handlePlayerMessage);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
        if (['requested', 'playing', 'buffering'].includes(playbackPhase)) {
            postPlayerCommand('pause');
            if (!replayMode) {
                queueViewerEvent('paused', null);
            }
            setPlaybackUi('paused');
        }
        clearPlaybackWatchdog();
        return;
    }
});

async function initialize() {
    if (!sessionId || !/^[A-Za-z0-9:_-]{1,120}$/.test(sessionId)) {
        elements.locked.hidden = false;
        elements.lockedMessage.textContent = 'This viewer link does not identify a valid local session.';
        return;
    }
    const response = await send({
        type: Core.MESSAGE_TYPES.GET_VIEWER_SESSION,
        sessionId,
    });
    if (!response || !response.ok) {
        elements.locked.hidden = false;
        elements.lockedMessage.textContent = response && response.error === 'collection_not_complete'
            ? 'The sourcing window must finish before this viewer opens.'
            : 'This local viewer session is unavailable.';
        return;
    }
    session = response.session;
    currentIndex = session.queue.findIndex((record) => !isTerminal(record));
    if (currentIndex === -1 || session.status === Core.SESSION_STATUS.VIEWED) {
        showComplete();
        return;
    }
    elements.viewer.hidden = false;
    loadCurrentVideo();
}

initialize();
