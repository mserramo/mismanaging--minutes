(function (global) {
    "use strict";

    var DEFAULTS = {
        showRound: true,
        showMain: false,
        showMovie: false,
        showPoints: true,
        showClickFeedback: true,
        feedbackMessageMs: 600,
        usePostClickDelay: false,
        postClickDelayMs: 0,
        screenMotionMs: 600,
        inactivitySeconds: 120
    };
    var DECISION_COLUMNS = [
        "round", "phase", "sequence_id", "seed", "chosen_task_id",
        "chosen_task_label", "chosen_position", "chosen_is_main",
        "chosen_is_movie", "chosen_is_side", "displayed_choice_set_json",
        "task_state_before_json", "task_state_after_json", "side_points_added",
        "side_points_total", "main_count", "movie_count", "main_complete",
        "movie_complete", "main_bonus_awarded", "movie_bonus_awarded",
        "total_points", "response_time_ms", "task_elapsed_ms",
        "infinite_run_id", "infinite_rounds_remaining"
    ];
    var TASK_LABELS = {
        main: "Main task", movie: "Movie task", trio_a: "Trio A",
        trio_b: "Trio B", fives: "Fives", cumulative_a: "Cumulative A",
        cumulative_b: "Cumulative B", infinite_scroll: "Infinite scroll",
        simple_a: "Simple A", simple_b: "Simple B"
    };
    var TASK_TYPE_KEYS = {
        main: "M", movie: "MV", trio_a: "T", trio_b: "T", fives: "F",
        cumulative_a: "C", cumulative_b: "C", infinite_scroll: "IS",
        simple_a: "S", simple_b: "S"
    };
    var SIDE_IDS = [
        "trio_a", "trio_b", "fives", "cumulative_a", "cumulative_b",
        "infinite_scroll", "simple_a", "simple_b"
    ];
    var localEmbeddedData = {};
    var activeController = null;
    var lastResult = null;
    var OWNER_STORAGE_KEY = "csq-predrawn-active-instance-v2";
    var OWNER_TOP_KEY = "__CSQ_PREDRAWN_ACTIVE_INSTANCE_V2__";

    function own(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function numberValue(value, fallback) {
        var parsed = Number(value);
        return typeof parsed === "number" && isFinite(parsed) ? parsed : fallback;
    }

    function integerValue(value, fallback) {
        return Math.floor(numberValue(value, fallback));
    }

    function parseBoolean(value, fallback) {
        var normalized;
        if (typeof value === "boolean") { return value; }
        if (value === null || typeof value === "undefined" || value === "") { return fallback; }
        normalized = String(value).toLowerCase();
        if (["1", "true", "yes"].indexOf(normalized) >= 0) { return true; }
        if (["0", "false", "no"].indexOf(normalized) >= 0) { return false; }
        return fallback;
    }

    function engine() {
        return global.Qualtrics && global.Qualtrics.SurveyEngine ? global.Qualtrics.SurveyEngine : null;
    }

    function getEmbeddedData(name) {
        var value;
        if (own(localEmbeddedData, name)) { return localEmbeddedData[name]; }
        try {
            value = engine() && engine().getEmbeddedData(name);
            return value === null || typeof value === "undefined" ? "" : value;
        } catch (error) { return ""; }
    }

    function directEmbeddedData(name) {
        var value;
        try {
            value = engine() && engine().getEmbeddedData(name);
            return value === null || typeof value === "undefined" ? "" : String(value);
        } catch (error) { return ""; }
    }

    function setEmbeddedData(name, value) {
        var stored = value === null || typeof value === "undefined" ? "" : String(value);
        localEmbeddedData[name] = stored;
        try { if (engine()) { engine().setEmbeddedData(name, stored); } } catch (error) { /* local fallback */ }
    }

    function element(tag, className, text) {
        var node = global.document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== null && typeof text !== "undefined") { node.textContent = String(text); }
        return node;
    }

    function appendText(parent, tag, text, className) {
        var node = element(tag, className || "", text);
        parent.appendChild(node);
        return node;
    }

    function clearElement(node) {
        while (node && node.firstChild) { node.removeChild(node.firstChild); }
    }

    function getRoot(id, question) {
        var container;
        var root;
        if (question && typeof question.getQuestionContainer === "function") {
            container = question.getQuestionContainer();
            if (container && container.querySelector) { root = container.querySelector("#" + id); }
        }
        return root || (global.document && global.document.getElementById(id));
    }

    function isLikelyVisible(root) {
        var rect;
        var style;
        var view;
        var frame;
        if (!root || !root.getBoundingClientRect) { return false; }
        try {
            view = root.ownerDocument.defaultView;
            style = view.getComputedStyle(root);
            rect = root.getBoundingClientRect();
            if (style.display === "none" || style.visibility === "hidden" ||
                    Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) {
                return false;
            }
            frame = view.frameElement;
            if (frame) {
                style = frame.ownerDocument.defaultView.getComputedStyle(frame);
                rect = frame.getBoundingClientRect();
                if (style.display === "none" || style.visibility === "hidden" ||
                        Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
            }
            return true;
        } catch (error) { return false; }
    }

    function hideNextButton(question) {
        try { if (question && question.hideNextButton) { question.hideNextButton(); return; } } catch (error) { /* fallback */ }
        var button = global.document && global.document.getElementById("NextButton");
        if (button) { button.style.display = "none"; }
    }

    function showNextButton(question) {
        try { if (question && question.showNextButton) { question.showNextButton(); return; } } catch (error) { /* fallback */ }
        var button = global.document && global.document.getElementById("NextButton");
        if (button) { button.style.display = ""; }
    }

    function clickNextButton(question) {
        try { if (question && question.clickNextButton) { question.clickNextButton(); return; } } catch (error) { /* fallback */ }
        var button = global.document && global.document.getElementById("NextButton");
        if (button) { button.click(); }
    }

    function setFinishButtonLabel(question) {
        var button = global.document && global.document.getElementById("NextButton");
        try { if (question && question.setNextButtonText) { question.setNextButtonText("Finish"); } } catch (error) { /* DOM fallback */ }
        if (button) { button.textContent = "Finish"; button.setAttribute("aria-label", "Finish"); }
    }

    function activateController(question, controller) {
        cleanup();
        activeController = controller;
        if (question && question.addOnUnload) {
            question.addOnUnload(function () { if (activeController === controller) { cleanup(); } });
        }
    }

    function cleanup() {
        if (activeController && activeController.cleanup) { activeController.cleanup(); }
        activeController = null;
    }

    function readBootstrap(requireSequences) {
        var source = global.CSQ_BOOTSTRAP || {};
        var bank = source.bank || source.bankMetadata || {};
        var bankChunkCount = 0;
        var bankError = "";
        var body = "";
        var index;
        var needsSequences = requireSequences !== false;
        if (needsSequences && (!Array.isArray(bank.sequences) || !bank.sequences.length)) {
            bankChunkCount = Math.max(0, integerValue(getEmbeddedData("cs_bank_chunk_count"), 0));
            if (getEmbeddedData("cs_bank_format_version") !== "json-v1") {
                bankError = "Certified environment bank chunks are missing or unsupported.";
            } else if (!bankChunkCount) {
                bankError = "Certified environment bank chunks are empty.";
            } else {
                for (index = 1; index <= bankChunkCount; index += 1) {
                    body += getEmbeddedData("cs_bank_chunk_" + String(index).padStart(3, "0"));
                }
                try { bank = JSON.parse(body); }
                catch (error) { bankError = "Certified environment bank chunks could not be decoded."; }
            }
        }
        return {
            bank: bank,
            bankError: bankError,
            bankChunkCount: bankChunkCount,
            chunkCount: Math.max(1, integerValue(source.chunkCount, 64)),
            chunkMaxBytes: Math.max(1, integerValue(source.chunkMaxBytes, 18000))
        };
    }

    function validateBootstrap(bootstrap, requireSequences) {
        var bank = bootstrap.bank;
        if (bootstrap.bankError) { return bootstrap.bankError; }
        if (!bank || bank.format_version !== "certified-bank-v1") { return "Certified environment bank is missing or unsupported."; }
        if (!bank.profile) { return "Certified environment bank is incomplete."; }
        if (requireSequences !== false && (!Array.isArray(bank.sequences) || !bank.sequences.length)) { return "Certified environment bank is incomplete."; }
        if (!bank.certificate || bank.certificate.validation_status !== "certified") { return "Environment bank lacks a passing certificate."; }
        if (bootstrap.chunkMaxBytes > 18000) { return "Embedded-data chunks cannot exceed 18,000 UTF-8 bytes."; }
        return "";
    }

    function profileValues(profile) {
        return {
            rounds: integerValue(profile.rounds, 100),
            movieRounds: integerValue(profile.movie_rounds, 20),
            mainTarget: integerValue(profile.main_target, 60),
            sideBudget: integerValue(profile.side_budget, 20),
            sideCardsPerRound: integerValue(profile.side_cards_per_round, 4),
            mainBonus: integerValue(profile.main_bonus, 0),
            movieBonus: integerValue(profile.movie_bonus, 0),
            completionMargin: integerValue(profile.completion_margin, 10)
        };
    }

    function readConfig(bank) {
        var profile = profileValues(bank.profile);
        return {
            profile: profile,
            showRound: parseBoolean(getEmbeddedData("cs_show_round"), DEFAULTS.showRound),
            showMain: parseBoolean(getEmbeddedData("cs_show_main_cards"), DEFAULTS.showMain),
            showMovie: parseBoolean(getEmbeddedData("cs_show_movie_cards"), DEFAULTS.showMovie),
            showPoints: parseBoolean(getEmbeddedData("cs_show_total_points"), DEFAULTS.showPoints),
            showClickFeedback: parseBoolean(getEmbeddedData("cs_show_click_feedback"), DEFAULTS.showClickFeedback),
            feedbackMessageMs: numberValue(getEmbeddedData("cs_feedback_message_ms"), DEFAULTS.feedbackMessageMs),
            usePostClickDelay: parseBoolean(getEmbeddedData("cs_use_post_click_delay"), DEFAULTS.usePostClickDelay),
            postClickDelayMs: numberValue(getEmbeddedData("cs_post_click_delay_ms"), DEFAULTS.postClickDelayMs),
            screenMotionMs: numberValue(getEmbeddedData("cs_screen_motion_ms"), DEFAULTS.screenMotionMs),
            inactivitySeconds: numberValue(getEmbeddedData("cs_inactivity_seconds"), DEFAULTS.inactivitySeconds)
        };
    }

    function validateConfig(config) {
        var errors = [];
        if ([1, 2, 3, 4].indexOf(config.profile.sideCardsPerRound) < 0) { errors.push("The certified side-card count must be an integer from 1 through 4."); }
        if (config.feedbackMessageMs < 0 || config.feedbackMessageMs > 5000) { errors.push("Feedback duration must be 0–5,000 ms."); }
        if (config.postClickDelayMs < 0 || config.postClickDelayMs > 5000) { errors.push("Post-click delay must be 0–5,000 ms."); }
        if (config.screenMotionMs < 0 || config.screenMotionMs > 5000) { errors.push("Screen motion must be 0–5,000 ms."); }
        if (config.inactivitySeconds <= 0 || config.inactivitySeconds > 3600) { errors.push("Inactivity cutoff must be greater than 0 and no more than 3,600 seconds."); }
        return errors;
    }

    function persistConfig(config) {
        var pairs = {
            cs_show_round: config.showRound, cs_show_main_cards: config.showMain,
            cs_show_movie_cards: config.showMovie, cs_show_total_points: config.showPoints,
            cs_show_click_feedback: config.showClickFeedback,
            cs_feedback_message_ms: config.feedbackMessageMs,
            cs_use_post_click_delay: config.usePostClickDelay,
            cs_post_click_delay_ms: config.postClickDelayMs,
            cs_screen_motion_ms: config.screenMotionMs,
            cs_inactivity_seconds: config.inactivitySeconds
        };
        Object.keys(pairs).forEach(function (key) { setEmbeddedData(key, typeof pairs[key] === "boolean" ? (pairs[key] ? "1" : "0") : pairs[key]); });
    }

    function setupSection(parent, title) {
        var section = element("section", "cs-setup-section");
        appendText(section, "h5", title);
        parent.appendChild(section);
        return section;
    }

    function readonlyField(parent, label, value) {
        var wrap = element("div", "csq-field");
        var input = element("input", "csq-input cs-setup-readonly");
        appendText(wrap, "label", label, "csq-label");
        input.type = "text"; input.value = value; input.disabled = true;
        wrap.appendChild(input); parent.appendChild(wrap);
    }

    function numberField(parent, label, value, min, max) {
        var wrap = element("div", "csq-field");
        var input = element("input", "csq-input");
        appendText(wrap, "label", label, "csq-label");
        input.type = "number"; input.value = value; input.min = min; input.max = max;
        wrap.appendChild(input); parent.appendChild(wrap);
        return input;
    }

    function checkboxField(parent, label, checked) {
        var wrap = element("div", "csq-checkbox-field");
        var labelNode = element("label", "csq-checkbox-label");
        var input = element("input", "csq-checkbox");
        input.type = "checkbox"; input.checked = checked;
        labelNode.appendChild(input); labelNode.appendChild(element("span", "csq-checkbox-box"));
        labelNode.appendChild(element("span", "", label)); wrap.appendChild(labelNode); parent.appendChild(wrap);
        return input;
    }

    function initSetup(question) {
        var root = getRoot("csq-setup-root", question);
        var bootstrap = readBootstrap(false);
        var error = validateBootstrap(bootstrap, false);
        var bank = bootstrap.bank;
        var config;
        var economic;
        var display;
        var timing;
        var inputs = {};
        var errorsBox;
        var button;
        if (!root) { return null; }
        try { global.sessionStorage.removeItem(OWNER_STORAGE_KEY); } catch (storageError) { /* unavailable */ }
        try { if (global.top) { global.top[OWNER_TOP_KEY] = null; } } catch (frameError) { /* cross-origin */ }
        setEmbeddedData("cs_game_owner_token", "");
        setEmbeddedData("cs_game_owner_claim_source", "");
        clearElement(root); hideNextButton(question);
        root.className = "cs-setup";
        appendText(root, "h2", "Development-only configuration");
        appendText(root, "p", "Certified economic parameters are read-only. Only presentation and timing controls can be changed here.", "cs-setup-note");
        if (error) { appendText(root, "div", error, "cs-debug-notice"); return null; }
        config = readConfig(bank);
        economic = setupSection(root, "Certified economic environment");
        readonlyField(economic, "Profile version", bank.profile.profile_version);
        readonlyField(economic, "Rounds (R₀)", config.profile.rounds);
        readonlyField(economic, "Movie rounds (Rᴍ)", config.profile.movieRounds);
        readonlyField(economic, "Main target share (q)", bank.profile.main_target_share);
        readonlyField(economic, "Main choices required (Q)", config.profile.mainTarget);
        readonlyField(economic, "Available pre-movie side choices (S)", config.profile.sideBudget);
        readonlyField(economic, "Side cards shown each round", config.profile.sideCardsPerRound);
        readonlyField(economic, "Per-Cumulative-task pre-movie appearance cap", bank.profile.ordinary_cumulative_appearance_cap);
        readonlyField(economic, "Main completion bonus (B)", config.profile.mainBonus);
        readonlyField(economic, "Movie completion bonus (M)", config.profile.movieBonus);
        readonlyField(economic, "Certification margin (δ)", config.profile.completionMargin);
        readonlyField(economic, "Certified sequences", bank.certificate.sequence_count);
        readonlyField(economic, "Required B minimum", bank.certificate.required_B_min);
        readonlyField(economic, "Required M minimum", bank.certificate.required_M_min);
        readonlyField(economic, "Required B+M minimum", bank.certificate.required_B_plus_M_min);
        readonlyField(economic, "Bank hash", bank.certificate.bank_hash);
        readonlyField(economic, "Detailed CSV SHA-256", bank.certificate.validated_sequences_sha256);
        readonlyField(economic, "Summary CSV SHA-256", bank.certificate.validated_sequence_summary_sha256);
        display = setupSection(root, "Participant counters and feedback");
        inputs.showRound = checkboxField(display, "Show round counter?", config.showRound);
        inputs.showMain = checkboxField(display, "Show main-card counter?", config.showMain);
        inputs.showMovie = checkboxField(display, "Show movie-card counter?", config.showMovie);
        inputs.showPoints = checkboxField(display, "Show points counter?", config.showPoints);
        inputs.showClickFeedback = checkboxField(display, "Show per-click point feedback?", config.showClickFeedback);
        timing = setupSection(root, "Timing");
        inputs.feedbackMessageMs = numberField(timing, "Feedback message duration (ms)", config.feedbackMessageMs, 0, 5000);
        inputs.usePostClickDelay = checkboxField(timing, "Wait before the next round?", config.usePostClickDelay);
        inputs.postClickDelayMs = numberField(timing, "Wait before next round (ms)", config.postClickDelayMs, 0, 5000);
        inputs.screenMotionMs = numberField(timing, "Screen motion duration (ms)", config.screenMotionMs, 0, 5000);
        inputs.inactivitySeconds = numberField(timing, "Inactivity cutoff (seconds)", config.inactivitySeconds, 0.1, 3600);
        errorsBox = element("div", "csq-validation-errors"); root.appendChild(errorsBox);
        button = element("button", "csq-continue-button", "Continue to instructions"); button.type = "button"; root.appendChild(button);
        button.addEventListener("click", function () {
            var next = {
                profile: config.profile,
                showRound: inputs.showRound.checked, showMain: inputs.showMain.checked,
                showMovie: inputs.showMovie.checked, showPoints: inputs.showPoints.checked,
                showClickFeedback: inputs.showClickFeedback.checked,
                feedbackMessageMs: numberValue(inputs.feedbackMessageMs.value, -1),
                usePostClickDelay: inputs.usePostClickDelay.checked,
                postClickDelayMs: numberValue(inputs.postClickDelayMs.value, -1),
                screenMotionMs: numberValue(inputs.screenMotionMs.value, -1),
                inactivitySeconds: numberValue(inputs.inactivitySeconds.value, -1)
            };
            var problems = validateConfig(next);
            clearElement(errorsBox);
            problems.forEach(function (problem) { appendText(errorsBox, "p", problem); });
            if (!problems.length) { persistConfig(next); clickNextButton(question); }
        });
        var controller = { cleanup: function () { root.__csqController = null; } };
        root.__csqController = controller; activateController(question, controller); return controller;
    }

    function decodeBase64(value) {
        var binary = global.atob(value);
        var bytes = new Uint8Array(binary.length);
        var index;
        for (index = 0; index < binary.length; index += 1) { bytes[index] = binary.charCodeAt(index); }
        return bytes;
    }

    function bitCount(value) {
        var count = 0;
        while (value) { count += value & 1; value >>>= 1; }
        return count;
    }

    function decodeEnvironment(bank, sequence) {
        var bytes = decodeBase64(sequence.rounds_b64);
        var colorBytes = decodeBase64(sequence.color_map_b64);
        var taskOrder = bank.task_order;
        var profile = profileValues(bank.profile);
        var rounds = [];
        var colorMap = {};
        var index;
        var offset;
        var mask;
        var simpleCodes;
        var cardCount;
        var codes;
        var cards;
        var movieStart = profile.rounds - profile.movieRounds + 1;
        var simpleValues = { simple_a: [4, 8, 12], simple_b: [2, 10, 16] };
        for (index = 0; index < taskOrder.length; index += 1) {
            colorMap[taskOrder[index]] = index % 2 === 0 ? colorBytes[index / 2] >> 4 : colorBytes[(index - 1) / 2] & 15;
        }
        for (index = 0; index < profile.rounds; index += 1) {
            offset = index * 5; mask = bytes[offset]; simpleCodes = bytes[offset + 1];
            cardCount = 1 + bitCount(mask) + (index + 1 >= movieStart ? 1 : 0);
            codes = [bytes[offset + 2] >> 4, bytes[offset + 2] & 15,
                bytes[offset + 3] >> 4, bytes[offset + 3] & 15,
                bytes[offset + 4] >> 4, bytes[offset + 4] & 15];
            cards = codes.slice(0, cardCount).map(function (code, position) {
                var taskId = taskOrder[code];
                var payoff = null;
                if (taskId === "simple_a") { payoff = simpleValues.simple_a[simpleCodes & 3]; }
                if (taskId === "simple_b") { payoff = simpleValues.simple_b[(simpleCodes >> 2) & 3]; }
                return { taskId: taskId, position: position + 1, simplePayoff: payoff };
            });
            rounds.push({ number: index + 1, phase: index + 1 >= movieStart ? "movie" : "ordinary", cards: cards });
        }
        var runId = 0;
        var runStart = -1;
        rounds.forEach(function (round, roundIndex) {
            var hasInfinite = round.cards.some(function (card) { return card.taskId === "infinite_scroll"; });
            var previousHas = roundIndex > 0 && rounds[roundIndex - 1].cards.some(function (card) { return card.taskId === "infinite_scroll"; });
            if (hasInfinite && !previousHas) { runId += 1; runStart = roundIndex; }
            if (hasInfinite) {
                var end = roundIndex;
                while (end + 1 < rounds.length && rounds[end + 1].cards.some(function (card) { return card.taskId === "infinite_scroll"; })) { end += 1; }
                round.infiniteRunId = runId; round.infiniteRunStart = runStart + 1;
                round.infiniteRunEnd = end + 1; round.infiniteRoundsRemaining = end - roundIndex + 1;
            }
            if (!hasInfinite) { runStart = -1; }
        });
        return { sequenceId: sequence.sequence_id, seed: sequence.seed, rounds: rounds, colorMap: colorMap, benchmark: sequence };
    }

    function uniformSequenceIndex(length) {
        var maximum = 4294967296;
        var limit = Math.floor(maximum / length) * length;
        var draw;
        if (global.crypto && global.crypto.getRandomValues) {
            do { var values = new Uint32Array(1); global.crypto.getRandomValues(values); draw = values[0]; } while (draw >= limit);
            return draw % length;
        }
        return Math.floor(Math.random() * length);
    }

    function selectEnvironment(bank) {
        var stored = integerValue(getEmbeddedData("cs_sequence_id"), 0);
        var index = stored >= 1 && stored <= bank.sequences.length ? stored - 1 : uniformSequenceIndex(bank.sequences.length);
        return decodeEnvironment(bank, bank.sequences[index]);
    }

    function taskLookup(profile) {
        var result = {};
        profile.side_tasks.forEach(function (task) { result[task.id] = task; });
        return result;
    }

    function taskTypeKey(taskId) {
        return TASK_TYPE_KEYS[taskId] || "";
    }

    function addRule(parent, key, label, payoff, appearance) {
        var row = element("div", "csq-rule-row");
        var heading = element("div", "csq-rule-heading");
        appendText(heading, "span", key, "csq-rule-code");
        appendText(heading, "span", label, "csq-rule-label");
        row.appendChild(heading);
        appendText(row, "p", payoff, "csq-rule-payoff");
        appendText(row, "p", appearance, "csq-rule-appearance");
        parent.appendChild(row);
    }

    function formatInteger(value) {
        return String(Math.round(numberValue(value, 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function formatChoiceList(values) {
        var labels = values.map(function (value) { return formatInteger(value); });
        if (labels.length < 2) { return labels.join(""); }
        return labels.slice(0, -1).join(", ") + " or " + labels[labels.length - 1];
    }

    function rulesForProfile(profile, includeMovie) {
        var tasks = taskLookup(profile);
        var trioA = tasks.trio_a;
        var trioB = tasks.trio_b;
        var fives = tasks.fives;
        var cumulativeA = tasks.cumulative_a;
        var cumulativeB = tasks.cumulative_b;
        var infinite = tasks.infinite_scroll;
        var simpleA = tasks.simple_a;
        var simpleB = tasks.simple_b;
        var rules = [
            {
                key: "M", label: "Main",
                payoff: formatInteger(profile.main_bonus) + " points for collecting at least " + profile.main_target + " cards.",
                appearance: "Appears every round."
            },
            {
                key: "T", label: "Trio",
                payoff: "A: " + formatInteger(trioA.group_bonus) + " points for every " + trioA.group_size + " collected cards; B: " + formatInteger(trioB.group_bonus) + " points for every " + trioB.group_size + " collected cards.",
                appearance: "Not necessarily consecutive."
            },
            {
                key: "F", label: "Fives",
                payoff: formatInteger(fives.group_bonus) + " points for every " + fives.group_size + " collected cards.",
                appearance: "Not necessarily consecutive."
            },
            {
                key: "C", label: "Cumulative",
                payoff: "A: " + cumulativeA.marginal_base + ", " + (cumulativeA.marginal_base + cumulativeA.marginal_increment) + ", " + (cumulativeA.marginal_base + 2 * cumulativeA.marginal_increment) + ", … points; B: " + cumulativeB.marginal_base + ", " + (cumulativeB.marginal_base + cumulativeB.marginal_increment) + ", " + (cumulativeB.marginal_base + 2 * cumulativeB.marginal_increment) + ", … points.",
                appearance: "Not necessarily consecutive."
            },
            {
                key: "IS", label: "Infinite scroll",
                payoff: infinite.marginal_base + ", " + (infinite.marginal_base + infinite.marginal_increment) + ", " + (infinite.marginal_base + 2 * infinite.marginal_increment) + ", … points within each run.",
                appearance: "Appears in consecutive runs of " + infinite.run_length_min + "–" + infinite.run_length_max + " rounds."
            },
            {
                key: "S", label: "Simple",
                payoff: "A: " + formatChoiceList(simpleA.outcomes.map(function (item) { return item.points; })) + " points; B: " + formatChoiceList(simpleB.outcomes.map(function (item) { return item.points; })) + " points. Current payoff shown on card.",
                appearance: "Not necessarily consecutive."
            }
        ];
        if (includeMovie) {
            rules.push({
                key: "MV", label: "Movie",
                payoff: formatInteger(profile.movie_bonus) + " points for collecting all " + profile.movie_rounds + " cards.",
                appearance: "Appears in the final " + profile.movie_rounds + " consecutive rounds."
            });
        }
        return rules;
    }

    function renderRulesPanel(parent, profile, includeMovie) {
        clearElement(parent);
        appendText(parent, "h3", "Payoff key");
        rulesForProfile(profile, includeMovie).forEach(function (rule) {
            addRule(parent, rule.key, rule.label, rule.payoff, rule.appearance);
        });
    }

    function initialTaskState() {
        var counts = {}; var contributions = {};
        SIDE_IDS.forEach(function (id) { counts[id] = 0; contributions[id] = 0; });
        return { main: 0, movie: 0, sidePay: 0, counts: counts, runCounts: {}, contributions: contributions, completedBonuses: { trio_a: 0, trio_b: 0, fives: 0 } };
    }

    function cloneState(state) {
        return JSON.parse(JSON.stringify(state));
    }

    function applyChoice(bankProfile, state, round, card) {
        var taskId = card.taskId;
        var tasks = taskLookup(bankProfile);
        var task;
        var before;
        var reward = 0;
        var runKey;
        if (taskId === "main") { state.main += 1; return 0; }
        if (taskId === "movie") { state.movie += 1; return 0; }
        task = tasks[taskId]; before = state.counts[taskId]; state.counts[taskId] += 1;
        if (task.type === "group") {
            if ((before + 1) % task.group_size === 0) { reward = task.group_bonus; state.completedBonuses[taskId] += 1; }
        } else if (task.type === "cumulative") {
            reward = task.marginal_base + task.marginal_increment * before;
        } else if (task.type === "run") {
            runKey = String(round.infiniteRunId); before = state.runCounts[runKey] || 0;
            reward = task.marginal_base + task.marginal_increment * before; state.runCounts[runKey] = before + 1;
        } else { reward = card.simplePayoff; }
        state.sidePay += reward; state.contributions[taskId] += reward; return reward;
    }

    function awardedTotalPoints(profile, taskState) {
        return taskState.sidePay
            + (taskState.main >= profile.mainTarget ? profile.mainBonus : 0)
            + (taskState.movie >= profile.movieRounds ? profile.movieBonus : 0);
    }

    function taskProgressText(bankProfile, state, round, card) {
        var taskId = card.taskId;
        var task = taskLookup(bankProfile)[taskId];
        var count;
        var next;
        if (taskId === "main") { return ""; }
        if (taskId === "movie") { return state.movie + " of " + bankProfile.movie_rounds + " collected"; }
        count = state.counts[taskId];
        if (task.type === "group") {
            next = task.group_size - (count % task.group_size);
            return count + " chosen · " + next + " to next " + task.group_bonus + "-point bonus";
        }
        if (task.type === "cumulative") {
            next = task.marginal_base + task.marginal_increment * count;
            return "+ " + next + " points";
        }
        if (task.type === "run") {
            next = task.marginal_base + task.marginal_increment * (state.runCounts[String(round.infiniteRunId)] || 0);
            return "+ " + next + " points";
        }
        return "+ " + card.simplePayoff + " points";
    }

    function utf8ByteLength(value) {
        if (global.TextEncoder) { return new global.TextEncoder().encode(value).length; }
        return unescape(encodeURIComponent(value)).length;
    }

    function csvValue(value) {
        var text = value === null || typeof value === "undefined" ? "" : String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    function decisionToCsvRow(decision, columns) {
        return columns.map(function (column) { return csvValue(decision[column]); }).join(",") + "\r\n";
    }

    function packRecords(records, maximumChunks, maximumBytes) {
        var chunks = []; var current = ""; var currentBytes = 0; var overflowRows = 0;
        records.forEach(function (record) {
            var bytes = utf8ByteLength(record);
            if (bytes > maximumBytes) { overflowRows += 1; return; }
            if (current && currentBytes + bytes > maximumBytes) { chunks.push(current); current = ""; currentBytes = 0; }
            if (chunks.length >= maximumChunks) { overflowRows += 1; return; }
            current += record; currentBytes += bytes;
        });
        if (current && chunks.length < maximumChunks) { chunks.push(current); }
        return { chunks: chunks, overflow: overflowRows > 0, overflowRows: overflowRows };
    }

    function packDecisionRows(decisions, maximumChunks, maximumBytes) {
        return packRecords(decisions.map(function (decision) { return decisionToCsvRow(decision, DECISION_COLUMNS); }), maximumChunks, maximumBytes);
    }

    function environmentRecord(round) {
        return csvValue(round.number) + "," + csvValue(round.phase) + "," + csvValue(JSON.stringify(round.cards)) + "," + csvValue(round.infiniteRunId || "") + "," + csvValue(round.infiniteRunStart || "") + "," + csvValue(round.infiniteRunEnd || "") + "\r\n";
    }

    function persistChunks(prefix, packed, maximumChunks) {
        var index;
        for (index = 0; index < maximumChunks; index += 1) { setEmbeddedData(prefix + String(index + 1).padStart(3, "0"), packed.chunks[index] || ""); }
    }

    function clearBankChunks(bootstrap) {
        var count = Math.max(
            0,
            integerValue(
                bootstrap.bankChunkCount || getEmbeddedData("cs_bank_chunk_count"),
                0
            )
        );
        var index;
        for (index = 1; index <= count; index += 1) {
            setEmbeddedData("cs_bank_chunk_" + String(index).padStart(3, "0"), "");
        }
        setEmbeddedData("cs_bank_chunks_cleared", count ? 1 : 0);
    }

    function persistFinalData(state, status, bootstrap) {
        var bank = bootstrap.bank;
        var profile = profileValues(bank.profile);
        var packed = packDecisionRows(state.decisions, bootstrap.chunkCount, bootstrap.chunkMaxBytes);
        var environmentPacked = packRecords(state.environment.rounds.map(environmentRecord), bootstrap.chunkCount, bootstrap.chunkMaxBytes);
        var mainComplete = state.task.main >= profile.mainTarget;
        var movieComplete = state.task.movie === profile.movieRounds;
        var mainAward = status === "completed" && mainComplete ? profile.mainBonus : 0;
        var movieAward = status === "completed" && movieComplete ? profile.movieBonus : 0;
        var total = state.task.sidePay + mainAward + movieAward;
        var elapsed = Math.max(0, Date.now() - state.startedAtWall);
        var inactiveElapsed = Math.max(0, Date.now() - state.lastActivityAt);
        var readableColorMap = {};
        Object.keys(state.environment.colorMap).forEach(function (taskId) {
            readableColorMap[taskId] = bank.profile.colors[state.environment.colorMap[taskId]].id;
        });
        var fields = {
            cs_task_status: status, cs_decision_count: state.decisions.length,
            cs_task_elapsed_ms: elapsed, cs_final_points: total,
            cs_side_points: state.task.sidePay, cs_main_cards_collected: state.task.main,
            cs_movie_cards_collected: state.task.movie, cs_main_complete: mainComplete ? 1 : 0,
            cs_movie_complete: movieComplete ? 1 : 0, cs_main_bonus_awarded: mainAward,
            cs_movie_bonus_awarded: movieAward,
            cs_side_task_breakdown: JSON.stringify(state.task.contributions),
            cs_side_task_counts: JSON.stringify(state.task.counts),
            cs_completed_structured_bonuses: JSON.stringify(state.task.completedBonuses),
            cs_activity_event_count: state.activityEventCount,
            cs_last_activity_source: state.lastActivitySource,
            cs_inactivity_elapsed_ms_at_end: inactiveElapsed,
            cs_sequence_id: state.environment.sequenceId, cs_seed: state.environment.seed,
            cs_task_color_map: JSON.stringify(readableColorMap),
            cs_profile_version: bank.profile.profile_version,
            cs_bank_hash: bank.certificate.bank_hash,
            cs_validated_sequences_hash: bank.certificate.validated_sequences_sha256,
            cs_validated_summary_hash: bank.certificate.validated_sequence_summary_sha256,
            cs_benchmark_optimal_payoff: state.environment.benchmark.benchmark_optimal_payoff,
            cs_benchmark_V00: state.environment.benchmark.V00,
            cs_benchmark_V01: state.environment.benchmark.V01,
            cs_benchmark_V10: state.environment.benchmark.V10,
            cs_benchmark_V11: state.environment.benchmark.V11,
            cs_log_columns: DECISION_COLUMNS.join(","), cs_log_chunk_count: packed.chunks.length,
            cs_log_format_version: "csv-v2", cs_log_overflow: packed.overflow ? 1 : 0,
            cs_log_overflow_rows: packed.overflowRows,
            cs_environment_columns: "round,phase,displayed_choice_set_json,infinite_run_id,infinite_run_start,infinite_run_end",
            cs_environment_chunk_count: environmentPacked.chunks.length,
            cs_environment_format_version: "csv-v1", cs_environment_overflow: environmentPacked.overflow ? 1 : 0,
            cs_environment_overflow_rows: environmentPacked.overflowRows
        };
        Object.keys(fields).forEach(function (name) { setEmbeddedData(name, fields[name]); });
        persistChunks("cs_log_chunk_", packed, bootstrap.chunkCount);
        persistChunks("cs_environment_chunk_", environmentPacked, bootstrap.chunkCount);
        lastResult = { status: status, decisions: state.decisions.slice(), fields: fields };
        global.CSQ_LAST_RESULT = lastResult;
        return fields;
    }

    function ownerRecord() {
        var parsed;
        try { parsed = JSON.parse(global.sessionStorage.getItem(OWNER_STORAGE_KEY) || "null"); if (parsed && parsed.token) { return parsed; } } catch (error) { /* unavailable */ }
        try { if (global.top && global.top[OWNER_TOP_KEY]) { return global.top[OWNER_TOP_KEY]; } } catch (error2) { /* cross-origin */ }
        var token = directEmbeddedData("cs_game_owner_token");
        return token ? { token: token, source: directEmbeddedData("cs_game_owner_claim_source") } : null;
    }

    function claimOwner(token, source) {
        var existing = ownerRecord();
        var record;
        if (existing && existing.token !== token) { return false; }
        record = { token: token, source: source, claimedAt: Date.now() };
        try { global.sessionStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(record)); } catch (error) { /* unavailable */ }
        try { if (global.top) { global.top[OWNER_TOP_KEY] = record; } } catch (error2) { /* cross-origin */ }
        setEmbeddedData("cs_game_owner_token", token); setEmbeddedData("cs_game_owner_claim_source", source);
        return true;
    }

    function clearOwner(token) {
        var existing = ownerRecord();
        if (existing && existing.token !== token) { return; }
        try { global.sessionStorage.removeItem(OWNER_STORAGE_KEY); } catch (error) { /* unavailable */ }
        try { if (global.top) { global.top[OWNER_TOP_KEY] = null; } } catch (error2) { /* cross-origin */ }
        setEmbeddedData("cs_game_owner_token", ""); setEmbeddedData("cs_game_owner_claim_source", "");
    }

    function nowMonotonic() {
        return global.performance && global.performance.now ? global.performance.now() : Date.now();
    }

    function initGame(question) {
        var root = getRoot("csq-game-root", question);
        var bootstrap = readBootstrap(); var error = validateBootstrap(bootstrap);
        var bank = bootstrap.bank; var config = error ? null : readConfig(bank);
        var environment = error ? null : selectEnvironment(bank);
        var token = "csq-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
        var timers = []; var listeners = []; var authority = false;
        var state;
        var gameLayout; var shell; var rulesPanel; var statusLeft; var statusRight;
        var inactivityClock; var cue; var cards; var movieRuleVisible = false;
        if (!root) { return null; }
        clearElement(root); hideNextButton(question);
        if (error || validateConfig(config).length) { appendText(root, "div", error || validateConfig(config).join(" "), "cs-debug-notice"); return null; }
        if (global.document && global.document.body) { global.document.body.classList.add("csq-game-active"); }
        gameLayout = element("div", "csq-game-layout");
        shell = element("div", "cs-task"); shell.style.setProperty("--cs-screen-motion-ms", config.screenMotionMs + "ms");
        var status = element("div", "cs-status"); statusLeft = element("div", "cs-status-left"); statusRight = element("div", "cs-status-right");
        status.appendChild(statusLeft); status.appendChild(statusRight); shell.appendChild(status);
        cue = element("div", "cs-cue"); shell.appendChild(cue); cards = element("div", "cs-card-row"); shell.appendChild(cards);
        rulesPanel = element("aside", "csq-rules-panel"); rulesPanel.setAttribute("aria-label", "Card payoff reminder");
        renderRulesPanel(rulesPanel, bank.profile, movieRuleVisible);
        gameLayout.appendChild(shell); gameLayout.appendChild(rulesPanel); root.appendChild(gameLayout);
        state = {
            environment: environment, task: initialTaskState(), roundIndex: 0,
            decisions: [], startedAtWall: Date.now(), roundStartedAt: nowMonotonic(),
            lastActivityAt: Date.now(), activityEventCount: 0, lastActivitySource: "game_start",
            waiting: false, finished: false
        };
        setEmbeddedData("cs_sequence_id", environment.sequenceId);
        setEmbeddedData("cs_seed", environment.seed);
        if (isLikelyVisible(root)) { authority = claimOwner(token, "game_start_visible"); }

        function addListener(target, type, callback, options) {
            if (!target || !target.addEventListener) { return; }
            target.addEventListener(type, callback, options); listeners.push([target, type, callback, options]);
        }

        function markActivity(source) {
            if (state.finished) { return; }
            authority = claimOwner(token, source) || authority;
            if (!authority) { return; }
            state.lastActivityAt = Date.now(); state.activityEventCount += 1; state.lastActivitySource = source;
            refreshInactivityClock();
        }

        function inactivityClockText() {
            var remaining = Math.max(
                0,
                Math.ceil((config.inactivitySeconds * 1000 - (Date.now() - state.lastActivityAt)) / 1000)
            );
            var minutes = Math.floor(remaining / 60);
            var seconds = remaining % 60;
            return "Inactive in " + minutes + ":" + String(seconds).padStart(2, "0");
        }

        function refreshInactivityClock() {
            var remainingSeconds;
            if (!inactivityClock) { return; }
            inactivityClock.textContent = inactivityClockText();
            remainingSeconds = Math.max(
                0,
                Math.ceil((config.inactivitySeconds * 1000 - (Date.now() - state.lastActivityAt)) / 1000)
            );
            inactivityClock.className = "cs-inactivity-clock" + (remainingSeconds <= 10 ? " cs-inactivity-warning" : "");
        }

        function counters() {
            var profile = config.profile;
            clearElement(statusLeft); clearElement(statusRight);
            if (config.showRound) { appendText(statusLeft, "span", "Round " + (Math.min(state.roundIndex + 1, profile.rounds)) + " of " + profile.rounds); }
            if (config.showMain) { appendText(statusLeft, "span", "Main: " + state.task.main + " / " + profile.mainTarget); }
            if (config.showMovie) { appendText(statusLeft, "span", "Movie: " + state.task.movie + " / " + profile.movieRounds); }
            if (config.showPoints) { appendText(statusRight, "span", "Points: " + awardedTotalPoints(profile, state.task)); }
            inactivityClock = appendText(statusRight, "span", "", "cs-inactivity-clock");
            refreshInactivityClock();
        }

        function cardSetForLog(round) {
            return round.cards.map(function (card) {
                return {
                    position: card.position, task_id: card.taskId, task_label: TASK_LABELS[card.taskId],
                    simple_payoff: card.simplePayoff,
                    progress: taskProgressText(bank.profile, state.task, round, card),
                    color_id: bank.profile.colors[environment.colorMap[card.taskId]].id
                };
            });
        }

        function finish(statusName) {
            if (state.finished) { return; }
            if (!authority && !claimOwner(token, "finish")) { return; }
            authority = true; state.finished = true; state.waiting = true;
            timers.forEach(global.clearTimeout); timers = [];
            listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2], item[3]); }); listeners = [];
            persistFinalData(state, statusName, bootstrap); clearBankChunks(bootstrap);
            clearOwner(token); clickNextButton(question);
        }

        function choose(round, card, button) {
            var before; var after; var reward; var decision; var delay; var displayed;
            if (state.finished || state.waiting || state.environment.rounds[state.roundIndex] !== round) { return; }
            markActivity("card_click"); if (!authority) { return; }
            state.waiting = true; before = cloneState(state.task); displayed = cardSetForLog(round);
            reward = applyChoice(bank.profile, state.task, round, card); after = cloneState(state.task);
            Array.prototype.forEach.call(cards.querySelectorAll("button"), function (node) { node.disabled = true; });
            button.className += " cs-card-selected";
            if (config.showClickFeedback) {
                cue.textContent = card.taskId === "main" ? "Main task selected" : card.taskId === "movie" ? "Movie task selected" : "+" + reward + " points";
                cue.className = "cs-cue cs-cue-visible " + (reward ? "cs-cue-points" : "");
            }
            decision = {
                round: round.number, phase: round.phase, sequence_id: environment.sequenceId,
                seed: environment.seed, chosen_task_id: card.taskId,
                chosen_task_label: TASK_LABELS[card.taskId], chosen_position: card.position,
                chosen_is_main: card.taskId === "main" ? 1 : 0,
                chosen_is_movie: card.taskId === "movie" ? 1 : 0,
                chosen_is_side: SIDE_IDS.indexOf(card.taskId) >= 0 ? 1 : 0,
                displayed_choice_set_json: JSON.stringify(displayed),
                task_state_before_json: JSON.stringify(before), task_state_after_json: JSON.stringify(after),
                side_points_added: reward, side_points_total: state.task.sidePay,
                main_count: state.task.main, movie_count: state.task.movie,
                main_complete: state.task.main >= config.profile.mainTarget ? 1 : 0,
                movie_complete: state.task.movie >= config.profile.movieRounds ? 1 : 0,
                main_bonus_awarded: state.task.main >= config.profile.mainTarget ? config.profile.mainBonus : 0,
                movie_bonus_awarded: state.task.movie >= config.profile.movieRounds ? config.profile.movieBonus : 0,
                total_points: awardedTotalPoints(config.profile, state.task),
                response_time_ms: Math.max(0, Math.round(nowMonotonic() - state.roundStartedAt)),
                task_elapsed_ms: Math.max(0, Date.now() - state.startedAtWall),
                infinite_run_id: round.infiniteRunId || "",
                infinite_rounds_remaining: round.infiniteRoundsRemaining || ""
            };
            state.decisions.push(decision); counters(); state.roundIndex += 1;
            if (state.roundIndex >= config.profile.rounds) {
                delay = config.showClickFeedback ? config.feedbackMessageMs : 0;
                timers.push(global.setTimeout(function () { finish("completed"); }, delay)); return;
            }
            delay = Math.max(config.showClickFeedback ? config.feedbackMessageMs : 0, config.usePostClickDelay ? config.postClickDelayMs : 0);
            timers.push(global.setTimeout(function () { state.waiting = false; renderRound(); }, delay));
        }

        function renderRound() {
            var round = environment.rounds[state.roundIndex];
            var showMovieRule = round.cards.some(function (card) { return card.taskId === "movie"; });
            clearElement(cards); clearElement(cue); cue.className = "cs-cue"; counters();
            if (showMovieRule !== movieRuleVisible) {
                movieRuleVisible = showMovieRule;
                renderRulesPanel(rulesPanel, bank.profile, movieRuleVisible);
            }
            cards.className = "cs-card-row cs-card-row-new";
            shell.setAttribute("data-card-count", round.cards.length);
            state.roundStartedAt = nowMonotonic();
            round.cards.forEach(function (card) {
                var color = bank.profile.colors[environment.colorMap[card.taskId]];
                var progress = taskProgressText(bank.profile, state.task, round, card);
                var heading;
                var button = element("button", "cs-card"); button.type = "button";
                button.setAttribute("data-task-id", card.taskId);
                button.setAttribute("data-position", card.position);
                button.setAttribute("data-round", round.number);
                button.setAttribute("data-type-key", taskTypeKey(card.taskId));
                button.setAttribute("aria-label", color.label + " card, " + TASK_LABELS[card.taskId] + (progress ? ". " + progress : ""));
                button.style.setProperty("--card-color", color.hex);
                heading = element("span", "cs-card-heading");
                appendText(heading, "span", color.label, "cs-card-color-label");
                appendText(heading, "span", taskTypeKey(card.taskId), "cs-card-type-key");
                button.appendChild(heading);
                if (progress) { appendText(button, "span", progress, "cs-points"); }
                if (card.taskId === "infinite_scroll" && round.number === round.infiniteRunStart) {
                    appendText(button, "span", "New run: exactly " + (round.infiniteRunEnd - round.infiniteRunStart + 1) + " rounds", "cs-multiplier");
                }
                button.addEventListener("pointerdown", function () { markActivity("card_pointerdown"); });
                button.addEventListener("click", function () { choose(round, card, button); });
                cards.appendChild(button);
            });
        }

        ["pointerdown", "mousedown", "touchstart", "keydown"].forEach(function (type) {
            addListener(root, type, function () { markActivity("root_" + type); }, true);
            addListener(global.document, type, function () { markActivity("document_" + type); }, true);
            addListener(global, type, function () { markActivity("window_" + type); }, true);
        });
        addListener(global, "focus", function () { markActivity("window_focus"); }, true);
        var inactivityTimer = global.setInterval(function () {
            refreshInactivityClock();
            if (!state.finished && authority && Date.now() - state.lastActivityAt >= config.inactivitySeconds * 1000) { finish("inactive"); }
        }, 250);
        timers.push(inactivityTimer);
        renderRound();
        var controller = {
            state: state, finish: finish,
            cleanup: function () {
                timers.forEach(function (timer) { global.clearTimeout(timer); global.clearInterval(timer); }); timers = [];
                listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2], item[3]); }); listeners = [];
                if (!state.finished) { clearOwner(token); }
                if (global.document && global.document.body) { global.document.body.classList.remove("csq-game-active"); }
                root.__csqController = null;
            }
        };
        root.__csqController = controller; activateController(question, controller); return controller;
    }

    function addDefinition(list, term, value) {
        list.appendChild(element("dt", "", term)); list.appendChild(element("dd", "", value === "" ? "—" : value));
    }

    function yesNo(value) { return parseBoolean(value, false) ? "Yes" : "No"; }

    function parseCsvBody(body) {
        var rows = []; var row = []; var field = ""; var quoted = false; var index; var character;
        for (index = 0; index < body.length; index += 1) {
            character = body.charAt(index);
            if (quoted) {
                if (character === '"' && body.charAt(index + 1) === '"') { field += '"'; index += 1; }
                else if (character === '"') { quoted = false; }
                else { field += character; }
            } else if (character === '"') { quoted = true; }
            else if (character === ",") { row.push(field); field = ""; }
            else if (character === "\n") { row.push(field.replace(/\r$/, "")); if (row.length > 1 || row[0] !== "") { rows.push(row); } row = []; field = ""; }
            else { field += character; }
        }
        if (field || row.length) { row.push(field); rows.push(row); }
        return rows;
    }

    function packedDecisionsFromEmbeddedData(bootstrap) {
        var columns = String(getEmbeddedData("cs_log_columns") || "").split(",");
        var count = integerValue(getEmbeddedData("cs_log_chunk_count"), 0); var body = ""; var index;
        for (index = 1; index <= Math.min(count, bootstrap.chunkCount); index += 1) { body += getEmbeddedData("cs_log_chunk_" + String(index).padStart(3, "0")); }
        return parseCsvBody(body).map(function (row) { var object = {}; columns.forEach(function (column, columnIndex) { object[column] = row[columnIndex]; }); return object; });
    }

    function renderDecisionTable(parent, decisions) {
        var wrapper = element("div", "csq-debug-table-wrap"); var table = element("table", "cs-debug-table");
        var head = element("thead"); var headRow = element("tr"); var body = element("tbody");
        DECISION_COLUMNS.forEach(function (column) { headRow.appendChild(element("th", "", column)); }); head.appendChild(headRow); table.appendChild(head);
        decisions.forEach(function (decision) { var row = element("tr"); DECISION_COLUMNS.forEach(function (column) { row.appendChild(element("td", "", decision[column])); }); body.appendChild(row); });
        table.appendChild(body); wrapper.appendChild(table); parent.appendChild(wrapper);
    }

    function initOutcome(question) {
        var root = getRoot("csq-outcome-root", question); var bootstrap = readBootstrap(false);
        var status = String(getEmbeddedData("cs_task_status") || "unknown"); var panel; var list; var details; var decisions;
        if (!root) { return null; }
        clearElement(root); root.className = "cs-debug";
        appendText(root, "h2", status === "inactive" ? "Task ended for inactivity" : "Development debug summary");
        if (status === "inactive") { appendText(root, "p", "The task ended after " + getEmbeddedData("cs_inactivity_seconds") + " consecutive seconds without captured activity.", "cs-debug-notice"); }
        panel = element("div", "cs-debug-panel"); appendText(panel, "h3", "Certified environment and outcome"); list = element("dl");
        [
            ["Task status", status], ["Sequence ID", getEmbeddedData("cs_sequence_id")], ["Seed", getEmbeddedData("cs_seed")],
            ["Profile version", getEmbeddedData("cs_profile_version")], ["Bank hash", getEmbeddedData("cs_bank_hash")],
            ["Task-to-color map", getEmbeddedData("cs_task_color_map")],
            ["Answered rounds", getEmbeddedData("cs_decision_count")], ["Main choices", getEmbeddedData("cs_main_cards_collected")],
            ["Movie choices", getEmbeddedData("cs_movie_cards_collected")], ["Main completed", yesNo(getEmbeddedData("cs_main_complete"))],
            ["Movie completed", yesNo(getEmbeddedData("cs_movie_complete"))], ["Side-task points", getEmbeddedData("cs_side_points")],
            ["Main bonus awarded", getEmbeddedData("cs_main_bonus_awarded")], ["Movie bonus awarded", getEmbeddedData("cs_movie_bonus_awarded")],
            ["Total payoff", getEmbeddedData("cs_final_points")], ["Side-task counts", getEmbeddedData("cs_side_task_counts")],
            ["Side-task contribution breakdown", getEmbeddedData("cs_side_task_breakdown")],
            ["Completed structured bonuses", getEmbeddedData("cs_completed_structured_bonuses")],
            ["Benchmark-optimal payoff", getEmbeddedData("cs_benchmark_optimal_payoff")],
            ["V00 / V01 / V10 / V11", ["cs_benchmark_V00", "cs_benchmark_V01", "cs_benchmark_V10", "cs_benchmark_V11"].map(getEmbeddedData).join(" / ")],
            ["Captured activity events", getEmbeddedData("cs_activity_event_count")], ["Last captured activity", getEmbeddedData("cs_last_activity_source")],
            ["Decision log format", getEmbeddedData("cs_log_format_version")], ["Decision chunks", getEmbeddedData("cs_log_chunk_count")],
            ["Environment chunks", getEmbeddedData("cs_environment_chunk_count")],
            ["Bank transport chunks cleared", yesNo(getEmbeddedData("cs_bank_chunks_cleared"))],
            ["Task elapsed (ms)", getEmbeddedData("cs_task_elapsed_ms")]
        ].forEach(function (item) { addDefinition(list, item[0], item[1]); }); panel.appendChild(list); root.appendChild(panel);
        decisions = lastResult && lastResult.status === status ? lastResult.decisions : packedDecisionsFromEmbeddedData(bootstrap);
        if (decisions.length) { renderDecisionTable(root, decisions); } else { appendText(root, "p", "No decision rows were recorded."); }
        details = element("details", "cs-debug-details"); appendText(details, "summary", "Certificate diagnostics");
        details.appendChild(element("pre", "", JSON.stringify(bootstrap.bank.certificate, null, 2))); root.appendChild(details);
        showNextButton(question); setFinishButtonLabel(question);
        var relabel = global.setTimeout(function () { setFinishButtonLabel(question); }, 100);
        var controller = { cleanup: function () { global.clearTimeout(relabel); root.__csqController = null; } };
        root.__csqController = controller; activateController(question, controller); return controller;
    }

    global.CSQ = {
        initSetup: initSetup, initGame: initGame, initOutcome: initOutcome, cleanup: cleanup,
        __test: {
            defaults: DEFAULTS, decisionColumns: DECISION_COLUMNS.slice(0),
            parseBoolean: parseBoolean, readBootstrap: readBootstrap, validateBootstrap: validateBootstrap,
            profileValues: profileValues, readConfig: readConfig, validateConfig: validateConfig,
            decodeEnvironment: decodeEnvironment, selectEnvironment: selectEnvironment,
            initialTaskState: initialTaskState, applyChoice: applyChoice,
            taskProgressText: taskProgressText, taskTypeKey: taskTypeKey,
            awardedTotalPoints: awardedTotalPoints,
            rulesForProfile: rulesForProfile,
            utf8ByteLength: utf8ByteLength,
            csvValue: csvValue, decisionToCsvRow: decisionToCsvRow,
            packRecords: packRecords, packDecisionRows: packDecisionRows,
            parseCsvBody: parseCsvBody, getEmbeddedData: getEmbeddedData,
            setEmbeddedData: setEmbeddedData, packedDecisionsFromEmbeddedData: packedDecisionsFromEmbeddedData
        }
    };
}(window));
