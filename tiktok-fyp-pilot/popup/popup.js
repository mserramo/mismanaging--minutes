/* global TikTokPilotCore */
'use strict';

const Core = TikTokPilotCore;
const elements = {
    message: document.getElementById('message'),
    newSession: document.getElementById('new-session'),
    activeSession: document.getElementById('active-session'),
    durationSummary: document.getElementById('duration-summary'),
    consent: document.getElementById('consent'),
    grant: document.getElementById('grant'),
    qualtricsReady: document.getElementById('qualtrics-ready'),
    activeLabel: document.getElementById('active-label'),
    activeStatus: document.getElementById('active-status'),
    activeProgress: document.getElementById('active-progress'),
    timeProgress: document.getElementById('time-progress'),
    resume: document.getElementById('resume'),
    openViewer: document.getElementById('open-viewer'),
    stop: document.getElementById('stop'),
    settings: document.getElementById('settings'),
    inspector: document.getElementById('inspector'),
    clear: document.getElementById('clear'),
    revoke: document.getElementById('revoke'),
};

let currentState = null;

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

function showMessage(text, kind) {
    elements.message.textContent = text;
    elements.message.className = `notice${kind ? ` ${kind}` : ''}`;
    elements.message.hidden = false;
}

function clearMessage() {
    elements.message.hidden = true;
    elements.message.textContent = '';
}

function setBusy(button, busy) {
    button.disabled = busy;
    button.dataset.busy = busy ? 'true' : 'false';
}

function render(response) {
    currentState = response;
    const state = response.state;
    const active = state.activeSession;
    elements.revoke.hidden = !response.permissionGranted;
    elements.durationSummary.textContent = `${state.settings.harvestDurationSeconds} seconds`;

    elements.newSession.hidden = Boolean(active);
    elements.activeSession.hidden = !active;
    if (!active) {
        elements.grant.hidden = response.permissionGranted;
        elements.qualtricsReady.hidden = !response.permissionGranted;
        elements.consent.checked = false;
        elements.grant.disabled = true;
        return;
    }

    const progress = active.progress;
    const automated = progress.collectionMode === Core.COLLECTION_MODE.AUTOMATED_BACKGROUND;
    const collecting = active.status === Core.SESSION_STATUS.COLLECTING;
    const failed = active.status === Core.SESSION_STATUS.FAILED;
    const qualtrics = active.deliveryTarget === Core.DELIVERY_TARGET.QUALTRICS;
    elements.activeProgress.textContent = automated
        ? failed
            ? `Failure: ${progress.stopReason || 'unknown_failure'} · ${progress.unseenCount} sourced`
            : `${progress.unseenCount} sourced · ` +
                `${Math.ceil(progress.harvestRemainingMs / 1000)}s remaining`
        : `${Math.min(progress.qualifiedSeconds, progress.durationSeconds)} / ` +
            `${progress.durationSeconds}s · ${progress.unseenCount} / ` +
            `${progress.targetUnseenCount} reserved`;
    elements.timeProgress.style.width = automated
        ? `${Math.min(100, (progress.harvestElapsedMs /
            (progress.harvestDurationSeconds * 1000)) * 100)}%`
        : `${Math.min(100, (progress.qualifiedMs /
            (progress.durationSeconds * 1000)) * 100)}%`;
    elements.activeLabel.textContent = collecting
        ? 'Collection in progress'
        : active.status === Core.SESSION_STATUS.COMPLETE
            ? 'Collection complete'
            : failed
                ? 'Collection failed'
                : 'Viewer in progress';
    elements.activeStatus.textContent = collecting ? 'Background' : failed ? 'Retry' : 'Ready';
    elements.resume.hidden = !collecting;
    elements.stop.hidden = !collecting && !failed;
    elements.openViewer.hidden = collecting || failed;
    elements.openViewer.textContent = qualtrics ? 'Return to Qualtrics' : 'Open viewer';
}

async function refresh() {
    const response = await send({ type: Core.MESSAGE_TYPES.GET_STATE });
    if (!response || !response.ok) {
        showMessage('The extension state could not be loaded.', 'error');
        return;
    }
    render(response);
}

elements.consent.addEventListener('change', () => {
    const permissionGranted = Boolean(currentState && currentState.permissionGranted);
    elements.grant.disabled = permissionGranted || !elements.consent.checked;
});

elements.grant.addEventListener('click', async () => {
    clearMessage();
    setBusy(elements.grant, true);
    try {
        const granted = await chrome.permissions.request({
            origins: ['https://www.tiktok.com/*'],
        });
        if (!granted) {
            showMessage('TikTok access was not granted.', 'error');
            return;
        }
        showMessage('TikTok access is ready. Return to Qualtrics; collection starts only from the survey.', 'success');
        await refresh();
    } catch (_error) {
        showMessage('Chrome could not request TikTok access. Please try again.', 'error');
    } finally {
        setBusy(elements.grant, false);
        const permissionGranted = Boolean(currentState && currentState.permissionGranted);
        elements.grant.disabled = permissionGranted || !elements.consent.checked;
    }
});

elements.resume.addEventListener('click', async () => {
    clearMessage();
    setBusy(elements.resume, true);
    const response = await send({ type: Core.MESSAGE_TYPES.RESUME_SESSION });
    if (!response || !response.ok) {
        showMessage('The FYP collection tab could not be reopened.', 'error');
        setBusy(elements.resume, false);
        return;
    }
    window.close();
});

elements.openViewer.addEventListener('click', async () => {
    if (!currentState || !currentState.state.activeSession) {
        return;
    }
    setBusy(elements.openViewer, true);
    const response = await send({
        type: Core.MESSAGE_TYPES.OPEN_VIEWER,
        sessionId: currentState.state.activeSession.id,
    });
    if (!response || !response.ok) {
        showMessage('The viewer is not available yet.', 'error');
        setBusy(elements.openViewer, false);
        return;
    }
    window.close();
});

elements.stop.addEventListener('click', async () => {
    if (!currentState || !currentState.state.activeSession) {
        return;
    }
    if (!confirm('Stop this collection session? Its local records will remain until cleared.')) {
        return;
    }
    const response = await send({
        type: Core.MESSAGE_TYPES.STOP_SESSION,
        sessionId: currentState.state.activeSession.id,
    });
    if (!response || !response.ok) {
        showMessage('The session could not be stopped.', 'error');
        return;
    }
    await refresh();
});

elements.settings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
});

elements.inspector.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('inspector/inspector.html') });
});

elements.clear.addEventListener('click', async () => {
    if (!confirm('Clear every locally stored pilot session? Pilot settings will be kept.')) {
        return;
    }
    const response = await send({ type: Core.MESSAGE_TYPES.CLEAR_DATA });
    if (!response || !response.ok) {
        showMessage('Local pilot data could not be cleared.', 'error');
        return;
    }
    showMessage('All collected pilot data was cleared.', 'success');
    await refresh();
});

elements.revoke.addEventListener('click', async () => {
    if (!confirm('Revoke this extension’s access to TikTok? Stored records will remain.')) {
        return;
    }
    const response = await send({ type: Core.MESSAGE_TYPES.REVOKE_ACCESS });
    if (!response || !response.ok) {
        showMessage('TikTok access could not be fully revoked.', 'error');
        return;
    }
    showMessage('TikTok access was revoked. Stored records were preserved.', 'success');
    await refresh();
});

refresh();
