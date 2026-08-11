#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

global.window = global;
const bankPath = process.env.CSQ_BANK_PATH || "qualtrics/certified_environment_bank.json";
const bank = JSON.parse(fs.readFileSync(bankPath, "utf8"));
const bankMetadata = Object.fromEntries(Object.entries(bank).filter(([key]) => key !== "sequences"));
const bankJson = JSON.stringify(bank);
const bankChunks = Array.from(
    { length: Math.ceil(Buffer.byteLength(bankJson, "utf8") / 18000) },
    (_, index) => bankJson.slice(index * 18000, (index + 1) * 18000)
);
const embeddedData = {
    cs_bank_format_version: "json-v1",
    cs_bank_chunk_count: String(bankChunks.length)
};
bankChunks.forEach((chunk, index) => {
    embeddedData[`cs_bank_chunk_${String(index + 1).padStart(3, "0")}`] = chunk;
});
global.Qualtrics = {
    SurveyEngine: {
        getEmbeddedData: (name) => embeddedData[name] || "",
        setEmbeddedData: (name, value) => { embeddedData[name] = String(value); }
    }
};
global.CSQ_BOOTSTRAP = { bankMetadata, chunkCount: 64, chunkMaxBytes: 18000 };
require("./card_stacking_qualtrics.js");

const engine = global.CSQ.__test;
const profile = bank.profile;
const sideIds = new Set(profile.side_tasks.map((task) => task.id));
assert.equal(engine.defaults.showMain, false);
assert.equal(engine.defaults.showMovie, false);
assert.equal(engine.defaults.showPoints, true);
assert.equal(engine.defaults.showMainCardPayoff, false);
assert.equal(engine.defaults.showMovieCardPayoff, false);
assert.equal(engine.defaults.showSideCardPayoff, true);
assert.equal(engine.defaults.inactivitySeconds, 120);
assert.equal(Object.hasOwn(engine.defaults, "showSidePoints"), false);
const firstRuleEnvironment = engine.decodeEnvironment(bank, bank.sequences[0]);
const preMovieRuleGroups = engine.ruleGroupsForEnvironment(profile, firstRuleEnvironment, false);
const movieRuleGroups = engine.ruleGroupsForEnvironment(profile, firstRuleEnvironment, true);
const allRuleTaskIds = [
    "main", "trio_a", "trio_b", "fives", "cumulative_a",
    "cumulative_b", "infinite_scroll", "simple_a", "simple_b", "movie"
];
const allRuleGroupIds = ["main", "trio", "fives", "cumulative", "infinite_scroll", "simple", "movie"];
const preMovieMembers = preMovieRuleGroups.flatMap((group) => group.members);
const movieMembers = movieRuleGroups.flatMap((group) => group.members);

