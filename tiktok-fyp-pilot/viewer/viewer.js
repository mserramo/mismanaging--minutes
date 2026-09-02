/* global TikTokPilotCore */
'use strict';

const Core = TikTokPilotCore;
const READY_TIMEOUT_MS = 15000;
const IFRAME_LOAD_GRACE_MS = 1000;
const PLAYBACK_STALL_MS = 45000;
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
let lastCurrentTimeSecond = -1;
let terminalHandled = false;
let pendingTerminal = null;
let eventQueue = Promise.resolve();
let playbackPhase = 'idle';
let readyHandled = false;
let nativePlayerFallback = false;

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

function queueViewerEvent(type, value) {
    if (!session || currentIndex < 0 || !session.queue[currentIndex]) {
        return Promise.resolve({ ok: false });
    }
    const targetSessionId = session.id;
    const targetVideoId = session.queue[currentIndex].videoId;
    const eventAt = Date.now();
    const operation = eventQueue.then(() => send({
        type: Core.MESSAGE_TYPES.VIEWER_EVENT,
        sessionId: targetSessionId,
        videoId: targetVideoId,
        at: eventAt,
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

function embedUrl(videoId) {
    const parameters = new URLSearchParams({
        controls: '0',
        progress_bar: '0',
        play_button: '0',
        volume_control: '0',
        fullscreen_button: '0',
        timestamp: '0',
        loop: '0',
        autoplay: '0',
        music_info: '0',
        description: '0',
        rel: '0',
        native_context_menu: '0',
        closed_caption: '0',
    });
    return `${Core.TIKTOK_ORIGIN}/player/v1/${videoId}?${parameters.toString()}`;
}

function unfinishedIndex(queue) {
    return queue.findIndex(
        (record) => !['ended', 'unavailable'].includes(record.viewerStatus)
    );
}

function removeCurrentPlayer() {
    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    if (iframeLoadTimer) {
        clearTimeout(iframeLoadTimer);
        iframeLoadTimer = null;
    }
    if (playbackTimer) {
        clearTimeout(playbackTimer);
        playbackTimer = null;
    }
    currentIframe = null;
    playbackPhase = 'idle';
    nativePlayerFallback = false;
    elements.playerMount.classList.remove('is-interactive');
    elements.playerMount.replaceChildren();
}

async function acceptPlayerReady(eventType, statusText) {
    if (
        readyHandled ||
        terminalHandled ||
        !currentIframe ||
        !session ||
        currentIndex < 0
    ) {
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
    const response = await queueViewerEventWithRetry(eventType, null);
    if (!response || !response.ok) {
        readyHandled = false;
        elements.placeholder.hidden = false;
        showNotice('Player readiness could not be saved locally. Reload this viewer.', 'error');
        return;
    }
    session.queue[currentIndex].viewerStatus = 'ready';
    nativePlayerFallback = eventType === 'iframe_loaded';
    elements.playerMount.classList.toggle('is-interactive', nativePlayerFallback);
    elements.play.hidden = nativePlayerFallback;
    elements.play.disabled = nativePlayerFallback;
    elements.videoTitle.textContent = 'Ready to watch';
    elements.videoStatus.textContent = nativePlayerFallback
        ? 'Use the Play button shown directly on the TikTok video.'
        : statusText;
}

function clearPlaybackWatchdog() {
    if (playbackTimer) {
        clearTimeout(playbackTimer);
        playbackTimer = null;
    }
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
        elements.videoStatus.textContent =
            'No playback progress was received. You can continue to the next video.';
        await handleTerminal('playback_timeout', null);
    }, PLAYBACK_STALL_MS);
}

function loadCurrentVideo() {
    removeCurrentPlayer();
    terminalHandled = false;
    pendingTerminal = null;
    readyHandled = false;
    lastCurrentTimeSecond = -1;
    elements.play.disabled = true;
    elements.next.disabled = true;
    elements.next.textContent = 'Next video';
    elements.retry.hidden = true;
    elements.retry.disabled = false;
    elements.play.hidden = false;
    elements.play.textContent = 'Play video';
    elements.videoTitle.textContent = 'Preparing video';
    elements.videoStatus.textContent = 'Waiting for the official TikTok player.';
    elements.placeholder.hidden = false;

    const record = session.queue[currentIndex];
    if (!['ended', 'unavailable'].includes(record.viewerStatus)) {
        record.viewerStatus = 'pending';
    }
    elements.videoNumber.textContent = `${currentIndex + 1}`;
    elements.counter.textContent = `${currentIndex + 1} of ${session.queue.length}`;

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
            acceptPlayerReady(
                'iframe_loaded',
                'Press Play to start this video.'
            );
        }, IFRAME_LOAD_GRACE_MS);
    }, { once: true });
    elements.playerMount.appendChild(iframe);

    // Some current TikTok players load successfully but omit onPlayerReady
    // when embedded in a chrome-extension page. Never classify that omission
    // alone as an unavailable post: expose the participant-initiated Play path
    // and let an explicit player error or post-Play watchdog decide terminality.
    readyTimer = setTimeout(() => {
        if (terminalHandled || iframe !== currentIframe || readyHandled) {
            return;
        }
        acceptPlayerReady(
            'iframe_loaded',
            'The embed loaded without a ready signal. Press Play to test playback.'
        );
    }, READY_TIMEOUT_MS);
}

