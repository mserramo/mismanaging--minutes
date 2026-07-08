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
    const showTimeLeft = ['1', 'true', 'yes'].includes(
        String(task.dataset.showElapsedMinutes || '').toLowerCase()
    );
    const inactivityDisplay = document.getElementById('cs-inactivity-display');
    const timeLeftDisplay = document.getElementById('cs-time-left-display');
    const configuredChoiceSubmitDelayMs = Number(task.dataset.clickFeedbackMs || 100);
    const choiceSubmitDelayMs = Number.isFinite(configuredChoiceSubmitDelayMs)
        ? Math.max(0, configuredChoiceSubmitDelayMs)
        : 100;
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

        setValue('chosen_card_id', cardButton.dataset.cardId);
        setValue('chosen_card_position', cardButton.dataset.position);
        setValue('chosen_is_main', cardButton.dataset.isMain === 'True' ? 'True' : 'False');
        setValue('chosen_x', cardButton.dataset.x);
        setValue('chosen_y', cardButton.dataset.y);
        setValue('chosen_z', cardButton.dataset.z);
        setValue('response_time_ms', clickedResponseTimeMs);
        setValue('task_elapsed_ms', clickedTaskElapsedMs);
        setValue('timed_out_inactive', 'False');
        setValue('timed_out_task_duration', 'False');

        document.querySelectorAll('.cs-card').forEach((button) => {
            button.disabled = true;
            button.classList.toggle('cs-card-selected', button === cardButton);
        });
        window.setTimeout(() => form.submit(), choiceSubmitDelayMs);
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

    updateInactivityClock();
    window.setInterval(updateInactivityClock, 250);
})();
