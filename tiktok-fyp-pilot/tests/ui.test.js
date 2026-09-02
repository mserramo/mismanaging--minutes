'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = ['popup', 'options', 'viewer', 'inspector', 'harness'];

test('every statically referenced UI element exists in its page', () => {
    pages.forEach((page) => {
        const html = fs.readFileSync(path.join(root, page, `${page}.html`), 'utf8');
        const javascript = fs.readFileSync(path.join(root, page, `${page}.js`), 'utf8');
        const ids = Array.from(
            javascript.matchAll(/document\.getElementById\('([a-z0-9-]+)'\)/g),
            (match) => match[1]
        );
        ids.forEach((id) => {
            assert.match(html, new RegExp(`id=["']${id}["']`), `${page}: missing #${id}`);
        });
        assert.doesNotMatch(html, /<script(?!\s+src=)/i, `${page}: inline script violates CSP`);
    });
});

test('participant-facing consent accurately states storage and network boundaries', () => {
    const popup = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
    assert.match(popup, /does not store usernames/i);
    assert.match(popup, /normal TikTok pages and embeds still communicate with TikTok/i);
    assert.match(popup, /Access remains until I use\s+Revoke access/i);
});

test('viewer exposes Play, terminal retry, and gated Next controls', () => {
    const html = fs.readFileSync(path.join(root, 'viewer/viewer.html'), 'utf8');
    const javascript = fs.readFileSync(path.join(root, 'viewer/viewer.js'), 'utf8');
    assert.match(html, /id="play"[^>]*disabled/);
    assert.match(html, /id="next"[^>]*disabled/);
    assert.match(html, /id="retry"[^>]*hidden/);
    assert.match(javascript, /queueViewerEventWithRetry/);
    assert.match(javascript, /iframe\.addEventListener\('load'/);
    assert.match(javascript, /iframe_loaded/);
    assert.match(javascript, /nativePlayerFallback/);
    assert.match(javascript, /is-interactive/);
    assert.doesNotMatch(javascript, /handleTerminal\('ready_timeout'/);
    assert.match(javascript, /PLAYBACK_STALL_MS/);
    assert.match(javascript, /armPlaybackWatchdog/);
    assert.match(javascript, /visibilitychange/);
    assert.match(
        javascript,
        /normalized\.type === 'paused'[\s\S]{0,260}elements\.play\.disabled = false/
    );
    assert.match(
        javascript,
        /normalized\.type === 'buffering'[\s\S]{0,320}armPlaybackWatchdog\(\)/
    );
    const visibilityHandler = javascript.match(
        /document\.addEventListener\('visibilitychange',[\s\S]*?\n\}\);/
    );
    assert.ok(visibilityHandler);
    assert.doesNotMatch(visibilityHandler[0], /armPlaybackWatchdog\(\)/);
    assert.doesNotMatch(javascript, /PLAYBACK_TIMEOUT_MS/);
    assert.match(javascript, /terminalHandled/);
});
