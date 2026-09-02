'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
    assert.deepEqual(manifest.permissions.sort(), ['scripting', 'storage']);
    assert.deepEqual(manifest.optional_host_permissions, ['https://www.tiktok.com/*']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
    const serialized = JSON.stringify(manifest);
    ['cookies', 'history', 'webRequest', '<all_urls>', 'storage.sync'].forEach((forbidden) => {
        assert.equal(serialized.includes(forbidden), false);
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

test('dynamic collector is document_start and JavaScript avoids unsafe rendering', () => {
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(background, /optional_host_permissions|registerContentScripts/);
    assert.match(background, /runAt:\s*'document_start'/);
    assert.match(background, /world:\s*'ISOLATED'/);
    assert.match(background, /setAccessLevel/);

    const javascript = allFiles(root)
        .filter((file) => file.endsWith('.js'))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
    assert.doesNotMatch(javascript, /\.innerHTML\s*=/);
    assert.doesNotMatch(javascript, /\beval\s*\(/);
    assert.doesNotMatch(javascript, /parseInt\s*\(/);
});

test('viewer targets TikTok exactly and never uses wildcard postMessage', () => {
    const viewer = fs.readFileSync(path.join(root, 'viewer/viewer.js'), 'utf8');
    assert.match(viewer, /Core\.TIKTOK_ORIGIN/);
    assert.doesNotMatch(viewer, /postMessage\([\s\S]{0,180},\s*['"]\*['"]\s*\)/);
    assert.match(viewer, /autoplay:\s*'0'/);
    assert.match(viewer, /referrerPolicy\s*=\s*'no-referrer'/);
});

test('collector and service worker retain fail-closed runtime guards', () => {
    const collector = fs.readFileSync(path.join(root, 'content/collector.js'), 'utf8');
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(collector, /event\.isTrusted/);
    assert.match(collector, /Core\.isFypPath\(location\.pathname\)/);
    assert.match(collector, /IntersectionObserver/);
    assert.match(collector, /MARK_EXPOSED/);
    assert.match(collector, /EXCLUDE_VIDEO/);
    assert.match(collector, /failClosedAfterSafetyWrite/);
    assert.match(collector, /excludeAmbiguousRecords/);
    assert.match(collector, /ttfp-reserved-card/);
    assert.doesNotMatch(collector, /record\.element\.remove\(\)/);
    assert.doesNotMatch(collector, /const batchId = `\$\{sourceId\}/);
    assert.match(background, /registrationQueue/);
    assert.match(background, /isViewerForSession/);
    assert.match(background, /wrong_viewer_tab/);
    assert.match(background, /activateTombstoneGuards/);
    assert.match(background, /STATE_UPDATED/);
    assert.doesNotMatch(background, /tabs\.query\(\{\s*url:\s*chrome\.runtime\.getURL\('viewer/);
});
