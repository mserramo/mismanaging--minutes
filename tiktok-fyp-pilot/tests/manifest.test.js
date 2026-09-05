'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function allFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory() ? allFiles(fullPath) : [fullPath];
    });
}

test('manifest has narrow MV3 permissions and no static TikTok injection', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions.sort(), ['alarms', 'scripting', 'storage']);
    assert.deepEqual(manifest.optional_host_permissions, ['https://www.tiktok.com/*']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.deepEqual(manifest.externally_connectable, {
        matches: ['https://stanforduniversity.qualtrics.com/*'],
    });
    const serialized = JSON.stringify(manifest);
    ['cookies', 'history', 'webRequest', '<all_urls>', 'storage.sync'].forEach((forbidden) => {
        assert.equal(serialized.includes(forbidden), false);
    });
});

test('manifest public key fixes the unpacked ID used by both Qualtrics surveys', () => {
    const digest = crypto.createHash('sha256')
        .update(Buffer.from(manifest.key, 'base64'))
        .digest('hex')
        .slice(0, 32);
    const extensionId = Array.from(
        digest,
        (character) => String.fromCharCode(97 + '0123456789abcdef'.indexOf(character))
    ).join('');
    assert.equal(extensionId, 'pjcgejllbdjbhegipdkagnafileoecpo');
    [
        'qualtrics/tiktok_fyp_qualtrics.js',
        'qualtrics/tiktok_fyp_natural_qualtrics.js',
    ].forEach((relativePath) => {
        const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
        assert.match(source, new RegExp(`const EXTENSION_ID = '${extensionId}'`));
        assert.doesNotMatch(source, /extensionInput|Chrome extension ID/);
        assert.match(source, /connect\(\);/);
    });
});

test('manifest entry points exist and CSP allows only the TikTok frame', () => {
    assert.equal(fs.existsSync(path.join(root, manifest.background.service_worker)), true);
    assert.equal(fs.existsSync(path.join(root, manifest.action.default_popup)), true);
    assert.equal(fs.existsSync(path.join(root, manifest.options_ui.page)), true);
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-src https:\/\/www\.tiktok\.com/);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline/);
});

test('participant popup grants access but cannot accidentally start a standalone run', () => {
    const popupHtml = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
    assert.match(popupHtml, /Grant TikTok access/);
    assert.match(popupHtml, /Return to the Qualtrics survey/);
    assert.doesNotMatch(popupHtml, /Start standalone session/);
    assert.doesNotMatch(popupJs, /MESSAGE_TYPES\.START_SESSION/);
});

test('dynamic collector is document_start and JavaScript avoids unsafe rendering', () => {
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(background, /optional_host_permissions|registerContentScripts/);
    assert.match(background, /runAt:\s*'document_start'/);
    assert.match(background, /world:\s*'ISOLATED'/);
    assert.match(background, /setAccessLevel/);
    assert.match(background, /content\/natural-session\.js/);

    const javascript = allFiles(root)
        .filter((file) => file.endsWith('.js'))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
    assert.doesNotMatch(javascript, /\.innerHTML\s*=/);
    assert.doesNotMatch(javascript, /\beval\s*\(/);
    assert.doesNotMatch(javascript, /parseInt\s*\(/);
});

test('natural collector is nonblocking and never inspects key values or cursor coordinates', () => {
    const natural = fs.readFileSync(path.join(root, 'content/natural-session.js'), 'utf8');
    assert.match(natural, /NATURAL_ACTIVITY/);
    assert.match(natural, /attachShadow\(\{ mode: 'closed' \}\)/);
    assert.match(natural, /document\.visibilityState/);
    assert.doesNotMatch(natural, /document\.hasFocus\(\)/);
    assert.match(natural, /authoritativeTabFocused/);
    assert.doesNotMatch(natural, /updateBanner\('counting'\)/);
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(background, /chrome\.windows\.get\(tab\.windowId\)/);
    assert.match(background, /tab\.active !== true/);
    assert.match(natural, /SEEN_THRESHOLD_MS = 500/);
    assert.doesNotMatch(natural, /event\.(key|code|clientX|clientY|pageX|pageY)/);
    assert.doesNotMatch(natural, /preventDefault|stopImmediatePropagation/);
    assert.doesNotMatch(natural, /media\.muted\s*=/);
});

test('viewer targets TikTok exactly and never uses wildcard postMessage', () => {
    const viewer = fs.readFileSync(path.join(root, 'viewer/viewer.js'), 'utf8');
    assert.match(viewer, /Core\.TIKTOK_ORIGIN/);
    assert.doesNotMatch(viewer, /postMessage\([\s\S]{0,180},\s*['"]\*['"]\s*\)/);
    assert.match(viewer, /autoplay:\s*autoplayUnlocked \? '1' : '0'/);
    assert.match(viewer, /allow = 'autoplay; fullscreen'/);
    assert.match(viewer, /referrerPolicy\s*=\s*'no-referrer'/);
});

test('collector and service worker retain fail-closed runtime guards', () => {
    const collector = fs.readFileSync(path.join(root, 'content/collector.js'), 'utf8');
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(collector, /event\.isTrusted/);
    assert.match(collector, /Core\.isFypPath\(location\.pathname\)/);
    assert.match(collector, /MutationObserver/);
    assert.match(collector, /setTimeout/);
    assert.doesNotMatch(collector, /requestAnimationFrame/);
    assert.match(collector, /attachShadow\(\{ mode: 'closed' \}\)/);
    assert.match(collector, /media\.muted = true/);
    assert.match(collector, /stopImmediatePropagation/);
    assert.match(collector, /EXCLUDE_VIDEO/);
    assert.match(collector, /CONFIRM_RESERVATION/);
    assert.match(collector, /REPLACEMENT_WAIT_MS = 1000/);
    assert.match(collector, /STAGE_TIMEOUT_MS = 8000/);
    assert.match(collector, /MAX_ADVANCE_ATTEMPTS = 3/);
    assert.match(collector, /Continue to Qualtrics \(testing\)/);
    assert.match(collector, /Recent diagnostic log/);
    assert.match(collector, /reportCollectorReady/);
    assert.match(collector, /waiting_deadline/);
    assert.match(collector, /validUnseenCount > 0/);
    assert.match(collector, /excludeAmbiguousRecords/);
    assert.match(collector, /ttfp-reserved-card/);
    assert.doesNotMatch(collector, /record\.element\.remove\(\)/);
    assert.doesNotMatch(collector, /const batchId = `\$\{sourceId\}/);
    assert.match(background, /registrationQueue/);
    assert.match(background, /isViewerForSession/);
    assert.match(background, /wrong_viewer_tab/);
    assert.match(background, /activateTombstoneGuards/);
    assert.match(background, /harvestReturnTabs/);
    assert.match(background, /CONFIRM_RESERVATION/);
    assert.match(background, /STATE_UPDATED/);
    assert.doesNotMatch(background, /tabs\.query\(\{\s*url:\s*chrome\.runtime\.getURL\('viewer/);
});
