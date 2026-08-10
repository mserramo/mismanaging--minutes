(function (global) {
    "use strict";

    var DEFAULTS = {
        durationMinutes: 1,
        numScreenTypes: 50,
        showTimeLeft: true,
        showMainCards: true,
        showTotalPoints: true,
        showClickFeedback: true,
        feedbackMessageMs: 600,
        usePostClickDelay: false,
        postClickDelayMs: 0,
        mainBonusDelayMs: 0,
        screenMotionMs: 600,
        bonusThresholdMainCards: 55,
        mainBonusPoints: 1650,
        inactivitySeconds: 30
    };

    var LIMITS = {
        maxDurationMinutes: 40,
        maxFeedbackMs: 5000,
        maxMotionMs: 5000,
        thresholdPerMinute: 55,
        pointsPerMainCard: 30
    };

    var DECISION_COLUMNS = [
        "screen_number",
        "screen_type_index",
        "chosen_card_id",
        "chosen_card_label",
        "chosen_card_position",
        "chosen_is_main",
        "chosen_x",
        "chosen_y",
        "chosen_z",
        "response_time_ms",
        "task_elapsed_ms",
        "main_cards_collected",
        "points_before",
        "card_points_added",
        "multiplier_applied",
        "multiplier_y",
        "multiplier_z",
        "main_bonus_triggered_this_round",
        "main_bonus_points_added",
        "points_after"
    ];

    var localEmbeddedData = {};
    var activeController = null;
    var lastResult = null;
    var GAME_OWNER_STORAGE_KEY = "csq-card-stacking-active-instance-v1";
    var GAME_OWNER_TOP_KEY = "__CSQ_CARD_STACKING_ACTIVE_INSTANCE_V1__";

    function own(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function isFiniteNumber(value) {
        return typeof value === "number" && isFinite(value);
    }

    function numberValue(value, fallback) {
        var parsed = Number(value);
        return isFiniteNumber(parsed) ? parsed : fallback;
    }

    function nonnegativeNumber(value, fallback) {
        return Math.max(0, numberValue(value, fallback));
    }

    function positiveInteger(value, fallback) {
        var parsed = Math.floor(numberValue(value, fallback));
        return parsed > 0 ? parsed : fallback;
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function parseBoolean(value, fallback) {
        var normalized;
        if (typeof value === "boolean") {
            return value;
        }
        if (value === null || typeof value === "undefined" || value === "") {
            return fallback;
        }
        normalized = String(value).toLowerCase();
        if (normalized === "1" || normalized === "true" || normalized === "yes") {
            return true;
        }
        if (normalized === "0" || normalized === "false" || normalized === "no") {
            return false;
        }
        return fallback;
    }

    function surveyEngine() {
        if (global.Qualtrics && global.Qualtrics.SurveyEngine) {
            return global.Qualtrics.SurveyEngine;
        }
        return null;
    }

    function getEmbeddedData(name) {
        var engine;
        var value;
        if (own(localEmbeddedData, name)) {
            return localEmbeddedData[name];
        }
        engine = surveyEngine();
        if (engine && typeof engine.getEmbeddedData === "function") {
            try {
                value = engine.getEmbeddedData(name);
                return value === null || typeof value === "undefined" ? "" : value;
            } catch (error) {
                return "";
            }
        }
        return "";
    }

    function setEmbeddedData(name, value) {
        var engine = surveyEngine();
        var stored = value === null || typeof value === "undefined" ? "" : String(value);
        localEmbeddedData[name] = stored;
        if (engine && typeof engine.setEmbeddedData === "function") {
            try {
                engine.setEmbeddedData(name, stored);
            } catch (error) {
                /* The local copy still lets the outcome page render in a test harness. */
            }
        }
    }

    function directEmbeddedData(name) {
        var engine = surveyEngine();
        var value;
        if (!engine || typeof engine.getEmbeddedData !== "function") {
            return "";
        }
        try {
            value = engine.getEmbeddedData(name);
            return value === null || typeof value === "undefined" ? "" : String(value);
        } catch (error) {
            return "";
        }
    }

    function sessionOwnerRecord() {
        var raw;
        var parsed;
        try {
            if (!global.sessionStorage) {
                return null;
            }
            raw = global.sessionStorage.getItem(GAME_OWNER_STORAGE_KEY);
            if (!raw) {
                return null;
            }
            parsed = JSON.parse(raw);
            return parsed && parsed.token ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    function topOwnerRecord() {
        try {
            if (global.top && global.top[GAME_OWNER_TOP_KEY] &&
                    global.top[GAME_OWNER_TOP_KEY].token) {
                return global.top[GAME_OWNER_TOP_KEY];
            }
        } catch (error) {
            /* A cross-origin preview parent cannot be used as a shared store. */
        }
        return null;
    }

    function readOwnerRecord() {
        var record = sessionOwnerRecord() || topOwnerRecord();
        var token;
        if (record) {
            return record;
        }
        token = directEmbeddedData("cs_game_owner_token");
        if (!token) {
            return null;
        }
        return {
            token: token,
            source: directEmbeddedData("cs_game_owner_claim_source"),
            channel: "embedded_data"
        };
    }

    function writeOwnerRecord(token, source) {
        var channels = [];
        var record = {
            token: token,
            source: source || "activity",
            claimedAt: Date.now(),
            channel: ""
        };
        try {
            if (global.sessionStorage) {
                global.sessionStorage.setItem(GAME_OWNER_STORAGE_KEY, JSON.stringify(record));
                channels.push("session_storage");
            }
        } catch (error) {
            /* Qualtrics privacy settings can disable storage. */
        }
        try {
            if (global.top) {
                global.top[GAME_OWNER_TOP_KEY] = record;
                channels.push("top_window");
            }
        } catch (error) {
            /* Cross-origin parents are expected in some preview layouts. */
        }
        setEmbeddedData("cs_game_owner_token", token);
        setEmbeddedData("cs_game_owner_claim_source", record.source);
        setEmbeddedData("cs_game_owner_claimed_at", record.claimedAt);
        channels.push("embedded_data");
        record.channel = channels.join("+");
        return record;
    }

    function clearOwnerCoordination() {
        try {
            if (global.sessionStorage) {
                global.sessionStorage.removeItem(GAME_OWNER_STORAGE_KEY);
            }
        } catch (error) {
            /* Qualtrics privacy settings can disable storage. */
        }
        try {
            if (global.top) {
                global.top[GAME_OWNER_TOP_KEY] = null;
            }
        } catch (error) {
            /* Cross-origin parents are expected in some preview layouts. */
        }
        setEmbeddedData("cs_game_owner_token", "");
        setEmbeddedData("cs_game_owner_claim_source", "");
        setEmbeddedData("cs_game_owner_claimed_at", "");
    }

    function isLikelyVisible(root) {
        var documentNode;
        var view;
        var style;
        var rect;
        var frame;
        if (!root || typeof root.getBoundingClientRect !== "function") {
            return false;
        }
        documentNode = root.ownerDocument;
        if (documentNode && documentNode.visibilityState === "hidden") {
            return false;
        }
        view = documentNode && documentNode.defaultView;
        try {
            style = view && typeof view.getComputedStyle === "function" ?
                view.getComputedStyle(root) : null;
            if (style && (style.display === "none" || style.visibility === "hidden" ||
                    Number(style.opacity) === 0)) {
                return false;
            }
            rect = root.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                return false;
            }
            frame = view && view.frameElement;
            if (frame) {
                style = frame.ownerDocument && frame.ownerDocument.defaultView ?
                    frame.ownerDocument.defaultView.getComputedStyle(frame) : null;
                rect = frame.getBoundingClientRect();
                if ((style && (style.display === "none" || style.visibility === "hidden" ||
                        Number(style.opacity) === 0)) || !rect || rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
            }
        } catch (error) {
            /* The root itself was measurable; inaccessible ancestors are not fatal. */
        }
        return true;
    }

    function readBootstrap() {
        var source = global.CSQ_BOOTSTRAP || {};
        var screenTypes = Array.isArray(source.screenTypes) ? source.screenTypes : [];
        var cardDeck = Array.isArray(source.cardDeck) ? source.cardDeck : [];
        return {
            screenTypes: screenTypes,
            cardDeck: cardDeck,
            maxDecisions: positiveInteger(source.maxDecisions, 4800),
            chunkCount: positiveInteger(source.chunkCount, 64),
            chunkMaxBytes: positiveInteger(source.chunkMaxBytes, 18000)
        };
    }

    function validateBootstrap(bootstrap) {
        var index;
        var expectedSideCards;
        if (!bootstrap.screenTypes.length) {
            return "No card-stacking screen types were provided.";
        }
        if (bootstrap.cardDeck.length < 2) {
            return "The card deck must contain at least two cards.";
        }
        expectedSideCards = bootstrap.cardDeck.length - 1;
        for (index = 0; index < bootstrap.screenTypes.length; index += 1) {
            if (!bootstrap.screenTypes[index] ||
                    !Array.isArray(bootstrap.screenTypes[index].side_values) ||
                    bootstrap.screenTypes[index].side_values.length < expectedSideCards) {
                return "Each screen type must provide values for every non-main card.";
            }
        }
        if (bootstrap.chunkMaxBytes > 18000) {
            return "The decision-log chunk byte limit cannot exceed 18,000 bytes.";
        }
        return "";
    }

    function getRoot(id, question) {
        var root = null;
        var container;
        if (question && typeof question.getQuestionContainer === "function") {
            container = question.getQuestionContainer();
            if (container && typeof container.querySelector === "function") {
                root = container.querySelector("#" + id);
            }
        }
        if (!root && global.document) {
            root = global.document.getElementById(id);
        }
        return root;
    }

    function clearElement(element) {
        while (element && element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    function element(tagName, className, text) {
        var node = global.document.createElement(tagName);
        if (className) {
            node.className = className;
        }
        if (text !== null && typeof text !== "undefined") {
            node.textContent = String(text);
        }
        return node;
    }

    function appendText(parent, tagName, text, className) {
        var node = element(tagName, className || "", text);
        parent.appendChild(node);
        return node;
    }

    function formatNumber(value) {
        var number = Number(value);
        if (!isFiniteNumber(number)) {
            return "0";
        }
        return Math.floor(number) === number ? String(number) : number.toFixed(1);
    }

    function formatClock(milliseconds) {
        var totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = totalSeconds % 60;
        return (minutes < 10 ? "0" : "") + minutes + ":" +
            (seconds < 10 ? "0" : "") + seconds;
    }

    function nowMonotonic() {
        if (global.performance && typeof global.performance.now === "function") {
            return global.performance.now();
        }
        return Date.now();
    }

    function hideNextButton(question) {
        var nativeButton;
        if (question && typeof question.hideNextButton === "function") {
            question.hideNextButton();
        }
        nativeButton = global.document && global.document.getElementById("NextButton");
        if (nativeButton) {
            nativeButton.style.display = "none";
        }
    }

    function showNextButton(question) {
        var nativeButton;
        if (question && typeof question.showNextButton === "function") {
            question.showNextButton();
        }
        nativeButton = global.document && global.document.getElementById("NextButton");
        if (nativeButton) {
            nativeButton.style.display = "";
        }
    }

    function clickNextButton(question) {
        var nativeButton;
        if (question && typeof question.clickNextButton === "function") {
            question.clickNextButton();
            return;
        }
        nativeButton = global.document && global.document.getElementById("NextButton");
        if (nativeButton && typeof nativeButton.click === "function") {
            nativeButton.click();
        }
    }

    function setFinishButtonLabel(question) {
        var nativeButton;
        if (question && typeof question.setNextButtonText === "function") {
            try {
                question.setNextButtonText("Finish");
            } catch (error) {
                /* Fall through to the DOM label below. */
            }
        }
        nativeButton = global.document && global.document.getElementById("NextButton");
        if (!nativeButton) {
            return;
        }
        if (String(nativeButton.tagName).toLowerCase() === "input") {
            nativeButton.value = "Finish";
        } else {
            nativeButton.textContent = "Finish";
        }
        nativeButton.setAttribute("aria-label", "Finish");
    }

    function registerUnload(question, callback) {
        var engine = surveyEngine();
        if (question && typeof question.addOnUnload === "function") {
            question.addOnUnload(callback);
        } else if (engine && typeof engine.addOnUnload === "function") {
            engine.addOnUnload(callback);
        }
    }

    function activateController(question, controller) {
        if (activeController && typeof activeController.cleanup === "function") {
            activeController.cleanup();
        }
        activeController = controller;
        registerUnload(question, function () {
            if (activeController === controller) {
                controller.cleanup();
                activeController = null;
            }
        });
    }

    function cleanup() {
        if (activeController && typeof activeController.cleanup === "function") {
            activeController.cleanup();
        }
        activeController = null;
    }

    function defaultThreshold(durationMinutes) {
        return Math.max(1, Math.round(durationMinutes * LIMITS.thresholdPerMinute));
    }

    function defaultBonusPoints(threshold) {
        return Math.max(0, threshold * LIMITS.pointsPerMainCard);
    }

    function getConfigNumber(fieldName, fallback) {
        var raw = getEmbeddedData(fieldName);
        return raw === "" ? fallback : numberValue(raw, fallback);
    }

    function getConfigBoolean(fieldName, fallback) {
        return parseBoolean(getEmbeddedData(fieldName), fallback);
    }

    function readConfig(bootstrap) {
        var maximumTypes = Math.max(1, bootstrap.screenTypes.length);
        return {
            durationMinutes: getConfigNumber("cs_duration_minutes", DEFAULTS.durationMinutes),
            numScreenTypes: clamp(
                Math.floor(getConfigNumber("cs_num_screen_types", Math.min(DEFAULTS.numScreenTypes, maximumTypes))),
                1,
                maximumTypes
            ),
            showTimeLeft: getConfigBoolean("cs_show_time_left", DEFAULTS.showTimeLeft),
            showMainCards: getConfigBoolean("cs_show_main_cards", DEFAULTS.showMainCards),
            showTotalPoints: getConfigBoolean("cs_show_total_points", DEFAULTS.showTotalPoints),
            showClickFeedback: getConfigBoolean("cs_show_click_feedback", DEFAULTS.showClickFeedback),
            feedbackMessageMs: getConfigNumber("cs_feedback_message_ms", DEFAULTS.feedbackMessageMs),
            usePostClickDelay: getConfigBoolean("cs_use_post_click_delay", DEFAULTS.usePostClickDelay),
            postClickDelayMs: getConfigNumber("cs_post_click_delay_ms", DEFAULTS.postClickDelayMs),
            mainBonusDelayMs: getConfigNumber("cs_main_bonus_delay_ms", DEFAULTS.mainBonusDelayMs),
            screenMotionMs: getConfigNumber("cs_screen_motion_ms", DEFAULTS.screenMotionMs),
            bonusThresholdMainCards: getConfigNumber(
                "cs_bonus_threshold_main_cards",
                DEFAULTS.bonusThresholdMainCards
            ),
            mainBonusPoints: getConfigNumber("cs_main_bonus_points", DEFAULTS.mainBonusPoints),
            inactivitySeconds: getConfigNumber("cs_inactivity_seconds", DEFAULTS.inactivitySeconds)
        };
    }

    function validateConfig(config, maximumScreenTypes) {
        var errors = [];

        function add(field, message) {
            errors.push({ field: field, message: message });
        }

        if (!isFiniteNumber(config.durationMinutes)) {
            add("cs_duration_minutes", "Enter the task duration in minutes.");
        } else if (config.durationMinutes <= 0) {
            add("cs_duration_minutes", "Task duration must be greater than 0 minutes.");
        } else if (config.durationMinutes > LIMITS.maxDurationMinutes) {
            add("cs_duration_minutes", "Task duration cannot exceed 40 minutes.");
        }

        if (!isFiniteNumber(config.numScreenTypes) || Math.floor(config.numScreenTypes) !== config.numScreenTypes) {
            add("cs_num_screen_types", "Enter a whole-number screen-type count.");
        } else if (config.numScreenTypes < 1 || config.numScreenTypes > maximumScreenTypes) {
            add(
                "cs_num_screen_types",
                "Screen-type count must be between 1 and " + maximumScreenTypes + "."
            );
        }

        if (!isFiniteNumber(config.feedbackMessageMs)) {
            add("cs_feedback_message_ms", "Enter the feedback message duration in milliseconds.");
        } else if (Math.floor(config.feedbackMessageMs) !== config.feedbackMessageMs) {
            add("cs_feedback_message_ms", "Feedback message duration must be a whole number.");
        } else if (config.feedbackMessageMs < 0) {
            add("cs_feedback_message_ms", "Feedback message duration cannot be negative.");
        } else if (config.feedbackMessageMs > LIMITS.maxFeedbackMs) {
            add("cs_feedback_message_ms", "Feedback message duration cannot exceed 5000 milliseconds.");
        }

        if (!isFiniteNumber(config.postClickDelayMs)) {
            add("cs_post_click_delay_ms", "Enter the wait before next screen in milliseconds.");
        } else if (Math.floor(config.postClickDelayMs) !== config.postClickDelayMs) {
            add("cs_post_click_delay_ms", "Wait before next screen must be a whole number.");
        } else if (config.postClickDelayMs < 0) {
            add("cs_post_click_delay_ms", "Wait before next screen cannot be negative.");
        } else if (config.postClickDelayMs > LIMITS.maxFeedbackMs) {
            add("cs_post_click_delay_ms", "Wait before next screen cannot exceed 5000 milliseconds.");
        }

        if (!isFiniteNumber(config.mainBonusDelayMs)) {
            add("cs_main_bonus_delay_ms", "Enter the L-th main-card wait before next screen.");
        } else if (Math.floor(config.mainBonusDelayMs) !== config.mainBonusDelayMs) {
            add("cs_main_bonus_delay_ms", "L-th main-card wait must be a whole number.");
        } else if (config.mainBonusDelayMs < 0) {
            add("cs_main_bonus_delay_ms", "L-th main-card wait before next screen cannot be negative.");
        } else if (config.mainBonusDelayMs > LIMITS.maxFeedbackMs) {
            add("cs_main_bonus_delay_ms", "L-th main-card wait before next screen cannot exceed 5000 milliseconds.");
        }

        if (!isFiniteNumber(config.screenMotionMs)) {
            add("cs_screen_motion_ms", "Enter the screen motion duration in milliseconds.");
        } else if (Math.floor(config.screenMotionMs) !== config.screenMotionMs) {
            add("cs_screen_motion_ms", "Screen motion duration must be a whole number.");
        } else if (config.screenMotionMs < 0) {
            add("cs_screen_motion_ms", "Screen motion duration cannot be negative.");
        } else if (config.screenMotionMs > LIMITS.maxMotionMs) {
            add("cs_screen_motion_ms", "Screen motion duration cannot exceed 5000 milliseconds.");
        }

        if (!isFiniteNumber(config.bonusThresholdMainCards)) {
            add("cs_bonus_threshold_main_cards", "Enter the main-card bonus threshold.");
        } else if (Math.floor(config.bonusThresholdMainCards) !== config.bonusThresholdMainCards) {
            add("cs_bonus_threshold_main_cards", "Main-card bonus threshold must be a whole number.");
        } else if (config.bonusThresholdMainCards < 1) {
            add("cs_bonus_threshold_main_cards", "Main-card bonus threshold must be at least 1.");
        }

        if (!isFiniteNumber(config.mainBonusPoints)) {
            add("cs_main_bonus_points", "Enter the main-card bonus points.");
        } else if (config.mainBonusPoints < 0) {
            add("cs_main_bonus_points", "Main-card bonus points cannot be negative.");
        }

        if (!isFiniteNumber(config.inactivitySeconds)) {
            add("cs_inactivity_seconds", "Enter the inactivity cutoff in seconds.");
        } else if (Math.floor(config.inactivitySeconds) !== config.inactivitySeconds) {
            add("cs_inactivity_seconds", "Inactivity cutoff must be a whole number.");
        } else if (config.inactivitySeconds < 1) {
            add("cs_inactivity_seconds", "Inactivity cutoff must be at least 1 second.");
        }

        return { valid: errors.length === 0, errors: errors };
    }

    function persistConfig(config) {
        setEmbeddedData("cs_duration_minutes", config.durationMinutes);
        setEmbeddedData("cs_num_screen_types", config.numScreenTypes);
        setEmbeddedData("cs_show_time_left", config.showTimeLeft ? "1" : "0");
        setEmbeddedData("cs_show_main_cards", config.showMainCards ? "1" : "0");
        setEmbeddedData("cs_show_total_points", config.showTotalPoints ? "1" : "0");
        setEmbeddedData("cs_show_click_feedback", config.showClickFeedback ? "1" : "0");
        setEmbeddedData("cs_feedback_message_ms", config.feedbackMessageMs);
        setEmbeddedData("cs_use_post_click_delay", config.usePostClickDelay ? "1" : "0");
        setEmbeddedData("cs_post_click_delay_ms", config.postClickDelayMs);
        setEmbeddedData("cs_main_bonus_delay_ms", config.mainBonusDelayMs);
        setEmbeddedData("cs_screen_motion_ms", config.screenMotionMs);
        setEmbeddedData("cs_bonus_threshold_main_cards", config.bonusThresholdMainCards);
        setEmbeddedData("cs_main_bonus_points", config.mainBonusPoints);
        setEmbeddedData("cs_inactivity_seconds", config.inactivitySeconds);
    }

    function createNumberField(parent, options) {
        var wrapper = element("div", "csq-field");
        var label = element("label", "csq-label", options.label);
        var input = element("input", "csq-input");
        var note;
        label.setAttribute("for", options.id);
        input.type = "number";
        input.id = options.id;
        input.name = options.id;
        input.value = String(options.value);
        if (typeof options.min !== "undefined") {
            input.min = String(options.min);
        }
        if (typeof options.max !== "undefined") {
            input.max = String(options.max);
        }
        input.step = String(typeof options.step === "undefined" ? 1 : options.step);
        wrapper.appendChild(label);
        if (options.note) {
            note = element("p", "cs-field-note", options.note);
            wrapper.appendChild(note);
        }
        wrapper.appendChild(input);
        parent.appendChild(wrapper);
        return input;
    }

    function createCheckboxField(parent, options) {
        var wrapper = element("div", "csq-field csq-checkbox-field");
        var label = element("label", "csq-checkbox-label");
        var input = element("input", "csq-checkbox");
        var indicator = element("span", "csq-checkbox-box");
        var span = element("span", "csq-checkbox-text", options.label);
        input.type = "checkbox";
        input.id = options.id;
        input.name = options.id;
        input.checked = Boolean(options.value);
        indicator.setAttribute("aria-hidden", "true");
        label.setAttribute("for", options.id);
        label.appendChild(input);
        label.appendChild(indicator);
        label.appendChild(span);
        wrapper.appendChild(label);
        if (options.note) {
            wrapper.appendChild(element("p", "cs-field-note", options.note));
        }
        parent.appendChild(wrapper);
        return input;
    }

    function createSetupSection(parent, title) {
        var section = element("section", "cs-setup-section");
        appendText(section, "h3", title);
        parent.appendChild(section);
        return section;
    }

    function initSetup(question) {
        var root = getRoot("csq-setup-root", question);
        var bootstrap = readBootstrap();
        var config;
        var controller;
        var panel;
        var section;
        var inputs = {};
        var errorBox;
        var continueButton;
        var thresholdOverridden = false;
        var pointsOverridden = false;
        var listeners = [];

        if (!root) {
            return null;
        }
        if (root.__csqController) {
            return root.__csqController;
        }

        hideNextButton(question);
        clearElement(root);
        root.className = (root.className + " cs-setup").replace(/^\s+|\s+$/g, "");
        root.appendChild(element(
            "div",
            "cs-debug-notice",
            "Development-only experimenter setup. Do not show this page in the production experiment or to participants."
        ));

        panel = element("div", "cs-debug-panel");
        appendText(panel, "h2", "Task parameters");
        root.appendChild(panel);
        config = readConfig(bootstrap);

        section = createSetupSection(panel, "Task and bonus");
        inputs.durationMinutes = createNumberField(section, {
            id: "cs_duration_minutes",
            label: "Task duration in minutes",
            value: config.durationMinutes,
            min: 0.01,
            max: LIMITS.maxDurationMinutes,
            step: 0.1
        });
        inputs.numScreenTypes = createNumberField(section, {
            id: "cs_num_screen_types",
            label: "Possible screen types",
            value: config.numScreenTypes,
            min: 1,
            max: Math.max(1, bootstrap.screenTypes.length),
            step: 1
        });
        inputs.bonusThresholdMainCards = createNumberField(section, {
            id: "cs_bonus_threshold_main_cards",
            label: "Main-card bonus threshold (L)",
            value: config.bonusThresholdMainCards,
            min: 1,
            step: 1
        });
        inputs.mainBonusPoints = createNumberField(section, {
            id: "cs_main_bonus_points",
            label: "Main-card bonus points (Q)",
            value: config.mainBonusPoints,
            min: 0,
            step: 0.1
        });
        inputs.inactivitySeconds = createNumberField(section, {
            id: "cs_inactivity_seconds",
            label: "Inactivity cutoff in seconds",
            value: config.inactivitySeconds,
            min: 1,
            step: 1
        });

        section = createSetupSection(panel, "Participant counters");
        inputs.showTimeLeft = createCheckboxField(section, {
            id: "cs_show_time_left",
            label: "Show time-left counter to participant?",
            value: config.showTimeLeft
        });
        inputs.showMainCards = createCheckboxField(section, {
            id: "cs_show_main_cards",
            label: "Show main-card counter to participant?",
            value: config.showMainCards
        });
        inputs.showTotalPoints = createCheckboxField(section, {
            id: "cs_show_total_points",
            label: "Show total-points counter to participant?",
            value: config.showTotalPoints
        });

        section = createSetupSection(panel, "Per-click feedback");
        inputs.showClickFeedback = createCheckboxField(section, {
            id: "cs_show_click_feedback",
            label: "Show per-click point feedback?",
            value: config.showClickFeedback,
            note: "Controls whether participants see point and multiplier feedback after each card choice."
        });
        inputs.feedbackMessageMs = createNumberField(section, {
            id: "cs_feedback_message_ms",
            label: "Feedback message duration in milliseconds",
            value: config.feedbackMessageMs,
            min: 0,
            max: LIMITS.maxFeedbackMs,
            step: 1
        });

        section = createSetupSection(panel, "Screen advance and motion");
        inputs.usePostClickDelay = createCheckboxField(section, {
            id: "cs_use_post_click_delay",
            label: "Wait before next screen?",
            value: config.usePostClickDelay,
            note: "Controls whether the current screen remains visible briefly after a card click before advancing."
        });
        inputs.postClickDelayMs = createNumberField(section, {
            id: "cs_post_click_delay_ms",
            label: "Wait before next screen in milliseconds",
            value: config.postClickDelayMs,
            min: 0,
            max: LIMITS.maxFeedbackMs,
            step: 1
        });
        inputs.mainBonusDelayMs = createNumberField(section, {
            id: "cs_main_bonus_delay_ms",
            label: "L-th main-card wait before next screen in milliseconds",
            value: config.mainBonusDelayMs,
            min: 0,
            max: LIMITS.maxFeedbackMs,
            step: 1
        });
        inputs.screenMotionMs = createNumberField(section, {
            id: "cs_screen_motion_ms",
            label: "Screen motion duration in milliseconds",
            value: config.screenMotionMs,
            min: 0,
            max: LIMITS.maxMotionMs,
            step: 1
        });

        errorBox = element("div", "csq-validation-errors");
        errorBox.id = "csq-setup-errors";
        errorBox.setAttribute("role", "alert");
        errorBox.setAttribute("aria-live", "polite");
        root.appendChild(errorBox);

        continueButton = element("button", "csq-continue-button", "Continue");
        continueButton.type = "button";
        continueButton.id = "csq-setup-continue";
        root.appendChild(continueButton);

        function listen(target, eventName, callback) {
            target.addEventListener(eventName, callback, false);
            listeners.push({ target: target, eventName: eventName, callback: callback });
        }

        function setReadOnly(input, locked, title) {
            input.readOnly = locked;
            input.setAttribute("aria-disabled", locked ? "true" : "false");
            if (locked) {
                input.className = (input.className + " cs-setup-readonly").replace(/^\s+|\s+$/g, "");
                input.title = title;
            } else {
                input.className = input.className.replace(/(?:^|\s)cs-setup-readonly(?=\s|$)/g, "").replace(/^\s+|\s+$/g, "");
                input.title = "";
            }
        }

        function updateLocking() {
            setReadOnly(
                inputs.feedbackMessageMs,
                !inputs.showClickFeedback.checked,
                "Locked because per-click point feedback is set to No."
            );
            setReadOnly(
                inputs.postClickDelayMs,
                !inputs.usePostClickDelay.checked,
                "Locked because wait before next screen is set to No."
            );
            setReadOnly(
                inputs.mainBonusDelayMs,
                !inputs.usePostClickDelay.checked,
                "Locked because wait before next screen is set to No."
            );
        }

        function updateAutomaticValues() {
            var duration = numberValue(inputs.durationMinutes.value, 0);
            var threshold;
            if (!thresholdOverridden) {
                inputs.bonusThresholdMainCards.value = String(defaultThreshold(duration));
            }
            threshold = numberValue(inputs.bonusThresholdMainCards.value, 0);
            if (!pointsOverridden) {
                inputs.mainBonusPoints.value = formatNumber(defaultBonusPoints(threshold));
            }
        }

        function configFromInputs() {
            function inputNumber(input) {
                return input.value === "" ? NaN : Number(input.value);
            }
            return {
                durationMinutes: inputNumber(inputs.durationMinutes),
                numScreenTypes: inputNumber(inputs.numScreenTypes),
                showTimeLeft: inputs.showTimeLeft.checked,
                showMainCards: inputs.showMainCards.checked,
                showTotalPoints: inputs.showTotalPoints.checked,
                showClickFeedback: inputs.showClickFeedback.checked,
                feedbackMessageMs: inputNumber(inputs.feedbackMessageMs),
                usePostClickDelay: inputs.usePostClickDelay.checked,
                postClickDelayMs: inputNumber(inputs.postClickDelayMs),
                mainBonusDelayMs: inputNumber(inputs.mainBonusDelayMs),
                screenMotionMs: inputNumber(inputs.screenMotionMs),
                bonusThresholdMainCards: inputNumber(inputs.bonusThresholdMainCards),
                mainBonusPoints: inputNumber(inputs.mainBonusPoints),
                inactivitySeconds: inputNumber(inputs.inactivitySeconds)
            };
        }

        function showErrors(result) {
            var list;
            var index;
            var inputNodes = root.querySelectorAll("input");
            for (index = 0; index < inputNodes.length; index += 1) {
                inputNodes[index].removeAttribute("aria-invalid");
            }
            clearElement(errorBox);
            if (result.valid) {
                return;
            }
            appendText(errorBox, "p", "Please correct the following setup values:");
            list = element("ul");
            for (index = 0; index < result.errors.length; index += 1) {
                appendText(list, "li", result.errors[index].message);
                if (global.document.getElementById(result.errors[index].field)) {
                    global.document.getElementById(result.errors[index].field).setAttribute("aria-invalid", "true");
                }
            }
            errorBox.appendChild(list);
            if (global.document.getElementById(result.errors[0].field)) {
                global.document.getElementById(result.errors[0].field).focus();
            }
        }

        function continueToIntro() {
            var nextConfig = configFromInputs();
            var validation = validateConfig(nextConfig, Math.max(1, bootstrap.screenTypes.length));
            showErrors(validation);
            if (!validation.valid) {
                return;
            }
            clearOwnerCoordination();
            persistConfig(nextConfig);
            controller.cleanup();
            activeController = null;
            clickNextButton(question);
        }

        listen(inputs.showClickFeedback, "change", updateLocking);
        listen(inputs.usePostClickDelay, "change", updateLocking);
        listen(inputs.durationMinutes, "input", updateAutomaticValues);
        listen(inputs.bonusThresholdMainCards, "input", function () {
            thresholdOverridden = true;
            if (!pointsOverridden) {
                inputs.mainBonusPoints.value = formatNumber(
                    defaultBonusPoints(numberValue(inputs.bonusThresholdMainCards.value, 0))
                );
            }
        });
        listen(inputs.mainBonusPoints, "input", function () {
            pointsOverridden = true;
        });
        listen(continueButton, "click", continueToIntro);
        updateLocking();

        controller = {
            inputs: inputs,
            getConfig: configFromInputs,
            cleanup: function () {
                var index;
                for (index = 0; index < listeners.length; index += 1) {
                    listeners[index].target.removeEventListener(
                        listeners[index].eventName,
                        listeners[index].callback,
                        false
                    );
                }
                listeners = [];
                root.__csqController = null;
            }
        };
        root.__csqController = controller;
        activateController(question, controller);
        return controller;
    }

    function createPrng(seed) {
        var state = Number(seed) >>> 0;
        return function () {
            var value;
            state = (state + 0x6D2B79F5) >>> 0;
            value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    function randomSeed() {
        var values;
        if (global.crypto && typeof global.crypto.getRandomValues === "function" && global.Uint32Array) {
            values = new global.Uint32Array(1);
            global.crypto.getRandomValues(values);
            return values[0] >>> 0;
        }
        return ((Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0);
    }

    function shuffledIndices(length, random) {
        var output = [];
        var index;
        var swapIndex;
        var held;
        for (index = 0; index < length; index += 1) {
            output.push(index);
        }
        for (index = output.length - 1; index > 0; index -= 1) {
            swapIndex = Math.floor(random() * (index + 1));
            held = output[index];
            output[index] = output[swapIndex];
            output[swapIndex] = held;
        }
        return output;
    }

    function generateRandomization(seed, deckLength, numScreenTypes, maxDecisions) {
        var random = createPrng(seed);
        var colorOrder = shuffledIndices(deckLength, random);
        var mainColorIndex = colorOrder[Math.floor(random() * colorOrder.length)];
        var screenSequence = [];
        var index;
        for (index = 0; index < maxDecisions; index += 1) {
            screenSequence.push(Math.floor(random() * numScreenTypes) + 1);
        }
        return {
            seed: Number(seed) >>> 0,
            colorOrder: colorOrder,
            mainColorIndex: mainColorIndex,
            screenSequence: screenSequence,
            random: random
        };
    }

    function screenTypeByIndex(screenTypes, typeIndex) {
        var direct = screenTypes[typeIndex - 1];
        var index;
        if (direct && Number(direct.type_index) === Number(typeIndex)) {
            return direct;
        }
        for (index = 0; index < screenTypes.length; index += 1) {
            if (Number(screenTypes[index].type_index) === Number(typeIndex)) {
                return screenTypes[index];
            }
        }
        return screenTypes[0] || { type_index: typeIndex, side_values: [] };
    }

    function buildCards(screenType, colorOrder, mainColorIndex, cardDeck, screenNumber) {
        var cards = [];
        var sideValues = screenType.side_values || [];
        var sideIndex = 0;
        var orderIndex;
        var colorIndex;
        var deckCard;
        var isMain;
        var values;
        var card;
        for (orderIndex = 0; orderIndex < colorOrder.length; orderIndex += 1) {
            colorIndex = Number(colorOrder[orderIndex]);
            deckCard = cardDeck[colorIndex] || {};
            isMain = colorIndex === Number(mainColorIndex);
            card = {
                color_id: deckCard.color_id || "color_" + colorIndex,
                label: deckCard.label || "Card",
                color: deckCard.color || "#334155",
                position: orderIndex + 1,
                screen_number: screenNumber,
                screen_type_index: Number(screenType.type_index),
                is_main: isMain,
                id: isMain ? "main" : "side_" + (sideIndex + 1),
                x: null,
                y: null,
                z: null
            };
            if (!isMain) {
                values = sideValues[sideIndex] || {};
                sideIndex += 1;
                card.x = numberValue(values.x, 0);
                card.y = numberValue(values.y, 0);
                card.z = numberValue(values.z, 0);
            }
            cards.push(card);
        }
        return cards;
    }

    function calculateChoiceOutcome(card, state, config, randomValue, screenNumber) {
        var mainCardsCollected = state.mainCardsCollected;
        var mainBonusTriggered = state.mainBonusTriggered;
        var cardPointsAdded = 0;
        var multiplierApplied = false;
        var bonusThisRound = false;
        var bonusPointsAdded = 0;
        if (card.is_main) {
            mainCardsCollected += 1;
            bonusThisRound = !mainBonusTriggered &&
                config.bonusThresholdMainCards > 0 &&
                mainCardsCollected >= config.bonusThresholdMainCards;
            if (bonusThisRound) {
                mainBonusTriggered = true;
                bonusPointsAdded = config.mainBonusPoints;
            }
        } else {
            multiplierApplied = randomValue < card.y / 100;
            cardPointsAdded = multiplierApplied ? card.x * card.z : card.x;
        }
        return {
            pointsBefore: state.pointsAccumulated,
            cardPointsAdded: cardPointsAdded,
            multiplierApplied: multiplierApplied,
            mainCardsCollected: mainCardsCollected,
            mainBonusTriggered: mainBonusTriggered,
            mainBonusTriggeredThisRound: bonusThisRound,
            mainBonusPointsAdded: bonusPointsAdded,
            mainBonusTriggerScreen: bonusThisRound ? screenNumber : state.mainBonusTriggerScreen,
            pointsAfter: state.pointsAccumulated + cardPointsAdded + bonusPointsAdded
        };
    }

    function utf8ByteLength(value) {
        var text = String(value);
        var bytes = 0;
        var index;
        var code;
        for (index = 0; index < text.length; index += 1) {
            code = text.charCodeAt(index);
            if (code < 0x80) {
                bytes += 1;
            } else if (code < 0x800) {
                bytes += 2;
            } else if (code >= 0xD800 && code <= 0xDBFF &&
                    index + 1 < text.length &&
                    text.charCodeAt(index + 1) >= 0xDC00 &&
                    text.charCodeAt(index + 1) <= 0xDFFF) {
                bytes += 4;
                index += 1;
            } else {
                bytes += 3;
            }
        }
        return bytes;
    }

    function csvValue(value) {
        var text;
        if (value === null || typeof value === "undefined") {
            return "";
        }
        if (typeof value === "boolean") {
            return value ? "true" : "false";
        }
        text = String(value);
        if (/[",\r\n]/.test(text)) {
            return "\"" + text.replace(/"/g, "\"\"") + "\"";
        }
        return text;
    }

    function decisionToCsvRow(decision, columns) {
        var activeColumns = columns || DECISION_COLUMNS;
        var values = [];
        var index;
        for (index = 0; index < activeColumns.length; index += 1) {
            values.push(csvValue(decision[activeColumns[index]]));
        }
        return values.join(",") + "\r\n";
    }

    function packDecisionRows(decisions, maximumChunks, maximumBytes) {
        var chunks = [];
        var current = "";
        var currentBytes = 0;
        var overflowRows = 0;
        var index;
        var row;
        var rowBytes;
        var remaining;

        for (index = 0; index < decisions.length; index += 1) {
            row = decisionToCsvRow(decisions[index], DECISION_COLUMNS);
            rowBytes = utf8ByteLength(row);
            if (rowBytes > maximumBytes) {
                overflowRows += 1;
                continue;
            }
            if (current && currentBytes + rowBytes > maximumBytes) {
                if (chunks.length >= maximumChunks) {
                    remaining = decisions.length - index;
                    overflowRows += remaining;
                    current = "";
                    currentBytes = 0;
                    break;
                }
                chunks.push(current);
                current = "";
                currentBytes = 0;
            }
            if (chunks.length >= maximumChunks) {
                remaining = decisions.length - index;
                overflowRows += remaining;
                break;
            }
            current += row;
            currentBytes += rowBytes;
        }

        if (current) {
            if (chunks.length < maximumChunks) {
                chunks.push(current);
            } else {
                overflowRows += 1;
            }
        }

        return {
            columns: DECISION_COLUMNS.slice(0),
            chunks: chunks,
            overflow: overflowRows > 0,
            overflowRows: overflowRows
        };
    }

    function parseCsvBody(body) {
        var rows = [];
        var row = [];
        var field = "";
        var inQuotes = false;
        var index;
        var character;
        var next;
        if (!body) {
            return rows;
        }
        for (index = 0; index < body.length; index += 1) {
            character = body.charAt(index);
            next = index + 1 < body.length ? body.charAt(index + 1) : "";
            if (inQuotes) {
                if (character === "\"" && next === "\"") {
                    field += "\"";
                    index += 1;
                } else if (character === "\"") {
                    inQuotes = false;
                } else {
                    field += character;
                }
            } else if (character === "\"") {
                inQuotes = true;
            } else if (character === ",") {
                row.push(field);
                field = "";
            } else if (character === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            } else if (character !== "\r") {
                field += character;
            }
        }
        if (field !== "" || row.length) {
            row.push(field);
            rows.push(row);
        }
        return rows;
    }

    function rowsToDecisionObjects(rows, columns) {
        var decisions = [];
        var rowIndex;
        var columnIndex;
        var decision;
        for (rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            decision = {};
            for (columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
                decision[columns[columnIndex]] = typeof rows[rowIndex][columnIndex] === "undefined" ?
                    "" : rows[rowIndex][columnIndex];
            }
            decisions.push(decision);
        }
        return decisions;
    }

    function persistRandomization(randomization, cardDeck) {
        var labels = [];
        var index;
        for (index = 0; index < randomization.colorOrder.length; index += 1) {
            labels.push((cardDeck[randomization.colorOrder[index]] || {}).label || "Card");
        }
        setEmbeddedData("cs_seed", randomization.seed);
        setEmbeddedData("cs_color_order", JSON.stringify(labels));
        setEmbeddedData("cs_color_order_indices", JSON.stringify(randomization.colorOrder));
        setEmbeddedData("cs_main_color", (cardDeck[randomization.mainColorIndex] || {}).label || "Card");
        setEmbeddedData("cs_main_color_index", randomization.mainColorIndex);
        setEmbeddedData("cs_screen_sequence", JSON.stringify(randomization.screenSequence));
    }

    function persistFinalData(state, status, bootstrap) {
        var packed = packDecisionRows(
            state.decisions,
            bootstrap.chunkCount,
            bootstrap.chunkMaxBytes
        );
        var elapsed = Math.max(0, Date.now() - state.startedAtWall);
        var index;
        var fieldName;

        setEmbeddedData("cs_task_status", status);
        setEmbeddedData("cs_decision_count", state.decisions.length);
        setEmbeddedData("cs_task_elapsed_ms", elapsed);
        setEmbeddedData("cs_final_points", state.pointsAccumulated);
        setEmbeddedData("cs_main_cards_collected", state.mainCardsCollected);
        setEmbeddedData("cs_main_bonus_triggered", state.mainBonusTriggered ? "1" : "0");
        setEmbeddedData(
            "cs_main_bonus_trigger_screen",
            state.mainBonusTriggerScreen === null ? "" : state.mainBonusTriggerScreen
        );
        setEmbeddedData("cs_activity_event_count", state.activityEventCount || 0);
        setEmbeddedData("cs_last_activity_source", state.lastActivitySource || "");
        setEmbeddedData(
            "cs_inactivity_elapsed_ms_at_end",
            state.inactivityElapsedMsAtEnd || 0
        );
        setEmbeddedData(
            "cs_activity_listener_targets",
            state.activityListenerTargetCount || 0
        );
        setEmbeddedData(
            "cs_event_counts_supported",
            state.eventCountsSupported ? "1" : "0"
        );
        setEmbeddedData("cs_game_root_count", state.gameRootCount || 0);
        setEmbeddedData("cs_game_instance_token", state.instanceToken || "");
        setEmbeddedData("cs_authoritative_instance", state.isAuthoritative ? "1" : "0");
        setEmbeddedData("cs_suppressed_by_peer", state.suppressedByPeer ? "1" : "0");
        setEmbeddedData("cs_authority_channel", state.authorityChannel || "");
        setEmbeddedData("cs_owner_claim_source", state.ownerClaimSource || "");
        setEmbeddedData("cs_log_columns", DECISION_COLUMNS.join(","));
        setEmbeddedData("cs_log_chunk_count", packed.chunks.length);
        setEmbeddedData("cs_log_format_version", "csv-v1");
        setEmbeddedData("cs_log_overflow", packed.overflow ? "1" : "0");
        setEmbeddedData("cs_log_overflow_rows", packed.overflowRows);

        for (index = 0; index < bootstrap.chunkCount; index += 1) {
            fieldName = "cs_log_chunk_" + ("00" + (index + 1)).slice(-3);
            setEmbeddedData(fieldName, index < packed.chunks.length ? packed.chunks[index] : "");
        }

        lastResult = {
            status: status,
            elapsedMs: elapsed,
            decisions: state.decisions.slice(0),
            packed: packed
        };
        global.CSQ_LAST_RESULT = lastResult;
        return packed;
    }

    function initGame(question) {
        var root = getRoot("csq-game-root", question);
        var bootstrap = readBootstrap();
        var bootstrapError = validateBootstrap(bootstrap);
        var config;
        var storedSeed;
        var seed;
        var randomization;
        var controller;
        var task;
        var statusRow;
        var statusLeft;
        var statusRight;
        var timeLeftDisplay;
        var inactivityDisplay;
        var pointsDisplay;
        var mainCardDisplay;
        var cueDisplay;
        var cardRow;
        var state;
        var eventNames = [
            "pointermove",
            "pointerdown",
            "mousemove",
            "mousedown",
            "keydown",
            "touchstart",
            "wheel",
            "scroll",
            "click"
        ];
        var eventCountNames = [
            "click",
            "pointerdown",
            "pointerup",
            "mousedown",
            "mouseup",
            "keydown",
            "touchstart"
        ];
        var eventCountSnapshot = {};
        var activityTargets = [];
        var intervalId = null;
        var timeoutIds = [];
        var index;

        if (!root) {
            return null;
        }
        if (root.__csqController) {
            return root.__csqController;
        }

        function addActivityTarget(target) {
            if (target && typeof target.addEventListener === "function" &&
                    activityTargets.indexOf(target) === -1) {
                activityTargets.push(target);
            }
        }

        addActivityTarget(root);
        addActivityTarget(root.ownerDocument);
        addActivityTarget(root.ownerDocument && root.ownerDocument.defaultView);
        addActivityTarget(global.document);
        addActivityTarget(global);

        hideNextButton(question);
        clearElement(root);
        config = readConfig(bootstrap);
        storedSeed = getEmbeddedData("cs_seed");
        seed = storedSeed === "" || !isFiniteNumber(Number(storedSeed)) ? randomSeed() : Number(storedSeed) >>> 0;
        randomization = bootstrapError ? null : generateRandomization(
            seed,
            bootstrap.cardDeck.length,
            config.numScreenTypes,
            bootstrap.maxDecisions
        );

        task = element("div", "cs-task");
        task.style.setProperty("--cs-screen-motion-ms", config.screenMotionMs + "ms");
        root.appendChild(task);
        statusRow = element("div", "cs-status");
        statusLeft = element("div", "cs-status-left");
        statusRight = element("div", "cs-status-right");
        statusRow.appendChild(statusLeft);
        statusRow.appendChild(statusRight);
        task.appendChild(statusRow);

        if (config.showTimeLeft) {
            timeLeftDisplay = element("span", "", "Time left: " + formatClock(config.durationMinutes * 60000));
            timeLeftDisplay.id = "cs-time-left-display";
            statusLeft.appendChild(timeLeftDisplay);
        }
        inactivityDisplay = element("span", "", "Inactivity limit: " + config.inactivitySeconds + "s");
        inactivityDisplay.id = "cs-inactivity-display";
        statusLeft.appendChild(inactivityDisplay);
        if (config.showTotalPoints) {
            pointsDisplay = element("span", "", "Total Points: 0");
            pointsDisplay.id = "cs-points-display";
            statusRight.appendChild(pointsDisplay);
        }
        if (config.showMainCards) {
            mainCardDisplay = element("span", "", "Main cards collected: 0");
            mainCardDisplay.id = "cs-main-card-display";
            statusRight.appendChild(mainCardDisplay);
        }
        cueDisplay = element("div", "cs-cue");
        cueDisplay.id = "cs-cue";
        cueDisplay.setAttribute("aria-live", "polite");
        task.appendChild(cueDisplay);
        cardRow = element("div", "cs-card-row cs-card-row-new");
        cardRow.id = "cs-card-row";
        cardRow.setAttribute("aria-label", "Card choices");
        task.appendChild(cardRow);

        state = {
            instanceToken: Date.now().toString(36) + "-" + randomSeed().toString(36),
            isAuthoritative: false,
            suppressedByPeer: false,
            authorityChannel: "",
            ownerClaimSource: "",
            startedAtWall: Date.now(),
            currentScreenStartedAt: nowMonotonic(),
            currentScreenNumber: 1,
            pointsAccumulated: 0,
            mainCardsCollected: 0,
            mainBonusTriggered: false,
            mainBonusTriggerScreen: null,
            lastActivityAt: nowMonotonic(),
            lastActivitySource: "game_start",
            activityEventCount: 0,
            inactivityElapsedMsAtEnd: 0,
            activityListenerTargetCount: activityTargets.length,
            eventCountsSupported: Boolean(
                global.performance &&
                global.performance.eventCounts &&
                typeof global.performance.eventCounts.get === "function"
            ),
            gameRootCount: root.ownerDocument &&
                typeof root.ownerDocument.querySelectorAll === "function" ?
                root.ownerDocument.querySelectorAll("#csq-game-root").length : 1,
            lastChoiceAcceptedAt: -Infinity,
            decisions: [],
            waiting: false,
            finished: false,
            random: randomization ? randomization.random : Math.random
        };

        function schedule(callback, delay) {
            var timeoutId = global.setTimeout(callback, Math.max(0, delay));
            timeoutIds.push(timeoutId);
            return timeoutId;
        }

        function taskElapsedMs() {
            return Math.max(0, Date.now() - state.startedAtWall);
        }

        function durationMs() {
            return Math.max(0, Math.round(config.durationMinutes * 60000));
        }

        function durationExpired() {
            return durationMs() > 0 && taskElapsedMs() >= durationMs();
        }

        function inactivityElapsedMs() {
            return Math.max(0, nowMonotonic() - state.lastActivityAt);
        }

        function foreignOwner() {
            var owner = readOwnerRecord();
            return owner && owner.token !== state.instanceToken ? owner : null;
        }

        function claimAuthority(source, requireVisible) {
            var owner;
            var written;
            if (state.isAuthoritative) {
                return true;
            }
            owner = readOwnerRecord();
            if (owner && owner.token !== state.instanceToken) {
                state.suppressedByPeer = true;
                return false;
            }
            if (requireVisible && !isLikelyVisible(root)) {
                state.suppressedByPeer = true;
                return false;
            }
            written = writeOwnerRecord(state.instanceToken, source);
            owner = readOwnerRecord();
            if (owner && owner.token !== state.instanceToken) {
                state.suppressedByPeer = true;
                return false;
            }
            state.isAuthoritative = true;
            state.authorityChannel = written.channel;
            state.ownerClaimSource = source || "activity";
            return true;
        }

        function suppressForPeer() {
            if (state.finished) {
                return;
            }
            state.suppressedByPeer = true;
            state.finished = true;
            controller.cleanup();
            if (activeController === controller) {
                activeController = null;
            }
        }

        function markActivity(source) {
            if (state.finished) {
                return false;
            }
            if (!claimAuthority(source || "activity", false)) {
                suppressForPeer();
                return false;
            }
            state.lastActivityAt = nowMonotonic();
            state.lastActivitySource = source || "activity";
            state.activityEventCount += 1;
            return true;
        }

        function initializeEventCounts() {
            var eventIndex;
            var current;
            if (!state.eventCountsSupported) {
                return;
            }
            for (eventIndex = 0; eventIndex < eventCountNames.length; eventIndex += 1) {
                current = global.performance.eventCounts.get(eventCountNames[eventIndex]);
                eventCountSnapshot[eventCountNames[eventIndex]] = Number(current) || 0;
            }
        }

        function pollEventCounts() {
            var eventIndex;
            var eventName;
            var previous;
            var current;
            if (!state.eventCountsSupported) {
                return;
            }
            for (eventIndex = 0; eventIndex < eventCountNames.length; eventIndex += 1) {
                eventName = eventCountNames[eventIndex];
                previous = eventCountSnapshot[eventName] || 0;
                current = Number(global.performance.eventCounts.get(eventName)) || 0;
                if (current > previous) {
                    markActivity("performance_event:" + eventName);
                }
                eventCountSnapshot[eventName] = current;
            }
        }

        function updateCounters() {
            if (pointsDisplay) {
                pointsDisplay.textContent = "Total Points: " + formatNumber(state.pointsAccumulated);
            }
            if (mainCardDisplay) {
                mainCardDisplay.textContent = "Main cards collected: " + state.mainCardsCollected;
            }
        }

        function cueBox(message, className) {
            return element("span", "cs-cue-box " + (className || ""), message);
        }

        function showCue(message, className, sideMessage, sideClassName) {
            if (!config.showClickFeedback || !message) {
                return;
            }
            clearElement(cueDisplay);
            cueDisplay.appendChild(cueBox(message, className));
            if (sideMessage) {
                cueDisplay.appendChild(cueBox(sideMessage, sideClassName));
            }
            cueDisplay.className = "cs-cue cs-cue-visible";
            if (config.feedbackMessageMs > 0) {
                schedule(function () {
                    cueDisplay.className = "cs-cue";
                    schedule(function () {
                        clearElement(cueDisplay);
                    }, 90);
                }, config.feedbackMessageMs);
            }
        }

        function cardsForCurrentScreen() {
            var sequenceIndex = Math.max(0, state.currentScreenNumber - 1);
            var typeIndex = randomization.screenSequence[sequenceIndex];
            var screenType = screenTypeByIndex(bootstrap.screenTypes, typeIndex);
            return buildCards(
                screenType,
                randomization.colorOrder,
                randomization.mainColorIndex,
                bootstrap.cardDeck,
                state.currentScreenNumber
            );
        }

        function disableCards(selectedButton) {
            var buttons = cardRow.querySelectorAll(".cs-card");
            var buttonIndex;
            for (buttonIndex = 0; buttonIndex < buttons.length; buttonIndex += 1) {
                buttons[buttonIndex].disabled = true;
                if (buttons[buttonIndex] === selectedButton) {
                    buttons[buttonIndex].className += " cs-card-selected";
                }
            }
        }

        function finish(status) {
            if (state.finished) {
                return;
            }
            if (foreignOwner()) {
                suppressForPeer();
                return;
            }
            if (!claimAuthority("task_end:" + status, true)) {
                suppressForPeer();
                return;
            }
            state.inactivityElapsedMsAtEnd = Math.round(inactivityElapsedMs());
            state.finished = true;
            persistRandomization(randomization, bootstrap.cardDeck);
            persistFinalData(state, status, bootstrap);
            controller.cleanup();
            activeController = null;
            global.setTimeout(function () {
                clickNextButton(question);
            }, 0);
        }

        function advanceScreen() {
            if (state.finished) {
                return;
            }
            if (durationExpired()) {
                finish("duration");
                return;
            }
            if (state.decisions.length >= bootstrap.maxDecisions) {
                finish("max_decisions");
                return;
            }
            state.currentScreenNumber += 1;
            state.waiting = false;
            renderCards();
        }

        function submitChoice(card, button) {
            var responseTime;
            var elapsed;
            var outcome;
            var decision;
            var delay;
            var acceptedAt;
            if (state.finished || state.waiting) {
                return;
            }
            if (durationExpired()) {
                finish("duration");
                return;
            }
            acceptedAt = nowMonotonic();
            if (acceptedAt - state.lastChoiceAcceptedAt < 250) {
                return;
            }
            state.lastChoiceAcceptedAt = acceptedAt;
            if (!markActivity("card_choice")) {
                return;
            }
            state.waiting = true;
            responseTime = Math.max(0, Math.round(nowMonotonic() - state.currentScreenStartedAt));
            elapsed = taskElapsedMs();
            outcome = calculateChoiceOutcome(
                card,
                state,
                config,
                card.is_main ? 1 : state.random(),
                state.currentScreenNumber
            );
            state.pointsAccumulated = outcome.pointsAfter;
            state.mainCardsCollected = outcome.mainCardsCollected;
            state.mainBonusTriggered = outcome.mainBonusTriggered;
            state.mainBonusTriggerScreen = outcome.mainBonusTriggerScreen;
            decision = {
                screen_number: state.currentScreenNumber,
                screen_type_index: card.screen_type_index,
                chosen_card_id: card.id,
                chosen_card_label: card.label,
                chosen_card_position: card.position,
                chosen_is_main: card.is_main,
                chosen_x: card.is_main ? null : card.x,
                chosen_y: card.is_main ? null : card.y,
                chosen_z: card.is_main ? null : card.z,
                response_time_ms: responseTime,
                task_elapsed_ms: elapsed,
                main_cards_collected: outcome.mainCardsCollected,
                points_before: outcome.pointsBefore,
                card_points_added: outcome.cardPointsAdded,
                multiplier_applied: outcome.multiplierApplied,
                multiplier_y: card.is_main ? null : card.y,
                multiplier_z: card.is_main ? null : card.z,
                main_bonus_triggered_this_round: outcome.mainBonusTriggeredThisRound,
                main_bonus_points_added: outcome.mainBonusPointsAdded,
                points_after: outcome.pointsAfter
            };
            state.decisions.push(decision);
            updateCounters();
            disableCards(button);

            if (outcome.mainBonusTriggeredThisRound) {
                showCue(
                    "+" + formatNumber(outcome.mainBonusPointsAdded) +
                        " points -- collected " + config.bonusThresholdMainCards + " main cards",
                    "cs-cue-main-bonus"
                );
            } else if (outcome.multiplierApplied) {
                showCue(
                    "+" + formatNumber(outcome.cardPointsAdded) + " points",
                    "cs-cue-points",
                    formatNumber(card.z) + "x",
                    "cs-cue-multiplier-badge"
                );
            } else if (!card.is_main) {
                showCue("+" + formatNumber(outcome.cardPointsAdded) + " points", "cs-cue-points");
            } else {
                showCue("+1 " + card.label, "cs-cue-points");
            }

            if (state.decisions.length >= bootstrap.maxDecisions) {
                finish("max_decisions");
                return;
            }
            if (config.usePostClickDelay) {
                delay = outcome.mainBonusTriggeredThisRound ?
                    config.mainBonusDelayMs : config.postClickDelayMs;
                schedule(advanceScreen, delay);
            } else {
                advanceScreen();
            }
        }

        function renderCards() {
            var cards;
            var cardIndex;
            var card;
            var button;
            var label;
            var points;
            var multiplier;
            if (state.finished) {
                return;
            }
            state.currentScreenStartedAt = nowMonotonic();
            cardRow.className = "cs-card-row";
            cardRow.offsetWidth;
            clearElement(cardRow);
            cards = cardsForCurrentScreen();
            for (cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
                card = cards[cardIndex];
                button = element("button", "cs-card");
                button.type = "button";
                button.style.setProperty("--card-color", card.color);
                button.setAttribute("data-card-id", card.id);
                button.setAttribute("data-card-label", card.label);
                button.setAttribute("data-position", String(card.position));
                button.setAttribute("data-is-main", card.is_main ? "true" : "false");
                label = element("span", "cs-card-label", card.label);
                button.appendChild(label);
                if (!card.is_main) {
                    points = element("span", "cs-points", "Points: " + formatNumber(card.x));
                    multiplier = element(
                        "span",
                        "cs-multiplier",
                        formatNumber(card.y) + "% of " + formatNumber(card.z) + "x"
                    );
                    button.appendChild(points);
                    button.appendChild(multiplier);
                }
                (function (selectedCard, selectedButton) {
                    function choose(event) {
                        if (event && event.type === "keydown" &&
                                event.key !== "Enter" && event.key !== " ") {
                            return;
                        }
                        submitChoice(selectedCard, selectedButton);
                    }
                    selectedButton.addEventListener("pointerup", choose, false);
                    selectedButton.addEventListener("click", choose, false);
                    selectedButton.addEventListener("keydown", choose, false);
                }(card, button));
                cardRow.appendChild(button);
            }
            cardRow.className = "cs-card-row cs-card-row-new";
        }

        function resetActivity(event) {
            markActivity(event && event.type ? event.type : "activity_event");
        }

        function updateClocks() {
            var elapsedSeconds;
            var remaining;
            if (state.finished) {
                return;
            }
            if (foreignOwner()) {
                suppressForPeer();
                return;
            }
            if (timeLeftDisplay) {
                timeLeftDisplay.textContent = "Time left: " +
                    formatClock(Math.max(0, durationMs() - taskElapsedMs()));
            }
            if (durationExpired()) {
                finish("duration");
                return;
            }
            pollEventCounts();
            elapsedSeconds = Math.floor(inactivityElapsedMs() / 1000);
            remaining = Math.max(0, config.inactivitySeconds - elapsedSeconds);
            inactivityDisplay.textContent = "Inactivity limit: " + remaining + "s";
            if (elapsedSeconds >= config.inactivitySeconds) {
                finish("inactive");
            }
        }

        controller = {
            state: state,
            finish: finish,
            cleanup: function () {
                var timeoutIndex;
                var targetIndex;
                if (intervalId !== null) {
                    global.clearInterval(intervalId);
                    intervalId = null;
                }
                for (timeoutIndex = 0; timeoutIndex < timeoutIds.length; timeoutIndex += 1) {
                    global.clearTimeout(timeoutIds[timeoutIndex]);
                }
                timeoutIds = [];
                for (targetIndex = 0; targetIndex < activityTargets.length; targetIndex += 1) {
                    for (timeoutIndex = 0; timeoutIndex < eventNames.length; timeoutIndex += 1) {
                        activityTargets[targetIndex].removeEventListener(
                            eventNames[timeoutIndex],
                            resetActivity,
                            true
                        );
                    }
                }
                root.__csqController = null;
            }
        };
        root.__csqController = controller;
        activateController(question, controller);

        if (bootstrapError) {
            clearElement(task);
            task.appendChild(element("div", "cs-debug-notice", bootstrapError));
            finish("error");
            return controller;
        }

        persistRandomization(randomization, bootstrap.cardDeck);
        initializeEventCounts();
        for (var targetIndex = 0; targetIndex < activityTargets.length; targetIndex += 1) {
            for (index = 0; index < eventNames.length; index += 1) {
                activityTargets[targetIndex].addEventListener(eventNames[index], resetActivity, true);
            }
        }
        updateCounters();
        renderCards();
        updateClocks();
        intervalId = global.setInterval(updateClocks, 250);
        return controller;
    }

    function addDefinition(list, term, value) {
        list.appendChild(element("dt", "", term));
        list.appendChild(element("dd", "", value === "" ? "" : String(value)));
    }

    function yesNo(value) {
        return parseBoolean(value, false) ? "Yes" : "No";
    }

    function packedDecisionsFromEmbeddedData(bootstrap) {
        var rawColumns = String(getEmbeddedData("cs_log_columns") || DECISION_COLUMNS.join(","));
        var columns = rawColumns.split(",");
        var chunkCount = clamp(
            Math.floor(numberValue(getEmbeddedData("cs_log_chunk_count"), 0)),
            0,
            bootstrap.chunkCount
        );
        var body = "";
        var index;
        var name;
        for (index = 0; index < chunkCount; index += 1) {
            name = "cs_log_chunk_" + ("00" + (index + 1)).slice(-3);
            body += String(getEmbeddedData(name) || "");
        }
        return rowsToDecisionObjects(parseCsvBody(body), columns);
    }

    function renderDecisionTable(parent, decisions) {
        var wrapper = element("div", "csq-debug-table-wrap");
        var table = element("table", "cs-debug-table");
        var head = element("thead");
        var headRow = element("tr");
        var body = element("tbody");
        var fragment = global.document.createDocumentFragment();
        var columnIndex;
        var rowIndex;
        var row;
        var value;
        for (columnIndex = 0; columnIndex < DECISION_COLUMNS.length; columnIndex += 1) {
            headRow.appendChild(element("th", "", DECISION_COLUMNS[columnIndex]));
        }
        head.appendChild(headRow);
        table.appendChild(head);
        for (rowIndex = 0; rowIndex < decisions.length; rowIndex += 1) {
            row = element("tr");
            for (columnIndex = 0; columnIndex < DECISION_COLUMNS.length; columnIndex += 1) {
                value = decisions[rowIndex][DECISION_COLUMNS[columnIndex]];
                if ((DECISION_COLUMNS[columnIndex] === "chosen_x" ||
                        DECISION_COLUMNS[columnIndex] === "chosen_y" ||
                        DECISION_COLUMNS[columnIndex] === "chosen_z") &&
                        parseBoolean(decisions[rowIndex].chosen_is_main, false)) {
                    value = "N/A";
                } else if (DECISION_COLUMNS[columnIndex] === "chosen_is_main" ||
                        DECISION_COLUMNS[columnIndex] === "multiplier_applied" ||
                        DECISION_COLUMNS[columnIndex] === "main_bonus_triggered_this_round") {
                    value = yesNo(value);
                }
                row.appendChild(element("td", "", value));
            }
            fragment.appendChild(row);
        }
        body.appendChild(fragment);
        table.appendChild(body);
        wrapper.appendChild(table);
        parent.appendChild(wrapper);
    }

    function renderNormalOutcome(root, bootstrap, status) {
        var decisions = lastResult && lastResult.status === status ?
            lastResult.decisions : packedDecisionsFromEmbeddedData(bootstrap);
        var panel;
        var list;
        var details;
        var pre;
        var warning;

        appendText(root, "h2", "Development debug summary");
        root.appendChild(element(
            "div",
            "cs-debug-notice",
            "This page is only for debugging during development. Do not show this page in the production experiment."
        ));
        panel = element("div", "cs-debug-panel");
        appendText(panel, "h3", "Development-only configuration and outcome");
        list = element("dl");
        addDefinition(list, "Task status", status);
        addDefinition(list, "Task duration", getEmbeddedData("cs_duration_minutes") + " minutes");
        addDefinition(list, "Possible screen types", getEmbeddedData("cs_num_screen_types"));
        addDefinition(list, "Time-left counter shown", yesNo(getEmbeddedData("cs_show_time_left")));
        addDefinition(list, "Main-card counter shown", yesNo(getEmbeddedData("cs_show_main_cards")));
        addDefinition(list, "Total-points counter shown", yesNo(getEmbeddedData("cs_show_total_points")));
        addDefinition(list, "Per-click point feedback shown", yesNo(getEmbeddedData("cs_show_click_feedback")));
        addDefinition(list, "Feedback message duration", getEmbeddedData("cs_feedback_message_ms") + " ms");
        addDefinition(list, "Wait before next screen used", yesNo(getEmbeddedData("cs_use_post_click_delay")));
        addDefinition(list, "Wait before next screen", getEmbeddedData("cs_post_click_delay_ms") + " ms");
        addDefinition(list, "L-th main-card wait before next screen", getEmbeddedData("cs_main_bonus_delay_ms") + " ms");
        addDefinition(list, "Screen motion duration", getEmbeddedData("cs_screen_motion_ms") + " ms");
        addDefinition(list, "Main-card bonus threshold (L)", getEmbeddedData("cs_bonus_threshold_main_cards"));
        addDefinition(list, "Main-card bonus points (Q)", getEmbeddedData("cs_main_bonus_points"));
        addDefinition(list, "Answered decision screens", getEmbeddedData("cs_decision_count"));
        addDefinition(list, "Main cards collected", getEmbeddedData("cs_main_cards_collected"));
        addDefinition(list, "Total Points", getEmbeddedData("cs_final_points"));
        addDefinition(list, "Main-card bonus triggered", yesNo(getEmbeddedData("cs_main_bonus_triggered")));
        addDefinition(list, "Main-card bonus trigger screen", getEmbeddedData("cs_main_bonus_trigger_screen"));
        addDefinition(list, "Participant color order", getEmbeddedData("cs_color_order"));
        addDefinition(list, "Main-card color", getEmbeddedData("cs_main_color"));
        addDefinition(list, "Randomization seed", getEmbeddedData("cs_seed"));
        addDefinition(list, "Inactivity cutoff", getEmbeddedData("cs_inactivity_seconds") + " seconds");
        addDefinition(list, "Captured activity events", getEmbeddedData("cs_activity_event_count"));
        addDefinition(list, "Last captured activity", getEmbeddedData("cs_last_activity_source"));
        addDefinition(
            list,
            "Activity listener targets",
            getEmbeddedData("cs_activity_listener_targets")
        );
        addDefinition(
            list,
            "Performance event counter supported",
            yesNo(getEmbeddedData("cs_event_counts_supported"))
        );
        addDefinition(list, "Game roots found", getEmbeddedData("cs_game_root_count"));
        addDefinition(
            list,
            "Authoritative game instance",
            yesNo(getEmbeddedData("cs_authoritative_instance"))
        );
        addDefinition(list, "Authority claim source", getEmbeddedData("cs_owner_claim_source"));
        addDefinition(list, "Authority channel", getEmbeddedData("cs_authority_channel"));
        addDefinition(
            list,
            "Suppressed by another preview instance",
            yesNo(getEmbeddedData("cs_suppressed_by_peer"))
        );
        addDefinition(
            list,
            "Inactivity elapsed at task end",
            formatNumber(numberValue(getEmbeddedData("cs_inactivity_elapsed_ms_at_end"), 0) / 1000) +
                " seconds"
        );
        addDefinition(
            list,
            "Total task elapsed time",
            formatNumber(numberValue(getEmbeddedData("cs_task_elapsed_ms"), 0) / 1000) + " seconds"
        );
        panel.appendChild(list);
        root.appendChild(panel);

        if (parseBoolean(getEmbeddedData("cs_log_overflow"), false)) {
            warning = element(
                "div",
                "cs-debug-notice",
                "Decision-log storage overflowed. " + getEmbeddedData("cs_log_overflow_rows") +
                    " decision rows were not stored."
            );
            root.appendChild(warning);
        }
        if (decisions.length) {
            renderDecisionTable(root, decisions);
        } else {
            appendText(root, "p", "No decision rows were recorded.");
        }

        details = element("details", "cs-debug-details");
        appendText(details, "summary", "Generated possible screen types");
        pre = element("pre", "", JSON.stringify(bootstrap.screenTypes, null, 2));
        details.appendChild(pre);
        root.appendChild(details);
        details = element("details", "cs-debug-details");
        appendText(details, "summary", "Sampled screen sequence");
        pre = element("pre", "", getEmbeddedData("cs_screen_sequence"));
        details.appendChild(pre);
        root.appendChild(details);
        appendText(
            root,
            "p",
            "End of development run. This terminal debug page will be removed or replaced before the production experiment.",
            "cs-debug-end"
        );
    }

    function initOutcome(question) {
        var root = getRoot("csq-outcome-root", question);
        var bootstrap = readBootstrap();
        var status = String(getEmbeddedData("cs_task_status") || "unknown");
        var controller;
        var labelTimeouts = [];
        if (!root) {
            return null;
        }
        if (root.__csqController) {
            return root.__csqController;
        }
        clearElement(root);
        root.className = (root.className + " cs-debug").replace(/^\s+|\s+$/g, "");
        if (status === "inactive") {
            appendText(root, "h2", "Task ended");
            appendText(
                root,
                "p",
                "The task ended because there were " + getEmbeddedData("cs_inactivity_seconds") +
                    " consecutive seconds of inactivity."
            );
            appendText(root, "p", "You have lost the opportunity to earn a bonus from this task.");
        }
        renderNormalOutcome(root, bootstrap, status);
        showNextButton(question);
        setFinishButtonLabel(question);
        labelTimeouts.push(global.setTimeout(function () {
            setFinishButtonLabel(question);
        }, 0));
        labelTimeouts.push(global.setTimeout(function () {
            setFinishButtonLabel(question);
        }, 100));
        controller = {
            status: status,
            cleanup: function () {
                var index;
                for (index = 0; index < labelTimeouts.length; index += 1) {
                    global.clearTimeout(labelTimeouts[index]);
                }
                labelTimeouts = [];
                root.__csqController = null;
            }
        };
        root.__csqController = controller;
        activateController(question, controller);
        return controller;
    }

    global.CSQ = {
        initSetup: initSetup,
        initGame: initGame,
        initOutcome: initOutcome,
        cleanup: cleanup,
        __test: {
            defaults: DEFAULTS,
            limits: LIMITS,
            decisionColumns: DECISION_COLUMNS.slice(0),
            parseBoolean: parseBoolean,
            validateConfig: validateConfig,
            createPrng: createPrng,
            generateRandomization: generateRandomization,
            buildCards: buildCards,
            calculateChoiceOutcome: calculateChoiceOutcome,
            utf8ByteLength: utf8ByteLength,
            csvValue: csvValue,
            decisionToCsvRow: decisionToCsvRow,
            packDecisionRows: packDecisionRows,
            parseCsvBody: parseCsvBody,
            rowsToDecisionObjects: rowsToDecisionObjects,
            readBootstrap: readBootstrap,
            getEmbeddedData: getEmbeddedData,
            setEmbeddedData: setEmbeddedData,
            packedDecisionsFromEmbeddedData: packedDecisionsFromEmbeddedData
        }
    };
}(window));