async function persistPendingTerminal() {
    if (!pendingTerminal) {
        return;
    }
    elements.retry.disabled = true;
    const response = await queueViewerEventWithRetry(
        pendingTerminal.type,
        pendingTerminal.value
    );
    if (!response || !response.ok) {
        elements.retry.hidden = false;
        elements.retry.disabled = false;
        showNotice(
            'Playback finished, but its status was not saved locally. Use Retry saving status.',
            'error'
        );
        return;
    }
    const type = pendingTerminal.type;
    pendingTerminal = null;
    session.queue[currentIndex].viewerStatus =
        type === 'ended' ? 'ended' : 'unavailable';
    elements.retry.hidden = true;
    elements.next.disabled = false;
    elements.play.disabled = true;
}

async function handleTerminal(type, value) {
    if (terminalHandled) {
        return;
    }
    terminalHandled = true;
    if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
    }
    if (iframeLoadTimer) {
        clearTimeout(iframeLoadTimer);
        iframeLoadTimer = null;
    }
    if (playbackTimer) {
        clearPlaybackWatchdog();
    }
    playbackPhase = 'terminal';
    pendingTerminal = { type, value };
    elements.play.disabled = true;
    await persistPendingTerminal();
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

    const record = session.queue[currentIndex];

    if (
        nativePlayerFallback &&
        record.viewerStatus === 'ready' &&
        (
            normalized.type === 'playing' ||
            (
                normalized.type === 'current_time' &&
                normalized.value.currentTime > 0
            )
        )
    ) {
        const response = await queueViewerEventWithRetry('play_command', null);
        if (!response || !response.ok) {
            showNotice('Native playback could not be saved locally. Reload this viewer.', 'error');
            return;
        }
        record.viewerStatus = 'play_requested';
        playbackPhase = 'requested';
        armPlaybackWatchdog();
    }

    if (normalized.type === 'ready') {
        if (!['pending', 'ready'].includes(record.viewerStatus)) {
            return;
        }
        await acceptPlayerReady('ready', 'Press Play to start this video.');
        return;
    }
    if (normalized.type === 'current_time') {
        if (!['play_requested', 'playing'].includes(record.viewerStatus)) {
            return;
        }
        const second = Math.floor(normalized.value.currentTime);
        if (second !== lastCurrentTimeSecond) {
            lastCurrentTimeSecond = second;
            playbackPhase = 'playing';
            record.viewerStatus = 'playing';
            elements.play.disabled = true;
            elements.play.textContent = 'Playing';
            queueViewerEvent('current_time', normalized.value);
            armPlaybackWatchdog();
        }
        return;
    }
    if (normalized.type === 'ended') {
        if (!['play_requested', 'playing'].includes(record.viewerStatus)) {
            return;
        }
        elements.videoTitle.textContent = 'Video finished';
        elements.videoStatus.textContent = 'Continue when you are ready.';
        await handleTerminal('ended', null);
        return;
    }
    if (normalized.type === 'player_error') {
        elements.placeholder.hidden = false;
        elements.videoTitle.textContent = 'Video unavailable';
        elements.videoStatus.textContent =
            'TikTok could not play this post. You can continue to the next video.';
        await handleTerminal('player_error', normalized.value);
        return;
    }
    if (['init', 'playing', 'paused', 'buffering'].includes(normalized.type)) {
        if (
            normalized.type !== 'init' &&
            !['play_requested', 'playing'].includes(record.viewerStatus)
        ) {
            return;
        }
        if (normalized.type === 'playing') {
            elements.videoTitle.textContent = 'Now playing';
            elements.videoStatus.textContent = 'The next button unlocks when the video ends.';
            record.viewerStatus = 'playing';
            playbackPhase = 'playing';
            elements.play.disabled = true;
            elements.play.textContent = 'Playing';
            armPlaybackWatchdog();
        } else if (normalized.type === 'paused') {
            playbackPhase = 'paused';
            clearPlaybackWatchdog();
            elements.play.disabled = false;
            elements.play.textContent = 'Resume video';
            elements.videoTitle.textContent = 'Playback paused';
            elements.videoStatus.textContent = 'Press Resume video to continue.';
        } else if (normalized.type === 'buffering') {
            playbackPhase = 'buffering';
            elements.play.disabled = true;
            elements.videoTitle.textContent = 'Buffering';
            elements.videoStatus.textContent = 'Waiting for TikTok playback to resume.';
            armPlaybackWatchdog();
        }
        queueViewerEvent(normalized.type, null);
    }
}

