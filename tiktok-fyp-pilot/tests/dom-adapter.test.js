'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Dom = require('../content/dom-adapter.js');

const A = '7311111111111111111';
const B = '7311111111111111112';

test('covered navigation includes an empty next slot and preserves a captured current slot', () => {
    const slot = (top) => ({
        isConnected: true,
        contains: () => false,
        getBoundingClientRect: () => ({ top, bottom: top + 800, left: 0, right: 400, width: 400, height: 800 }),
    });
    const previous = slot(-800);
    const captured = slot(0);
    const emptyNext = slot(800);
    const documentObject = { querySelectorAll: () => [previous, captured, emptyNext] };
    const position = Dom.coveredFeedPosition(documentObject, [{ element: captured, videoId: A }], 1000, 800);
    assert.equal(position.current, captured);
    assert.equal(position.next, emptyNext);
});

test('covered navigation ignores collapsed cards and handles a recycled next position', () => {
    const collapsed = { isConnected: true, contains: () => false,
        getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) };
    const recycled = { isConnected: true, contains: () => false,
        getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800 }) };
    const position = Dom.coveredFeedPosition({ querySelectorAll: () => [collapsed, recycled] }, [], 1000, 800);
    assert.equal(position.current, recycled);
    assert.equal(position.next, null);
});

function anchor(href) {
    return {
        getAttribute(name) {
            return name === 'href' ? href : null;
        },
    };
}

function fakeElement(hrefs) {
    return {
        nodeType: 1,
        matches() {
            return false;
        },
        querySelectorAll(selector) {
            if (selector.includes('/video/')) {
                return hrefs.map(anchor);
            }
            return [];
        },
    };
}

function playerWrapper(id, videos = [{}]) {
    return {
        nodeType: 1,
        getAttribute(name) {
            return name === 'id' ? id : null;
        },
        matches(selector) {
            return selector === Dom.PLAYER_WRAPPER_SELECTOR;
        },
        querySelectorAll(selector) {
            if (selector === Dom.PLAYER_WRAPPER_SELECTOR) {
                return [];
            }
            if (selector === 'video') {
                return videos;
            }
            return [];
        },
    };
}

test('multiple links to the same post resolve to one ID', () => {
    const element = fakeElement([
        `https://www.tiktok.com/@one/video/${A}`,
        `https://www.tiktok.com/@one/video/${A}?refer=feed`,
    ]);
    assert.deepEqual(Dom.videoIdsWithin(element, 'https://www.tiktok.com/foryou'), [A]);
});

test('conflicting post links remain ambiguous', () => {
    const element = fakeElement([
        `https://www.tiktok.com/@one/video/${A}`,
        `https://www.tiktok.com/@two/video/${B}`,
    ]);
    assert.deepEqual(Dom.videoIdsWithin(element, 'https://www.tiktok.com/foryou'), [A, B]);
});

test('wrong-host and malformed links are ignored', () => {
    const element = fakeElement([
        `https://evil.test/@one/video/${A}`,
        'https://www.tiktok.com/@one/video/not-digits',
    ]);
    assert.deepEqual(Dom.videoIdsWithin(element, 'https://www.tiktok.com/foryou'), []);
});

test('current TikTok xgplayer wrappers resolve exact post IDs', () => {
    const wrapper = playerWrapper(`xgwrapper-0-${A}`);
    assert.deepEqual(Dom.playerWrapperVideoIdsWithin(wrapper), [A]);
    assert.deepEqual(
        Dom.videoIdsWithin(wrapper, 'https://www.tiktok.com/foryou'),
        [A]
    );
});

test('xgplayer IDs fail closed without an exact shape and associated video', () => {
    const malformed = playerWrapper(`prefix-xgwrapper-0-${A}`);
    const missingVideo = playerWrapper(`xgwrapper-0-${A}`, []);
    const tooShort = playerWrapper('xgwrapper-0-1234');
    assert.deepEqual(Dom.playerWrapperVideoIdsWithin(malformed), []);
    assert.deepEqual(Dom.playerWrapperVideoIdsWithin(missingVideo), []);
    assert.deepEqual(Dom.playerWrapperVideoIdsWithin(tooShort), []);
});

test('a conflicting post link and player wrapper remain ambiguous', () => {
    const link = anchor(`https://www.tiktok.com/@one/video/${A}`);
    const wrapper = playerWrapper(`xgwrapper-0-${B}`);
    const card = {
        matches() {
            return false;
        },
        querySelectorAll(selector) {
            if (selector.includes('/video/')) {
                return [link];
            }
            if (selector === Dom.PLAYER_WRAPPER_SELECTOR) {
                return [wrapper];
            }
            return [];
        },
    };
    assert.deepEqual(
        Dom.videoIdsWithin(card, 'https://www.tiktok.com/foryou'),
        [A, B]
    );
});

