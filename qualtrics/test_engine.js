#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

global.window = global;
require("./card_stacking_qualtrics.js");

const engine = global.CSQ.__test;
const columns = engine.decisionColumns;

function decision(index) {
    return {
        screen_number: index + 1,
        screen_type_index: (index % 50) + 1,
        chosen_card_id: index % 5 === 0 ? "main" : `side_${(index % 4) + 1}`,
        chosen_card_label: `Card "${index}, café"`,
        chosen_card_position: (index % 5) + 1,
        chosen_is_main: index % 5 === 0,
        chosen_x: index % 5 === 0 ? null : (index % 12) + 1,
        chosen_y: index % 5 === 0 ? null : (index % 21) + 10,
        chosen_z: index % 5 === 0 ? null : (index % 4) + 1,
        response_time_ms: 500 + index,
        task_elapsed_ms: 500 * (index + 1),
        main_cards_collected: Math.floor(index / 5) + 1,
        points_before: index * 6,
        card_points_added: index % 5 === 0 ? 0 : 6,
        multiplier_applied: index % 7 === 0,
        multiplier_y: index % 5 === 0 ? null : (index % 21) + 10,
        multiplier_z: index % 5 === 0 ? null : (index % 4) + 1,
        main_bonus_triggered_this_round: index === 274,
        main_bonus_points_added: index === 274 ? 1650 : 0,
        points_after: (index + 1) * 6 + (index >= 274 ? 1650 : 0)
    };
}

const randomizationA = engine.generateRandomization(20260810, 5, 50, 4800);
const randomizationB = engine.generateRandomization(20260810, 5, 50, 4800);
assert.deepEqual(randomizationA.colorOrder, randomizationB.colorOrder);
assert.equal(randomizationA.mainColorIndex, randomizationB.mainColorIndex);
assert.deepEqual(randomizationA.screenSequence, randomizationB.screenSequence);
assert.equal(randomizationA.screenSequence.length, 4800);
assert.deepEqual([...randomizationA.colorOrder].sort(), [0, 1, 2, 3, 4]);
assert.ok(randomizationA.screenSequence.every((value) => value >= 1 && value <= 50));

const sideCard = { is_main: false, x: 10, y: 20, z: 3 };
const emptyState = {
    pointsAccumulated: 0,
    mainCardsCollected: 0,
    mainBonusTriggered: false,
    mainBonusTriggerScreen: null
};
const scoringConfig = { bonusThresholdMainCards: 55, mainBonusPoints: 1650 };
const multiplierSuccess = engine.calculateChoiceOutcome(
    sideCard, emptyState, scoringConfig, 0.1, 1
);
const multiplierFailure = engine.calculateChoiceOutcome(
    sideCard, emptyState, scoringConfig, 0.9, 1
);
assert.equal(multiplierSuccess.multiplierApplied, true);
assert.equal(multiplierSuccess.cardPointsAdded, 30);
assert.equal(multiplierFailure.multiplierApplied, false);
assert.equal(multiplierFailure.cardPointsAdded, 10);

const bonusState = {
    pointsAccumulated: 100,
    mainCardsCollected: 54,
    mainBonusTriggered: false,
    mainBonusTriggerScreen: null
};
const bonusOutcome = engine.calculateChoiceOutcome(
    { is_main: true }, bonusState, scoringConfig, 1, 275
);
assert.equal(bonusOutcome.mainCardsCollected, 55);
assert.equal(bonusOutcome.mainBonusTriggeredThisRound, true);
assert.equal(bonusOutcome.mainBonusTriggerScreen, 275);
assert.equal(bonusOutcome.mainBonusPointsAdded, 1650);
assert.equal(bonusOutcome.pointsAfter, 1750);

const maximumRun = Array.from({ length: 4800 }, (_, index) => decision(index));
const packed = engine.packDecisionRows(maximumRun, 64, 18000);
assert.equal(packed.overflow, false);
assert.equal(packed.overflowRows, 0);
assert.ok(packed.chunks.length > 1 && packed.chunks.length <= 64);
assert.ok(packed.chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 18000));

const decodedRows = engine.parseCsvBody(packed.chunks.join(""));
const decoded = engine.rowsToDecisionObjects(decodedRows, columns);
assert.equal(decoded.length, 4800);
assert.equal(decoded[0].chosen_card_label, 'Card "0, café"');
assert.equal(decoded[4799].screen_number, "4800");
assert.ok(decodedRows.every((row) => row.length === columns.length));

const overflow = engine.packDecisionRows(maximumRun, 1, 18000);
assert.equal(overflow.overflow, true);
assert.ok(overflow.overflowRows > 0);
assert.equal(overflow.chunks.length, 1);

if (process.argv[2]) {
    const exportFields = [
        "ResponseId",
        "cs_log_columns",
        "cs_log_chunk_count",
        "cs_log_format_version",
        "cs_log_overflow",
        "cs_log_overflow_rows",
        ...Array.from({ length: 64 }, (_, index) =>
            `cs_log_chunk_${String(index + 1).padStart(3, "0")}`
        )
    ];
    const exportValues = [
        "R_SYNTHETIC_4800",
        columns.join(","),
        String(packed.chunks.length),
        "csv-v1",
        "0",
        "0",
        ...Array.from({ length: 64 }, (_, index) => packed.chunks[index] || "")
    ];
    const exportCell = (value) => {
        const text = String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    fs.writeFileSync(
        process.argv[2],
        `${exportFields.map(exportCell).join(",")}\r\n` +
        `${exportValues.map(exportCell).join(",")}\r\n`,
        "utf8"
    );
}

console.log(
    `OK: engine tests passed; ${packed.chunks.length} chunks for 4,800 rows; ` +
    `largest chunk ${Math.max(...packed.chunks.map((chunk) => Buffer.byteLength(chunk, "utf8")))} bytes`
);