assert.equal(preMovieRuleGroups.length, 6);
assert.equal(movieRuleGroups.length, 7);
assert.deepEqual(
    new Set(preMovieRuleGroups.map((group) => group.groupId)),
    new Set(allRuleGroupIds.filter((groupId) => groupId !== "movie"))
);
assert.deepEqual(new Set(movieRuleGroups.map((group) => group.groupId)), new Set(allRuleGroupIds));
assert.equal(preMovieMembers.length, 9);
assert.equal(new Set(preMovieMembers.map((member) => member.taskId)).size, 9);
assert.equal(movieMembers.length, 10);
assert.equal(new Set(movieMembers.map((member) => member.taskId)).size, 10);
assert.deepEqual(
    new Set(preMovieMembers.map((member) => member.taskId)),
    new Set(allRuleTaskIds.filter((taskId) => taskId !== "movie"))
);
assert.deepEqual(new Set(movieMembers.map((member) => member.taskId)), new Set(allRuleTaskIds));
allRuleTaskIds.forEach((taskId) => {
    assert.equal(movieMembers.filter((member) => member.taskId === taskId).length, 1);
});
assert.deepEqual(
    preMovieRuleGroups.find((group) => group.groupId === "trio").members.map((member) => member.taskId),
    ["trio_a", "trio_b"]
);
assert.deepEqual(
    preMovieRuleGroups.find((group) => group.groupId === "cumulative").members.map((member) => member.taskId),
    ["cumulative_a", "cumulative_b"]
);
assert.deepEqual(
    preMovieRuleGroups.find((group) => group.groupId === "simple").members.map((member) => member.taskId),
    ["simple_a", "simple_b"]
);
movieMembers.forEach((member) => {
    assert.equal(member.color, profile.colors[firstRuleEnvironment.colorMap[member.taskId]]);
});
assert.deepEqual(
    preMovieRuleGroups.map((group) => group.groupId),
    movieRuleGroups.filter((group) => group.groupId !== "movie").map((group) => group.groupId)
);
assert.deepEqual(
    engine.ruleGroupsForEnvironment(profile, firstRuleEnvironment, false).map((group) => group.groupId),
    preMovieRuleGroups.map((group) => group.groupId)
);
assert.deepEqual(
    engine.ruleGroupsForEnvironment(profile, firstRuleEnvironment, true).map((group) => group.groupId),
    movieRuleGroups.map((group) => group.groupId)
);
assert.ok(new Set(bank.sequences.slice(0, 32).map((sequence) => {
    const environment = engine.decodeEnvironment(bank, sequence);
    return engine.ruleGroupsForEnvironment(profile, environment, false).map((group) => group.groupId).join(",");
})).size > 1);
assert.equal(
    engine.sharedAccumulationNote,
    "Each color accumulates separately—cards of different colors are never combined. Unless stated otherwise, accumulation may be nonconsecutive."
);
assert.match(preMovieRuleGroups.find((group) => group.groupId === "trio").description, /every 3 cards of the same color/i);
assert.match(preMovieRuleGroups.find((group) => group.groupId === "fives").description, /every 5 cards of the same color/i);
assert.match(preMovieRuleGroups.find((group) => group.groupId === "infinite_scroll").description, /consecutive/i);
assert.match(preMovieRuleGroups.find((group) => group.groupId === "infinite_scroll").description, /resets/i);
movieRuleGroups.forEach((group) => {
    assert.doesNotMatch(group.description, /\bpoints?\b/i);
    assert.match(group.description, /pts\./i);
});
assert.equal(preMovieRuleGroups.filter((group) => group.groupId === "movie").length, 0);
assert.equal(movieRuleGroups.filter((group) => group.groupId === "movie").length, 1);

function mockStyle() {
    const values = new Map();
    return {
        getPropertyPriority: (name) => values.get(name)?.priority || "",
        getPropertyValue: (name) => values.get(name)?.value || "",
        removeProperty: (name) => {
            const previous = values.get(name)?.value || "";
            values.delete(name);
            return previous;
        },
        setProperty: (name, value, priority = "") => {
            values.set(name, { value: String(value), priority: String(priority) });
        }
    };
}

function mockGapRoot(baseTop) {
    const style = mockStyle();
    return {
        style,
        getBoundingClientRect: () => ({
            top: baseTop + Number.parseFloat(style.getPropertyValue("margin-top") || "0")
        })
    };
}

function mockHeader(bottom, width = 200, height = 40) {
    return { getBoundingClientRect: () => ({ bottom, width, height }) };
}

const hadOwnDocument = Object.hasOwn(global, "document");
const originalDocument = global.document;
try {
    const excessiveRoot = mockGapRoot(200);
    global.document = { querySelector: () => mockHeader(100) };
    assert.deepEqual(engine.compactGameTopGap(excessiveRoot), { headerFound: true, gap: 100, offset: 82 });
    assert.equal(excessiveRoot.style.getPropertyValue("margin-top"), "-82px");
    assert.equal(excessiveRoot.style.getPropertyPriority("margin-top"), "important");

    const smallGapRoot = mockGapRoot(124);
    assert.deepEqual(engine.compactGameTopGap(smallGapRoot), { headerFound: true, gap: 24, offset: 0 });
    assert.equal(smallGapRoot.style.getPropertyValue("margin-top"), "");

    const cappedRoot = mockGapRoot(300);
    assert.deepEqual(engine.compactGameTopGap(cappedRoot), { headerFound: true, gap: 200, offset: 120 });
    assert.equal(cappedRoot.style.getPropertyValue("margin-top"), "-120px");

    const missingHeaderRoot = mockGapRoot(200);
    global.document = { querySelector: () => null };
    assert.deepEqual(engine.compactGameTopGap(missingHeaderRoot), { headerFound: false, gap: 0, offset: 0 });
    assert.equal(missingHeaderRoot.style.getPropertyValue("margin-top"), "");

    const hiddenHeaderRoot = mockGapRoot(200);
    global.document = { querySelector: () => mockHeader(100, 0, 40) };
    assert.deepEqual(engine.compactGameTopGap(hiddenHeaderRoot), { headerFound: false, gap: 0, offset: 0 });
    assert.equal(hiddenHeaderRoot.style.getPropertyValue("margin-top"), "");

    const repeatRoot = mockGapRoot(200);
    global.document = { querySelector: () => mockHeader(100) };
    const firstGapResult = engine.compactGameTopGap(repeatRoot);
    const secondGapResult = engine.compactGameTopGap(repeatRoot);
    assert.deepEqual(secondGapResult, firstGapResult);
    assert.equal(repeatRoot.style.getPropertyValue("margin-top"), "-82px");
} finally {
    if (hadOwnDocument) { global.document = originalDocument; }
    else { delete global.document; }
}
assert.equal(engine.validateBootstrap(engine.readBootstrap()), "");
assert.equal(engine.validateBootstrap(engine.readBootstrap(false), false), "");
assert.equal(engine.readBootstrap().bank.sequences.length, bank.sequences.length);
assert.ok(bankChunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 18000));
if (!process.env.CSQ_BANK_PATH) {
    assert.equal(bank.sequences.length, 2048);
}

