/* global Qualtrics */
'use strict';

(function () {
    Qualtrics.SurveyEngine.addOnReady(function () {
        const question = this;
        const root = document.getElementById('ttfp-natural-report-root');
        if (!root) {
            return;
        }
        root.replaceChildren();

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

        function getEmbeddedData(name) {
            try {
                const value = Qualtrics.SurveyEngine.getEmbeddedData(name);
                return value === null || value === undefined ? '' : String(value);
            } catch (_error) {
                return '';
            }
        }

        function nonnegative(value) {
            const number = Number(value);
            return Number.isFinite(number) && number >= 0 ? number : 0;
        }

        function seconds(milliseconds) {
            return (nonnegative(milliseconds) / 1000).toFixed(1) + 's';
        }

        function parseSummary() {
            const raw = getEmbeddedData('ttfp_natural_summary_json');
            if (!raw) {
                return null;
            }
            try {
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (_error) {
                return null;
            }
        }

        function appendLine(parent, label, value) {
            const line = element('p', 'ttfpnr-line');
            line.append(
                element('strong', null, label + ': '),
                document.createTextNode(String(value))
            );
            parent.appendChild(line);
        }

        const style = element('style');
        style.textContent = `
            #ttfp-natural-report-root, #ttfp-natural-report-root * { box-sizing: border-box; }
            #ttfp-natural-report-root { color: #172033; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .ttfpnr-shell { margin: 0 auto; width: min(820px, 100%); }
            .ttfpnr-title { font-size: 24px; line-height: 1.2; margin: 0 0 18px; }
            .ttfpnr-output { border-top: 1px solid #d7dce5; padding-top: 14px; }
            .ttfpnr-line { margin: 0 0 7px; overflow-wrap: anywhere; }
            .ttfpnr-empty { color: #b42318; margin: 0; }
        `;
        document.head.appendChild(style);

        const shell = element('section', 'ttfpnr-shell');
        shell.appendChild(element('h2', 'ttfpnr-title', 'Recorded session data'));
        const summary = parseSummary();
        if (!summary) {
            shell.appendChild(element(
                'p',
                'ttfpnr-empty',
                'No valid natural-session summary was found.'
            ));
            root.appendChild(shell);
            question.showNextButton();
            return;
        }

        const videos = Array.isArray(summary.videos) ? summary.videos : [];
        const activity = summary.activity && typeof summary.activity === 'object'
            ? summary.activity
            : {};
        const output = element('div', 'ttfpnr-output');
        appendLine(output, 'Status', summary.status || 'complete');
        appendLine(output, 'Qualified viewing time', seconds(summary.qualifiedMs));
        appendLine(output, 'Videos registered (at least 0.5s)', Math.floor(nonnegative(summary.videoCount)));
        videos.forEach((video, index) => {
            appendLine(
                output,
                'Video ' + (Math.floor(nonnegative(video.order)) || index + 1),
                'post ID ' + String(video.videoId || '—') +
                    '; active watch time ' + seconds(video.activeWatchMs)
            );
        });
        appendLine(output, 'Video transitions', Math.floor(nonnegative(activity.videoTransitions)));
        appendLine(output, 'Pointer-movement bursts', Math.floor(nonnegative(activity.pointerMoveBursts)));
        appendLine(output, 'Clicks', Math.floor(nonnegative(activity.clicks)));
        appendLine(output, 'Scroll-wheel events', Math.floor(nonnegative(activity.wheelEvents)));
        appendLine(output, 'Key events', Math.floor(nonnegative(activity.keyEvents)));
        appendLine(output, 'Pauses', Math.floor(nonnegative(activity.pauseCount)));
        appendLine(output, 'Resumes', Math.floor(nonnegative(activity.resumeCount)));
        appendLine(output, 'Tab-away events', Math.floor(nonnegative(activity.tabAwayCount)));
        appendLine(output, 'Tab-away time', seconds(activity.tabAwayMs));
        appendLine(output, 'Window-blur events', Math.floor(nonnegative(activity.windowBlurCount)));
        appendLine(output, 'Window-unfocused time', seconds(activity.windowBlurMs));
        appendLine(
            output,
            'Compact summary truncated',
            getEmbeddedData('ttfp_natural_summary_truncated') === '1' ? 'yes' : 'no'
        );
        shell.appendChild(output);
        root.appendChild(shell);
        question.showNextButton();
    });
})();
