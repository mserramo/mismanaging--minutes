(function () {
    const task = document.querySelector('.cs-task');
    if (!task) {
        return;
    }

    const form = task.closest('form');
    const cardRow = document.getElementById('cs-card-row');
    const inactivityDisplay = document.getElementById('cs-inactivity-display');
    const timeLeftDisplay = document.getElementById('cs-time-left-display');
    const pointsDisplay = document.getElementById('cs-points-display');
    const mainCardDisplay = document.getElementById('cs-main-card-display');
    const cueDisplay = document.getElementById('cs-cue');

    const startedAt = performance.now();
    const taskTimerKey = task.dataset.taskTimerKey || 'card_stacking_task_started_at';
    const inactivitySeconds = Number(task.dataset.inactivitySeconds || 30);
    const taskDurationSeconds = Number(task.dataset.taskDurationSeconds || 0);
    const bonusThresholdMainCards = Number(task.dataset.bonusThresholdMainCards || 0);
    const mainBonusPoints = Number(task.dataset.mainBonusPoints || 0);
    const mainColorIndex = Number(task.dataset.mainColorIndex || 0);
    const showClickFeedback = parseBoolean(task.dataset.showClickFeedback || 'true');
    const usePostClickDelay = parseBoolean(task.dataset.usePostClickDelay || 'false');
    const showTimeLeft = parseBoolean(task.dataset.showElapsedMinutes || 'false');
    const feedbackMessageMs = positiveNumber(task.dataset.feedbackMessageMs, 600);
    const postClickWaitMs = positiveNumber(task.dataset.clickFeedbackMs, 0);
    const mainBonusWaitMs = positiveNumber(task.dataset.mainBonusFeedbackMs, 0);

    const screenTypes = readJson('cs-screen-types-json', []);
    const screenSequence = readJson('cs-screen-sequence-json', []);
    const colorOrder = readJson('cs-color-order-json', []);
    const cardDeck = readJson('cs-card-deck-json', []);
    const decisions = [];

    let currentScreenNumber = 1;
    let currentScreenStartedAt = performance.now();
    let pointsAccumulated = positiveNumber(task.dataset.pointsAccumulated, 0);
    let mainCardsCollected = positiveNumber(task.dataset.mainCardsCollected, 0);
    let mainBonusTriggered = parseBoolean(task.dataset.mainBonusTriggered || 'false');
    let lastActivityAt = Date.now();
    let submitted = false;
    let cueHideTimer = null;

    window.sessionStorage.setItem(taskTimerKey, String(Date.now()));

    function readJson(id, fallback) {
        const element = document.getElementById(id);
        if (!element) {
            return fallback;
        }
        try {
            return JSON.parse(element.textContent || element.value || '');
        } catch (error) {
            return fallback;
        }
    }

    function positiveNumber(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.max(0, parsed);
    }

    function parseBoolean(value) {
        return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
    }

    function setValue(id, value) {
        const input = document.getElementById(id);
        if (input) {
            input.value = value === null || value === undefined || value === 'None' ? '' : value;
        }
    }

    function responseTimeMs() {
        return Math.max(0, Math.round(performance.now() - currentScreenStartedAt));
    }

    function taskElapsedMs() {
        const taskStartedAt = Number(window.sessionStorage.getItem(taskTimerKey) || Date.now());
        return Math.max(0, Math.round(Date.now() - taskStartedAt));
    }

    function formatClock(ms) {
        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function formatPoints(value) {
        if (!Number.isFinite(value)) {
            return '0';
        }
        return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }

    function taskDurationMs() {
        return Math.max(0, Math.round(taskDurationSeconds * 1000));
    }

    function taskTimeLeftMs() {
        const durationMs = taskDurationMs();
        if (durationMs <= 0) {
            return 0;
        }
        return Math.max(0, durationMs - taskElapsedMs());
    }

    function durationExpired() {
        const durationMs = taskDurationMs();
        return durationMs > 0 && taskElapsedMs() >= durationMs;
    }

    function screenTypeForCurrentScreen() {
        const sequenceIndex = Math.max(0, currentScreenNumber - 1);
        const typeIndex = screenSequence[sequenceIndex] || screenSequence[screenSequence.length - 1] || 1;
        return screenTypes[typeIndex - 1] || screenTypes[0] || { type_index: typeIndex, side_values: [] };
    }

    function displayValue(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return '';
        }
        return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
    }

    function cardsForCurrentScreen() {
        const screenType = screenTypeForCurrentScreen();
        const sideValues = screenType.side_values || [];
        let sideIndex = 0;
        return colorOrder.map((colorIndex, index) => {
            const deckCard = cardDeck[colorIndex] || {};
            const isMain = Number(colorIndex) === mainColorIndex;
            const card = {
                color_id: deckCard.color_id || `color_${colorIndex}`,
                label: deckCard.label || 'Card',
                color: deckCard.color || '#334155',
                position: index + 1,
                screen_number: currentScreenNumber,
                screen_type_index: screenType.type_index,
                is_main: isMain,
                id: isMain ? 'main' : `side_${sideIndex + 1}`,
                x: null,
                y: null,
                z: null,
            };
            if (!isMain) {
                const values = sideValues[sideIndex] || {};
                sideIndex += 1;
                card.x = Number(values.x || 0);
                card.y = Number(values.y || 0);
                card.z = Number(values.z || 0);
            }
            return card;
        });
    }

    function renderCards() {
        if (!cardRow) {
            return;
        }
        currentScreenStartedAt = performance.now();
        cardRow.classList.remove('cs-card-row-new');
        void cardRow.offsetWidth;
        cardRow.replaceChildren();
        cardsForCurrentScreen().forEach((card) => {
            const button = document.createElement('button');
            button.className = 'cs-card';
            button.type = 'button';
            button.style.setProperty('--card-color', card.color);
            button.dataset.cardId = card.id;
            button.dataset.cardLabel = card.label;
            button.dataset.position = String(card.position);
            button.dataset.isMain = card.is_main ? 'true' : 'false';
            button.dataset.x = card.x === null ? '' : String(card.x);
            button.dataset.y = card.y === null ? '' : String(card.y);
            button.dataset.z = card.z === null ? '' : String(card.z);

            const label = document.createElement('span');
            label.className = 'cs-card-label';
            label.textContent = card.label;
            button.appendChild(label);

            if (!card.is_main) {
                const points = document.createElement('span');
                points.className = 'cs-points';
                points.textContent = `Points: ${displayValue(card.x)}`;
                button.appendChild(points);

                const multiplier = document.createElement('span');
                multiplier.className = 'cs-multiplier';
                multiplier.textContent = `${displayValue(card.y)}% of ${displayValue(card.z)}x`;
                button.appendChild(multiplier);
            }

            button.addEventListener('click', () => submitChoice(card, button));
            cardRow.appendChild(button);
        });
        cardRow.classList.add('cs-card-row-new');
    }

    function cueBox(message, className) {
        const box = document.createElement('span');
        box.className = `cs-cue-box ${className || ''}`.trim();
        box.textContent = message;
        return box;
    }

    function showCue(message, className, sideMessage, sideClassName) {
        if (!showClickFeedback || !cueDisplay || !message) {
            return;
        }
        window.clearTimeout(cueHideTimer);
        cueDisplay.replaceChildren(cueBox(message, className));
        if (sideMessage) {
            cueDisplay.appendChild(cueBox(sideMessage, sideClassName));
        }
        cueDisplay.className = 'cs-cue cs-cue-visible';
        hideCueAfter(feedbackMessageMs);
    }

    function hideCueAfter(delayMs) {
        if (!cueDisplay || delayMs <= 0) {
            return;
        }
        cueHideTimer = window.setTimeout(() => {
            cueDisplay.classList.remove('cs-cue-visible');
            window.setTimeout(() => cueDisplay.replaceChildren(), 90);
        }, delayMs);
    }

    function updateCounters() {
        if (pointsDisplay) {
            pointsDisplay.textContent = `Total Points: ${formatPoints(pointsAccumulated)}`;
        }
        if (mainCardDisplay) {
            mainCardDisplay.textContent = `Main cards collected: ${mainCardsCollected}`;
        }
    }

    function setFinalHiddenFields(status) {
        const lastDecision = decisions[decisions.length - 1] || {};
        setValue('chosen_card_id', lastDecision.chosen_card_id || '');
        setValue('chosen_card_position', lastDecision.chosen_card_position || '');
        setValue('chosen_is_main', lastDecision.chosen_is_main === undefined ? '' : lastDecision.chosen_is_main ? 'True' : 'False');
        setValue('chosen_x', lastDecision.chosen_x);
        setValue('chosen_y', lastDecision.chosen_y);
        setValue('chosen_z', lastDecision.chosen_z);
        setValue('response_time_ms', lastDecision.response_time_ms || 0);
        setValue('task_elapsed_ms', taskElapsedMs());
        setValue('points_before', lastDecision.points_before === undefined ? pointsAccumulated : lastDecision.points_before);
        setValue('card_points_added', lastDecision.card_points_added || 0);
        setValue('multiplier_applied', lastDecision.multiplier_applied ? 'True' : 'False');
        setValue('multiplier_y', lastDecision.multiplier_y);
        setValue('multiplier_z', lastDecision.multiplier_z);
        setValue('main_bonus_triggered_this_round', lastDecision.main_bonus_triggered_this_round ? 'True' : 'False');
        setValue('main_bonus_points_added', lastDecision.main_bonus_points_added || 0);
        setValue('points_after', pointsAccumulated);
        setValue('timed_out_inactive', status === 'inactive' ? 'True' : 'False');
        setValue('timed_out_task_duration', status === 'duration' ? 'True' : 'False');
        setValue('decision_count', decisions.length);
        setValue('decisions_json', JSON.stringify(decisions));
        setValue('screen_sequence_json', JSON.stringify(screenSequence));
    }

    function finishTask(status) {
        if (submitted) {
            return;
        }
        submitted = true;
        setFinalHiddenFields(status);
        form.submit();
    }

    function disableCards(selectedButton) {
        document.querySelectorAll('.cs-card').forEach((button) => {
            button.disabled = true;
            button.classList.toggle('cs-card-selected', button === selectedButton);
        });
    }

    function advanceScreen() {
        if (durationExpired()) {
            finishTask('duration');
            return;
        }
        currentScreenNumber += 1;
        renderCards();
    }

    function submitChoice(card, cardButton) {
        if (submitted || durationExpired()) {
            finishTask('duration');
            return;
        }
        lastActivityAt = Date.now();
        const pointsBefore = pointsAccumulated;
        const clickedResponseTimeMs = responseTimeMs();
        const clickedTaskElapsedMs = taskElapsedMs();
        let cardPointsAdded = 0;
        let multiplierApplied = false;
        let mainBonusTriggeredThisRound = false;
        let mainBonusPointsAdded = 0;

        if (card.is_main) {
            mainCardsCollected += 1;
            mainBonusTriggeredThisRound = (
                !mainBonusTriggered
                && bonusThresholdMainCards > 0
                && mainCardsCollected >= bonusThresholdMainCards
            );
            if (mainBonusTriggeredThisRound) {
                mainBonusTriggered = true;
                mainBonusPointsAdded = mainBonusPoints;
            }
        } else {
            multiplierApplied = Math.random() < card.y / 100;
            cardPointsAdded = multiplierApplied ? card.x * card.z : card.x;
        }

        pointsAccumulated = pointsBefore + cardPointsAdded + mainBonusPointsAdded;
        const decision = {
            screen_number: currentScreenNumber,
            screen_type_index: card.screen_type_index,
            chosen_card_id: card.id,
            chosen_card_label: card.label,
            chosen_card_position: card.position,
            chosen_is_main: card.is_main,
            chosen_x: card.is_main ? null : card.x,
            chosen_y: card.is_main ? null : card.y,
            chosen_z: card.is_main ? null : card.z,
            response_time_ms: clickedResponseTimeMs,
            task_elapsed_ms: clickedTaskElapsedMs,
            main_cards_collected: mainCardsCollected,
            points_before: pointsBefore,
            card_points_added: cardPointsAdded,
            multiplier_applied: multiplierApplied,
            multiplier_y: card.is_main ? null : card.y,
            multiplier_z: card.is_main ? null : card.z,
            main_bonus_triggered_this_round: mainBonusTriggeredThisRound,
            main_bonus_points_added: mainBonusPointsAdded,
            points_after: pointsAccumulated,
        };
        decisions.push(decision);
        updateCounters();
        disableCards(cardButton);

        if (mainBonusTriggeredThisRound) {
            showCue(
                `+${formatPoints(mainBonusPointsAdded)} points -- collected ${bonusThresholdMainCards} main cards`,
                'cs-cue-main-bonus'
            );
        } else if (multiplierApplied) {
            showCue(
                `+${formatPoints(cardPointsAdded)} points`,
                'cs-cue-points',
                `${formatPoints(card.z)}x`,
                'cs-cue-multiplier-badge'
            );
        } else if (!card.is_main) {
            showCue(`+${formatPoints(cardPointsAdded)} points`, 'cs-cue-points');
        } else {
            showCue(`+1 ${card.label}`, 'cs-cue-points');
        }

        if (usePostClickDelay) {
            const delayMs = mainBonusTriggeredThisRound ? mainBonusWaitMs : postClickWaitMs;
            window.setTimeout(advanceScreen, delayMs);
        } else {
            advanceScreen();
        }
    }

    function resetActivity() {
        lastActivityAt = Date.now();
    }

    function updateInactivityClock() {
        if (showTimeLeft && timeLeftDisplay) {
            timeLeftDisplay.textContent = `Time left: ${formatClock(taskTimeLeftMs())}`;
        }
        if (durationExpired()) {
            finishTask('duration');
            return;
        }
        const elapsedSeconds = Math.floor((Date.now() - lastActivityAt) / 1000);
        const remaining = Math.max(0, inactivitySeconds - elapsedSeconds);
        if (inactivityDisplay) {
            inactivityDisplay.textContent = `Inactivity limit: ${remaining}s`;
        }
        if (elapsedSeconds >= inactivitySeconds) {
            finishTask('inactive');
        }
    }

    ['mousemove', 'keydown', 'touchstart', 'scroll', 'click'].forEach((eventName) => {
        window.addEventListener(eventName, resetActivity, { passive: true });
    });

    updateCounters();
    renderCards();
    updateInactivityClock();
    window.setInterval(updateInactivityClock, 250);
})();
