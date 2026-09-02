(function (root, factory) {
    const core = root.TikTokPilotCore || (
        typeof require === 'function' ? require('../lib/core.js') : null
    );
    const api = factory(core);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.TikTokPilotDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
    'use strict';

    const CARD_SELECTORS = [
        '[data-e2e="recommend-list-item-container"]',
        '[data-e2e="feed-item"]',
        '[data-e2e="recommend-list-item"]',
    ];
    const PLAYER_WRAPPER_SELECTOR = '[id^="xgwrapper-"]';
    const PLAYER_WRAPPER_ID_PATTERN = /^xgwrapper-[0-9]+-([1-9][0-9]{14,24})$/;

    function anchorsWithin(element) {
        if (!element || typeof element.querySelectorAll !== 'function') {
            return [];
        }
        const anchors = Array.from(element.querySelectorAll('a[href*="/video/"]'));
        if (
            element.matches &&
            element.matches('a[href*="/video/"]') &&
            !anchors.includes(element)
        ) {
            anchors.unshift(element);
        }
        return anchors;
    }

    function playerWrappersWithin(element) {
        if (!element || typeof element.querySelectorAll !== 'function') {
            return [];
        }
        const wrappers = Array.from(element.querySelectorAll(PLAYER_WRAPPER_SELECTOR));
        if (
            element.matches &&
            element.matches(PLAYER_WRAPPER_SELECTOR) &&
            !wrappers.includes(element)
        ) {
            wrappers.unshift(element);
        }
        return wrappers;
    }

    function playerWrapperVideoIdsWithin(element) {
        const ids = new Set();
        playerWrappersWithin(element).forEach((wrapper) => {
            // Current TikTok FYP cards omit their old /video/{id} anchors and
            // identify the post on the xgplayer wrapper instead. Require an
            // exact wrapper shape and an associated <video> so unrelated page
            // IDs can never become collection candidates.
            if (videosWithin(wrapper).length === 0) {
                return;
            }
            const match = PLAYER_WRAPPER_ID_PATTERN.exec(
                wrapper.getAttribute('id') || ''
            );
            if (match && Core.isVideoId(match[1])) {
                ids.add(match[1]);
            }
        });
        return Array.from(ids);
    }

    function videoIdsWithin(element, baseUrl) {
        const ids = new Set();
        anchorsWithin(element).forEach((anchor) => {
            const id = Core.parseTikTokVideoId(anchor.getAttribute('href'), baseUrl);
            if (id) {
                ids.add(id);
            }
        });
        playerWrapperVideoIdsWithin(element).forEach((id) => ids.add(id));
        return Array.from(ids);
    }

    function videosWithin(element) {
        if (!element || typeof element.querySelectorAll !== 'function') {
            return [];
        }
        const videos = Array.from(element.querySelectorAll('video'));
        if (element.matches && element.matches('video') && !videos.includes(element)) {
            videos.unshift(element);
        }
        return videos;
    }

    function preferredCardRoot(anchor, baseUrl) {
        if (!anchor || typeof anchor.closest !== 'function') {
            return null;
        }
        for (const selector of CARD_SELECTORS) {
            const match = anchor.closest(selector);
            if (match && videosWithin(match).length > 0) {
                return match;
            }
        }
        return null;
    }

    function fallbackCardRoot(anchor, baseUrl) {
        let node = anchor;
        let levels = 0;
        while (node && node.parentElement && levels < 6) {
            node = node.parentElement;
            levels += 1;
            if (node.tagName === 'MAIN' || node.tagName === 'BODY') {
                break;
            }
            const ids = videoIdsWithin(node, baseUrl);
            if (ids.length > 1) {
                // Surface the nearest bounded ambiguity for durable exclusion,
                // but snapshotFeed marks heuristic multi-ID roots non-removable.
                if (videosWithin(node).length > 0) {
                    return node;
                }
                break;
            }
            if (ids.length === 1 && videosWithin(node).length > 0) {
                return node;
            }
        }
        return null;
    }

    function findCardRoot(anchor, baseUrl) {
        const preferred = preferredCardRoot(anchor, baseUrl);
        if (preferred) {
            return preferred;
        }
        return fallbackCardRoot(anchor, baseUrl);
    }

    function snapshotFeed(documentObject, baseUrl) {
        if (!documentObject || typeof documentObject.querySelectorAll !== 'function') {
            return [];
        }
        const roots = [];
        const seenRoots = new Set();

        // Prefer TikTok's bounded feed-card containers. This also discovers
        // current FYP cards whose post ID exists only on an xgplayer wrapper.
        Array.from(documentObject.querySelectorAll(CARD_SELECTORS.join(','))).forEach(
            (element) => {
                const trustedBoundary = Boolean(
                    element.matches &&
                    CARD_SELECTORS.some((selector) => element.matches(selector))
                );
                if (
                    !trustedBoundary ||
                    seenRoots.has(element) ||
                    videosWithin(element).length === 0 ||
                    videoIdsWithin(element, baseUrl).length === 0
                ) {
                    return;
                }
                seenRoots.add(element);
                roots.push(element);
            }
        );

        Array.from(documentObject.querySelectorAll('a[href*="/video/"]')).forEach((anchor) => {
            const parsed = Core.parseTikTokVideoId(anchor.getAttribute('href'), baseUrl);
            if (!parsed) {
                return;
            }
            const root = findCardRoot(anchor, baseUrl);
            if (!root || seenRoots.has(root)) {
                return;
            }
            seenRoots.add(root);
            roots.push(root);
        });

        Array.from(documentObject.querySelectorAll(PLAYER_WRAPPER_SELECTOR)).forEach(
            (wrapper) => {
                const ids = playerWrapperVideoIdsWithin(wrapper);
                if (ids.length !== 1) {
                    return;
                }
                const root = findCardRoot(wrapper, baseUrl);
                if (!root || seenRoots.has(root)) {
                    return;
                }
                seenRoots.add(root);
                roots.push(root);
            }
        );

        const records = roots.map((element, index) => {
            const ids = videoIdsWithin(element, baseUrl);
            const ambiguous = ids.length !== 1;
            const trustedBoundary = Boolean(
                element.matches &&
                CARD_SELECTORS.some((selector) => element.matches(selector))
            );
            return {
                element,
                ids,
                videoId: ids.length === 1 ? ids[0] : null,
                ambiguous,
                removable: !ambiguous || trustedBoundary,
                videos: videosWithin(element),
                liveIndex: index,
                occurrenceCount: 1,
            };
        });

        const occurrences = new Map();
        records.forEach((record) => {
            if (record.videoId) {
                occurrences.set(
                    record.videoId,
                    (occurrences.get(record.videoId) || 0) + 1
                );
            }
        });
        records.forEach((record) => {
            if (record.videoId) {
                record.occurrenceCount = occurrences.get(record.videoId);
            }
        });
        return records;
    }

    function rectOverlapsViewport(rect, viewportWidth, viewportHeight) {
        if (!rect) {
            return false;
        }
        return (
            rect.bottom > 0 &&
            rect.top < viewportHeight &&
            rect.right > 0 &&
            rect.left < viewportWidth
        );
    }

    function isBelowViewport(rect, viewportHeight) {
        return Boolean(rect && rect.top >= viewportHeight);
    }

    function bestVideoForRecord(record, viewportWidth, viewportHeight) {
        let best = null;
        (record && Array.isArray(record.videos) ? record.videos : []).forEach((video) => {
            const rect = video.getBoundingClientRect();
            const ratio = Core.visibleRatio(rect, viewportWidth, viewportHeight);
            if (!best || ratio > best.ratio) {
                best = { video, ratio, rect };
            }
        });
        return best;
    }

    function videoIsPlaying(video) {
        if (!video) {
            return false;
        }
        if (video.dataset && video.dataset.syntheticPlaying === 'true') {
            return true;
        }
        return video.paused === false && video.ended === false && video.readyState >= 2;
    }

    function addedVideoIds(mutationRecords, baseUrl) {
        const ids = new Set();
        (Array.isArray(mutationRecords) ? mutationRecords : []).forEach((record) => {
            Array.from(record.addedNodes || []).forEach((node) => {
                if (!node || node.nodeType !== 1) {
                    return;
                }
                videoIdsWithin(node, baseUrl).forEach((id) => ids.add(id));
            });
        });
        return ids;
    }

    function connected(record) {
        return Boolean(record && record.element && record.element.isConnected);
    }

    function recordsWithAnyId(records, ids) {
        const targetIds = ids instanceof Set ? ids : new Set(ids || []);
        return (Array.isArray(records) ? records : []).filter(
            (record) => Array.isArray(record.ids) && record.ids.some((id) => targetIds.has(id))
        );
    }

    return Object.freeze({
        CARD_SELECTORS,
        PLAYER_WRAPPER_SELECTOR,
        PLAYER_WRAPPER_ID_PATTERN,
        anchorsWithin,
        playerWrappersWithin,
        playerWrapperVideoIdsWithin,
        videoIdsWithin,
        videosWithin,
        findCardRoot,
        snapshotFeed,
        rectOverlapsViewport,
        isBelowViewport,
        bestVideoForRecord,
        videoIsPlaying,
        addedVideoIds,
        connected,
        recordsWithAnyId,
    });
});
