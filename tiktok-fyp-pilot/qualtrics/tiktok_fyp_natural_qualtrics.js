/* global Qualtrics */
'use strict';

(function () {
    const EXTENSION_ID = 'pjcgejllbdjbhegipdkagnafileoecpo';
    const BRIDGE_NAME = 'tiktok-fyp-qualtrics-v1';
    const MIN_BRIDGE_VERSION = 5;
    const POLL_MS = 500;
    const CHUNK_SIZE = 12000;
    const MAX_CHUNKS = 6;
    const SUMMARY_MAX_CHARS = 12000;
    let teardown = function () {};

    Qualtrics.SurveyEngine.addOnReady(function () {
        const question = this;
        const root = document.getElementById('ttfp-natural-root');
        if (!root) {
            return;
        }
        question.hideNextButton();
        root.replaceChildren();

        let port = null;
        let requestSequence = 0;
        let sessionId = cleanSessionId('${e://Field/ttfp_natural_session_id}');
        let pollTimer = null;
        let destroyed = false;
        let finishing = false;
        let completedSession = null;
        const pending = new Map();

        function cleanSessionId(value) {
            return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(value)
                ? value
                : null;
        }

        function element(tag, className, text) {
            const node = document.createElement(tag);
            if (className) {
                node.className = className;
            }
            if (text !== undefined) {
                node.textContent = text;
            }
            return node;
        }

        function button(text, className) {
            const node = element('button', className, text);
            node.type = 'button';
            return node;
        }

        const style = element('style');
        style.textContent = `
            #ttfp-natural-root, #ttfp-natural-root * { box-sizing: border-box; }
            #ttfp-natural-root { color: #172033; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .ttfpn-shell { margin: 0 auto; width: min(700px, 100%); }
            .ttfpn-eyebrow { color: #595ee8; font-size: 11px; font-weight: 800; letter-spacing: .1em; margin: 0 0 7px; text-transform: uppercase; }
            .ttfpn-title { font-size: clamp(25px, 4vw, 34px); line-height: 1.12; margin: 0 0 8px; }
            .ttfpn-copy { color: #56627a; margin: 0 0 16px; }
            .ttfpn-card { background: #fff; border: 1px solid #d7deeb; border-radius: 16px; box-shadow: 0 10px 30px rgba(23,32,51,.07); padding: 18px; }
            .ttfpn-guide { background: #f7f8fc; border: 1px solid #e0e4f2; border-radius: 12px; margin-bottom: 18px; padding: 15px 16px; }
            .ttfpn-guide h3 { font-size: 15px; margin: 0 0 10px; }
            .ttfpn-steps { color: #344054; margin: 0; padding-left: 22px; }
            .ttfpn-steps li + li { margin-top: 8px; }
            .ttfpn-steps strong { color: #172033; }
            .ttfpn-connect { border-top: 1px solid #e2e6ee; padding-top: 16px; }
            .ttfpn-button { background: #fff; border: 1px solid #c6cede; border-radius: 9px; color: #172033; cursor: pointer; font: inherit; font-weight: 750; min-height: 42px; padding: 9px 15px; }
            .ttfpn-button.primary { background: #595ee8; border-color: #595ee8; color: #fff; }
            .ttfpn-button:disabled { cursor: not-allowed; opacity: .48; }
            .ttfpn-status { color: #56627a; margin: 14px 0 0; min-height: 23px; }
            .ttfpn-status.error { color: #b42318; }
            .ttfpn-status.success { color: #067647; }
            .ttfpn-progress { background: #e8ebf4; border-radius: 999px; height: 8px; margin-top: 12px; overflow: hidden; }
            .ttfpn-progress-fill { background: #595ee8; height: 100%; transition: width .2s ease; width: 0; }
            .ttfpn-actions { display: flex; gap: 9px; justify-content: center; margin-top: 15px; }
            .ttfpn-note { border-top: 1px solid #e2e6ee; color: #667085; font-size: 12px; margin: 14px 0 0; padding-top: 13px; }
            .ttfpn-result { background: #ecfdf3; border: 1px solid #abefc6; border-radius: 12px; color: #05603a; margin-top: 15px; padding: 14px; }
            .ttfpn-result[hidden] { display: none; }
        `;
        document.head.appendChild(style);

        const shell = element('section', 'ttfpn-shell');
        const eyebrow = element('p', 'ttfpn-eyebrow', 'Research pilot');
        const title = element('h2', 'ttfpn-title', 'Natural TikTok browsing session');
        const copy = element(
            'p',
            'ttfpn-copy',
            'You will browse your normal For You feed in TikTok. This survey resumes automatically when the timed session is complete.'
        );
        const card = element('div', 'ttfpn-card');
        const guide = element('section', 'ttfpn-guide');
        const guideTitle = element('h3', null, 'Before you begin');
        const steps = element('ol', 'ttfpn-steps');
        [
            [
                'Install the extension. ',
                'For this pilot, open chrome://extensions, turn on Developer mode, select Load unpacked, and choose the supplied tiktok-fyp-pilot folder containing manifest.json.'
            ],
            [
                'Grant TikTok access. ',
                'Open TikTok FYP Research Pilot, accept the disclosure, and select Grant TikTok access. Then return here.'
            ],
            [
                'Check the extension. ',
                'This survey connects automatically. Wait for the confirmation below before starting.'
            ],
            [
                'Start the natural session. ',
                'Select Start natural session. TikTok opens in a dedicated foreground tab with a small timer. Browse the For You feed normally and keep that tab focused.'
            ],
            [
                'Return automatically. ',
                'When the required qualified time is reached, the dedicated TikTok tab closes and this exact survey tab returns to the front. Continue only after the completion message appears.'
            ],
        ].forEach(([heading, detail]) => {
            const item = element('li');
            item.append(element('strong', null, heading), document.createTextNode(detail));
            steps.appendChild(item);
        });
        guide.append(guideTitle, steps);

        const connectArea = element('div', 'ttfpn-connect');
        const status = element(
            'p',
            'ttfpn-status',
            'Checking the research extension automatically…'
        );
        const progressTrack = element('div', 'ttfpn-progress');
        const progressFill = element('div', 'ttfpn-progress-fill');
        progressTrack.appendChild(progressFill);
        const actions = element('div', 'ttfpn-actions');
        const retryButton = button('Check extension again', 'ttfpn-button');
        retryButton.hidden = true;
        const startButton = button('Start natural session', 'ttfpn-button primary');
        startButton.disabled = true;
        actions.append(retryButton, startButton);
        const note = element(
            'p',
            'ttfpn-note',
            'The response receives numeric post IDs, qualified exposure durations, aggregate pointer/click/wheel/key-event counts, and tab/window/video state markers. It never receives usernames, captions, creator information, cursor coordinates, or key values.'
        );
        const result = element('div', 'ttfpn-result');
        result.hidden = true;
        connectArea.append(status, progressTrack, actions, note, result);
        card.append(guide, connectArea);
        shell.append(eyebrow, title, copy, card);
        root.appendChild(shell);

        function setStatus(message, kind) {
            status.textContent = message;
            status.className = 'ttfpn-status' + (kind ? ' ' + kind : '');
        }

        function setEmbeddedData(name, value) {
            Qualtrics.SurveyEngine.setEmbeddedData(
                name,
                value === null || value === undefined ? '' : String(value)
            );
        }

        function storeChunkedPayload(payload) {
            const serialized = JSON.stringify(payload);
            const chunks = [];
            for (let offset = 0; offset < serialized.length; offset += CHUNK_SIZE) {
                chunks.push(serialized.slice(offset, offset + CHUNK_SIZE));
            }
            const truncated = chunks.length > MAX_CHUNKS;
            const kept = chunks.slice(0, MAX_CHUNKS);
            for (let index = 0; index < MAX_CHUNKS; index += 1) {
                setEmbeddedData(
                    'ttfp_natural_payload_' + (index + 1),
                    kept[index] || ''
                );
            }
            setEmbeddedData('ttfp_natural_payload_chunks', kept.length);
            setEmbeddedData('ttfp_natural_payload_truncated', truncated ? '1' : '0');
            return { serialized, truncated };
        }

        function storeSummaryPayload(payload) {
            const source = payload && typeof payload === 'object' ? payload : {};
            const sourceActivity = source.activity && typeof source.activity === 'object'
                ? source.activity
                : {};
            const activity = {};
            [
                'pointerMoveBursts',
                'clicks',
                'wheelEvents',
                'keyEvents',
                'tabAwayCount',
                'tabAwayMs',
                'windowBlurCount',
                'windowBlurMs',
                'videoTransitions',
                'pauseCount',
                'resumeCount',
            ].forEach((name) => {
                activity[name] = Math.max(0, Number(sourceActivity[name]) || 0);
            });
            activity.qualificationReasonCounts = sourceActivity.qualificationReasonCounts &&
                typeof sourceActivity.qualificationReasonCounts === 'object'
                ? sourceActivity.qualificationReasonCounts
                : {};
            const sourceVideos = Array.isArray(source.videos) ? source.videos : [];
            const summary = {
                schemaVersion: 1,
                sessionId: cleanSessionId(source.sessionId) || sessionId || '',
                status: typeof source.status === 'string' ? source.status : 'complete',
                startedAt: Number(source.startedAt) || null,
                completedAt: Number(source.completedAt) || null,
                stopReason: typeof source.stopReason === 'string' ? source.stopReason : '',
                requiredQualifiedMs: Math.max(0, Number(source.requiredQualifiedMs) || 0),
                qualifiedMs: Math.max(0, Number(source.qualifiedMs) || 0),
                videoCount: sourceVideos.length,
                videoRecordsStored: sourceVideos.length,
                videoRecordsTruncated: false,
                videos: sourceVideos.map((video) => ({
                    videoId: String(video.videoId || ''),
                    firstSeenAt: Number(video.firstSeenAt) || null,
                    lastSeenAt: Number(video.lastSeenAt) || null,
                    activeWatchMs: Math.max(0, Number(video.activeWatchMs) || 0),
                    order: Math.max(0, Number(video.order) || 0),
                    feedOrder: Number.isFinite(Number(video.feedOrder))
                        ? Number(video.feedOrder)
                        : null,
                })),
                activity,
            };
            let serialized = JSON.stringify(summary);
            while (serialized.length > SUMMARY_MAX_CHARS && summary.videos.length > 0) {
                summary.videos.pop();
                summary.videoRecordsStored = summary.videos.length;
                summary.videoRecordsTruncated = true;
                serialized = JSON.stringify(summary);
            }
            const truncated = summary.videoRecordsTruncated || serialized.length > SUMMARY_MAX_CHARS;
            setEmbeddedData('ttfp_natural_summary_json', serialized.slice(0, SUMMARY_MAX_CHARS));
            setEmbeddedData('ttfp_natural_summary_truncated', truncated ? '1' : '0');
            return { serialized, truncated };
        }

        function rejectPending(reason) {
            pending.forEach((entry) => {
                clearTimeout(entry.timer);
                entry.reject(new Error(reason));
            });
            pending.clear();
        }

        function request(type, payload) {
            return new Promise((resolve, reject) => {
                if (!port) {
                    reject(new Error('bridge_disconnected'));
                    return;
                }
                requestSequence += 1;
                const requestId = 'natural-' + Date.now() + '-' + requestSequence;
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    reject(new Error('bridge_timeout'));
                }, 8000);
                pending.set(requestId, { resolve, reject, timer });
                port.postMessage({ ...payload, type, requestId });
            });
        }

        function connect() {
            retryButton.hidden = true;
            startButton.disabled = true;
            if (!window.chrome || !chrome.runtime || typeof chrome.runtime.connect !== 'function') {
                setStatus('Chrome did not expose the extension bridge on this survey domain.', 'error');
                retryButton.hidden = false;
                return;
            }
            if (port) {
                port.disconnect();
            }
            setStatus('Connecting to the research extension…');
            try {
                port = chrome.runtime.connect(EXTENSION_ID, { name: BRIDGE_NAME });
            } catch (_error) {
                port = null;
                retryButton.hidden = false;
                setStatus('The research extension was not found. Install or reload version 0.5.2, then check again.', 'error');
                return;
            }
            port.onMessage.addListener((message) => {
                const entry = message && pending.get(message.requestId);
                if (!entry) {
                    return;
                }
                pending.delete(message.requestId);
                clearTimeout(entry.timer);
                entry.resolve(message);
            });
            port.onDisconnect.addListener(() => {
                port = null;
                rejectPending('bridge_disconnected');
                if (!destroyed && !finishing) {
                    startButton.disabled = true;
                    retryButton.hidden = false;
                    setStatus('Extension connection closed. Check the extension again.', 'error');
                }
            });
            request('hello', { sessionId }).then(handleStatus).catch(() => {
                retryButton.hidden = false;
                setStatus('The research extension did not answer. Install or reload version 0.5.2, then check again.', 'error');
            });
        }

        function schedulePoll() {
            clearTimeout(pollTimer);
            if (!destroyed && port && sessionId && !finishing) {
                pollTimer = setTimeout(pollStatus, POLL_MS);
            }
        }

        function pollStatus() {
            request('status', { sessionId }).then(handleStatus).catch(() => {
                if (!destroyed) {
                    setStatus('Waiting to reconnect to the extension…', 'error');
                }
            });
        }

        function finishCompletedSession(session) {
            if (finishing) {
                return;
            }
            completedSession = session;
            finishing = true;
            clearTimeout(pollTimer);
            const payload = session.naturalResult || {};
            const stored = storeChunkedPayload(payload);
            const summaryStored = storeSummaryPayload(payload);
            const progress = session.progress || {};
            setEmbeddedData('ttfp_natural_status', 'complete');
            setEmbeddedData('ttfp_natural_required_ms',
                Number(progress.naturalSessionSeconds || 0) * 1000);
            setEmbeddedData('ttfp_natural_qualified_ms', Number(progress.qualifiedMs || 0));
            setEmbeddedData('ttfp_natural_video_count', Array.isArray(payload.videos) ? payload.videos.length : 0);
            setEmbeddedData(
                'ttfp_natural_video_ids_json',
                JSON.stringify((payload.videos || []).map((video) => video.videoId)).slice(0, CHUNK_SIZE)
            );
            setEmbeddedData('ttfp_natural_stop_reason', payload.stopReason || '');
            request('finish', { sessionId }).then((response) => {
                if (!response || !response.ok) {
                    throw new Error((response && response.error) || 'finish_failed');
                }
                setEmbeddedData('ttfp_natural_status', 'viewed');
                setEmbeddedData('ttfp_natural_completed', '1');
                progressFill.style.width = '100%';
                startButton.hidden = true;
                result.hidden = false;
                result.textContent = stored.truncated || summaryStored.truncated
                    ? 'Session complete. The saved record reached a pilot size cap and was flagged. Opening your activity record…'
                    : 'Session complete and saved. Opening your activity record…';
                setStatus('Natural TikTok session complete and registered.', 'success');
                question.showNextButton();
                setTimeout(() => {
                    if (!destroyed && typeof question.clickNextButton === 'function') {
                        question.clickNextButton();
                    }
                }, 500);
            }).catch(() => {
                finishing = false;
                startButton.hidden = false;
                startButton.disabled = false;
                startButton.textContent = 'Save completion again';
                setStatus('The completed record could not be finalized. Select Save completion again.', 'error');
            });
        }

        function handleStatus(response) {
            if (!response || !response.ok) {
                startButton.disabled = true;
                retryButton.hidden = false;
                setStatus('Extension error: ' + ((response && response.error) || 'unknown_error') + '.', 'error');
                return;
            }
            const bridgeVersion = Number(response.bridgeVersion || 0);
            const extensionVersion = response.extensionVersion || 'unknown';
            setEmbeddedData('ttfp_natural_bridge_version', bridgeVersion);
            if (bridgeVersion < MIN_BRIDGE_VERSION) {
                startButton.disabled = true;
                retryButton.hidden = false;
                setStatus('Extension v' + extensionVersion + ' is outdated. Reload version 0.5.2 or later on chrome://extensions, then check again.', 'error');
                return;
            }
            if (!response.permissionGranted) {
                startButton.disabled = true;
                retryButton.hidden = false;
                setStatus('Open the extension, accept the disclosure, and grant TikTok access. Then check again.', 'error');
                return;
            }
            if (response.conflict) {
                startButton.disabled = true;
                retryButton.hidden = false;
                setStatus('Another extension session is active. Stop or finish it, then check again.', 'error');
                return;
            }
            if (!response.session) {
                retryButton.hidden = true;
                sessionId = null;
                startButton.hidden = false;
                startButton.textContent = 'Start natural session';
                startButton.disabled = false;
                setStatus('Extension v' + extensionVersion + ' connected. TikTok access is ready.', 'success');
                return;
            }
            if (response.session.collectionMode !== 'natural_fyp_session') {
                startButton.disabled = true;
                setStatus('The active session belongs to the covered-harvest survey, not this natural-session survey.', 'error');
                return;
            }
            sessionId = response.session.id;
            setEmbeddedData('ttfp_natural_session_id', sessionId);
            setEmbeddedData('ttfp_natural_status', response.session.status);
            const progress = response.session.progress || {};
            const requiredMs = Math.max(1, Number(progress.naturalSessionSeconds || 60) * 1000);
            const qualifiedMs = Math.max(0, Number(progress.qualifiedMs || 0));
            progressFill.style.width = Math.min(100, qualifiedMs / requiredMs * 100) + '%';
            if (response.session.status === 'complete' || response.session.status === 'viewed') {
                finishCompletedSession(response.session);
                return;
            }
            if (response.session.status === 'stopped' || response.session.status === 'failed') {
                sessionId = null;
                startButton.hidden = false;
                startButton.disabled = false;
                startButton.textContent = 'Start a fresh natural session';
                setEmbeddedData('ttfp_natural_stop_reason', response.session.stopReason || 'stopped');
                setStatus('The TikTok session stopped before completion. Start a fresh session to continue.', 'error');
                return;
            }
            startButton.disabled = true;
            setStatus(
                Math.floor(qualifiedMs / 1000) + ' / ' + Math.round(requiredMs / 1000) +
                ' qualified seconds. Continue browsing in the dedicated TikTok tab.'
            );
            schedulePoll();
        }

        retryButton.addEventListener('click', connect);
        startButton.addEventListener('click', () => {
            if (completedSession && sessionId) {
                finishCompletedSession(completedSession);
                return;
            }
            completedSession = null;
            startButton.disabled = true;
            setStatus('Opening the dedicated TikTok tab…');
            request('start_natural', {}).then((response) => {
                if (!response || !response.ok) {
                    throw new Error((response && response.error) || 'start_failed');
                }
                sessionId = response.sessionId;
                setEmbeddedData('ttfp_natural_session_id', sessionId);
                setEmbeddedData('ttfp_natural_status', 'collecting');
                schedulePoll();
            }).catch((error) => {
                startButton.disabled = false;
                setStatus('Could not start: ' + error.message + '.', 'error');
            });
        });

        function onVisibilityChange() {
            if (document.visibilityState === 'visible' && port && sessionId && !finishing) {
                pollStatus();
            }
        }

        document.addEventListener('visibilitychange', onVisibilityChange);
        connect();

        teardown = function () {
            destroyed = true;
            clearTimeout(pollTimer);
            rejectPending('page_unloaded');
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (port) {
                port.disconnect();
                port = null;
            }
            style.remove();
        };
    });

    Qualtrics.SurveyEngine.addOnUnload(function () {
        teardown();
    });
})();