elements.play.addEventListener('click', async () => {
    if (!currentIframe || !currentIframe.contentWindow || elements.play.disabled) {
        return;
    }
    elements.play.disabled = true;
    elements.videoStatus.textContent = 'Starting playback…';
    const record = session.queue[currentIndex];
    const wasResume = playbackPhase === 'paused' || record.viewerStatus === 'playing';
    record.viewerStatus = 'play_requested';
    playbackPhase = 'requested';
    armPlaybackWatchdog();
    const savePlayCommand = queueViewerEventWithRetry('play_command', null);
    currentIframe.contentWindow.postMessage(
        { type: 'unMute', value: null, 'x-tiktok-player': true },
        Core.TIKTOK_ORIGIN
    );
    currentIframe.contentWindow.postMessage(
        { type: 'play', value: null, 'x-tiktok-player': true },
        Core.TIKTOK_ORIGIN
    );
    const response = await savePlayCommand;
    if (!response || !response.ok) {
        if (terminalHandled) {
            return;
        }
        playbackPhase = wasResume ? 'paused' : 'idle';
        clearPlaybackWatchdog();
        currentIframe.contentWindow.postMessage(
            { type: 'pause', value: null, 'x-tiktok-player': true },
            Core.TIKTOK_ORIGIN
        );
        record.viewerStatus = wasResume ? 'playing' : 'ready';
        elements.play.disabled = false;
        elements.play.textContent = wasResume ? 'Resume video' : 'Play video';
        showNotice('The Play action could not be saved locally. Please try again.', 'error');
    }
});

elements.retry.addEventListener('click', () => {
    persistPendingTerminal();
});

elements.next.addEventListener('click', async () => {
    if (!terminalHandled || elements.next.disabled) {
        return;
    }
    currentIndex = unfinishedIndex(session.queue);
    if (currentIndex === -1) {
        removeCurrentPlayer();
        elements.next.disabled = true;
        elements.next.textContent = 'Finishing…';
        const response = await send({
            type: Core.MESSAGE_TYPES.VIEWER_FINISH,
            sessionId: session.id,
        });
        if (!response || !response.ok) {
            showNotice('The viewer could not be marked complete.', 'error');
            elements.next.disabled = false;
            elements.next.textContent = 'Retry finishing';
            return;
        }
        showComplete();
        return;
    }
    loadCurrentVideo();
});

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
        clearPlaybackWatchdog();
        return;
    }
    // Visibility alone is not evidence that the iframe resumed. Keep the
    // watchdog suspended and expose an explicit resume affordance until a fresh
    // playing/current-time message arrives.
    if (['requested', 'playing', 'buffering'].includes(playbackPhase)) {
        playbackPhase = 'paused';
        elements.play.disabled = false;
        elements.play.textContent = 'Resume video';
        elements.videoStatus.textContent = 'Press Resume video if playback did not resume.';
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
            ? 'Both the qualified-time and unseen-video targets must be met first.'
            : 'This local viewer session is unavailable.';
        return;
    }
    session = response.session;
    currentIndex = unfinishedIndex(session.queue);
    if (currentIndex === -1 || session.status === Core.SESSION_STATUS.VIEWED) {
        showComplete();
        return;
    }
    elements.viewer.hidden = false;
    loadCurrentVideo();
}

initialize();
