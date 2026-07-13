(function () {
    const task = document.querySelector('.cs-task');
    if (!task) {
        return;
    }

    const form = task.closest('form');
    const startedAt = performance.now();
    const roundNumber = Number(task.dataset.roundNumber || 1);
    const taskTimerKey = task.dataset.taskTimerKey || 'card_stacking_task_started_at';
    const inactivitySeconds = Number(task.dataset.inactivitySeconds || 30);
    const taskDurationSeconds = Number(task.dataset.taskDurationSeconds || 0);
    const bonusThresholdMainCards = Number(task.dataset.bonusThresholdMainCards || 0);
    const mainBonusPoints = Number(task.dataset.mainBonusPoints || 0);
    const pointsAccumulated = Number(task.dataset.pointsAccumulated || 0);
    const mainCardsCollected = Number(task.dataset.mainCardsCollected || 0);
    const mainBonusAlreadyTriggered = ['1', 'true', 'yes'].includes(
        String(task.dataset.mainBonusTriggered || '').toLowerCase()
    );
    const showClickFeedback = ['1', 'true', 'yes'].includes(
        String(task.dataset.showClickFeedback || 'true').toLowerCase()
    );
    const usePostClickDelay = ['1', 'true', 'yes'].includes(
        String(task.dataset.usePostClickDelay || 'true').toLowerCase()
    );
    const showTimeLeft = ['1', 'true', 'yes'].includes(
        String(task.dataset.showElapsedMinutes || '').toLowerCase()
    );
    const initialFeedbackMessage = task.dataset.initialFeedbackMessage || '';
    const initialFeedbackClass = task.dataset.initialFeedbackClass || '';
    const initialFeedbackSideMessage = task.dataset.initialFeedbackSideMessage || '';
    const initialFeedbackSideClass = task.dataset.initialFeedbackSideClass || '';
    const inactivityDisplay = document.getElementById('cs-inactivity-display');
    const timeLeftDisplay = document.getElementById('cs-time-left-display');
    const pointsDisplay = document.getElementById('cs-points-display');
    const cueDisplay = document.getElementById('cs-cue');
    const configuredFeedbackMessageMs = Number(task.dataset.feedbackMessageMs || 600);
    const feedbackMessageMs = Number.isFinite(configuredFeedbackMessageMs)
        ? Math.max(0, configuredFeedbackMessageMs)
        : 600;
    const configuredPostClickWaitMs = Number(task.dataset.clickFeedbackMs || 0);
    const postClickWaitMs = Number.isFinite(configuredPostClickWaitMs)
        ? Math.max(0, configuredPostClickWaitMs)
        : 0;
    const configuredMainBonusWaitMs = Number(
        task.dataset.mainBonusFeedbackMs || 0
    );
    const mainBonusWaitMs = Number.isFinite(configuredMainBonusWaitMs)
        ? Math.max(0, configuredMainBonusWaitMs)
        : 0;
    let lastActivityAt = Date.now();
    let submitted = false;

    if (roundNumber === 1 || !window.sessionStorage.getItem(taskTimerKey)) {
        window.sessionStorage.setItem(taskTimerKey, String(Date.now()));
    }

    function setValue(id, value) {
        const input = document.getElementById(id);
        if (input) {
            input.value = value === null || value === undefined || value === 'None' ? '' : value;
        }
    }

    function responseTimeMs() {
        return Math.max(0, Math.round(performance.now() - startedAt));
    }

    function taskElapsedMs() {
        const taskStartedAt = Number(window.sessionStorage.getItem(taskTimerKey) || Date.now());
        return Math.max(0, Math.round(Date.now() - taskStartedAt));
    }

    function formatElapsed(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
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

    function parseCardNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function parseBoolean(value) {
        return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
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
        cueDisplay.replaceChildren(cueBox(message, className));
        if (sideMessage) {
            cueDisplay.appendChild(cueBox(sideMessage, sideClassName));
        }
        cueDisplay.className = 'cs-cue cs-cue-visible';
    }

    function hideCueAfter(delayMs) {
        if (!cueDisplay || delayMs <= 0) {
            return;
        }
        window.setTimeout(() => {
            cueDisplay.classList.remove('cs-cue-visible');
            window.setTimeout(() => cueDisplay.replaceChildren(), 90);
        }, delayMs);
    }

    function showInitialCue() {
        showCue(
            initialFeedbackMessage,
            initialFeedbackClass,
            initialFeedbackSideMessage,
            initialFeedbackSideClass
        );
        if (initialFeedbackMessage) {
            hideCueAfter(feedbackMessageMs);
        }
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

    function submitChoice(cardButton) {
        if (submitted) {
            return;
        }
        if (durationExpired()) {
            submitTaskDurationTimeout();
            return;
        }
        submitted = true;
        const clickedResponseTimeMs = responseTimeMs();
        const clickedTaskElapsedMs = taskElapsedMs();
        const isMain = parseBoolean(cardButton.dataset.isMain);
        const cardX = parseCardNumber(cardButton.dataset.x);
        const cardY = parseCardNumber(cardButton.dataset.y);
        const cardZ = parseCardNumber(cardButton.dataset.z);
        const cardLabel = cardButton.dataset.cardLabel || 'Main card';
        let cardPointsAdded = 0;
        let multiplierApplied = false;
        let mainBonusTriggered = false;
        let mainBonusPointsAdded = 0;

        if (isMain) {
            const nextMainCardsCollected = mainCardsCollected + 1;
            mainBonusTriggered = (
                !mainBonusAlreadyTriggered
                && bonusThresholdMainCards > 0
                && nextMainCardsCollected >= bonusThresholdMainCards
            );
            if (mainBonusTriggered) {
                mainBonusPointsAdded = mainBonusPoints;
            }
        } else {
            multiplierApplied = Math.random() < cardY / 100;
            cardPointsAdded = multiplierApplied ? cardX * cardZ : cardX;
        }

        const pointsAfter = pointsAccumulated + cardPointsAdded + mainBonusPointsAdded;

        setValue('chosen_card_id', cardButton.dataset.cardId);
        setValue('chosen_card_position', cardButton.dataset.position);
        setValue('chosen_is_main', isMain ? 'True' : 'False');
        setValue('chosen_x', cardButton.dataset.x);
        setValue('chosen_y', cardButton.dataset.y);
        setValue('chosen_z', cardButton.dataset.z);
        setValue('response_time_ms', clickedResponseTimeMs);
        setValue('task_elapsed_ms', clickedTaskElapsedMs);
        setValue('points_before', pointsAccumulated);
        setValue('card_points_added', cardPointsAdded);
        setValue('multiplier_applied', multiplierApplied ? 'True' : 'False');
        setValue('multiplier_y', isMain ? '' : cardY);
        setValue('multiplier_z', isMain ? '' : cardZ);
        setValue('main_bonus_triggered_this_round', mainBonusTriggered ? 'True' : 'False');
        setValue('main_bonus_points_added', mainBonusPointsAdded);
        setValue('points_after', pointsAfter);
        setValue('timed_out_inactive', 'False');
        setValue('timed_out_task_duration', 'False');
        if (pointsDisplay) {
            pointsDisplay.textContent = `Total Points: ${formatPoints(pointsAfter)}`;
        }

        document.querySelectorAll('.cs-card').forEach((button) => {
            button.disabled = true;
            button.classList.toggle('cs-card-selected', button === cardButton);
        });
        if (usePostClickDelay) {
            if (mainBonusTriggered || mainBonusPointsAdded > 0) {
                showCue(
                    `+${formatPoints(mainBonusPointsAdded)} points -- collected ${bonusThresholdMainCards} main cards`,
                    'cs-cue-main-bonus'
                );
            } else if (multiplierApplied) {
                showCue(
                    `+${formatPoints(cardPointsAdded)} points`,
                    'cs-cue-points',
                    `${formatPoints(cardZ)}x`,
                    'cs-cue-multiplier-badge'
                );
            } else if (!isMain) {
                showCue(`+${formatPoints(cardPointsAdded)} points`, 'cs-cue-points');
            } else {
                showCue(`+1 ${cardLabel}`, 'cs-cue-points');
            }
            hideCueAfter(feedbackMessageMs);
            const submitDelayMs = mainBonusTriggered
                ? mainBonusWaitMs
                : postClickWaitMs;
            window.setTimeout(() => form.submit(), submitDelayMs);
        } else {
            form.submit();
        }
    }

    function submitInactiveTimeout() {
        if (submitted) {
            return;
        }
        submitted = true;

        setValue('chosen_card_id', '');
        setValue('chosen_card_position', '');
        setValue('chosen_is_main', '');
        setValue('chosen_x', '');
        setValue('chosen_y', '');
        setValue('chosen_z', '');
        setValue('response_time_ms', responseTimeMs());
        setValue('task_elapsed_ms', taskElapsedMs());
        setValue('points_before', pointsAccumulated);
        setValue('card_points_added', '');
        setValue('multiplier_applied', '');
        setValue('multiplier_y', '');
        setValue('multiplier_z', '');
        setValue('main_bonus_triggered_this_round', 'False');
        setValue('main_bonus_points_added', '');
        setValue('points_after', pointsAccumulated);
        setValue('timed_out_inactive', 'True');
        setValue('timed_out_task_duration', 'False');
        form.submit();
    }

    function submitTaskDurationTimeout() {
        if (submitted) {
            return;
        }
        submitted = true;

        setValue('chosen_card_id', '');
        setValue('chosen_card_position', '');
        setValue('chosen_is_main', '');
        setValue('chosen_x', '');
        setValue('chosen_y', '');
        setValue('chosen_z', '');
        setValue('response_time_ms', responseTimeMs());
        setValue('task_elapsed_ms', taskElapsedMs());
        setValue('points_before', pointsAccumulated);
        setValue('card_points_added', '');
        setValue('multiplier_applied', '');
        setValue('multiplier_y', '');
        setValue('multiplier_z', '');
        setValue('main_bonus_triggered_this_round', 'False');
        setValue('main_bonus_points_added', '');
        setValue('points_after', pointsAccumulated);
        setValue('timed_out_inactive', 'False');
        setValue('timed_out_task_duration', 'True');
        form.submit();
    }

    function resetActivity() {
        lastActivityAt = Date.now();
    }

    function updateInactivityClock() {
        if (showTimeLeft && timeLeftDisplay) {
            timeLeftDisplay.textContent = `Time left: ${formatElapsed(taskTimeLeftMs())}`;
        }
        if (durationExpired()) {
            submitTaskDurationTimeout();
            return;
        }
        const elapsedSeconds = Math.floor((Date.now() - lastActivityAt) / 1000);
        const remaining = Math.max(0, inactivitySeconds - elapsedSeconds);
        if (inactivityDisplay) {
            inactivityDisplay.textContent = `Inactivity limit: ${remaining}s`;
        }
        if (elapsedSeconds >= inactivitySeconds) {
            submitInactiveTimeout();
        }
    }

    document.querySelectorAll('.cs-card').forEach((cardButton) => {
        cardButton.addEventListener('click', () => submitChoice(cardButton));
    });

    ['mousemove', 'keydown', 'touchstart', 'scroll', 'click'].forEach((eventName) => {
        window.addEventListener(eventName, resetActivity, { passive: true });
    });

    showInitialCue();
    updateInactivityClock();
    window.setInterval(updateInactivityClock, 250);
})();
