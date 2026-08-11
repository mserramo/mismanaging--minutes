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
    SIDE_TASKS,
    draw_sequence,
    load_profile,
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