test('snapshot discovers current TikTok cards without post anchors', () => {
    const video = {};
    const wrapper = playerWrapper(`xgwrapper-0-${A}`, [video]);
    const card = {
        isConnected: true,
        matches(selector) {
            return selector === '[data-e2e="recommend-list-item-container"]';
        },
        querySelectorAll(selector) {
            if (selector === Dom.PLAYER_WRAPPER_SELECTOR) {
                return [wrapper];
            }
            if (selector === 'video') {
                return [video];
            }
            if (selector.includes('/video/')) {
                return [];
            }
            return [];
        },
    };
    wrapper.closest = () => card;
    const documentObject = {
        querySelectorAll(selector) {
            if (selector === Dom.CARD_SELECTORS.join(',')) {
                return [card];
            }
            if (selector === Dom.PLAYER_WRAPPER_SELECTOR) {
                return [wrapper];
            }
            return [];
        },
    };

    const records = Dom.snapshotFeed(documentObject, 'https://www.tiktok.com/foryou');
    assert.equal(records.length, 1);
    assert.equal(records[0].videoId, A);
    assert.equal(records[0].ambiguous, false);
    assert.deepEqual(records[0].videos, [video]);
});

test('viewport overlap and below-viewport checks are conservative', () => {
    assert.equal(Dom.rectOverlapsViewport({
        top: 799,
        bottom: 900,
        left: 0,
        right: 100,
    }, 1000, 800), true);
    assert.equal(Dom.rectOverlapsViewport({
        top: 800,
        bottom: 900,
        left: 0,
        right: 100,
    }, 1000, 800), false);
    assert.equal(Dom.isBelowViewport({ top: 800 }, 800), true);
    assert.equal(Dom.isBelowViewport({ top: -100 }, 800), false);
});

test('added-node extraction returns IDs only', () => {
    const first = fakeElement([`https://www.tiktok.com/@one/video/${A}`]);
    const second = fakeElement([`https://www.tiktok.com/@two/video/${B}`]);
    const ids = Dom.addedVideoIds([
        { addedNodes: [first, second] },
    ], 'https://www.tiktok.com/foryou');
    assert.deepEqual(Array.from(ids).sort(), [A, B]);
});

test('fallback card selection returns the nearest safe one-ID ancestor', () => {
    const video = {};
    const link = anchor(`https://www.tiktok.com/@one/video/${A}`);
    link.closest = () => null;
    const makeAncestor = (tagName) => ({
        tagName,
        parentElement: null,
        matches() {
            return false;
        },
        querySelectorAll(selector) {
            if (selector.includes('/video/')) {
                return [link];
            }
            if (selector === 'video') {
                return [video];
            }
            return [];
        },
    });
    const nearest = makeAncestor('DIV');
    const outer = makeAncestor('SECTION');
    const body = makeAncestor('BODY');
    link.parentElement = nearest;
    nearest.parentElement = outer;
    outer.parentElement = body;

    assert.equal(
        Dom.findCardRoot(link, 'https://www.tiktok.com/foryou'),
        nearest
    );
});

test('a trusted preferred card remains visible to ambiguity and tombstone guards', () => {
    const first = anchor(`https://www.tiktok.com/@one/video/${A}`);
    const second = anchor(`https://www.tiktok.com/@two/video/${B}`);
    const card = {
        matches(selector) {
            return selector === '[data-e2e="recommend-list-item-container"]';
        },
        querySelectorAll(selector) {
            if (selector.includes('/video/')) {
                return [first, second];
            }
            if (selector === 'video') {
                return [{}];
            }
            return [];
        },
    };
    first.closest = () => card;
    second.closest = () => card;
    const documentObject = {
        querySelectorAll() {
            return [first, second];
        },
    };

    const records = Dom.snapshotFeed(documentObject, 'https://www.tiktok.com/foryou');
    assert.equal(records.length, 1);
    assert.equal(records[0].ambiguous, true);
    assert.equal(records[0].removable, true);
    assert.deepEqual(records[0].ids, [A, B]);
    assert.deepEqual(Dom.recordsWithAnyId(records, new Set([B])), records);
});

test('a heuristic multi-ID ancestor is surfaced but never broadly removed', () => {
    const first = anchor(`https://www.tiktok.com/@one/video/${A}`);
    const second = anchor(`https://www.tiktok.com/@two/video/${B}`);
    const shared = {
        tagName: 'DIV',
        parentElement: { tagName: 'BODY' },
        matches() {
            return false;
        },
        querySelectorAll(selector) {
            if (selector.includes('/video/')) {
                return [first, second];
            }
            if (selector === 'video') {
                return [{}];
            }
            return [];
        },
    };
    first.closest = () => null;
    second.closest = () => null;
    first.parentElement = shared;
    second.parentElement = shared;
    const documentObject = {
        querySelectorAll() {
            return [first, second];
        },
    };

    const records = Dom.snapshotFeed(documentObject, 'https://www.tiktok.com/foryou');
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].ids, [A, B]);
    assert.equal(records[0].ambiguous, true);
    assert.equal(records[0].removable, false);
});