for (const packed of bank.sequences) {
    const environment = engine.decodeEnvironment(bank, packed);
    assert.equal(environment.rounds.length, 100);
    assert.equal(environment.sequenceId, packed.sequence_id);
    for (const round of environment.rounds) {
        const ids = round.cards.map((card) => card.taskId);
        assert.equal(ids.filter((id) => id === "main").length, 1);
        assert.equal(new Set(ids).size, ids.length);
        const sideCount = ids.filter((id) => sideIds.has(id)).length;
        assert.equal(sideCount, profile.side_cards_per_round);
        if (round.number <= 80) {
            assert.equal(ids.includes("movie"), false);
            assert.equal(ids.length, profile.side_cards_per_round + 1);
            assert.equal(ids.at(-1), "main");
        } else {
            assert.equal(ids.filter((id) => id === "movie").length, 1);
            assert.equal(ids.length, profile.side_cards_per_round + 2);
            assert.equal(ids.at(-2), "main");
            assert.equal(ids.at(-1), "movie");
        }
        for (const card of round.cards) {
            assert.ok(environment.colorMap[card.taskId] >= 0 && environment.colorMap[card.taskId] < 10);
        }
    }
    for (let index = 0; index < environment.rounds.length;) {
        const hasInfinite = environment.rounds[index].cards.some((card) => card.taskId === "infinite_scroll");
        if (!hasInfinite) { index += 1; continue; }
        const start = index;
        while (index + 1 < environment.rounds.length && environment.rounds[index + 1].cards.some(
            (card) => card.taskId === "infinite_scroll"
        )) { index += 1; }
        const end = index;
        assert.ok(end - start + 1 >= 4 && end - start + 1 <= 7);
        const runId = environment.rounds[start].infiniteRunId;
        for (let runIndex = start; runIndex <= end; runIndex += 1) {
            const round = environment.rounds[runIndex];
            assert.equal(round.infiniteRunId, runId);
            assert.equal(round.infiniteRunStart, start + 1);
            assert.equal(round.infiniteRunEnd, end + 1);
            assert.equal(round.infiniteRoundsRemaining, end - runIndex + 1);
        }
        index += 1;
    }
}

const definitions = Object.fromEntries(profile.side_tasks.map((task) => [task.id, task]));
function round(taskId, simplePayoff, runId = null) {
    return {
        number: 1,
        cards: [{ taskId, simplePayoff, position: 1 }],
        infiniteRunId: runId,
        infiniteRoundsRemaining: runId ? 4 : null
    };
}
function chooseRepeated(taskId, times, simplePayoff = null, runId = null) {
    const state = engine.initialTaskState();
    const gains = [];
    const currentRound = round(taskId, simplePayoff, runId);
    for (let index = 0; index < times; index += 1) {
        gains.push(engine.applyChoice(profile, state, currentRound, currentRound.cards[0]));
    }
    return { state, gains };
}

