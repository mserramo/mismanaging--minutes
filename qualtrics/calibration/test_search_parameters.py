#!/usr/bin/env python3
from __future__ import annotations

import json
import random
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from search_parameters import (
    DEFAULT_CONFIG,
    RoundDraw,
    SIDE_TASKS,
    conservative_upper_bound,
    cumulative_total,
    derive_bonuses,
    draw_sequence,
    load_config,
    make_candidates,
    run,
    run_total,
    start_now_points_per_card,
    subset_distribution,
    variant_separation_details,
)


class ParameterSearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = load_config(DEFAULT_CONFIG)
        cls.candidate = make_candidates(cls.config)[0]

    def test_subset_distribution_is_exact_and_has_distinct_cards(self) -> None:
        for count in (3, 4):
            distribution = subset_distribution(self.candidate.non_is_weights, count)
            self.assertAlmostEqual(sum(probability for _subset, probability in distribution), 1.0)
            self.assertTrue(all(len(subset) == count for subset, _probability in distribution))
            self.assertTrue(all(len(set(subset)) == count for subset, _probability in distribution))

    def test_unfiltered_draws_always_have_four_side_cards_and_bounded_runs(self) -> None:
        ordinary = subset_distribution(self.candidate.non_is_weights, 4)
        run = subset_distribution(self.candidate.non_is_weights, 3)
        sequence = draw_sequence(self.candidate, 400, random.Random(98765), ordinary, run)
        self.assertTrue(all(len(round_data.side_tasks) == 4 for round_data in sequence))
        self.assertTrue(all(len(set(round_data.side_tasks)) == 4 for round_data in sequence))
        run_lengths = {
            round_data.run_length for round_data in sequence if round_data.run_length is not None
        }
        self.assertTrue(run_lengths)
        self.assertTrue(run_lengths <= set(self.candidate.is_duration_probabilities))

    def test_conservative_bounds_are_monotone(self) -> None:
        values = [conservative_upper_bound(self.candidate, count) for count in range(21)]
        self.assertEqual(values, sorted(values))

    def test_derived_bonuses_certify_requested_ordering(self) -> None:
        result = derive_bonuses(self.config, self.candidate)
        self.assertTrue(result["robust_ordering_certified"])
        self.assertGreater(result["guaranteed_gap_both_over_main"], 0)
        self.assertGreater(result["guaranteed_gap_main_over_movie"], 0)
        self.assertGreater(result["guaranteed_gap_movie_over_neither"], 0)
        self.assertEqual(result["derived_main_bonus"] % 5, 0)
        self.assertEqual(result["derived_movie_bonus"] % 5, 0)

    def test_every_generated_candidate_has_distinct_variants(self) -> None:
        candidates = make_candidates(self.config)
        self.assertTrue(
            all(
                variant_separation_details(self.config, candidate)[
                    "variant_separation_pass"
                ]
                for candidate in candidates
            )
        )

        weights = dict(self.candidate.non_is_weights)
        for first, second in (
            ("trio_a", "trio_b"),
            ("cumulative_a", "cumulative_b"),
            ("simple_a", "simple_b"),
        ):
            shared = (weights[first] + weights[second]) / 2
            weights[first] = shared
            weights[second] = shared
        duplicate = replace(
            self.candidate,
            non_is_weights=weights,
            group_bonuses={
                **self.candidate.group_bonuses,
                "trio_b": self.candidate.group_bonuses["trio_a"],
            },
            cumulative={
                "cumulative_a": self.candidate.cumulative["cumulative_a"],
                "cumulative_b": self.candidate.cumulative["cumulative_a"],
            },
            simple_tasks={
                "simple_a": self.candidate.simple_tasks["simple_a"],
                "simple_b": self.candidate.simple_tasks["simple_a"],
            },
        )
        details = variant_separation_details(self.config, duplicate)
        self.assertFalse(details["variant_separation_pass"])
        self.assertFalse(details["trio_variants_distinct"])
        self.assertFalse(details["cumulative_variants_distinct"])
        self.assertFalse(details["simple_variants_distinct"])

    def test_start_now_value_uses_future_availability_and_current_payoff(self) -> None:
        trio = "trio_a"
        cumulative = "cumulative_a"
        simple = "simple_a"
        infinite_scroll = "infinite_scroll"
        rounds = [
            RoundDraw((trio, cumulative, simple, infinite_scroll), {simple: 12}, 7, 1, 3),
            RoundDraw((trio, cumulative, infinite_scroll), {}, 7, 2, 3),
            RoundDraw((trio, cumulative, infinite_scroll), {}, 7, 3, 3),
            RoundDraw(("fives",), {}, None, None, None),
        ]
        self.assertEqual(
            start_now_points_per_card(self.candidate, trio, rounds, 0, 20),
            self.candidate.group_bonuses[trio] / 3,
        )
        self.assertEqual(
            start_now_points_per_card(self.candidate, trio, rounds, 1, 20),
            0,
        )
        self.assertEqual(
            start_now_points_per_card(self.candidate, simple, rounds, 0, 20),
            12,
        )
        self.assertEqual(
            start_now_points_per_card(self.candidate, cumulative, rounds, 0, 20),
            cumulative_total(self.candidate.cumulative[cumulative], 3) / 3,
        )
        self.assertEqual(
            start_now_points_per_card(self.candidate, infinite_scroll, rounds, 0, 20),
            run_total(self.candidate.infinite_scroll, 3) / 3,
        )

    def test_small_search_is_reproducible(self) -> None:
        raw = json.loads(DEFAULT_CONFIG.read_text())
        raw["candidate_count"] = 3
        raw["sequence_draws_per_candidate"] = 20
        raw["random_policy_repetitions"] = 2
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            config_path.write_text(json.dumps(raw))
            first = run(config_path, root / "first")
            second = run(config_path, root / "second")
            self.assertEqual(first["outputs"], second["outputs"])
            self.assertEqual(
                (root / "first" / "parameter_profiles.csv").read_bytes(),
                (root / "second" / "parameter_profiles.csv").read_bytes(),
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
