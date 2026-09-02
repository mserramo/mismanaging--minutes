/* global TikTokPilotCore */
'use strict';

const Core = TikTokPilotCore;
const form = document.getElementById('settings-form');
const duration = document.getElementById('duration');
const target = document.getElementById('target');
const save = document.getElementById('save');
const reset = document.getElementById('reset');
const message = document.getElementById('message');
const activeNote = document.getElementById('active-note');

function send(payload) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: 'extension_message_failed' });
                return;
            }
            resolve(response);
        });
    });
}

function setMessage(text, kind) {
    message.textContent = text;
    message.className = `notice${kind ? ` ${kind}` : ''}`;
    message.hidden = false;
}

async function loadSettings() {
    const response = await send({ type: Core.MESSAGE_TYPES.GET_STATE });
    if (!response || !response.ok) {
        setMessage('Pilot settings could not be loaded.', 'error');
        return;
    }
    duration.value = response.state.settings.durationSeconds;
    target.value = response.state.settings.targetUnseenCount;
    if (response.state.activeSession) {
        const locked = response.state.activeSession.progress;
        activeNote.textContent =
            `The active session remains locked at ${locked.durationSeconds} seconds and ` +
            `${locked.targetUnseenCount} unseen videos. Changes below apply next time.`;
        activeNote.hidden = false;
    }
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) {
        return;
    }
    save.disabled = true;
    const settings = Core.sanitizeSettings({
        durationSeconds: duration.value,
        targetUnseenCount: target.value,
    });
    const response = await send({
        type: Core.MESSAGE_TYPES.SAVE_SETTINGS,
        settings,
    });
    save.disabled = false;
    if (!response || !response.ok) {
        setMessage('Pilot settings could not be saved.', 'error');
        return;
    }
    duration.value = response.settings.durationSeconds;
    target.value = response.settings.targetUnseenCount;
    setMessage('Pilot settings saved locally.', 'success');
});

reset.addEventListener('click', () => {
    duration.value = Core.DEFAULT_SETTINGS.durationSeconds;
    target.value = Core.DEFAULT_SETTINGS.targetUnseenCount;
    message.hidden = true;
});

loadSettings();
