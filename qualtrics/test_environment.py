#!/usr/bin/env python3
"""Fast structural tests for the parameterized pre-drawn environment."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from generate_environment import (
    DEFAULT_PROFILE,
    REGIMES,
    Round,
    SIDE_TASKS,
    apply_choice,
    cp_model,
    draw_sequence,
    initial_task_state,
    load_profile,
    optimize_regime,
    trace_choices,
    validate_round_structure,
)


class FixedSideCardTests(unittest.TestCase):
    def test_profile_accepts_only_integer_counts_one_through_four(self) -> None:
        raw_profile = json.loads(DEFAULT_PROFILE.read_text())
        with tempfile.TemporaryDirectory() as directory:
            profile_path = Path(directory) / "profile.json"
            for valid_count in range(1, 5):
                with self.subTest(valid_count=valid_count):
                    candidate = copy.deepcopy(raw_profile)
                    candidate["side_cards_per_round"] = valid_count
                    profile_path.write_text(json.dumps(candidate))
                    self.assertEqual(
                        load_profile(profile_path)["side_cards_per_round"],
                        valid_count,
                    )
            for invalid_count in (0, 5, 2.5, True, "4"):
                with self.subTest(invalid_count=invalid_count):
                    candidate = copy.deepcopy(raw_profile)
                    candidate["side_cards_per_round"] = invalid_count
                    profile_path.write_text(json.dumps(candidate))
                    with self.assertRaisesRegex(ValueError, "side_cards_per_round"):
                        load_profile(profile_path)

    def test_one_through_four_side_cards_are_fixed_within_sequence(self) -> None:
        baseline = load_profile(DEFAULT_PROFILE)
        for side_cards_per_round in range(1, 5):
            with self.subTest(side_cards_per_round=side_cards_per_round):
                profile = copy.deepcopy(baseline)
                profile["side_cards_per_round"] = side_cards_per_round
                _seed, rounds, _colors = draw_sequence(profile, 1)
                validate_round_structure(profile, rounds)
                self.assertEqual(
                    {
                        sum(task_id in SIDE_TASKS for task_id in round_data.cards)
                        for round_data in rounds
                    },
                    {side_cards_per_round},
                )
                ordinary_sizes = {
                    len(round_data.cards)
                    for round_data in rounds
                    if round_data.phase == "ordinary"
                }
                movie_sizes = {
                    len(round_data.cards)
                    for round_data in rounds
                    if round_data.phase == "movie"
                }
                self.assertEqual(ordinary_sizes, {side_cards_per_round + 1})
                self.assertEqual(movie_sizes, {side_cards_per_round + 2})
                for round_data in rounds:
                    self.assertEqual(
                        round_data.cards[side_cards_per_round],
                        "main",
                    )
                    if round_data.phase == "movie":
                        self.assertEqual(round_data.cards[-1], "movie")


class InfiniteScrollingStreakTests(unittest.TestCase):
    def setUp(self) -> None:
        self.profile = load_profile(DEFAULT_PROFILE)

    @staticmethod
    def availability_round(number: int, run_id: int = 1) -> Round:
        return Round(
            number=number,
            phase="ordinary",
            cards=("infinite_scroll", "fives", "main", "movie"),
            simple_payoffs={},
            infinite_run_id=run_id,
            infinite_run_start=1,
            infinite_run_end=5,
        )

    def test_every_non_infinite_choice_breaks_the_current_streak(self) -> None:
        for breaker in ("main", "movie", "fives"):
            with self.subTest(breaker=breaker):
                state = initial_task_state()
                self.assertEqual(
                    apply_choice(
                        self.profile, state, self.availability_round(1),
                        "infinite_scroll",
                    ),
                    2,
                )
                self.assertEqual(
                    apply_choice(
                        self.profile, state, self.availability_round(2),
                        "infinite_scroll",
                    ),
                    6,
                )
                apply_choice(
                    self.profile, state, self.availability_round(3), breaker
                )
                self.assertEqual(state["run_streaks"]["1"], 0)
                self.assertEqual(
                    apply_choice(
                        self.profile, state, self.availability_round(4),
                        "infinite_scroll",
                    ),
                    2,
                )
                self.assertEqual(
                    apply_choice(
                        self.profile, state, self.availability_round(5),
                        "infinite_scroll",
                    ),
                    6,
                )

    def test_run_ids_match_runtime_chronological_reconstruction(self) -> None:
        for sequence_id in range(1, int(self.profile["bank_size"]) + 1):
            _seed, rounds, _color_map = draw_sequence(self.profile, sequence_id)
            expected_run_id = 0
            active_run_id = None
            previous_has_infinite = False
            for round_data in rounds:
                has_infinite = "infinite_scroll" in round_data.cards
                if has_infinite and not previous_has_infinite:
                    expected_run_id += 1
                    active_run_id = expected_run_id
                    self.assertEqual(round_data.infinite_run_start, round_data.number)
                if has_infinite:
                    self.assertEqual(round_data.infinite_run_id, active_run_id)
                    self.assertIsNotNone(round_data.infinite_run_start)
                    self.assertIsNotNone(round_data.infinite_run_end)
                    self.assertLessEqual(
                        int(round_data.infinite_run_start), round_data.number
                    )
                    self.assertGreaterEqual(
                        int(round_data.infinite_run_end), round_data.number
                    )
                else:
                    self.assertIsNone(round_data.infinite_run_id)
                    active_run_id = None
                previous_has_infinite = has_infinite

    @unittest.skipIf(cp_model is None, "OR-Tools is required for CP-SAT tests")
    def test_exact_optimizer_matches_streak_trace_in_all_regimes(self) -> None:
        profile = copy.deepcopy(self.profile)
        profile.update(
            rounds=10,
            movie_rounds=2,
            main_target=6,
            side_budget=2,
        )
        rounds = []
        for index in range(10):
            run_id = 1 if index < 5 else 2
            cards = ("infinite_scroll", "fives", "main")
            if index >= 8:
                cards += ("movie",)
            rounds.append(
                Round(
                    number=index + 1,
                    phase="movie" if index >= 8 else "ordinary",
                    cards=cards,
                    simple_payoffs={},
                    infinite_run_id=run_id,
                    infinite_run_start=1 if run_id == 1 else 6,
                    infinite_run_end=5 if run_id == 1 else 10,
                )
            )

        expected_values = {
            (0, 0): 120,
            (0, 1): 78,
            (1, 0): 32,
            (1, 1): 8,
        }
        for regime in REGIMES:
            with self.subTest(regime=regime):
                first = optimize_regime(profile, rounds, regime, canonical=True)
                second = optimize_regime(profile, rounds, regime, canonical=True)
                self.assertEqual(first, second)
                value, choices, _side_count = first
                _trace, state = trace_choices(profile, rounds, choices)
                self.assertEqual(value, expected_values[regime])
                self.assertEqual(state["side_pay"], value)
                self.assertEqual(state["main"], regime[0] * profile["main_target"])
                self.assertEqual(state["movie"], regime[1] * profile["movie_rounds"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
