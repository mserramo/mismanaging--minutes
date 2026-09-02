/* global TikTokPilotCore */
'use strict';

const Core = TikTokPilotCore;
const elements = {
    schema: document.getElementById('schema'),
    sessionCount: document.getElementById('session-count'),
    permission: document.getElementById('permission'),
    settings: document.getElementById('settings'),
    sessions: document.getElementById('sessions'),
    empty: document.getElementById('empty'),
    message: document.getElementById('message'),
    harness: document.getElementById('harness'),
    clear: document.getElementById('clear'),
    revoke: document.getElementById('revoke'),
};

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

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined) {
        element.textContent = text;
    }
    return element;
}

function showMessage(text, kind) {
    elements.message.textContent = text;
    elements.message.className = `notice${kind ? ` ${kind}` : ''}`;
    elements.message.hidden = false;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

function formatMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number / 1000).toFixed(2)}s` : '—';
}

function metadataItem(label, value) {
    const wrapper = node('div');
    wrapper.append(node('span', null, label), node('strong', null, value));
    return wrapper;
}

function makeTable(headers, rows) {
    const wrap = node('div', 'table-wrap');
    const table = node('table');
    const thead = node('thead');
    const headerRow = node('tr');
    headers.forEach((header) => headerRow.appendChild(node('th', null, header)));
    thead.appendChild(headerRow);
    const tbody = node('tbody');
    rows.forEach((row) => {
        const tr = node('tr');
        row.forEach((value, index) => {
            const cell = node('td', index === 0 ? 'mono' : null, String(value));
            tr.appendChild(cell);
        });
        tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
}

function renderSession(session, initiallyOpen) {
    const automated = session.collectionMode === Core.COLLECTION_MODE.AUTOMATED_BACKGROUND;
    const progress = Core.sessionProgress(session);
    const details = node('details', 'card session-card');
    details.open = initiallyOpen;
    const summary = node('summary');
    const titleBlock = node('div');
    titleBlock.append(
        node('div', 'session-title mono', session.id),
        node('div', 'session-subtitle', `Started ${formatDate(session.startedAt)}`)
    );
    summary.append(titleBlock, node('span', 'session-status', session.status));

    const body = node('div', 'session-body');
    const meta = node('div', 'metadata-grid');
    meta.append(
        metadataItem('Mode', automated ? 'Automated background' : 'Legacy manual'),
        metadataItem(
            'Locked harvest window',
            automated ? `${session.lockedSettings.harvestDurationSeconds}s` : '—'
        ),
        metadataItem(
            automated ? 'Collection rule' : 'Unseen target',
            automated ? 'All safe videos in window' : String(session.lockedSettings.targetUnseenCount)
        ),
        metadataItem(
            automated ? 'Harvest elapsed' : 'Qualified time',
            automated ? formatMs(progress.harvestElapsedMs) : formatMs(session.qualifiedMs)
        ),
        metadataItem('Harvest phase', automated ? session.harvestPhase : '—'),
        metadataItem(
            'Deadline',
            automated ? formatDate(session.harvestDeadlineAt) : '—'
        ),
        metadataItem('Selection seed', String(session.seed)),
        metadataItem('Seen IDs', String(session.seen.length)),
        metadataItem('Excluded IDs', String(session.excluded.length)),
        metadataItem('Reserved records', String(session.reserved.length)),
        metadataItem('Diagnostics', String(session.diagnostics.length)),
        metadataItem('Viewer events', String(session.viewerEvents.length))
    );
    body.appendChild(meta);

    if (automated) {
        body.appendChild(node('h3', 'section-heading', 'Automated harvest steps'));
        body.appendChild(makeTable(
            ['Phase', 'Time', 'Visibility', 'Timer delay', 'Hydration', 'Attempt', 'Driver ID'],
            session.harvestSteps.map((record) => [
                record.phase,
                formatDate(record.at),
                record.visibility,
                `${record.timerDelayMs}ms`,
                `${record.hydrationLatencyMs}ms`,
                record.advanceAttempt,
                record.driverVideoId || '—',
            ])
        ));
    }

    body.appendChild(node('h3', 'section-heading', 'Seen videos'));
    body.appendChild(makeTable(
        ['Video ID', 'First seen', 'Last seen', 'Active watch', 'Order'],
        session.seen.map((record) => [
            record.videoId,
            formatDate(record.firstSeenAt),
            formatDate(record.lastSeenAt),
            formatMs(record.activeWatchMs),
            record.order,
        ])
    ));

    body.appendChild(node('h3', 'section-heading', 'Excluded from unseen selection'));
    body.appendChild(makeTable(
        ['Video ID', 'Classification', 'Classified', 'Feed order'],
        session.excluded.map((record) => [
            record.videoId,
            record.classification,
            formatDate(record.classifiedAt),
            record.feedOrder === null ? '—' : record.feedOrder,
        ])
    ));

    body.appendChild(node('h3', 'section-heading', 'Reserved and invalidated videos'));
    body.appendChild(makeTable(
        ['Video ID', 'State', 'Intercepted', 'Ahead by', 'Feed order', 'Viewer'],
        session.reserved.map((record) => [
            record.videoId,
            record.state,
            formatDate(record.interceptedAt),
            record.aheadBy,
            record.feedOrder,
            record.viewerStatus,
        ])
    ));

    body.appendChild(node('h3', 'section-heading', 'Code-only diagnostics'));
    body.appendChild(makeTable(
        ['Code', 'Time', 'Safe detail'],
        session.diagnostics.map((record) => [
            record.code,
            formatDate(record.at),
            Object.entries(record.detail || {})
                .map(([key, value]) => `${key}=${value}`)
                .join(', ') || '—',
        ])
    ));

    body.appendChild(node('h3', 'section-heading', 'Viewer events'));
    body.appendChild(makeTable(
        ['Video ID', 'Event', 'Time'],
        session.viewerEvents.map((record) => [
            record.videoId,
            record.type,
            formatDate(record.at),
        ])
    ));

    details.append(summary, body);
    return details;
}

async function refresh() {
    const response = await send({ type: Core.MESSAGE_TYPES.GET_STATE });
    if (!response || !response.ok) {
        showMessage('Local pilot data could not be loaded.', 'error');
        return;
    }
    const state = response.state;
    elements.schema.textContent = `v${state.schemaVersion}`;
    elements.sessionCount.textContent = String(state.sessions.length);
    elements.permission.textContent = response.permissionGranted ? 'Granted' : 'Not granted';
    elements.settings.textContent =
        `${state.settings.harvestDurationSeconds}s maximize window`;
    elements.revoke.disabled = !response.permissionGranted;
    elements.sessions.replaceChildren();
    elements.empty.hidden = state.sessions.length !== 0;
    state.sessions
        .slice()
        .reverse()
        .forEach((session, index) => {
            elements.sessions.appendChild(renderSession(session, index === 0));
        });
}

elements.harness.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('harness/harness.html') });
});

elements.clear.addEventListener('click', async () => {
    if (!confirm('Permanently clear every locally stored pilot session?')) {
        return;
    }
    const response = await send({ type: Core.MESSAGE_TYPES.CLEAR_DATA });
    if (!response || !response.ok) {
        showMessage('Collected data could not be cleared.', 'error');
        return;
    }
    showMessage('All collected pilot data was cleared. Settings and TikTok permission were kept.', 'success');
    await refresh();
});

elements.revoke.addEventListener('click', async () => {
    if (!confirm('Revoke TikTok access? Collected records will be preserved.')) {
        return;
    }
    const response = await send({ type: Core.MESSAGE_TYPES.REVOKE_ACCESS });
    if (!response || !response.ok) {
        showMessage('TikTok access could not be fully revoked.', 'error');
        return;
    }
    showMessage('TikTok access was revoked. Collected records were preserved.', 'success');
    await refresh();
});

refresh();