assert.deepEqual(chooseRepeated("trio_a", 4).gains, [0, 0, 30, 0]);
assert.deepEqual(chooseRepeated("trio_b", 3).gains, [0, 0, 36]);
assert.deepEqual(chooseRepeated("fives", 6).gains, [0, 0, 0, 0, 60, 0]);
assert.deepEqual(chooseRepeated("cumulative_a", 4).gains, [2, 4, 6, 8]);
assert.deepEqual(chooseRepeated("cumulative_b", 4).gains, [1, 4, 7, 10]);
assert.deepEqual(chooseRepeated("infinite_scroll", 4, null, 7).gains, [2, 6, 10, 14]);
assert.deepEqual(chooseRepeated("simple_a", 1, 12).gains, [12]);
assert.deepEqual(chooseRepeated("simple_b", 1, 16).gains, [16]);
assert.equal(definitions.trio_a.group_bonus, 30);

const progressState = engine.initialTaskState();
const defaultCardTextConfig = {
    showMainCardPayoff: false,
    showMovieCardPayoff: false,
    showSideCardPayoff: true
};
const allCardPayoffsConfig = {
    showMainCardPayoff: true,
    showMovieCardPayoff: true,
    showSideCardPayoff: true
};
const hiddenNonSimplePayoffsConfig = {
    showMainCardPayoff: false,
    showMovieCardPayoff: false,
    showSideCardPayoff: false
};
assert.equal(engine.taskProgressText(profile, progressState, round("main"), round("main").cards[0]), "");
assert.equal(engine.taskProgressText(profile, progressState, round("simple_a", 12), round("simple_a", 12).cards[0]), "+12 pts.");
assert.equal(engine.taskProgressText(profile, progressState, round("cumulative_a"), round("cumulative_a").cards[0]), "+2 pts.");
progressState.counts.cumulative_a = 2;
assert.equal(engine.taskProgressText(profile, progressState, round("cumulative_a"), round("cumulative_a").cards[0]), "+6 pts.");
progressState.runCounts["7"] = 2;
assert.equal(engine.taskProgressText(profile, progressState, round("infinite_scroll", null, 7), round("infinite_scroll", null, 7).cards[0]), "+10 pts. · 4 rounds left in this run");
assert.equal(engine.cardPayoffText(profile, progressState, round("simple_a", 12), round("simple_a", 12).cards[0], hiddenNonSimplePayoffsConfig), "+12 pts.");
assert.equal(engine.cardPayoffText(profile, progressState, round("cumulative_a"), round("cumulative_a").cards[0], hiddenNonSimplePayoffsConfig), "");
assert.equal(engine.cardFooterText(profile, progressState, round("trio_a"), round("trio_a").cards[0]), "3 more for +30 pts. bonus");
progressState.counts.trio_a = 2;
assert.equal(engine.cardDisplayText(profile, progressState, round("trio_a"), round("trio_a").cards[0], defaultCardTextConfig).payoff, "+30 pts.");
assert.equal(engine.cardDisplayText(profile, progressState, round("trio_a"), round("trio_a").cards[0], defaultCardTextConfig).footer, "1 more for +30 pts. bonus");
assert.equal(engine.cardDisplayText(profile, progressState, round("trio_a"), round("trio_a").cards[0], hiddenNonSimplePayoffsConfig).payoff, "");
assert.equal(engine.cardDisplayText(profile, progressState, round("trio_a"), round("trio_a").cards[0], hiddenNonSimplePayoffsConfig).footer, "1 more for +30 pts. bonus");
assert.doesNotMatch(engine.taskProgressText(profile, progressState, round("trio_a"), round("trio_a").cards[0]), /chosen|selected|next/i);
const thresholdState = engine.initialTaskState();
assert.equal(engine.cardPayoffText(profile, thresholdState, round("main"), round("main").cards[0], allCardPayoffsConfig), "+0 pts.");
thresholdState.main = profile.main_target - 1;
assert.equal(engine.cardPayoffText(profile, thresholdState, round("main"), round("main").cards[0], defaultCardTextConfig), "");
assert.equal(engine.cardPayoffText(profile, thresholdState, round("main"), round("main").cards[0], allCardPayoffsConfig), "+3,000 pts.");
thresholdState.movie = profile.movie_rounds - 1;
assert.equal(engine.cardPayoffText(profile, thresholdState, round("movie"), round("movie").cards[0], allCardPayoffsConfig), "+3,000 pts.");
assert.equal(engine.cardFooterText(profile, thresholdState, round("main"), round("main").cards[0]), "");
assert.equal(engine.cardFooterText(profile, thresholdState, round("movie"), round("movie").cards[0]), "");
const totalState = engine.initialTaskState();
totalState.sidePay = 100;
assert.equal(engine.awardedTotalPoints(engine.profileValues(profile), totalState), 100);
totalState.main = profile.main_target;
assert.equal(engine.awardedTotalPoints(engine.profileValues(profile), totalState), 100 + profile.main_bonus);
totalState.movie = profile.movie_rounds;
assert.equal(engine.awardedTotalPoints(engine.profileValues(profile), totalState), 100 + profile.main_bonus + profile.movie_bonus);

