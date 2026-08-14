(function (global) {
    "use strict";

    var DEFAULTS = {
        treatmentMode: "sequential",
        allAtOnceDefaultZoom: 100,
        allAtOnceMinZoom: 100,
        payoffKeyMode: "overlay",
        showRound: true,
        showMain: false,
        showMovie: false,
        showPoints: true,
        showMainCardPayoff: false,
        showMovieCardPayoff: false,
        showSideCardPayoff: true,
        showClickFeedback: true,
        feedbackMessageMs: 600,
        usePostClickDelay: false,
        postClickDelayMs: 0,
        screenMotionMs: 600,
        inactivitySeconds: 120
    };
    var DECISION_COLUMNS = [
        "round", "phase", "sequence_id", "seed", "chosen_task_id",
        "chosen_task_label", "chosen_position", "generated_position", "chosen_is_main",
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
        cumulative_b: "Cumulative B", infinite_scroll: "Infinite scrolling",
        simple_a: "Simple A", simple_b: "Simple B"
    };
    var SIDE_IDS = [
        "trio_a", "trio_b", "fives", "cumulative_a", "cumulative_b",
        "infinite_scroll", "simple_a", "simple_b"
    ];
    var RULE_GROUP_IDS = ["main", "trio", "fives", "cumulative", "infinite_scroll", "simple", "movie"];
    var LAYOUT_VERSION = "fixed-slots-v1";
    var SHARED_ACCUMULATION_NOTE = "Each color accumulates separately—cards of different colors are never combined. Unless stated otherwise, accumulation may be nonconsecutive.";
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
        var treatmentMode = String(getEmbeddedData("cs_treatment_mode") || DEFAULTS.treatmentMode).toLowerCase();
        return {
            profile: profile,
            treatmentMode: treatmentMode,
            // These legacy fields remain in Survey Flow and exports, but the
            // participant display is now fixed. Normalize stale 75% values
            // from older copies instead of blocking either treatment.
            allAtOnceDefaultZoom: 100,
            allAtOnceMinZoom: 100,
            payoffKeyMode: String(getEmbeddedData("cs_payoff_key_mode") || DEFAULTS.payoffKeyMode).toLowerCase(),
            showRound: parseBoolean(getEmbeddedData("cs_show_round"), DEFAULTS.showRound),
            showMain: parseBoolean(getEmbeddedData("cs_show_main_cards"), DEFAULTS.showMain),
            showMovie: parseBoolean(getEmbeddedData("cs_show_movie_cards"), DEFAULTS.showMovie),
            showPoints: parseBoolean(getEmbeddedData("cs_show_total_points"), DEFAULTS.showPoints),
            showMainCardPayoff: parseBoolean(getEmbeddedData("cs_show_main_card_payoff"), DEFAULTS.showMainCardPayoff),
            showMovieCardPayoff: parseBoolean(getEmbeddedData("cs_show_movie_card_payoff"), DEFAULTS.showMovieCardPayoff),
            showSideCardPayoff: parseBoolean(getEmbeddedData("cs_show_side_card_payoff"), DEFAULTS.showSideCardPayoff),
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
        if (["sequential", "all_at_once"].indexOf(config.treatmentMode) < 0) { errors.push("Treatment must be sequential or all-at-once."); }
        if (["overlay", "below"].indexOf(config.payoffKeyMode) < 0) { errors.push("Payoff key mode must be overlay or below."); }
        if ([1, 2, 3, 4].indexOf(config.profile.sideCardsPerRound) < 0) { errors.push("The certified side-card count must be an integer from 1 through 4."); }
        if (config.feedbackMessageMs < 0 || config.feedbackMessageMs > 5000) { errors.push("Feedback duration must be 0–5,000 ms."); }
        if (config.postClickDelayMs < 0 || config.postClickDelayMs > 5000) { errors.push("Post-click delay must be 0–5,000 ms."); }
        if (config.screenMotionMs < 0 || config.screenMotionMs > 5000) { errors.push("Screen motion must be 0–5,000 ms."); }
        if (config.inactivitySeconds <= 0 || config.inactivitySeconds > 3600) { errors.push("Inactivity cutoff must be greater than 0 and no more than 3,600 seconds."); }
        return errors;
    }

    function persistConfig(config) {
        var pairs = {
            cs_treatment_mode: config.treatmentMode,
            cs_all_at_once_default_zoom: config.allAtOnceDefaultZoom,
            cs_all_at_once_min_zoom: config.allAtOnceMinZoom,
            cs_payoff_key_mode: config.payoffKeyMode,
            cs_show_round: config.showRound, cs_show_main_cards: config.showMain,
            cs_show_movie_cards: config.showMovie, cs_show_total_points: config.showPoints,
            cs_show_main_card_payoff: config.showMainCardPayoff,
            cs_show_movie_card_payoff: config.showMovieCardPayoff,
            cs_show_side_card_payoff: config.showSideCardPayoff,
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

    function selectField(parent, label, value, options) {
        var wrap = element("div", "csq-field");
        var input = element("select", "csq-input");
        appendText(wrap, "label", label, "csq-label");
        options.forEach(function (option) {
            var node = element("option", "", option.label);
            node.value = option.value;
            if (option.value === value) { node.selected = true; }
            input.appendChild(node);
        });
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
        var treatment;
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
        treatment = setupSection(root, "Treatment");
        inputs.treatmentMode = selectField(treatment, "Choice presentation", config.treatmentMode, [
            { value: "sequential", label: "Sequential" },
            { value: "all_at_once", label: "All at once" }
        ]);
        readonlyField(treatment, "All-at-once display scale", "100% (fixed)");
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
        inputs.showMainCardPayoff = checkboxField(display, "Show main-card +0/+B pts. text?", config.showMainCardPayoff);
        inputs.showMovieCardPayoff = checkboxField(display, "Show movie-card +0/+M pts. text?", config.showMovieCardPayoff);
        inputs.showSideCardPayoff = checkboxField(display, "Show non-Simple side-card +0/+X pts. text?", config.showSideCardPayoff);
        inputs.showClickFeedback = checkboxField(display, "Show per-click point feedback?", config.showClickFeedback);
        inputs.payoffKeyMode = selectField(display, "Payoff key placement", config.payoffKeyMode, [
            { value: "overlay", label: "Open from toolbar button" },
            { value: "below", label: "Always visible below game" }
        ]);
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
                treatmentMode: inputs.treatmentMode.value,
                allAtOnceDefaultZoom: config.allAtOnceDefaultZoom,
                allAtOnceMinZoom: config.allAtOnceMinZoom,
                payoffKeyMode: inputs.payoffKeyMode.value,
                showRound: inputs.showRound.checked, showMain: inputs.showMain.checked,
                showMovie: inputs.showMovie.checked, showPoints: inputs.showPoints.checked,
                showMainCardPayoff: inputs.showMainCardPayoff.checked,
                showMovieCardPayoff: inputs.showMovieCardPayoff.checked,
                showSideCardPayoff: inputs.showSideCardPayoff.checked,
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

    function initInstructions(question) {
        var root = getRoot("csq-instructions-root", question);
        var bootstrap = readBootstrap(false);
        var error = validateBootstrap(bootstrap, false);
        var bank = bootstrap.bank;
        var config = error ? null : readConfig(bank);
        var profile;
        var list;
        if (!root) { return null; }
        clearElement(root); root.className = "cs-shell"; showNextButton(question);
        if (error || validateConfig(config).length) {
            appendText(root, "div", error || validateConfig(config).join(" "), "cs-debug-notice");
            return null;
        }
        profile = bank.profile;
        appendText(root, "h2", "Card-choice task");
        if (config.treatmentMode === "all_at_once") {
            appendText(root, "p", "All " + profile.rounds + " choice sets will appear together in one scrollable list. Choose one card in every round. You may revisit any round and change its choice until you select Done.");
            appendText(root, "p", "The fixed status bar remains visible while you scroll and shows which rounds are in view, how many are answered, and your current payoff. Done appears below round " + profile.rounds + " and becomes available after all rounds are answered.");
        } else {
            appendText(root, "p", "You will make exactly " + profile.rounds + " choices, one round at a time. Each choice is final before the next round appears.");
            appendText(root, "p", "The fixed status bar remains visible and shows the current round, your current payoff, and the inactivity countdown.");
        }
        appendText(root, "p", config.payoffKeyMode === "overlay" ? "Use the Payoff key button in the fixed status bar whenever you want to review the task rules." : "The payoff key remains visible below the game.");
        appendText(root, "p", "Every round keeps every task in one permanent position. The main card and exactly " + profile.side_cards_per_round + " side-task cards are active; unavailable tasks are shown in gray and cannot be selected. The movie card becomes active for the final " + profile.movie_rounds + " rounds.");
        appendText(root, "p", "Choosing the main card at least " + profile.main_target + " times earns " + formatInteger(profile.main_bonus) + " pts. Choosing all " + profile.movie_rounds + " movie cards earns " + formatInteger(profile.movie_bonus) + " pts. Each bonus is received only if its requirement is met.");
        appendText(root, "h3", "Side-task rules");
        list = element("ul");
        [
            ["Trio A", "30 pts. for every completed group of 3 choices."],
            ["Trio B", "36 pts. for every completed group of 3 choices."],
            ["Fives", "60 pts. for every completed group of 5 choices."],
            ["Cumulative A", "successive choices pay 2, 4, 6, 8, … pts."],
            ["Cumulative B", "successive choices pay 1, 4, 7, 10, … pts."],
            ["Infinite Scrolling", "within each availability run, uninterrupted choices pay 2, 6, 10, 14, … pts. Choosing another card breaks the streak, so the next Infinite Scrolling choice restarts at 2 pts."],
            ["Simple A", "the displayed card pays 4, 8, or 12 pts., with probabilities 30%, 50%, and 20%."],
            ["Simple B", "the displayed card pays 2, 10, or 16 pts., with probabilities 45%, 40%, and 15%."]
        ].forEach(function (item) {
            var row = element("li");
            var strong = element("strong", "", item[0] + ": ");
            row.appendChild(strong); row.appendChild(global.document.createTextNode(item[1])); list.appendChild(row);
        });
        root.appendChild(list);
        appendText(root, "p", "Each task has one fixed color for you. Progress shown on a card is evaluated in round order. Please stay active: the visible inactivity clock resets when activity is captured and the task ends at zero.");
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
                return {
                    taskId: taskId,
                    position: position + 1,
                    generatedPosition: position + 1,
                    simplePayoff: payoff
                };
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
        return {
            sequenceId: sequence.sequence_id,
            seed: sequence.seed,
            rounds: rounds,
            colorMap: colorMap,
            slotOrder: slotOrderForSeed(sequence.seed),
            benchmark: sequence
        };
    }

    function slotOrderForSeed(seed) {
        var shuffled = SIDE_IDS.slice(0);
        var state = (integerValue(seed, 0) >>> 0) ^ 2654435769;
        var index;
        var swapIndex;
        var temporary;
        function nextUint32() {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return state >>> 0;
        }
        if (!state) { state = 1831565813; }
        for (index = shuffled.length - 1; index > 0; index -= 1) {
            swapIndex = nextUint32() % (index + 1);
            temporary = shuffled[index]; shuffled[index] = shuffled[swapIndex]; shuffled[swapIndex] = temporary;
        }
        return shuffled.concat(["main", "movie"]);
    }

    function fixedSlotsForRound(environment, round) {
        return environment.slotOrder.map(function (taskId, index) {
            var generated = round.cards.find(function (card) { return card.taskId === taskId; });
            return {
                taskId: taskId,
                position: index + 1,
                slotPosition: index + 1,
                generatedPosition: generated ? generated.generatedPosition || generated.position : null,
                simplePayoff: generated ? generated.simplePayoff : null,
                active: !!generated
            };
        });
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

    function addRuleGroup(parent, group) {
        var row = element("div", "csq-rule-row");
        var heading = element("div", "csq-rule-heading");
        group.members.forEach(function (member, index) {
            var mapping = element("span", "csq-rule-mapping");
            mapping.style.setProperty("--rule-color", member.color.hex);
            appendText(mapping, "span", member.color.label, "csq-rule-color");
            appendText(mapping, "span", member.label, "csq-rule-task-badge");
            heading.appendChild(mapping);
            if (index < group.members.length - 1) { appendText(heading, "span", "·", "csq-rule-separator"); }
        });
        row.appendChild(heading);
        appendText(row, "p", group.description, "csq-rule-payoff");
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

    function pointsWithSign(value) {
        return "+" + formatInteger(value) + " pts.";
    }

    function payoffSeries(base, increment) {
        return "+" + formatInteger(base) + ", +" + formatInteger(base + increment) + ", +" + formatInteger(base + 2 * increment) + ", …";
    }

    function signedChoiceList(values) {
        return "+" + formatChoiceList(values).replace(/, /g, ", +").replace(/ or /g, " or +");
    }

    function ruleMember(profile, environment, taskId) {
        return {
            taskId: taskId,
            label: TASK_LABELS[taskId],
            color: profile.colors[environment.colorMap[taskId]]
        };
    }

    function ruleGroupsForEnvironment(profile, environment, includeMovie) {
        var tasks = taskLookup(profile);
        var trioA = tasks.trio_a;
        var trioB = tasks.trio_b;
        var fives = tasks.fives;
        var cumulativeA = tasks.cumulative_a;
        var cumulativeB = tasks.cumulative_b;
        var infinite = tasks.infinite_scroll;
        var simpleA = tasks.simple_a;
        var simpleB = tasks.simple_b;
        var mainMember = ruleMember(profile, environment, "main");
        var trioAMember = ruleMember(profile, environment, "trio_a");
        var trioBMember = ruleMember(profile, environment, "trio_b");
        var fivesMember = ruleMember(profile, environment, "fives");
        var cumulativeAMember = ruleMember(profile, environment, "cumulative_a");
        var cumulativeBMember = ruleMember(profile, environment, "cumulative_b");
        var infiniteMember = ruleMember(profile, environment, "infinite_scroll");
        var simpleAMember = ruleMember(profile, environment, "simple_a");
        var simpleBMember = ruleMember(profile, environment, "simple_b");
        var movieMember = ruleMember(profile, environment, "movie");
        var groups = [
            {
                groupId: "main", members: [mainMember],
                description: "Pays " + pointsWithSign(profile.main_bonus) + " when " + profile.main_target + " " + mainMember.color.label + " cards are accumulated."
            },
            {
                groupId: "trio", members: [trioAMember, trioBMember],
                description: "For every " + trioA.group_size + " cards of the same color accumulated: " + trioAMember.color.label + " pays " + pointsWithSign(trioA.group_bonus) + "; " + trioBMember.color.label + " pays " + pointsWithSign(trioB.group_bonus)
            },
            {
                groupId: "fives", members: [fivesMember],
                description: "For every " + fives.group_size + " cards of the same color accumulated: " + fivesMember.color.label + " pays " + pointsWithSign(fives.group_bonus)
            },
            {
                groupId: "cumulative", members: [cumulativeAMember, cumulativeBMember],
                description: "Each card pays immediately. " + cumulativeAMember.color.label + " starts at " + pointsWithSign(cumulativeA.marginal_base) + " and rises by " + pointsWithSign(cumulativeA.marginal_increment) + " per " + cumulativeAMember.color.label + " card (" + payoffSeries(cumulativeA.marginal_base, cumulativeA.marginal_increment) + "); " + cumulativeBMember.color.label + " starts at " + pointsWithSign(cumulativeB.marginal_base) + " and rises by " + pointsWithSign(cumulativeB.marginal_increment) + " per " + cumulativeBMember.color.label + " card (" + payoffSeries(cumulativeB.marginal_base, cumulativeB.marginal_increment) + ")."
            },
            {
                groupId: "infinite_scroll", members: [infiniteMember],
                description: "Each card pays immediately. " + infiniteMember.color.label + " starts at " + pointsWithSign(infinite.marginal_base) + " and rises by " + pointsWithSign(infinite.marginal_increment) + " for each uninterrupted " + infiniteMember.color.label + " choice within a " + infinite.run_length_min + "–" + infinite.run_length_max + "-round run (" + payoffSeries(infinite.marginal_base, infinite.marginal_increment) + "). Choosing another card breaks the streak; the next " + infiniteMember.color.label + " choice restarts at " + pointsWithSign(infinite.marginal_base)
            },
            {
                groupId: "simple", members: [simpleAMember, simpleBMember],
                description: "Pays the amount shown each time: " + simpleAMember.color.label + " pays " + signedChoiceList(simpleA.outcomes.map(function (item) { return item.points; })) + " pts.; " + simpleBMember.color.label + " pays " + signedChoiceList(simpleB.outcomes.map(function (item) { return item.points; })) + " pts."
            },
            {
                groupId: "movie", members: [movieMember],
                description: "Pays " + pointsWithSign(profile.movie_bonus) + " when all " + profile.movie_rounds + " " + movieMember.color.label + " cards are accumulated; available in rounds " + (profile.rounds - profile.movie_rounds + 1) + "–" + profile.rounds + "."
            }
        ];
        return groups.filter(function (group) { return includeMovie || group.groupId !== "movie"; }).sort(function (left, right) {
            return ruleOrderValue(environment.seed, left.groupId) - ruleOrderValue(environment.seed, right.groupId)
                || RULE_GROUP_IDS.indexOf(left.groupId) - RULE_GROUP_IDS.indexOf(right.groupId);
        });
    }

    function ruleOrderValue(seed, groupId) {
        var hash = (integerValue(seed, 0) >>> 0) ^ 2166136261;
        var index;
        for (index = 0; index < groupId.length; index += 1) {
            hash ^= groupId.charCodeAt(index);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash;
    }

    function renderRulesPanel(parent, profile, environment, includeMovie) {
        clearElement(parent);
        appendText(parent, "h3", "Payoff key");
        appendText(parent, "p", SHARED_ACCUMULATION_NOTE, "csq-rule-note");
        ruleGroupsForEnvironment(profile, environment, includeMovie).forEach(function (group) { addRuleGroup(parent, group); });
    }

    function createPayoffKeyPresentation(root, profile, environment, mode) {
        var panel = element("aside", "csq-rules-panel");
        var overlay = null;
        var dialog = null;
        var closeButton = null;
        var heading;
        panel.setAttribute("aria-label", "Card payoff reminder");
        panel.setAttribute("data-csq-payoff-key", "");
        renderRulesPanel(panel, profile, environment, true);
        if (mode === "overlay") {
            overlay = element("div", "csq-rules-overlay");
            dialog = element("div", "csq-rules-dialog");
            closeButton = element("button", "csq-rules-close", "Close");
            closeButton.type = "button";
            closeButton.setAttribute("aria-label", "Close payoff key");
            heading = panel.querySelector("h3");
            if (heading) { heading.id = "csq-payoff-key-title"; }
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-labelledby", "csq-payoff-key-title");
            dialog.appendChild(closeButton); dialog.appendChild(panel); overlay.appendChild(dialog);
            overlay.hidden = true; overlay.setAttribute("aria-hidden", "true"); root.appendChild(overlay);
        }
        return { mode: mode, panel: panel, overlay: overlay, dialog: dialog, closeButton: closeButton, trigger: null };
    }

    function setPayoffKeyOpen(presentation, open) {
        var wasOpen;
        if (!presentation || presentation.mode !== "overlay" || !presentation.overlay) { return; }
        wasOpen = !presentation.overlay.hidden;
        presentation.overlay.hidden = !open;
        presentation.overlay.setAttribute("aria-hidden", open ? "false" : "true");
        if (global.document && global.document.body) {
            global.document.body.classList.toggle("csq-payoff-key-open", open);
        }
        if (open && presentation.closeButton && presentation.closeButton.focus) {
            presentation.closeButton.focus();
        } else if (!open && wasOpen && presentation.trigger && presentation.trigger.focus) {
            presentation.trigger.focus();
        }
    }

    function initialTaskState() {
        var counts = {}; var contributions = {};
        SIDE_IDS.forEach(function (id) { counts[id] = 0; contributions[id] = 0; });
        return { main: 0, movie: 0, sidePay: 0, counts: counts, runStreaks: {}, contributions: contributions, completedBonuses: { trio_a: 0, trio_b: 0, fives: 0 } };
    }

    function cloneState(state) {
        return JSON.parse(JSON.stringify(state));
    }

    function breakInfiniteStreak(bankProfile, state, round, chosenTaskId) {
        var runKey;
        if (!round || round.infiniteRunId === null || typeof round.infiniteRunId === "undefined" || chosenTaskId === "infinite_scroll") { return; }
        runKey = String(round.infiniteRunId);
        state.runStreaks[runKey] = 0;
    }

    function applyChoice(bankProfile, state, round, card) {
        var taskId = card.taskId;
        var tasks = taskLookup(bankProfile);
        var task;
        var before;
        var reward = 0;
        var runKey;
        breakInfiniteStreak(bankProfile, state, round, taskId);
        if (taskId === "main") { state.main += 1; return 0; }
        if (taskId === "movie") { state.movie += 1; return 0; }
        task = tasks[taskId]; before = state.counts[taskId]; state.counts[taskId] += 1;
        if (task.type === "group") {
            if ((before + 1) % task.group_size === 0) { reward = task.group_bonus; state.completedBonuses[taskId] += 1; }
        } else if (task.type === "cumulative") {
            reward = task.marginal_base + task.marginal_increment * before;
        } else if (task.type === "run") {
            if (round.infiniteRunId === null || typeof round.infiniteRunId === "undefined") { throw new Error("Infinite Scrolling card is missing its availability run."); }
            runKey = String(round.infiniteRunId); before = state.runStreaks[runKey] || 0;
            reward = task.marginal_base + task.marginal_increment * before; state.runStreaks[runKey] = before + 1;
        } else { reward = card.simplePayoff; }
        state.sidePay += reward; state.contributions[taskId] += reward; return reward;
    }

    function awardedTotalPoints(profile, taskState) {
        return taskState.sidePay
            + (taskState.main >= profile.mainTarget ? profile.mainBonus : 0)
            + (taskState.movie >= profile.movieRounds ? profile.movieBonus : 0);
    }

    function currentCardPayoff(bankProfile, state, round, card) {
        var taskId = card.taskId;
        var task = taskLookup(bankProfile)[taskId];
        var count;
        if (taskId === "main") {
            return state.main < bankProfile.main_target && state.main + 1 >= bankProfile.main_target ? bankProfile.main_bonus : 0;
        }
        if (taskId === "movie") {
            return state.movie < bankProfile.movie_rounds && state.movie + 1 >= bankProfile.movie_rounds ? bankProfile.movie_bonus : 0;
        }
        count = state.counts[taskId];
        if (task.type === "group") {
            return (count + 1) % task.group_size === 0 ? task.group_bonus : 0;
        }
        if (task.type === "cumulative") {
            return task.marginal_base + task.marginal_increment * count;
        }
        if (task.type === "run") {
            return task.marginal_base + task.marginal_increment * (state.runStreaks[String(round.infiniteRunId)] || 0);
        }
        return card.simplePayoff;
    }

    function cardPayoffText(bankProfile, state, round, card, config) {
        var taskId = card.taskId;
        var task = taskLookup(bankProfile)[taskId];
        var visible = task && task.type === "simple"
            || taskId === "main" && config.showMainCardPayoff
            || taskId === "movie" && config.showMovieCardPayoff
            || SIDE_IDS.indexOf(taskId) >= 0 && (!task || task.type !== "simple") && config.showSideCardPayoff;
        return visible ? "+" + formatInteger(currentCardPayoff(bankProfile, state, round, card)) + " pts." : "";
    }

    function cardsLeftLabel(remaining) {
        return remaining + (remaining === 1 ? " card left" : " cards left");
    }

    function cardFooterLines(bankProfile, state, round, card) {
        var taskId = card.taskId;
        var task = taskLookup(bankProfile)[taskId];
        var count;
        var remaining;
        if (!task) { return []; }
        if (task.type === "group") {
            count = state.counts[taskId];
            remaining = task.group_size - (count % task.group_size);
            return [cardsLeftLabel(remaining), "for +" + formatInteger(task.group_bonus) + " pts."];
        }
        if (task.type === "run") {
            remaining = integerValue(round.infiniteRoundsRemaining, 0);
            return remaining > 0 ? [cardsLeftLabel(remaining), "in this run"] : [];
        }
        return [];
    }

    function cardFooterText(bankProfile, state, round, card) {
        return cardFooterLines(bankProfile, state, round, card).join(" ");
    }

    function cardDisplayText(bankProfile, state, round, card, config) {
        var payoff = cardPayoffText(bankProfile, state, round, card, config);
        var footerLines = cardFooterLines(bankProfile, state, round, card);
        var footer = footerLines.join(" ");
        return { payoff: payoff, footer: footer, footerLines: footerLines, combined: [payoff, footer].filter(Boolean).join(" · ") };
    }

    function taskProgressText(bankProfile, state, round, card, config) {
        config = config || {
            showMainCardPayoff: DEFAULTS.showMainCardPayoff,
            showMovieCardPayoff: DEFAULTS.showMovieCardPayoff,
            showSideCardPayoff: DEFAULTS.showSideCardPayoff
        };
        return cardDisplayText(bankProfile, state, round, card, config).combined;
    }

    function displayedCardSet(bankProfile, environment, state, round, config) {
        return fixedSlotsForRound(environment, round).map(function (card) {
            var display = card.active
                ? cardDisplayText(bankProfile, state, round, card, config)
                : { payoff: "", footer: "", footerLines: [], combined: "" };
            return {
                position: card.slotPosition,
                slot_position: card.slotPosition,
                generated_position: card.generatedPosition,
                active: card.active,
                task_id: card.taskId,
                task_label: TASK_LABELS[card.taskId],
                simple_payoff: card.active ? card.simplePayoff : null,
                marginal_points: card.active ? currentCardPayoff(bankProfile, state, round, card) : null,
                payoff_text: display.payoff,
                footer_text: display.footer,
                footer_lines: display.footerLines,
                progress: display.combined,
                color_id: bankProfile.colors[environment.colorMap[card.taskId]].id
            };
        });
    }

    function decisionRecord(bankProfile, environment, round, card, before, after, reward, displayed, responseTime, taskElapsed) {
        var profile = profileValues(bankProfile);
        return {
            round: round.number,
            phase: round.phase,
            sequence_id: environment.sequenceId,
            seed: environment.seed,
            chosen_task_id: card.taskId,
            chosen_task_label: TASK_LABELS[card.taskId],
            chosen_position: card.slotPosition,
            generated_position: card.generatedPosition,
            chosen_is_main: card.taskId === "main" ? 1 : 0,
            chosen_is_movie: card.taskId === "movie" ? 1 : 0,
            chosen_is_side: SIDE_IDS.indexOf(card.taskId) >= 0 ? 1 : 0,
            displayed_choice_set_json: JSON.stringify(displayed),
            task_state_before_json: JSON.stringify(before),
            task_state_after_json: JSON.stringify(after),
            side_points_added: reward,
            side_points_total: after.sidePay,
            main_count: after.main,
            movie_count: after.movie,
            main_complete: after.main >= profile.mainTarget ? 1 : 0,
            movie_complete: after.movie >= profile.movieRounds ? 1 : 0,
            main_bonus_awarded: after.main >= profile.mainTarget ? profile.mainBonus : 0,
            movie_bonus_awarded: after.movie >= profile.movieRounds ? profile.movieBonus : 0,
            total_points: awardedTotalPoints(profile, after),
            response_time_ms: responseTime === null || typeof responseTime === "undefined" ? "" : responseTime,
            task_elapsed_ms: taskElapsed === null || typeof taskElapsed === "undefined" ? "" : taskElapsed,
            infinite_run_id: round.infiniteRunId || "",
            infinite_rounds_remaining: round.infiniteRoundsRemaining || ""
        };
    }

    function evaluateAllocation(bankProfile, environment, selections, config, timing) {
        var state = initialTaskState();
        var trace = [];
        var decisions = [];
        var answered = 0;
        timing = timing || {};
        environment.rounds.forEach(function (round, index) {
            var before = cloneState(state);
            var displayed = displayedCardSet(bankProfile, environment, before, round, config);
            var taskId = selections[index] || null;
            var card = taskId ? fixedSlotsForRound(environment, round).find(function (candidate) {
                return candidate.taskId === taskId && candidate.active;
            }) : null;
            var reward = 0;
            var after;
            if (card) {
                reward = applyChoice(bankProfile, state, round, card);
                answered += 1;
            } else {
                breakInfiniteStreak(bankProfile, state, round, null);
            }
            after = cloneState(state);
            trace.push({ round: round, before: before, after: after, card: card, reward: reward, displayed: displayed });
            if (card) {
                decisions.push(decisionRecord(
                    bankProfile,
                    environment,
                    round,
                    card,
                    before,
                    after,
                    reward,
                    displayed,
                    timing.responseTimes ? timing.responseTimes[index] : "",
                    timing.selectionElapsedMs ? timing.selectionElapsedMs[index] : ""
                ));
            }
        });
        return { task: state, trace: trace, decisions: decisions, answeredCount: answered };
    }

    function createCardButton(bankProfile, environment, round, card, state, config, selected, onChoose, onActivity) {
        var button = element("button", "cs-card");
        var heading = element("span", "cs-card-heading");
        var payoffSlot = element("span", "cs-card-payoff-slot");
        var footer = element("span", "cs-card-footer");
        button.type = "button";
        button.setAttribute("data-task-id", card.taskId);
        button.setAttribute("data-position", card.slotPosition);
        button.setAttribute("data-slot-position", card.slotPosition);
        button.setAttribute("data-slot-index", card.slotPosition - 1);
        button.setAttribute("data-active", card.active ? "1" : "0");
        button.setAttribute("data-round", round.number);
        button.setAttribute("role", "radio");
        appendText(heading, "span", "", "cs-card-color-label");
        appendText(payoffSlot, "span", "", "cs-card-payoff");
        button.appendChild(heading); button.appendChild(payoffSlot); button.appendChild(footer);
        button.__csqCard = { heading: heading.firstChild, payoff: payoffSlot.firstChild, footer: footer };
        if (card.active && onActivity) { button.addEventListener("pointerdown", function () { onActivity("card_pointerdown"); }); }
        if (card.active && onChoose) { button.addEventListener("click", function () { onChoose(round, card, button); }); }
        updateCardButton(button, bankProfile, environment, round, card, state, config, selected);
        return button;
    }

    function updateCardButton(button, bankProfile, environment, round, card, state, config, selected) {
        var color = bankProfile.colors[environment.colorMap[card.taskId]];
        var display = card.active
            ? cardDisplayText(bankProfile, state, round, card, config)
            : { payoff: "", footerLines: [], combined: "" };
        var refs = button.__csqCard;
        refs.heading.textContent = color.label;
        refs.payoff.textContent = card.active ? display.payoff : "Unavailable";
        clearElement(refs.footer);
        if (card.active) {
            display.footerLines.forEach(function (line) { appendText(refs.footer, "span", line, "cs-card-footer-line"); });
        }
        button.className = "cs-card" + (card.active ? " cs-card-active" : " cs-card-inactive")
            + (selected && card.active ? " cs-card-selected" : "");
        button.style.setProperty("--card-color", color.hex);
        button.disabled = !card.active;
        button.tabIndex = card.active ? 0 : -1;
        button.setAttribute("aria-disabled", card.active ? "false" : "true");
        button.setAttribute("aria-checked", selected && card.active ? "true" : "false");
        button.setAttribute("aria-label", color.label + " card, " + TASK_LABELS[card.taskId]
            + (card.active ? (display.combined ? ". " + display.combined : "") + (selected ? ". Selected" : "") : ". Unavailable this round"));
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

    function environmentRecord(environment, round) {
        return csvValue(round.number) + "," + csvValue(round.phase) + ","
            + csvValue(JSON.stringify(fixedSlotsForRound(environment, round))) + ","
            + csvValue(round.infiniteRunId || "") + "," + csvValue(round.infiniteRunStart || "")
            + "," + csvValue(round.infiniteRunEnd || "") + "\r\n";
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
        var environmentPacked = packRecords(state.environment.rounds.map(function (round) {
            return environmentRecord(state.environment, round);
        }), bootstrap.chunkCount, bootstrap.chunkMaxBytes);
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
            cs_answered_at_end: state.decisions.length,
            cs_treatment_mode: state.treatmentMode || "sequential",
            cs_all_at_once_final_zoom: state.treatmentMode === "all_at_once" ? state.zoom : "",
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
            cs_slot_order: JSON.stringify(state.environment.slotOrder),
            cs_layout_version: LAYOUT_VERSION,
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
            cs_log_format_version: "csv-v3", cs_log_overflow: packed.overflow ? 1 : 0,
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

    function eventTargetsInactiveCard(event) {
        var target = event && event.target;
        var path;
        if (event && typeof event.composedPath === "function") {
            path = event.composedPath();
            if (path.some(function (node) {
                return node && node.getAttribute && node.getAttribute("data-active") === "0";
            })) { return true; }
        }
        return !!(target && target.closest && target.closest('.cs-card[data-active="0"]'));
    }

    function persistLayoutMetadata(environment) {
        setEmbeddedData("cs_slot_order", JSON.stringify(environment.slotOrder));
        setEmbeddedData("cs_layout_version", LAYOUT_VERSION);
    }

    function compactGameTopGap(root) {
        var header;
        var headerRect;
        var rootRect;
        var gap;
        var offset = 0;
        if (!root || !root.style || !root.getBoundingClientRect || !global.document || !global.document.querySelector) {
            return { headerFound: false, gap: 0, offset: 0 };
        }
        root.style.removeProperty("margin-top");
        header = global.document.querySelector("#HeaderContainer, .Skin #Header, .Skin header");
        if (!header || !header.getBoundingClientRect) { return { headerFound: false, gap: 0, offset: 0 }; }
        headerRect = header.getBoundingClientRect();
        if (headerRect.width <= 0 || headerRect.height <= 0) { return { headerFound: false, gap: 0, offset: 0 }; }
        rootRect = root.getBoundingClientRect();
        gap = Math.max(0, Math.round(rootRect.top - headerRect.bottom));
        if (gap > 24) {
            offset = Math.min(120, Math.max(0, gap - 18));
            root.style.setProperty("margin-top", "-" + offset + "px", "important");
        }
        return { headerFound: true, gap: gap, offset: offset };
    }

    function createGameToolbar(root) {
        var toolbar = element("div", "csq-game-toolbar");
        var primary = element("div", "csq-game-toolbar-primary");
        var controls = element("div", "csq-game-toolbar-controls");
        var spacer = element("div", "csq-game-toolbar-spacer");
        toolbar.setAttribute("data-csq-toolbar", "");
        toolbar.appendChild(primary); toolbar.appendChild(controls); root.appendChild(toolbar);
        spacer.setAttribute("aria-hidden", "true"); root.appendChild(spacer);
        return { toolbar: toolbar, primary: primary, controls: controls, spacer: spacer };
    }

    function syncGameToolbar(root, toolbar, spacer) {
        var rootRect;
        var view;
        var viewportWidth;
        var viewportHeight;
        var left;
        var right;
        if (!root || !toolbar || !spacer || !root.getBoundingClientRect) { return; }
        view = root.ownerDocument && root.ownerDocument.defaultView ? root.ownerDocument.defaultView : global;
        rootRect = root.getBoundingClientRect();
        viewportWidth = view.innerWidth || (global.document && global.document.documentElement.clientWidth) || 1280;
        viewportHeight = view.innerHeight || (global.document && global.document.documentElement.clientHeight) || 768;
        left = Math.max(8, rootRect.left);
        right = Math.min(viewportWidth - 8, rootRect.right);
        if (right - left < 320) { left = 8; right = Math.max(328, viewportWidth - 8); }
        toolbar.style.left = Math.round(left) + "px";
        toolbar.style.width = Math.max(320, Math.round(right - left)) + "px";
        toolbar.style.top = Math.round(Math.max(8, Math.min(rootRect.top, viewportHeight - toolbar.offsetHeight - 8))) + "px";
        spacer.style.height = Math.ceil(toolbar.offsetHeight) + "px";
        root.style.setProperty("--csq-toolbar-height", Math.ceil(toolbar.offsetHeight) + "px");
    }

    function initSequentialGame(question) {
        var root = getRoot("csq-game-root", question);
        var bootstrap = readBootstrap(); var error = validateBootstrap(bootstrap);
        var bank = bootstrap.bank; var config = error ? null : readConfig(bank);
        var environment = error ? null : selectEnvironment(bank);
        var token = "csq-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
        var timers = []; var listeners = []; var authority = false;
        var state;
        var gameLayout; var stage; var shell; var rulesPanel; var rulesPresentation; var blocker; var cards;
        var toolbar; var toolbarSpacer; var statusLeft; var statusRight;
        var roundCounter; var mainCounter; var movieCounter; var pointsCounter;
        var inactivityClock; var feedback; var payoffButton;
        if (!root) { return null; }
        clearElement(root); hideNextButton(question);
        if (error || validateConfig(config).length) { appendText(root, "div", error || validateConfig(config).join(" "), "cs-debug-notice"); return null; }
        if (global.document && global.document.body) { global.document.body.classList.add("csq-game-active"); }
        root.className = "csq-sequential";
        var toolbarParts = createGameToolbar(root);
        toolbar = toolbarParts.toolbar; toolbarSpacer = toolbarParts.spacer;
        statusLeft = toolbarParts.primary; statusRight = toolbarParts.controls;
        if (config.showRound) {
            roundCounter = appendText(statusLeft, "span", "Round 1 of " + config.profile.rounds);
            roundCounter.setAttribute("data-csq", "sequential-round");
        }
        if (config.showMain) { mainCounter = appendText(statusLeft, "span", ""); }
        if (config.showMovie) { movieCounter = appendText(statusLeft, "span", ""); }
        if (config.showPoints) {
            pointsCounter = appendText(statusRight, "span", "Points: 0");
            pointsCounter.setAttribute("data-csq", "game-points");
        }
        inactivityClock = appendText(statusRight, "span", "", "cs-inactivity-clock");
        inactivityClock.setAttribute("data-csq", "game-inactivity");
        feedback = appendText(statusRight, "span", "", "csq-toolbar-feedback");
        if (config.payoffKeyMode === "overlay") {
            payoffButton = element("button", "csq-game-nav-button", "Payoff key"); payoffButton.type = "button";
            payoffButton.setAttribute("data-csq", "payoff-key-button"); statusRight.appendChild(payoffButton);
        }
        blocker = appendText(root, "div", "This task needs a wider browser window. Please widen the window or use a computer with at least 1280 pixels of browser width. Your progress is preserved and the inactivity timer is paused.", "csq-all-wide-blocker");
        blocker.hidden = true; blocker.setAttribute("role", "alert");
        gameLayout = element("div", "csq-game-layout");
        stage = element("div", "csq-sequential-stage");
        shell = element("div", "cs-task"); shell.style.setProperty("--cs-screen-motion-ms", config.screenMotionMs + "ms");
        cards = element("div", "cs-card-row"); shell.appendChild(cards);
        stage.appendChild(shell); gameLayout.appendChild(stage); root.appendChild(gameLayout);
        rulesPresentation = createPayoffKeyPresentation(root, bank.profile, environment, config.payoffKeyMode);
        rulesPanel = rulesPresentation.panel;
        if (config.payoffKeyMode === "below") { gameLayout.appendChild(rulesPanel); }
        state = {
            environment: environment, task: initialTaskState(), roundIndex: 0,
            decisions: [], startedAtWall: Date.now(), roundStartedAt: nowMonotonic(),
            lastActivityAt: Date.now(), activityEventCount: 0, lastActivitySource: "game_start",
            waiting: false, finished: false, treatmentMode: "sequential", zoom: "",
            narrow: false, narrowStartedAt: null,
            selections: Array(config.profile.rounds).fill(null),
            selectionElapsedMs: Array(config.profile.rounds).fill(""),
            responseTimes: Array(config.profile.rounds).fill("")
        };
        setEmbeddedData("cs_sequence_id", environment.sequenceId);
        setEmbeddedData("cs_seed", environment.seed);
        persistLayoutMetadata(environment);
        if (isLikelyVisible(root)) { authority = claimOwner(token, "game_start_visible"); }

        function addListener(target, type, callback, options) {
            if (!target || !target.addEventListener) { return; }
            target.addEventListener(type, callback, options); listeners.push([target, type, callback, options]);
        }

        function markActivity(source) {
            if (state.finished || state.narrow) { return; }
            authority = claimOwner(token, source) || authority;
            if (!authority) { return; }
            state.lastActivityAt = Date.now(); state.activityEventCount += 1; state.lastActivitySource = source;
            refreshInactivityClock();
        }

        if (payoffButton && rulesPresentation.overlay) {
            rulesPresentation.trigger = payoffButton;
            addListener(payoffButton, "click", function () { markActivity("payoff_key_open"); setPayoffKeyOpen(rulesPresentation, true); });
            addListener(rulesPresentation.closeButton, "click", function () { markActivity("payoff_key_close"); setPayoffKeyOpen(rulesPresentation, false); });
            addListener(rulesPresentation.overlay, "click", function (event) {
                if (event.target === rulesPresentation.overlay) { markActivity("payoff_key_backdrop"); setPayoffKeyOpen(rulesPresentation, false); }
            });
            addListener(global.document, "keydown", function (event) {
                if (event.key === "Escape" && !rulesPresentation.overlay.hidden) { markActivity("payoff_key_escape"); setPayoffKeyOpen(rulesPresentation, false); }
            });
        }

        function inactivityClockText() {
            var remaining = Math.max(
                0,
                Math.ceil((config.inactivitySeconds * 1000 - (Date.now() - state.lastActivityAt)) / 1000)
            );
            var minutes = Math.floor(remaining / 60);
            var seconds = remaining % 60;
            return state.narrow ? "Inactivity paused" : "Inactive in " + minutes + ":" + String(seconds).padStart(2, "0");
        }

        function refreshInactivityClock() {
            var remainingSeconds;
            if (!inactivityClock) { return; }
            inactivityClock.textContent = inactivityClockText();
            remainingSeconds = state.narrow ? config.inactivitySeconds : Math.max(
                0,
                Math.ceil((config.inactivitySeconds * 1000 - (Date.now() - state.lastActivityAt)) / 1000)
            );
            inactivityClock.className = "cs-inactivity-clock" + (!state.narrow && remainingSeconds <= 10 ? " cs-inactivity-warning" : "");
        }

        function counters() {
            var profile = config.profile;
            if (roundCounter) { roundCounter.textContent = "Round " + (Math.min(state.roundIndex + 1, profile.rounds)) + " of " + profile.rounds; }
            if (mainCounter) { mainCounter.textContent = "Main: " + state.task.main + " / " + profile.mainTarget; }
            if (movieCounter) { movieCounter.textContent = "Movie: " + state.task.movie + " / " + profile.movieRounds; }
            if (pointsCounter) { pointsCounter.textContent = "Points: " + awardedTotalPoints(profile, state.task); }
            refreshInactivityClock();
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
            var reward; var delay; var evaluation; var chosenIndex = state.roundIndex;
            if (state.finished || state.waiting || state.narrow || !card.active || state.environment.rounds[state.roundIndex] !== round) { return; }
            markActivity("card_click"); if (!authority) { return; }
            state.waiting = true;
            state.selections[chosenIndex] = card.taskId;
            state.selectionElapsedMs[chosenIndex] = Math.max(0, Date.now() - state.startedAtWall);
            state.responseTimes[chosenIndex] = Math.max(0, Math.round(nowMonotonic() - state.roundStartedAt));
            evaluation = evaluateAllocation(bank.profile, environment, state.selections, config, {
                responseTimes: state.responseTimes,
                selectionElapsedMs: state.selectionElapsedMs
            });
            reward = evaluation.trace[chosenIndex].reward;
            state.decisions = evaluation.decisions;
            Array.prototype.forEach.call(cards.querySelectorAll("button"), function (node) { node.disabled = true; });
            button.className += " cs-card-selected";
            if (config.showClickFeedback) {
                feedback.textContent = card.taskId === "main" ? "Main selected" : card.taskId === "movie" ? "Movie selected" : "+" + reward + " pts.";
                feedback.className = "csq-toolbar-feedback csq-toolbar-feedback-visible";
            }
            state.roundIndex += 1;
            state.task = state.roundIndex < config.profile.rounds ? cloneState(evaluation.trace[state.roundIndex].before) : evaluation.task;
            counters();
            if (state.roundIndex >= config.profile.rounds) {
                delay = config.showClickFeedback ? config.feedbackMessageMs : 0;
                timers.push(global.setTimeout(function () { finish("completed"); }, delay)); return;
            }
            delay = Math.max(config.showClickFeedback ? config.feedbackMessageMs : 0, config.usePostClickDelay ? config.postClickDelayMs : 0);
            timers.push(global.setTimeout(function () { state.waiting = false; renderRound(); }, delay));
        }

        function renderRound() {
            var round = environment.rounds[state.roundIndex];
            clearElement(cards); feedback.textContent = ""; feedback.className = "csq-toolbar-feedback"; counters();
            cards.className = "cs-card-row cs-card-row-new";
            shell.setAttribute("data-card-count", environment.slotOrder.length);
            state.roundStartedAt = nowMonotonic();
            fixedSlotsForRound(environment, round).forEach(function (card) {
                cards.appendChild(createCardButton(bank.profile, environment, round, card, state.task, config, false, choose, markActivity));
            });
        }

        function currentViewportWidth() {
            var view = root.ownerDocument && root.ownerDocument.defaultView;
            return view && view.innerWidth ? view.innerWidth : global.innerWidth;
        }

        function setNarrowMode() {
            var narrow = viewportIsTooNarrow(currentViewportWidth());
            state.narrow = narrow; blocker.hidden = !narrow; gameLayout.hidden = narrow;
            if (narrow) { setPayoffKeyOpen(rulesPresentation, false); }
            if (narrow && state.narrowStartedAt === null) { state.narrowStartedAt = Date.now(); }
            if (!narrow && state.narrowStartedAt !== null) {
                state.narrowStartedAt = null; state.lastActivityAt = Date.now(); state.lastActivitySource = "wide_view_resumed";
            }
            refreshInactivityClock();
            syncGameToolbar(root, toolbar, toolbarSpacer);
        }

        ["pointerdown", "mousedown", "touchstart", "keydown"].forEach(function (type) {
            addListener(root, type, function (event) { if (!eventTargetsInactiveCard(event)) { markActivity("root_" + type); } }, true);
            addListener(global.document, type, function (event) { if (!eventTargetsInactiveCard(event)) { markActivity("document_" + type); } }, true);
            addListener(global, type, function (event) { if (!eventTargetsInactiveCard(event)) { markActivity("window_" + type); } }, true);
        });
        addListener(global, "focus", function () { markActivity("window_focus"); }, true);
        addListener(global, "scroll", function () { syncGameToolbar(root, toolbar, toolbarSpacer); markActivity("window_scroll"); }, { passive: true });
        addListener(global, "resize", function () { setNarrowMode(); compactGameTopGap(root); syncGameToolbar(root, toolbar, toolbarSpacer); }, false);
        var inactivityTimer = global.setInterval(function () {
            refreshInactivityClock();
            if (!state.finished && !state.narrow && authority && Date.now() - state.lastActivityAt >= config.inactivitySeconds * 1000) { finish("inactive"); }
        }, 250);
        timers.push(inactivityTimer);
        renderRound();
        setNarrowMode(); syncGameToolbar(root, toolbar, toolbarSpacer);
        timers.push(global.setTimeout(function () { compactGameTopGap(root); syncGameToolbar(root, toolbar, toolbarSpacer); }, 0));
        timers.push(global.setTimeout(function () { compactGameTopGap(root); syncGameToolbar(root, toolbar, toolbarSpacer); }, 250));
        var controller = {
            state: state, finish: finish,
            cleanup: function () {
                timers.forEach(function (timer) { global.clearTimeout(timer); global.clearInterval(timer); }); timers = [];
                listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2], item[3]); }); listeners = [];
                if (!state.finished) { clearOwner(token); }
                if (global.document && global.document.body) { global.document.body.classList.remove("csq-game-active"); }
                if (toolbar && toolbar.style) { toolbar.style.display = "none"; }
                setPayoffKeyOpen(rulesPresentation, false);
                if (root && root.style) { root.style.removeProperty("margin-top"); root.style.removeProperty("--csq-toolbar-height"); }
                root.__csqController = null;
            }
        };
        root.__csqController = controller; activateController(question, controller); return controller;
    }

    function viewportIsTooNarrow(width) {
        return numberValue(width, 0) < 1280;
    }

    function initAllAtOnceGame(question) {
        var root = getRoot("csq-game-root", question);
        var bootstrap = readBootstrap();
        var error = validateBootstrap(bootstrap);
        var bank = bootstrap.bank;
        var config = error ? null : readConfig(bank);
        var environment = error ? null : selectEnvironment(bank);
        var token = "csq-all-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
        var timers = [];
        var listeners = [];
        var rowRefs = [];
        var authority = false;
        var visibleFrame = null;
        var feedbackTimer = null;
        var state;
        var toolbar;
        var toolbarSpacer;
        var primary;
        var controls;
        var viewingCounter;
        var answeredCounter;
        var mainCounter;
        var movieCounter;
        var pointsCounter;
        var inactivityClock;
        var feedback;
        var payoffButton;
        var doneButton;
        var helper;
        var completion;
        var blocker;
        var layout;
        var scrollPane;
        var list;
        var rulesPanel;
        var rulesPresentation;
        if (!root) { return null; }
        clearElement(root); hideNextButton(question);
        if (error || validateConfig(config).length) {
            appendText(root, "div", error || validateConfig(config).join(" "), "cs-debug-notice");
            return null;
        }
        if (global.document && global.document.body) { global.document.body.classList.add("csq-game-active", "csq-all-at-once-active"); }
        root.className = "csq-all-at-once";
        root.style.setProperty("--csq-choice-scale", "1");

        var toolbarParts = createGameToolbar(root);
        toolbar = toolbarParts.toolbar; toolbarSpacer = toolbarParts.spacer;
        primary = toolbarParts.primary; controls = toolbarParts.controls;
        viewingCounter = appendText(primary, "span", "Rounds 1–1 of " + config.profile.rounds);
        viewingCounter.setAttribute("data-csq", "all-viewing");
        answeredCounter = appendText(primary, "span", "Answered 0 of " + config.profile.rounds);
        answeredCounter.setAttribute("data-csq", "all-answered");
        if (config.showMain) { mainCounter = appendText(primary, "span", ""); }
        if (config.showMovie) { movieCounter = appendText(primary, "span", ""); }
        if (config.showPoints) {
            pointsCounter = appendText(controls, "span", "Points: 0");
            pointsCounter.setAttribute("data-csq", "all-points");
        }
        inactivityClock = appendText(controls, "span", "", "cs-inactivity-clock");
        inactivityClock.setAttribute("data-csq", "all-inactivity");
        feedback = appendText(controls, "span", "", "csq-toolbar-feedback");
        if (config.payoffKeyMode === "overlay") {
            payoffButton = element("button", "csq-game-nav-button", "Payoff key"); payoffButton.type = "button";
            payoffButton.setAttribute("data-csq", "payoff-key-button"); controls.appendChild(payoffButton);
        }
        blocker = appendText(root, "div", "This task needs a wider browser window. Please widen the window or use a computer with at least 1280 pixels of browser width. Your choices are preserved and the inactivity timer is paused.", "csq-all-wide-blocker");
        blocker.hidden = true; blocker.setAttribute("role", "alert");
        layout = element("div", "csq-all-layout");
        scrollPane = element("div", "csq-all-scroll"); scrollPane.tabIndex = 0;
        scrollPane.setAttribute("aria-label", "All card-choice rounds");
        list = element("div", "csq-all-list"); scrollPane.appendChild(list);
        layout.appendChild(scrollPane); root.appendChild(layout);
        rulesPresentation = createPayoffKeyPresentation(root, bank.profile, environment, config.payoffKeyMode);
        rulesPanel = rulesPresentation.panel; rulesPanel.id = "csq-all-payoff-key";
        if (config.payoffKeyMode === "below") { root.appendChild(rulesPanel); }

        state = {
            environment: environment,
            task: initialTaskState(),
            decisions: [],
            selections: Array(config.profile.rounds).fill(null),
            selectionElapsedMs: Array(config.profile.rounds).fill(""),
            responseTimes: Array(config.profile.rounds).fill(""),
            evaluation: null,
            startedAtWall: Date.now(),
            lastActivityAt: Date.now(),
            activityEventCount: 0,
            lastActivitySource: "game_start",
            finished: false,
            narrow: false,
            narrowStartedAt: null,
            zoom: 100,
            treatmentMode: "all_at_once",
            visibleStart: 0,
            visibleEnd: 0
        };
        state.evaluation = evaluateAllocation(bank.profile, environment, state.selections, config, {
            responseTimes: state.responseTimes, selectionElapsedMs: state.selectionElapsedMs
        });
        state.task = state.evaluation.task; state.decisions = state.evaluation.decisions;
        setEmbeddedData("cs_sequence_id", environment.sequenceId);
        setEmbeddedData("cs_seed", environment.seed);
        persistLayoutMetadata(environment);
        if (isLikelyVisible(root)) { authority = claimOwner(token, "game_start_visible"); }

        function addListener(target, type, callback, options) {
            if (!target || !target.addEventListener) { return; }
            target.addEventListener(type, callback, options); listeners.push([target, type, callback, options]);
        }

        function markActivity(source) {
            if (state.finished || state.narrow) { return; }
            authority = claimOwner(token, source) || authority;
            if (!authority) { return; }
            state.lastActivityAt = Date.now(); state.activityEventCount += 1; state.lastActivitySource = source;
            refreshInactivityClock();
        }

        if (payoffButton && rulesPresentation.overlay) {
            rulesPresentation.trigger = payoffButton;
            addListener(payoffButton, "click", function () { markActivity("payoff_key_open"); setPayoffKeyOpen(rulesPresentation, true); });
            addListener(rulesPresentation.closeButton, "click", function () { markActivity("payoff_key_close"); setPayoffKeyOpen(rulesPresentation, false); });
            addListener(rulesPresentation.overlay, "click", function (event) {
                if (event.target === rulesPresentation.overlay) { markActivity("payoff_key_backdrop"); setPayoffKeyOpen(rulesPresentation, false); }
            });
            addListener(global.document, "keydown", function (event) {
                if (event.key === "Escape" && !rulesPresentation.overlay.hidden) { markActivity("payoff_key_escape"); setPayoffKeyOpen(rulesPresentation, false); }
            });
        }

        function inactivityClockText() {
            var remaining;
            var minutes;
            var seconds;
            if (state.narrow) { return "Inactivity paused"; }
            remaining = Math.max(0, Math.ceil((config.inactivitySeconds * 1000 - (Date.now() - state.lastActivityAt)) / 1000));
            minutes = Math.floor(remaining / 60); seconds = remaining % 60;
            return "Inactive in " + minutes + ":" + String(seconds).padStart(2, "0");
        }

        function refreshInactivityClock() {
            var remainingSeconds;
            inactivityClock.textContent = inactivityClockText();
            remainingSeconds = state.narrow ? config.inactivitySeconds : Math.max(0, Math.ceil((config.inactivitySeconds * 1000 - (Date.now() - state.lastActivityAt)) / 1000));
            inactivityClock.className = "cs-inactivity-clock" + (!state.narrow && remainingSeconds <= 10 ? " cs-inactivity-warning" : "");
        }

        function refreshCounters() {
            var answered = state.evaluation.answeredCount;
            answeredCounter.textContent = "Answered " + answered + " of " + config.profile.rounds;
            if (mainCounter) { mainCounter.textContent = "Main: " + state.task.main + " / " + config.profile.mainTarget; }
            if (movieCounter) { movieCounter.textContent = "Movie: " + state.task.movie + " / " + config.profile.movieRounds; }
            if (pointsCounter) { pointsCounter.textContent = "Points: " + awardedTotalPoints(config.profile, state.task); }
            doneButton.disabled = state.narrow || answered !== config.profile.rounds;
            if (answered === config.profile.rounds) {
                helper.textContent = "All rounds are answered. You may review and change any choice before selecting Done.";
            } else {
                helper.textContent = "Answer every round to enable Done. " + (config.profile.rounds - answered) + " remaining.";
            }
            refreshInactivityClock();
        }

        function updateRound(index) {
            var ref = rowRefs[index];
            var trace = state.evaluation.trace[index];
            var selectedTaskId = state.selections[index];
            ref.status.textContent = selectedTaskId ? "Answered" : "Not answered";
            ref.outer.setAttribute("data-selected-task", selectedTaskId || "");
            ref.outer.setAttribute("data-answered", selectedTaskId ? "1" : "0");
            fixedSlotsForRound(environment, trace.round).forEach(function (card) {
                updateCardButton(ref.buttons[card.taskId], bank.profile, environment, trace.round, card, trace.before, config, selectedTaskId === card.taskId);
            });
        }

        function recomputeFrom(index) {
            state.evaluation = evaluateAllocation(bank.profile, environment, state.selections, config, {
                responseTimes: state.responseTimes, selectionElapsedMs: state.selectionElapsedMs
            });
            state.task = state.evaluation.task; state.decisions = state.evaluation.decisions;
            for (; index < rowRefs.length; index += 1) { updateRound(index); }
            refreshCounters();
        }

        function showFeedback(index) {
            var trace = state.evaluation.trace[index];
            var taskId = state.selections[index];
            if (!config.showClickFeedback) { return; }
            if (feedbackTimer) { global.clearTimeout(feedbackTimer); }
            feedback.textContent = taskId === "main" ? "Main selected" : taskId === "movie" ? "Movie selected" : "+" + trace.reward + " pts.";
            feedback.className = "csq-toolbar-feedback csq-toolbar-feedback-visible";
            feedbackTimer = global.setTimeout(function () {
                feedback.textContent = ""; feedback.className = "csq-toolbar-feedback";
            }, config.feedbackMessageMs);
            timers.push(feedbackTimer);
        }

        function choose(round, card) {
            var index = round.number - 1;
            if (state.finished || state.narrow || !card.active || state.selections[index] === card.taskId) { return; }
            markActivity("card_click"); if (!authority) { return; }
            state.selections[index] = card.taskId;
            state.selectionElapsedMs[index] = Math.max(0, Date.now() - state.startedAtWall);
            recomputeFrom(index); showFeedback(index);
        }

        environment.rounds.forEach(function (round, index) {
            var outer = element("section", "csq-all-round");
            var scale = element("div", "csq-all-round-scale");
            var heading = element("div", "csq-all-round-heading");
            var status = element("span", "csq-all-round-status", "Not answered");
            var cardRow = element("div", "csq-all-card-row");
            var buttons = {};
            outer.setAttribute("data-round", round.number); outer.setAttribute("data-answered", "0");
            heading.appendChild(element("span", "", "Round " + round.number + " of " + config.profile.rounds));
            heading.appendChild(status); scale.appendChild(heading);
            cardRow.setAttribute("role", "radiogroup"); cardRow.setAttribute("aria-label", "Round " + round.number);
            fixedSlotsForRound(environment, round).forEach(function (card) {
                var button = createCardButton(bank.profile, environment, round, card, state.evaluation.trace[index].before, config, false, choose, markActivity);
                buttons[card.taskId] = button; cardRow.appendChild(button);
            });
            scale.appendChild(cardRow); outer.appendChild(scale); list.appendChild(outer);
            rowRefs.push({ outer: outer, scale: scale, status: status, cardRow: cardRow, buttons: buttons });
        });
        completion = element("div", "csq-all-completion");
        completion.setAttribute("data-csq", "all-completion");
        helper = appendText(completion, "p", "Answer every round to enable Done. " + config.profile.rounds + " remaining.", "csq-all-helper");
        doneButton = element("button", "csq-all-nav-button csq-all-done", "Done");
        doneButton.type = "button"; doneButton.disabled = true;
        doneButton.setAttribute("data-csq", "all-done"); completion.appendChild(doneButton);
        list.appendChild(completion);

        function visibleRange() {
            var paneRect = scrollPane.getBoundingClientRect();
            var first = -1;
            var last = -1;
            rowRefs.forEach(function (ref, index) {
                var rect = ref.outer.getBoundingClientRect();
                if (rect.bottom > paneRect.top + 1 && rect.top < paneRect.bottom - 1) {
                    if (first < 0) { first = index; }
                    last = index;
                }
            });
            if (first < 0) { first = Math.max(0, Math.min(config.profile.rounds - 1, state.visibleStart)); last = first; }
            return { first: first, last: last };
        }

        function refreshVisibleRange() {
            var range = visibleRange();
            state.visibleStart = range.first; state.visibleEnd = range.last;
            viewingCounter.textContent = "Rounds " + (range.first + 1) + "–" + (range.last + 1) + " of " + config.profile.rounds;
            visibleFrame = null;
        }

        function scheduleVisibleRange() {
            if (visibleFrame !== null) { return; }
            if (global.requestAnimationFrame) { visibleFrame = global.requestAnimationFrame(refreshVisibleRange); }
            else { visibleFrame = global.setTimeout(refreshVisibleRange, 16); }
        }

        function currentViewportWidth() {
            var view = root.ownerDocument && root.ownerDocument.defaultView;
            return view && view.innerWidth ? view.innerWidth : global.innerWidth;
        }

        function setNarrowMode() {
            var narrow = viewportIsTooNarrow(currentViewportWidth());
            var changed = narrow !== state.narrow;
            state.narrow = narrow; blocker.hidden = !narrow; layout.hidden = narrow;
            if (config.payoffKeyMode === "below") { rulesPanel.hidden = narrow; }
            else if (narrow) { setPayoffKeyOpen(rulesPresentation, false); }
            Array.prototype.forEach.call(list.querySelectorAll("button.cs-card"), function (button) {
                button.disabled = narrow || button.getAttribute("data-active") === "0";
                button.tabIndex = button.disabled ? -1 : 0;
            });
            if (narrow && state.narrowStartedAt === null) { state.narrowStartedAt = Date.now(); }
            if (!narrow && state.narrowStartedAt !== null) {
                state.narrowStartedAt = null; state.lastActivityAt = Date.now(); state.lastActivitySource = "wide_view_resumed";
                scheduleVisibleRange();
            }
            refreshCounters();
            if (changed) { compactGameTopGap(root); }
            syncGameToolbar(root, toolbar, toolbarSpacer);
        }

        function finish(statusName) {
            if (state.finished || statusName === "completed" && state.evaluation.answeredCount !== config.profile.rounds) { return; }
            if (!authority && !claimOwner(token, "finish")) { return; }
            authority = true; state.finished = true;
            state.task = state.evaluation.task; state.decisions = state.evaluation.decisions;
            timers.forEach(function (timer) { global.clearTimeout(timer); global.clearInterval(timer); }); timers = [];
            listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2], item[3]); }); listeners = [];
            persistFinalData(state, statusName, bootstrap); clearBankChunks(bootstrap);
            clearOwner(token); clickNextButton(question);
        }

        addListener(scrollPane, "scroll", function () { markActivity("decision_scroll"); scheduleVisibleRange(); }, { passive: true });
        addListener(doneButton, "click", function () { markActivity("done"); finish("completed"); });
        ["pointerdown", "mousedown", "touchstart", "keydown", "wheel"].forEach(function (type) {
            addListener(root, type, function (event) { if (!eventTargetsInactiveCard(event)) { markActivity("root_" + type); } }, true);
        });
        addListener(global, "focus", function () { markActivity("window_focus"); }, true);
        addListener(global, "scroll", function () { syncGameToolbar(root, toolbar, toolbarSpacer); markActivity("window_scroll"); }, { passive: true });
        addListener(global, "resize", function () { setNarrowMode(); compactGameTopGap(root); syncGameToolbar(root, toolbar, toolbarSpacer); scheduleVisibleRange(); }, false);

        var inactivityTimer = global.setInterval(function () {
            refreshInactivityClock();
            if (!state.finished && !state.narrow && authority && Date.now() - state.lastActivityAt >= config.inactivitySeconds * 1000) { finish("inactive"); }
        }, 250);
        timers.push(inactivityTimer);
        rowRefs.forEach(function (_ref, index) { updateRound(index); });
        setNarrowMode(); syncGameToolbar(root, toolbar, toolbarSpacer); refreshCounters(); refreshVisibleRange();
        timers.push(global.setTimeout(function () { compactGameTopGap(root); syncGameToolbar(root, toolbar, toolbarSpacer); refreshVisibleRange(); }, 0));
        timers.push(global.setTimeout(function () { compactGameTopGap(root); syncGameToolbar(root, toolbar, toolbarSpacer); refreshVisibleRange(); }, 250));
        var controller = {
            state: state,
            finish: finish,
            recompute: function () { recomputeFrom(0); },
            cleanup: function () {
                timers.forEach(function (timer) { global.clearTimeout(timer); global.clearInterval(timer); }); timers = [];
                listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2], item[3]); }); listeners = [];
                if (visibleFrame !== null) {
                    if (global.cancelAnimationFrame) { global.cancelAnimationFrame(visibleFrame); } else { global.clearTimeout(visibleFrame); }
                }
                if (!state.finished) { clearOwner(token); }
                if (global.document && global.document.body) { global.document.body.classList.remove("csq-game-active", "csq-all-at-once-active"); }
                if (toolbar && toolbar.style) { toolbar.style.display = "none"; }
                setPayoffKeyOpen(rulesPresentation, false);
                if (rulesPanel) { rulesPanel.hidden = true; }
                if (root && root.style) { root.style.removeProperty("margin-top"); root.style.removeProperty("--csq-choice-scale"); root.style.removeProperty("--csq-toolbar-height"); }
                root.__csqController = null;
            }
        };
        root.__csqController = controller; activateController(question, controller); return controller;
    }

    function initGame(question) {
        var bootstrap = readBootstrap(false);
        var error = validateBootstrap(bootstrap, false);
        var config = error ? null : readConfig(bootstrap.bank);
        if (!error && !validateConfig(config).length && config.treatmentMode === "all_at_once") { return initAllAtOnceGame(question); }
        return initSequentialGame(question);
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
            ["Task status", status], ["Treatment", getEmbeddedData("cs_treatment_mode")],
            ["Sequence ID", getEmbeddedData("cs_sequence_id")], ["Seed", getEmbeddedData("cs_seed")],
            ["Layout version", getEmbeddedData("cs_layout_version")], ["Permanent slot order", getEmbeddedData("cs_slot_order")],
            ["Profile version", getEmbeddedData("cs_profile_version")], ["Bank hash", getEmbeddedData("cs_bank_hash")],
            ["Task-to-color map", getEmbeddedData("cs_task_color_map")],
            ["Answered rounds", getEmbeddedData("cs_answered_at_end") || getEmbeddedData("cs_decision_count")],
            ["All-at-once display scale", getEmbeddedData("cs_all_at_once_final_zoom")],
            ["Main choices", getEmbeddedData("cs_main_cards_collected")],
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
        initSetup: initSetup, initInstructions: initInstructions, initGame: initGame, initOutcome: initOutcome, cleanup: cleanup,
        __test: {
            defaults: DEFAULTS, decisionColumns: DECISION_COLUMNS.slice(0),
            parseBoolean: parseBoolean, readBootstrap: readBootstrap, validateBootstrap: validateBootstrap,
            profileValues: profileValues, readConfig: readConfig, validateConfig: validateConfig,
            decodeEnvironment: decodeEnvironment, selectEnvironment: selectEnvironment,
            slotOrderForSeed: slotOrderForSeed, fixedSlotsForRound: fixedSlotsForRound,
            initialTaskState: initialTaskState, applyChoice: applyChoice,
            evaluateAllocation: evaluateAllocation, viewportIsTooNarrow: viewportIsTooNarrow,
            currentCardPayoff: currentCardPayoff, cardPayoffText: cardPayoffText,
            cardFooterLines: cardFooterLines, cardFooterText: cardFooterText,
            cardDisplayText: cardDisplayText,
            taskProgressText: taskProgressText,
            awardedTotalPoints: awardedTotalPoints,
            sharedAccumulationNote: SHARED_ACCUMULATION_NOTE,
            ruleGroupsForEnvironment: ruleGroupsForEnvironment,
            compactGameTopGap: compactGameTopGap,
            utf8ByteLength: utf8ByteLength,
            csvValue: csvValue, decisionToCsvRow: decisionToCsvRow,
            packRecords: packRecords, packDecisionRows: packDecisionRows,
            environmentRecord: environmentRecord, layoutVersion: LAYOUT_VERSION,
            parseCsvBody: parseCsvBody, getEmbeddedData: getEmbeddedData,
            setEmbeddedData: setEmbeddedData, packedDecisionsFromEmbeddedData: packedDecisionsFromEmbeddedData
        }
    };
}(window));
