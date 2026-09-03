/* global Qualtrics */
'use strict';

(function () {
    const BRIDGE_NAME = 'tiktok-fyp-qualtrics-v1';
    const MIN_BRIDGE_VERSION = 2;
    const TIKTOK_ORIGIN = 'https://www.tiktok.com';
    const POLL_MS = 500;
    let teardown = function () {};

    Qualtrics.SurveyEngine.addOnReady(function () {
        const question = this;
        const root = document.getElementById('ttfp-qualtrics-root');
        if (!root) {
            return;
        }
        question.hideNextButton();
        root.replaceChildren();

        let port = null;
        let requestSequence = 0;
        let sessionId = cleanSessionId('${e://Field/ttfp_session_id}');
        let queue = [];
        let currentIndex = -1;
        let currentIframe = null;
        let playerReady = false;
        let playing = false;
        let terminal = false;
        let autoplayUnlocked = false;
        let pollTimer = null;
        let iframeReadyTimer = null;
        let autoAdvanceTimer = null;
        let destroyed = false;
        const pending = new Map();
        const playbackEvents = [];

        function cleanSessionId(value) {
            return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(value)
                ? value
                : null;
        }

        function configuredExtensionId() {
            const piped = '${e://Field/ttfp_extension_id}';
            const fromQuery = new URLSearchParams(location.search).get('ttfp_extension_id');
            const remembered = sessionStorage.getItem('ttfp_extension_id');
            return [fromQuery, piped, remembered].find((value) => /^[a-p]{32}$/.test(value || '')) || '';
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
            #ttfp-qualtrics-root, #ttfp-qualtrics-root * { box-sizing: border-box; }
            #ttfp-qualtrics-root { color: #172033; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .ttfpq-shell { width: min(680px, 100%); margin: 0 auto; }
            .ttfpq-eyebrow { margin: 0 0 7px; color: #595ee8; font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
            .ttfpq-title { margin: 0 0 8px; font-size: clamp(25px, 4vw, 34px); line-height: 1.12; }
            .ttfpq-copy { margin: 0 0 16px; color: #56627a; }
            .ttfpq-card { padding: 18px; border: 1px solid #d7deeb; border-radius: 16px; background: #fff; box-shadow: 0 10px 30px rgba(23,32,51,.07); }
            .ttfpq-guide { margin: 0 0 18px; padding: 15px 16px; border: 1px solid #e0e4f2; border-radius: 12px; background: #f7f8fc; }
            .ttfpq-guide h3 { margin: 0 0 10px; font-size: 15px; }
            .ttfpq-steps { margin: 0; padding-left: 22px; color: #344054; }
            .ttfpq-steps li { padding-left: 3px; }
            .ttfpq-steps li + li { margin-top: 8px; }
            .ttfpq-steps strong { color: #172033; }
            .ttfpq-connect { padding-top: 16px; border-top: 1px solid #e2e6ee; }
            .ttfpq-row { display: flex; gap: 9px; align-items: end; }
            .ttfpq-field { flex: 1; min-width: 0; }
            .ttfpq-field label { display: block; margin-bottom: 5px; font-size: 12px; font-weight: 750; }
            .ttfpq-field input { width: 100%; min-height: 42px; padding: 9px 11px; border: 1px solid #b9c2d3; border-radius: 9px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
            .ttfpq-button { min-height: 42px; padding: 9px 15px; border: 1px solid #c6cede; border-radius: 9px; background: #fff; color: #172033; cursor: pointer; font: inherit; font-weight: 750; }
            .ttfpq-button.primary { border-color: #595ee8; background: #595ee8; color: #fff; }
            .ttfpq-button:disabled { cursor: not-allowed; opacity: .48; }
            .ttfpq-status { margin: 14px 0 0; min-height: 23px; color: #56627a; }
            .ttfpq-status.error { color: #b42318; }
            .ttfpq-status.success { color: #067647; }
            .ttfpq-progress { height: 8px; margin-top: 12px; overflow: hidden; border-radius: 999px; background: #e8ebf4; }
            .ttfpq-progress-fill { height: 100%; width: 0; background: #595ee8; transition: width .2s ease; }
            .ttfpq-actions { display: flex; justify-content: center; margin-top: 15px; }
            .ttfpq-note { margin: 14px 0 0; padding-top: 13px; border-top: 1px solid #e2e6ee; color: #667085; font-size: 12px; }
            .ttfpq-viewer[hidden], .ttfpq-setup[hidden] { display: none !important; }
            .ttfpq-viewer { width: min(430px, 100%); margin: 0 auto; }
            .ttfpq-player { position: relative; width: min(100%, 360px); margin: 0 auto; aspect-ratio: 9 / 16; overflow: hidden; border-radius: 18px; outline: none; background: #0f1115; box-shadow: 0 20px 48px rgba(15,17,21,.2); cursor: pointer; }
            .ttfpq-player:focus-visible { box-shadow: 0 0 0 4px rgba(89,94,232,.28), 0 20px 48px rgba(15,17,21,.2); }
            .ttfpq-player-mount { position: absolute; inset: 0; width: 100%; height: 100%; }
            .ttfpq-player iframe { display: block; width: 100%; height: 100%; border: 0; pointer-events: none; }
            .ttfpq-placeholder { position: absolute; inset: 0; display: grid; place-content: center; padding: 24px; background: #111522; color: #d0d5dd; text-align: center; }
            .ttfpq-placeholder[hidden] { display: none; }
            .ttfpq-controls { display: grid; grid-template-columns: 44px minmax(0,1fr) 44px; gap: 8px; align-items: center; margin-top: 10px; padding: 8px; border: 1px solid #d7deeb; border-radius: 14px; background: #fff; }
            .ttfpq-nav { min-width: 0; padding: 7px; font-size: 20px; }
            .ttfpq-control-copy { min-width: 0; }
            .ttfpq-control-copy strong, .ttfpq-control-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .ttfpq-control-copy span { color: #667085; font-size: 11px; }
            .ttfpq-finished { padding: 28px; text-align: center; }
            @media (max-width: 520px) { .ttfpq-row { align-items: stretch; flex-direction: column; } .ttfpq-player { width: min(100%, 330px); } }
        `;
        document.head.appendChild(style);

        const shell = element('section', 'ttfpq-shell');
        const setup = element('div', 'ttfpq-setup');
        const eyebrow = element('p', 'ttfpq-eyebrow', 'Research pilot');
        const title = element('h2', 'ttfpq-title', 'Personalized TikTok video task');
        const copy = element('p', 'ttfpq-copy', 'Complete these steps in desktop Chrome. The videos will appear on this same survey page.');
        const card = element('div', 'ttfpq-card');
        const guide = element('section', 'ttfpq-guide');
        const guideTitle = element('h3', null, 'Before you begin');
        const steps = element('ol', 'ttfpq-steps');
        [
            [
                'Load the extension. ',
                'Open chrome://extensions, turn on Developer mode, select Load unpacked, and choose the supplied tiktok-fyp-pilot folder containing manifest.json. Open the extension, accept the disclosure, and grant TikTok access.'
            ],
            [
                'Copy the extension code. ',
                'On chrome://extensions, copy the 32-letter ID shown on the TikTok FYP Research Pilot card.'
            ],
            [
                'Start collection. ',
                'Paste the ID below, select Connect, and then select Start harvest.'
            ],
            [
                'Wait for collection. ',
                'TikTok will open behind a protective cover and this survey will regain focus. Keep both tabs open until the timer finishes.'
            ],
            [
                'Watch the videos. ',
                'The collected videos will appear here automatically. Click the video to play or pause, and use the arrow controls below it to move between videos.'
            ],
        ].forEach(([heading, detail]) => {
            const item = element('li');
            item.append(element('strong', null, heading), document.createTextNode(detail));
            steps.appendChild(item);
        });
        guide.append(guideTitle, steps);
        const connectArea = element('div', 'ttfpq-connect');
        const row = element('div', 'ttfpq-row');
        const field = element('div', 'ttfpq-field');
        const label = element('label', null, 'Chrome extension ID');
        const extensionInput = element('input');
        extensionInput.type = 'text';
        extensionInput.autocomplete = 'off';
        extensionInput.spellcheck = false;
        extensionInput.maxLength = 32;
        extensionInput.value = configuredExtensionId();
        label.htmlFor = 'ttfpq-extension-id';
        extensionInput.id = 'ttfpq-extension-id';
        field.append(label, extensionInput);
        const connectButton = button('Connect', 'ttfpq-button');
        const status = element('p', 'ttfpq-status', 'Complete steps 1–2, paste the extension ID, and then connect.');
        const progress = element('div', 'ttfpq-progress');
        const progressFill = element('div', 'ttfpq-progress-fill');
        progress.appendChild(progressFill);
        const actions = element('div', 'ttfpq-actions');
        const startButton = button('Start harvest', 'ttfpq-button primary');
        startButton.disabled = true;
        actions.appendChild(startButton);
        const note = element('p', 'ttfpq-note', 'This pilot sends numeric TikTok post IDs and the playback log into this Qualtrics response. TikTok separately receives normal embed-player requests and playback signals.');
        row.append(field, connectButton);
        connectArea.append(row, status, progress, actions, note);
        card.append(guide, connectArea);
        setup.append(eyebrow, title, copy, card);

        const viewer = element('div', 'ttfpq-viewer');
        viewer.hidden = true;
        const player = element('div', 'ttfpq-player');
        player.tabIndex = 0;
        player.setAttribute('role', 'button');
        player.setAttribute('aria-label', 'Play video');
        const playerMount = element('div', 'ttfpq-player-mount');
        const placeholder = element('div', 'ttfpq-placeholder', 'Preparing the TikTok player…');
        player.append(playerMount, placeholder);
        const controls = element('div', 'ttfpq-controls');
        const previousButton = button('←', 'ttfpq-button ttfpq-nav');
        previousButton.setAttribute('aria-label', 'Previous video');
        const controlCopy = element('div', 'ttfpq-control-copy');
        const controlTitle = element('strong', null, 'Preparing video');
        const controlStatus = element('span', null, 'Waiting for the player.');
        controlCopy.append(controlTitle, controlStatus);
        const nextButton = button('→', 'ttfpq-button ttfpq-nav');
        nextButton.setAttribute('aria-label', 'Next video');
        controls.append(previousButton, controlCopy, nextButton);
        viewer.append(player, controls);
        shell.append(setup, viewer);
        root.appendChild(shell);

        function setStatus(message, kind) {
            status.textContent = message;
            status.className = 'ttfpq-status' + (kind ? ' ' + kind : '');
        }

        function setEmbeddedData(name, value) {
            Qualtrics.SurveyEngine.setEmbeddedData(name, value === null ? '' : String(value));
        }

        function rememberEvent(type, detail) {
            playbackEvents.push({
                video: currentIndex + 1,
                type,
                at: Date.now(),
                detail: detail || null,
            });
            if (playbackEvents.length > 200) {
                playbackEvents.splice(0, playbackEvents.length - 200);
            }
            setEmbeddedData('ttfp_playback_events_json', JSON.stringify(playbackEvents));
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
                const requestId = 'q-' + Date.now() + '-' + requestSequence;
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    reject(new Error('bridge_timeout'));
                }, 8000);
                pending.set(requestId, { resolve, reject, timer });
                port.postMessage({ ...payload, type, requestId });
            });
        }

        function connect() {
            const extensionId = extensionInput.value.trim();
            if (!/^[a-p]{32}$/.test(extensionId)) {
                setStatus('The extension ID must be the 32-letter ID shown on chrome://extensions.', 'error');
                return;
            }
            if (!window.chrome || !chrome.runtime || typeof chrome.runtime.connect !== 'function') {
                setStatus('Chrome did not expose the extension bridge on this survey domain.', 'error');
                return;
            }
            if (port) {
                port.disconnect();
            }
            sessionStorage.setItem('ttfp_extension_id', extensionId);
            setEmbeddedData('ttfp_extension_id', extensionId);
            setStatus('Connecting to the research extension…');
            try {
                port = chrome.runtime.connect(extensionId, { name: BRIDGE_NAME });
            } catch (_error) {
                port = null;
                setStatus('The extension could not be reached. Confirm its ID and reload it.', 'error');
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
                if (!destroyed && viewer.hidden) {
                    startButton.disabled = true;
                    setStatus('Extension connection closed. Press Connect to retry.', 'error');
                }
            });
            request('hello', { sessionId }).then(handleStatus).catch(() => {
                setStatus('The extension did not answer. Confirm its ID and reload it.', 'error');
            });
        }

        function schedulePoll() {
            clearTimeout(pollTimer);
            if (!destroyed && port && sessionId) {
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

        function handleStatus(response) {
            if (!response || !response.ok) {
                setStatus(
                    'Extension error: ' + ((response && response.error) || 'unknown_error') + '.',
                    'error'
                );
                return;
            }
            const bridgeVersion = Number(response.bridgeVersion || 0);
            const extensionVersion = response.extensionVersion || 'unknown';
            setEmbeddedData('ttfp_bridge_version', bridgeVersion);
            if (bridgeVersion < MIN_BRIDGE_VERSION) {
                startButton.disabled = true;
                setStatus(
                    'Extension v' + extensionVersion + ' is outdated for this survey. ' +
                    'Open chrome://extensions, reload TikTok FYP Research Pilot, then press Connect again.',
                    'error'
                );
                return;
            }
            if (!response.permissionGranted) {
                startButton.disabled = true;
                setStatus('Open the extension, accept the disclosure, and grant TikTok access. Then press Connect again.', 'error');
                return;
            }
            if (response.conflict) {
                startButton.disabled = true;
                setStatus(
                    'A standalone extension session is active and cannot be transferred into this survey. ' +
                    'Open the extension, stop and clear that session, then press Connect again.',
                    'error'
                );
                return;
            }
            if (!response.session) {
                startButton.disabled = false;
                setStatus(
                    'Extension v' + extensionVersion + ' connected. TikTok access is ready.',
                    'success'
                );
                return;
            }
            if (response.session.deliveryTarget !== 'qualtrics') {
                startButton.disabled = true;
                setStatus('This session is not owned by Qualtrics and cannot be shown in this survey.', 'error');
                return;
            }
            sessionId = response.session.id;
            setEmbeddedData('ttfp_session_id', sessionId);
            setEmbeddedData('ttfp_harvest_status', response.session.status);
            const progressData = response.session.progress || {};
            const durationMs = Math.max(1, Number(progressData.harvestDurationSeconds || 30) * 1000);
            const elapsedMs = Math.max(0, Number(progressData.harvestElapsedMs || 0));
            progressFill.style.width = Math.min(100, elapsedMs / durationMs * 100) + '%';
            const count = Array.isArray(response.session.queue) ? response.session.queue.length : 0;
            if (response.session.status === 'collecting') {
                const remaining = Math.max(0, Math.ceil(Number(progressData.harvestRemainingMs || 0) / 1000));
                startButton.disabled = true;
                setStatus(
                    'Harvesting behind the covered TikTok tab: ' + count +
                    ' sourced, ' + remaining + 's remaining.'
                );
                schedulePoll();
                return;
            }
            if (response.session.status === 'failed' || response.session.status === 'stopped') {
                setEmbeddedData('ttfp_failure_reason', response.session.stopReason || response.session.status);
                setEmbeddedData('ttfp_video_count', '0');
                setEmbeddedData('ttfp_video_ids_json', '[]');
                setEmbeddedData('ttfp_playback_events_json', '[]');
                setEmbeddedData('ttfp_test_bypass', '1');
                actions.hidden = true;
                setStatus(
                    'Harvest stopped: ' +
                    (response.session.stopReason || response.session.status) + '. ' +
                    'Testing bypass is enabled; use the Qualtrics Next button to continue.',
                    'error'
                );
                question.showNextButton();
                return;
            }
            if (['complete', 'viewing'].includes(response.session.status)) {
                queue = response.session.queue || [];
                if (!queue.length) {
                    setStatus('The completed session did not contain playable video IDs.', 'error');
                    return;
                }
                setEmbeddedData('ttfp_video_count', queue.length);
                setEmbeddedData('ttfp_video_ids_json', JSON.stringify(queue.map((record) => record.videoId)));
                showViewer();
            }
        }

        function embedUrl(videoId) {
            const parameters = new URLSearchParams({
                controls: '0', progress_bar: '0', play_button: '0', volume_control: '0',
                fullscreen_button: '0', timestamp: '0', loop: '0',
                autoplay: autoplayUnlocked ? '1' : '0', music_info: '0',
                description: '0', rel: '0', native_context_menu: '0', closed_caption: '0',
            });
            return TIKTOK_ORIGIN + '/player/v1/' + videoId + '?' + parameters.toString();
        }

        function postPlayerCommand(type) {
            if (!currentIframe || !currentIframe.contentWindow) {
                return;
            }
            currentIframe.contentWindow.postMessage(
                { type, value: null, 'x-tiktok-player': true },
                TIKTOK_ORIGIN
            );
        }

        function updateControls(message) {
            previousButton.disabled = currentIndex <= 0;
            nextButton.disabled = currentIndex < 0;
            nextButton.textContent = currentIndex === queue.length - 1 ? '✓' : '→';
            nextButton.setAttribute('aria-label', currentIndex === queue.length - 1 ? 'Finish task' : 'Next video');
            if (message) {
                controlStatus.textContent = message;
            }
        }

        function markReady(message) {
            if (playerReady) {
                return;
            }
            playerReady = true;
            clearTimeout(iframeReadyTimer);
            placeholder.hidden = true;
            controlTitle.textContent = 'Ready to watch';
            controlStatus.textContent = (message ? message + ' ' : '') + 'Click the video to play.';
            player.setAttribute('aria-label', 'Play video');
            if (autoplayUnlocked) {
                postPlayerCommand('unMute');
                postPlayerCommand('play');
            }
        }

        function loadVideo(index, source) {
            clearTimeout(iframeReadyTimer);
            clearTimeout(autoAdvanceTimer);
            currentIndex = index;
            currentIframe = null;
            playerReady = false;
            playing = false;
            terminal = false;
            player.setAttribute('aria-label', 'Video loading');
            controlTitle.textContent = 'Preparing video';
            controlStatus.textContent = 'Waiting for the TikTok player.';
            placeholder.hidden = false;
            playerMount.replaceChildren();
            const iframe = document.createElement('iframe');
            iframe.title = 'Personalized TikTok video ' + (currentIndex + 1);
            iframe.src = embedUrl(queue[currentIndex].videoId);
            iframe.allow = 'autoplay; fullscreen';
            iframe.referrerPolicy = 'no-referrer';
            currentIframe = iframe;
            iframe.addEventListener('load', () => {
                if (iframe !== currentIframe) {
                    return;
                }
                iframeReadyTimer = setTimeout(() => markReady('Player loaded.'), 900);
            }, { once: true });
            playerMount.appendChild(iframe);
            rememberEvent('navigate', source || 'initial');
            updateControls();
        }

        function move(delta, source) {
            if (!queue.length) {
                return;
            }
            if (delta > 0 && currentIndex === queue.length - 1) {
                if (!terminal) {
                    rememberEvent('skip', source || 'navigation');
                }
                finishTask();
                return;
            }
            const nextIndex = Math.max(0, Math.min(queue.length - 1, currentIndex + delta));
            if (nextIndex === currentIndex) {
                return;
            }
            if (!terminal) {
                rememberEvent('skip', source || 'navigation');
            }
            loadVideo(nextIndex, source || 'navigation');
        }

        function handlePlayerMessage(event) {
            if (
                event.origin !== TIKTOK_ORIGIN ||
                !currentIframe ||
                event.source !== currentIframe.contentWindow ||
                !event.data ||
                event.data['x-tiktok-player'] !== true
            ) {
                return;
            }
            if (event.data.type === 'onPlayerReady') {
                markReady('Player ready.');
                return;
            }
            if (event.data.type === 'onStateChange' && Number.isInteger(event.data.value)) {
                if (event.data.value === 1) {
                    playing = true;
                    controlTitle.textContent = 'Now playing';
                    controlStatus.textContent = 'Click the video to pause. It advances automatically when it ends.';
                    player.setAttribute('aria-label', 'Pause video');
                    rememberEvent('playing');
                } else if (event.data.value === 2) {
                    playing = false;
                    controlTitle.textContent = 'Paused';
                    controlStatus.textContent = 'Click the video or press Space to resume.';
                    player.setAttribute('aria-label', 'Resume video');
                    rememberEvent('paused');
                } else if (event.data.value === 0 && !terminal) {
                    terminal = true;
                    playing = false;
                    player.setAttribute('aria-label', 'Video ended');
                    controlTitle.textContent = 'Video ended';
                    controlStatus.textContent = currentIndex === queue.length - 1 ? 'Press ✓ to finish.' : 'Opening the next video…';
                    rememberEvent('ended');
                    if (currentIndex < queue.length - 1) {
                        autoAdvanceTimer = setTimeout(() => move(1, 'automatic'), 450);
                    }
                }
                return;
            }
            if ((event.data.type === 'onPlayerError' || event.data.type === 'onError') && !terminal) {
                terminal = true;
                playing = false;
                player.setAttribute('aria-label', 'Video unavailable');
                controlTitle.textContent = 'Video unavailable';
                controlStatus.textContent = 'Use Next to continue.';
                rememberEvent('player_error');
            }
        }

        function showViewer() {
            if (!viewer.hidden) {
                return;
            }
            setup.hidden = true;
            viewer.hidden = false;
            window.addEventListener('message', handlePlayerMessage);
            loadVideo(0, 'initial');
        }

        function finishTask() {
            if (!sessionId || !port) {
                controlStatus.textContent = 'Reconnect the extension before finishing.';
                return;
            }
            nextButton.disabled = true;
            previousButton.disabled = true;
            request('finish', { sessionId }).then((response) => {
                if (!response || !response.ok) {
                    throw new Error((response && response.error) || 'finish_failed');
                }
                setEmbeddedData('ttfp_completed', '1');
                setEmbeddedData('ttfp_test_bypass', '0');
                setEmbeddedData('ttfp_harvest_status', 'viewed');
                playerMount.replaceChildren();
                controls.replaceChildren(element('div', 'ttfpq-finished', 'Video task complete. Continue with the survey.'));
                question.showNextButton();
            }).catch(() => {
                nextButton.disabled = false;
                controlStatus.textContent = 'The completion status could not be saved. Try ✓ again.';
            });
        }

        connectButton.addEventListener('click', connect);
        startButton.addEventListener('click', () => {
            startButton.disabled = true;
            setStatus('Starting the covered TikTok collector…');
            request('start', {}).then((response) => {
                if (!response || !response.ok) {
                    throw new Error((response && response.error) || 'start_failed');
                }
                if (Number(response.bridgeVersion || 0) < MIN_BRIDGE_VERSION) {
                    throw new Error('outdated_extension');
                }
                sessionId = response.sessionId;
                setEmbeddedData('ttfp_session_id', sessionId);
                setEmbeddedData('ttfp_harvest_status', 'collecting');
                schedulePoll();
            }).catch((error) => {
                startButton.disabled = false;
                const message = error.message === 'active_session_exists'
                    ? 'Another extension session is active. Stop and clear it, then start again from this survey.'
                    : error.message === 'outdated_extension'
                        ? 'Reload TikTok FYP Research Pilot on chrome://extensions, reconnect, and try again.'
                        : 'Could not start: ' + error.message + '.';
                setStatus(message, 'error');
            });
        });
        function togglePlayback() {
            if (!playerReady || terminal) {
                return;
            }
            autoplayUnlocked = true;
            if (playing) {
                postPlayerCommand('pause');
            } else {
                postPlayerCommand('unMute');
                postPlayerCommand('play');
                controlTitle.textContent = 'Starting';
                controlStatus.textContent = 'Waiting for playback…';
                player.setAttribute('aria-label', 'Pause video');
                rememberEvent('play_command');
            }
        }

        player.addEventListener('click', togglePlayback);
        previousButton.addEventListener('click', () => move(-1, 'button'));
        nextButton.addEventListener('click', () => move(1, 'button'));

        function keyHandler(event) {
            if (viewer.hidden || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
                return;
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
                event.preventDefault();
                move(-1, 'keyboard');
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') {
                event.preventDefault();
                move(1, 'keyboard');
            } else if (event.code === 'Space') {
                event.preventDefault();
                togglePlayback();
            } else if (event.key === 'Enter' && event.target === player) {
                event.preventDefault();
                togglePlayback();
            }
        }

        window.addEventListener('keydown', keyHandler);
        if (extensionInput.value) {
            connect();
        }

        teardown = function () {
            destroyed = true;
            clearTimeout(pollTimer);
            clearTimeout(iframeReadyTimer);
            clearTimeout(autoAdvanceTimer);
            rejectPending('page_unloaded');
            if (port) {
                port.disconnect();
                port = null;
            }
            window.removeEventListener('message', handlePlayerMessage);
            window.removeEventListener('keydown', keyHandler);
            player.removeEventListener('click', togglePlayback);
            style.remove();
        };
    });

    Qualtrics.SurveyEngine.addOnUnload(function () {
        teardown();
    });
})();