const sampleEnvironment = engine.decodeEnvironment(bank, bank.sequences[0]);
const sampleDecisions = Array.from({ length: 100 }, (_, index) => ({
    round: index + 1,
    phase: index < 80 ? "ordinary" : "movie",
    sequence_id: sampleEnvironment.sequenceId,
    seed: sampleEnvironment.seed,
    chosen_task_id: index < 60 ? "main" : index < 80 ? "simple_a" : "movie",
    chosen_task_label: "Synthetic",
    chosen_position: 1,
    chosen_is_main: index < 60 ? 1 : 0,
    chosen_is_movie: index >= 80 ? 1 : 0,
    chosen_is_side: index >= 60 && index < 80 ? 1 : 0,
    displayed_choice_set_json: JSON.stringify(sampleEnvironment.rounds[index].cards),
    task_state_before_json: JSON.stringify({ main: Math.min(index, 60), movie: Math.max(0, index - 80) }),
    task_state_after_json: JSON.stringify({ main: Math.min(index + 1, 60), movie: Math.max(0, index - 79) }),
    side_points_added: index >= 60 && index < 80 ? 8 : 0,
    side_points_total: Math.max(0, Math.min(index - 59, 20)) * 8,
    main_count: Math.min(index + 1, 60),
    movie_count: Math.max(0, index - 79),
    main_complete: index >= 59 ? 1 : 0,
    movie_complete: index === 99 ? 1 : 0,
    main_bonus_awarded: index >= 59 ? profile.main_bonus : 0,
    movie_bonus_awarded: index === 99 ? profile.movie_bonus : 0,
    total_points: 0,
    response_time_ms: 500,
    task_elapsed_ms: 500 * (index + 1),
    infinite_run_id: "",
    infinite_rounds_remaining: ""
}));
const packed = engine.packDecisionRows(sampleDecisions, 64, 18000);
assert.equal(packed.overflow, false);
assert.equal(packed.overflowRows, 0);
assert.ok(packed.chunks.length > 0 && packed.chunks.length <= 64);
assert.ok(packed.chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 18000));
const rows = engine.parseCsvBody(packed.chunks.join(""));
assert.equal(rows.length, 100);
assert.ok(rows.every((row) => row.length === engine.decisionColumns.length));
assert.ok(rows[99][engine.decisionColumns.indexOf("displayed_choice_set_json")].includes("movie"));

const environmentRecords = sampleEnvironment.rounds.map((item) =>
    [item.number, item.phase, JSON.stringify(item.cards), item.infiniteRunId || ""].map(engine.csvValue).join(",") + "\r\n"
);
const environmentPacked = engine.packRecords(environmentRecords, 64, 18000);
assert.equal(environmentPacked.overflow, false);
assert.ok(environmentPacked.chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 18000));

if (process.argv[2]) {
    const fields = [
        "ResponseId", "cs_log_columns", "cs_log_chunk_count", "cs_log_format_version",
        "cs_log_overflow", "cs_log_overflow_rows",
        ...Array.from({ length: 64 }, (_, index) => `cs_log_chunk_${String(index + 1).padStart(3, "0")}`)
    ];
    const values = [
        "R_SYNTHETIC_V2", engine.decisionColumns.join(","), String(packed.chunks.length),
        "csv-v2", "0", "0", ...Array.from({ length: 64 }, (_, index) => packed.chunks[index] || "")
    ];
    const exportCell = (value) => /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
    fs.writeFileSync(process.argv[2], `${fields.map(exportCell).join(",")}\r\n${values.map(exportCell).join(",")}\r\n`, "utf8");
}

console.log(`OK: ${bank.sequences.length} certified environments decoded; csv-v2 used ${packed.chunks.length} chunks`);
