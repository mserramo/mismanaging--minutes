#!/usr/bin/env python3
"""Search a bounded set of Card Stacking payoff and draw parameters.

This is an offline design aid. It does not alter the Qualtrics QSF, the
certified environment bank, or the participant-facing runtime.

The script does four things:

1. Builds reproducible candidate parameter sets from a small, editable grid.
2. Simulates unfiltered sequences from the stated drawing process and compares
   what it is worth to begin each side task at each ordinary round. It also
   measures a planning policy relative to a reserve-safe random policy.
3. Computes a conservative worst-case payoff bound over every sequence allowed
   by the payoff supports. It then derives nice-number Main and Movie bonuses
   that guarantee both > Main only > Movie only > neither.
4. Writes reviewable CSV files and a JSON record of the best candidate found.

The simulation policy is intentionally not called "optimal." The worst-case
bonus certificate is a proof; the sequential-policy results are diagnostics.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "search_config.json"
DEFAULT_OUTPUT = HERE / "output"

SIDE_TASKS = (
    "trio_a",
    "trio_b",
    "fives",
    "cumulative_a",
    "cumulative_b",
    "infinite_scroll",
    "simple_a",
    "simple_b",
)
NON_IS_TASKS = tuple(task for task in SIDE_TASKS if task != "infinite_scroll")


@dataclass(frozen=True)
class RoundDraw:
    side_tasks: tuple[str, ...]
    simple_payoffs: Mapping[str, int]
    run_id: int | None
    run_position: int | None
    run_length: int | None


@dataclass(frozen=True)
class Candidate:
    profile_id: str
    non_is_weights: Mapping[str, float]
    group_bonuses: Mapping[str, int]
    cumulative: Mapping[str, Mapping[str, int]]
    infinite_scroll: Mapping[str, int]
    is_start_probability: float
    is_duration_name: str
    is_duration_probabilities: Mapping[int, float]
    simple_tasks: Mapping[str, Sequence[Mapping[str, float]]]

    def as_jsonable(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "non_is_weights": dict(self.non_is_weights),
            "group_bonuses": dict(self.group_bonuses),
            "cumulative": {key: dict(value) for key, value in self.cumulative.items()},
            "infinite_scroll": dict(self.infinite_scroll),
            "is_start_probability": self.is_start_probability,
            "is_duration_name": self.is_duration_name,
            "is_duration_probabilities": {
                str(key): value for key, value in self.is_duration_probabilities.items()
            },
            "simple_tasks": {
                key: [dict(item) for item in value]
                for key, value in self.simple_tasks.items()
            },
        }


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def stable_seed(*parts: Any) -> int:
    digest = hashlib.sha256(canonical_json(parts)).digest()
    return int.from_bytes(digest[:8], "big")


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text())
    errors: list[str] = []
    rounds = int(config["rounds"])
    movie = int(config["movie_rounds"])
    main = int(config["main_target"])
    side_cards = int(config["side_cards_per_round"])
    if rounds <= 0:
        errors.append("rounds must be positive")
    if not 0 < movie < rounds:
        errors.append("movie_rounds must lie strictly between zero and rounds")
    if not 0 < main < rounds - movie:
        errors.append("main_target must leave at least one ordinary side choice")
    if side_cards != 4:
        errors.append("this search version assumes exactly four side cards per round")
    if not 0 <= float(config["required_incentive_cushion"]) < 1:
        errors.append("required_incentive_cushion must be in [0, 1)")
    if int(config["best_profiles_pdf_count"]) <= 0:
        errors.append("best_profiles_pdf_count must be positive")
    separation = config["variant_separation"]
    if float(separation["minimum_payoff_parameter_gap"]) <= 0:
        errors.append("minimum_payoff_parameter_gap must be positive")
    if not 0 <= float(separation["minimum_probability_gap_exclusive"]) < 1:
        errors.append("minimum_probability_gap_exclusive must be in [0, 1)")
    for task_id, outcomes in config["simple_tasks"].items():
        if abs(sum(float(item["probability"]) for item in outcomes) - 1.0) > 1e-9:
            errors.append(f"{task_id} probabilities must sum to one")
    for item in config["infinite_scroll_duration_distributions"]:
        if abs(sum(float(value) for value in item["probabilities"].values()) - 1.0) > 1e-9:
            errors.append(f"IS duration distribution {item['name']} must sum to one")
    if errors:
        raise ValueError("Invalid search configuration: " + "; ".join(errors))
    config["side_budget_both"] = rounds - movie - main
    return config


def rounded_up(value: float, step: int) -> int:
    return int(math.ceil((value - 1e-12) / step) * step)


def sample_weight_units(
    rng: random.Random, bounds: Mapping[str, Sequence[int]]
) -> dict[str, int]:
    task_ids = list(NON_IS_TASKS)
    for _ in range(20_000):
        values = {
            task_id: rng.randint(int(bounds[task_id][0]), int(bounds[task_id][1]))
            for task_id in task_ids
        }
        if sum(values.values()) == 20:
            return values
    raise RuntimeError("Could not draw non-IS weights that sum to 1.00")


def simple_total_variation(
    first: Sequence[Mapping[str, float]], second: Sequence[Mapping[str, float]]
) -> float:
    """Total-variation distance after aligning the two displayed-payoff supports."""

    first_probabilities = {
        int(item["points"]): float(item["probability"]) for item in first
    }
    second_probabilities = {
        int(item["points"]): float(item["probability"]) for item in second
    }
    support = set(first_probabilities) | set(second_probabilities)
    return 0.5 * sum(
        abs(first_probabilities.get(value, 0.0) - second_probabilities.get(value, 0.0))
        for value in support
    )


def variant_separation_details(
    config: Mapping[str, Any], candidate: Candidate
) -> dict[str, Any]:
    """Check that the A/B variants are meaningfully different.

    Payoff-rule gaps are compared directly. A difference in frequency counts
    only when the exact inclusion probabilities induced by drawing without
    replacement differ by more than the configured probability threshold.
    """

    ordinary = inclusion_probabilities(subset_distribution(candidate.non_is_weights, 4))
    during_is = inclusion_probabilities(subset_distribution(candidate.non_is_weights, 3))
    probability_threshold = float(
        config["variant_separation"]["minimum_probability_gap_exclusive"]
    )
    payoff_threshold = float(
        config["variant_separation"]["minimum_payoff_parameter_gap"]
    )

    def inclusion_gap(first: str, second: str) -> float:
        return max(
            abs(ordinary[first] - ordinary[second]),
            abs(during_is[first] - during_is[second]),
        )

    trio_payoff_gap = abs(
        int(candidate.group_bonuses["trio_a"])
        - int(candidate.group_bonuses["trio_b"])
    )
    trio_inclusion_gap = inclusion_gap("trio_a", "trio_b")

    side_budget = int(config["side_budget_both"])
    cumulative_payoff_gap = max(
        abs(
            cumulative_marginal(candidate.cumulative["cumulative_a"], count)
            - cumulative_marginal(candidate.cumulative["cumulative_b"], count)
        )
        for count in range(side_budget)
    )
    cumulative_inclusion_gap = inclusion_gap("cumulative_a", "cumulative_b")

    simple_distribution_gap = simple_total_variation(
        candidate.simple_tasks["simple_a"], candidate.simple_tasks["simple_b"]
    )
    simple_inclusion_gap = inclusion_gap("simple_a", "simple_b")

    trio_pass = (
        trio_payoff_gap >= payoff_threshold
        or trio_inclusion_gap > probability_threshold + 1e-12
    )
    cumulative_pass = (
        cumulative_payoff_gap >= payoff_threshold
        or cumulative_inclusion_gap > probability_threshold + 1e-12
    )
    simple_pass = (
        simple_distribution_gap > probability_threshold + 1e-12
        or simple_inclusion_gap > probability_threshold + 1e-12
    )
    return {
        "variant_separation_pass": bool(trio_pass and cumulative_pass and simple_pass),
        "trio_variants_distinct": trio_pass,
        "trio_payoff_gap": trio_payoff_gap,
        "trio_max_inclusion_probability_gap": trio_inclusion_gap,
        "cumulative_variants_distinct": cumulative_pass,
        "cumulative_max_marginal_payoff_gap": cumulative_payoff_gap,
        "cumulative_max_inclusion_probability_gap": cumulative_inclusion_gap,
        "simple_variants_distinct": simple_pass,
        "simple_payoff_distribution_total_variation": simple_distribution_gap,
        "simple_max_inclusion_probability_gap": simple_inclusion_gap,
    }


def make_candidates(config: Mapping[str, Any]) -> list[Candidate]:
    rng = random.Random(int(config["seed"]))
    seen: set[bytes] = set()
    candidates: list[Candidate] = []
    requested = int(config["candidate_count"])

    # Include a recognizable current-like weighting first. The new capped
    # cumulative and run rules still come from the editable option lists.
    fixed_units = {
        "trio_a": 3,
        "trio_b": 2,
        "fives": 2,
        "cumulative_a": 2,
        "cumulative_b": 2,
        "simple_a": 5,
        "simple_b": 4,
    }

    attempts = 0
    while len(candidates) < requested:
        attempts += 1
        if attempts > requested * 20_000:
            raise RuntimeError("Candidate grid is too small for the requested count")
        units = fixed_units if not candidates else sample_weight_units(
            rng, config["non_is_weight_bounds_in_five_point_units"]
        )
        group_bonuses = {
            task_id: int(rng.choice(values))
            for task_id, values in config["group_bonus_options"].items()
        }
        cumulative = {
            "cumulative_a": dict(rng.choice(config["cumulative_options"])),
            "cumulative_b": dict(rng.choice(config["cumulative_options"])),
        }
        infinite_scroll = dict(rng.choice(config["infinite_scroll_options"]))
        is_start_probability = float(rng.choice(config["infinite_scroll_start_probabilities"]))
        duration = rng.choice(config["infinite_scroll_duration_distributions"])
        payload = {
            "units": units,
            "group_bonuses": group_bonuses,
            "cumulative": cumulative,
            "infinite_scroll": infinite_scroll,
            "is_start_probability": is_start_probability,
            "duration": duration,
        }
        candidate = Candidate(
            profile_id=f"profile_{len(candidates) + 1:04d}",
            non_is_weights={task_id: units[task_id] / 20 for task_id in NON_IS_TASKS},
            group_bonuses=group_bonuses,
            cumulative=cumulative,
            infinite_scroll=infinite_scroll,
            is_start_probability=is_start_probability,
            is_duration_name=str(duration["name"]),
            is_duration_probabilities={
                int(key): float(value) for key, value in duration["probabilities"].items()
            },
            simple_tasks=config["simple_tasks"],
        )
        if not variant_separation_details(config, candidate)["variant_separation_pass"]:
            continue
        signature = canonical_json(payload)
        if signature in seen:
            continue
        seen.add(signature)
        candidates.append(candidate)
    return candidates


def subset_distribution(
    weights: Mapping[str, float], count: int
) -> list[tuple[tuple[str, ...], float]]:
    """Exact distribution induced by sequential weighted draws without replacement."""

    probabilities: defaultdict[tuple[str, ...], float] = defaultdict(float)

    def visit(remaining: tuple[str, ...], chosen: tuple[str, ...], probability: float) -> None:
        if len(chosen) == count:
            probabilities[tuple(sorted(chosen))] += probability
            return
        total = sum(float(weights[task_id]) for task_id in remaining)
        for index, task_id in enumerate(remaining):
            next_remaining = remaining[:index] + remaining[index + 1 :]
            visit(
                next_remaining,
                chosen + (task_id,),
                probability * float(weights[task_id]) / total,
            )

    visit(tuple(weights), (), 1.0)
    result = sorted(probabilities.items())
    total = sum(probability for _subset, probability in result)
    if abs(total - 1.0) > 1e-9:
        raise AssertionError(f"Subset probabilities sum to {total}")
    return result


def inclusion_probabilities(
    distribution: Sequence[tuple[tuple[str, ...], float]]
) -> dict[str, float]:
    return {
        task_id: sum(probability for subset, probability in distribution if task_id in subset)
        for task_id in NON_IS_TASKS
    }


def weighted_pick(rng: random.Random, values: Sequence[tuple[Any, float]]) -> Any:
    draw = rng.random()
    cumulative = 0.0
    for value, probability in values:
        cumulative += float(probability)
        if draw < cumulative:
            return value
    return values[-1][0]


def draw_sequence(
    candidate: Candidate,
    rounds: int,
    rng: random.Random,
    ordinary_distribution: Sequence[tuple[tuple[str, ...], float]],
    run_distribution: Sequence[tuple[tuple[str, ...], float]],
) -> list[RoundDraw]:
    result: list[RoundDraw] = []
    run_remaining = 0
    run_position = 0
    run_length = 0
    run_id = 0
    cooldown = False
    durations = sorted(candidate.is_duration_probabilities.items())
    simple_distributions = {
        task_id: [(int(item["points"]), float(item["probability"])) for item in outcomes]
        for task_id, outcomes in candidate.simple_tasks.items()
    }

    for _round_index in range(rounds):
        if run_remaining == 0:
            if cooldown:
                cooldown = False
            elif rng.random() < candidate.is_start_probability:
                run_length = int(weighted_pick(rng, durations))
                run_remaining = run_length
                run_position = 0
                run_id += 1

        if run_remaining:
            subset = tuple(weighted_pick(rng, run_distribution)) + ("infinite_scroll",)
            run_position += 1
            current_run_id: int | None = run_id
            current_run_position: int | None = run_position
            current_run_length: int | None = run_length
            run_remaining -= 1
            if run_remaining == 0:
                cooldown = True
        else:
            subset = tuple(weighted_pick(rng, ordinary_distribution))
            current_run_id = None
            current_run_position = None
            current_run_length = None

        simple_payoffs = {
            task_id: int(weighted_pick(rng, distribution))
            for task_id, distribution in simple_distributions.items()
            if task_id in subset
        }
        result.append(
            RoundDraw(
                side_tasks=tuple(sorted(subset, key=SIDE_TASKS.index)),
                simple_payoffs=simple_payoffs,
                run_id=current_run_id,
                run_position=current_run_position,
                run_length=current_run_length,
            )
        )
    return result


def cumulative_marginal(rule: Mapping[str, int], prior_count: int) -> int:
    return min(
        int(rule["cap"]),
        int(rule["start"]) + int(rule["increase"]) * prior_count,
    )


def cumulative_total(rule: Mapping[str, int], count: int) -> int:
    return sum(cumulative_marginal(rule, index) for index in range(count))


def run_total(rule: Mapping[str, int], count: int) -> int:
    return int(rule["start"]) * count + int(rule["increase"]) * count * (count - 1) // 2


def task_support_value(candidate: Candidate, task_id: str, count: int) -> int:
    if task_id in ("trio_a", "trio_b"):
        return (count // 3) * int(candidate.group_bonuses[task_id])
    if task_id == "fives":
        return (count // 5) * int(candidate.group_bonuses[task_id])
    if task_id in ("cumulative_a", "cumulative_b"):
        return cumulative_total(candidate.cumulative[task_id], count)
    if task_id == "infinite_scroll":
        maximum_run = max(candidate.is_duration_probabilities)
        full_runs, remainder = divmod(count, maximum_run)
        return (
            full_runs * run_total(candidate.infinite_scroll, maximum_run)
            + run_total(candidate.infinite_scroll, remainder)
        )
    if task_id in ("simple_a", "simple_b"):
        maximum = max(int(item["points"]) for item in candidate.simple_tasks[task_id])
        return maximum * count
    raise KeyError(task_id)


def conservative_upper_bound(candidate: Candidate, side_choices: int) -> int:
    """Multiple-choice knapsack over support-maximal task rewards.

    Availability is deliberately ignored. This allows the bound to cover every
    legal draw, including the extreme draw in which a positive-probability task
    is available whenever it is useful.
    """

    best = [0] + [-10**12] * side_choices
    for task_id in SIDE_TASKS:
        next_best = [-10**12] * (side_choices + 1)
        values = [task_support_value(candidate, task_id, count) for count in range(side_choices + 1)]
        for used in range(side_choices + 1):
            if best[used] < 0:
                continue
            for take in range(side_choices - used + 1):
                next_best[used + take] = max(next_best[used + take], best[used] + values[take])
        best = next_best
    return max(best)


def derive_bonuses(
    config: Mapping[str, Any], candidate: Candidate
) -> dict[str, float | int | bool]:
    rounds = int(config["rounds"])
    movie = int(config["movie_rounds"])
    main = int(config["main_target"])
    budgets = {
        "both": rounds - movie - main,
        "main_only": rounds - main,
        "movie_only": rounds - movie,
        "neither": rounds,
    }
    upper = {name: conservative_upper_bound(candidate, count) for name, count in budgets.items()}
    cushion = float(config["required_incentive_cushion"])
    absolute_gap = int(config["required_absolute_gap"])
    step = int(config["nice_number_step"])

    # These conditions compare each threshold bonus with the largest side-pay
    # opportunity that completing that threshold could force the participant
    # to give up. The extra absolute gap keeps strict inequalities even when an
    # upper bound is zero.
    movie_required = max(
        (1 + cushion) * upper["main_only"],
        (1 + cushion) * upper["neither"],
    ) + absolute_gap
    movie_bonus = rounded_up(movie_required, step)
    main_increment_required = (1 + cushion) * upper["movie_only"] + absolute_gap
    main_bonus = rounded_up(movie_bonus + main_increment_required, step)

    worst_totals = {
        "both_lower": main_bonus + movie_bonus,
        "main_only_upper": main_bonus + upper["main_only"],
        "movie_only_upper": movie_bonus + upper["movie_only"],
        "neither_upper": upper["neither"],
    }
    gaps = {
        "both_over_main": worst_totals["both_lower"] - worst_totals["main_only_upper"],
        "main_over_movie": main_bonus - worst_totals["movie_only_upper"],
        "movie_over_neither": movie_bonus - worst_totals["neither_upper"],
    }

    def percent_gap(high: float, low: float) -> float:
        return (high - low) / low if low else math.inf

    return {
        **{f"side_budget_{key}": value for key, value in budgets.items()},
        **{f"side_upper_{key}": value for key, value in upper.items()},
        "derived_main_bonus": main_bonus,
        "derived_movie_bonus": movie_bonus,
        "guaranteed_gap_both_over_main": gaps["both_over_main"],
        "guaranteed_gap_main_over_movie": gaps["main_over_movie"],
        "guaranteed_gap_movie_over_neither": gaps["movie_over_neither"],
        "guaranteed_pct_both_over_main": percent_gap(
            worst_totals["both_lower"], worst_totals["main_only_upper"]
        ),
        "guaranteed_pct_main_over_movie": percent_gap(
            main_bonus, worst_totals["movie_only_upper"]
        ),
        "guaranteed_pct_movie_over_neither": percent_gap(
            movie_bonus, worst_totals["neither_upper"]
        ),
        "robust_ordering_certified": all(value > 0 for value in gaps.values()),
    }


def start_now_points_per_card(
    candidate: Candidate,
    task_id: str,
    ordinary_rounds: Sequence[RoundDraw],
    round_index: int,
    side_budget: int,
) -> float:
    """Realized value per card of beginning a fresh task at one displayed offer.

    This is deliberately a task-comparison diagnostic, not a feasible policy.
    It uses only availability from the current round forward and assumes zero
    prior progress. Averaging it over sequences gives the completion risk that
    a sequential participant faces when starting at that round.
    """

    current = ordinary_rounds[round_index]
    if task_id not in current.side_tasks:
        raise ValueError(f"{task_id} is not displayed in round {round_index + 1}")
    future_appearances = sum(
        task_id in round_data.side_tasks for round_data in ordinary_rounds[round_index:]
    )
    if task_id in ("trio_a", "trio_b"):
        return (
            float(candidate.group_bonuses[task_id]) / 3
            if future_appearances >= 3
            else 0.0
        )
    if task_id == "fives":
        return (
            float(candidate.group_bonuses[task_id]) / 5
            if future_appearances >= 5
            else 0.0
        )
    if task_id in ("cumulative_a", "cumulative_b"):
        count = min(future_appearances, side_budget)
        return cumulative_total(candidate.cumulative[task_id], count) / count
    if task_id in ("simple_a", "simple_b"):
        return float(current.simple_payoffs[task_id])
    if task_id == "infinite_scroll":
        run_id = current.run_id
        count = 0
        for round_data in ordinary_rounds[round_index:]:
            if round_data.run_id != run_id or task_id not in round_data.side_tasks:
                break
            count += 1
        count = min(count, side_budget)
        return run_total(candidate.infinite_scroll, count) / count
    raise KeyError(task_id)


def initial_policy_state() -> dict[str, Any]:
    return {
        "counts": {task_id: 0 for task_id in SIDE_TASKS},
        "run_streak": 0,
        "run_id": None,
        "contributions": {task_id: 0 for task_id in SIDE_TASKS},
    }


def planning_score(
    candidate: Candidate, state: Mapping[str, Any], round_data: RoundDraw, task_id: str
) -> float:
    count = int(state["counts"][task_id])
    if task_id in ("trio_a", "trio_b"):
        bonus = int(candidate.group_bonuses[task_id])
        return float(bonus / 3)
    if task_id == "fives":
        bonus = int(candidate.group_bonuses[task_id])
        return float(bonus / 5)
    if task_id in ("cumulative_a", "cumulative_b"):
        return float(cumulative_marginal(candidate.cumulative[task_id], count))
    if task_id == "infinite_scroll":
        streak = int(state["run_streak"]) if state["run_id"] == round_data.run_id else 0
        return float(
            int(candidate.infinite_scroll["start"])
            + int(candidate.infinite_scroll["increase"]) * streak
        )
    return float(round_data.simple_payoffs[task_id])


def apply_side_choice(
    candidate: Candidate,
    state: dict[str, Any],
    round_data: RoundDraw,
    task_id: str | None,
) -> int:
    if task_id != "infinite_scroll":
        state["run_streak"] = 0
        state["run_id"] = None
    if task_id is None:
        return 0
    count = int(state["counts"][task_id])
    if task_id in ("trio_a", "trio_b"):
        reward = int(candidate.group_bonuses[task_id]) if (count + 1) % 3 == 0 else 0
    elif task_id == "fives":
        reward = int(candidate.group_bonuses[task_id]) if (count + 1) % 5 == 0 else 0
    elif task_id in ("cumulative_a", "cumulative_b"):
        reward = cumulative_marginal(candidate.cumulative[task_id], count)
    elif task_id == "infinite_scroll":
        if state["run_id"] != round_data.run_id:
            state["run_streak"] = 0
        reward = int(candidate.infinite_scroll["start"]) + int(
            candidate.infinite_scroll["increase"]
        ) * int(state["run_streak"])
        state["run_id"] = round_data.run_id
        state["run_streak"] = int(state["run_streak"]) + 1
    else:
        reward = int(round_data.simple_payoffs[task_id])
    state["counts"][task_id] = count + 1
    state["contributions"][task_id] += reward
    return reward


def reference_score_distribution(
    candidate: Candidate,
    ordinary_distribution: Sequence[tuple[tuple[str, ...], float]],
    run_distribution: Sequence[tuple[tuple[str, ...], float]],
    seed: int,
    draws: int = 3_000,
) -> list[float]:
    rng = random.Random(seed)
    scores: list[float] = []
    state = initial_policy_state()
    mean_duration = sum(
        length * probability
        for length, probability in candidate.is_duration_probabilities.items()
    )
    # Renewal approximation with one cooldown round after every run. This is
    # used only to build the policy's current-score reference distribution.
    is_round_share = (
        candidate.is_start_probability * mean_duration
        / (1 + candidate.is_start_probability * mean_duration)
    )
    for _ in range(draws):
        in_run = rng.random() < is_round_share
        tasks = tuple(weighted_pick(rng, run_distribution if in_run else ordinary_distribution))
        if in_run:
            tasks += ("infinite_scroll",)
        simple_payoffs = {}
        for task_id in ("simple_a", "simple_b"):
            if task_id in tasks:
                outcomes = [
                    (int(item["points"]), float(item["probability"]))
                    for item in candidate.simple_tasks[task_id]
                ]
                simple_payoffs[task_id] = int(weighted_pick(rng, outcomes))
        round_data = RoundDraw(tasks, simple_payoffs, 1 if in_run else None, 1, 5)
        scores.append(max(planning_score(candidate, state, round_data, task_id) for task_id in tasks))
    return sorted(scores)


def empirical_quantile(sorted_values: Sequence[float], probability: float) -> float:
    if not sorted_values:
        raise ValueError("Cannot take a quantile of an empty sequence")
    probability = min(1.0, max(0.0, probability))
    index = int(round(probability * (len(sorted_values) - 1)))
    return float(sorted_values[index])


def run_planning_policy(
    candidate: Candidate,
    sequence: Sequence[RoundDraw],
    config: Mapping[str, Any],
    reference_scores: Sequence[float],
) -> dict[str, Any]:
    ordinary_count = int(config["rounds"]) - int(config["movie_rounds"])
    side_needed = int(config["side_budget_both"])
    state = initial_policy_state()
    appearances = Counter()
    selections = Counter()
    total = 0
    for index, round_data in enumerate(sequence[:ordinary_count]):
        appearances.update(round_data.side_tasks)
        remaining = ordinary_count - index
        scores = {
            task_id: planning_score(candidate, state, round_data, task_id)
            for task_id in round_data.side_tasks
        }
        choose_side = False
        if side_needed == remaining:
            choose_side = True
        elif side_needed > 0:
            cutoff_probability = 1 - side_needed / remaining
            cutoff = empirical_quantile(reference_scores, cutoff_probability)
            choose_side = max(scores.values()) >= cutoff
        choice = max(scores, key=lambda task_id: (scores[task_id], -SIDE_TASKS.index(task_id))) if choose_side else None
        total += apply_side_choice(candidate, state, round_data, choice)
        if choice is not None:
            selections[choice] += 1
            side_needed -= 1
    if side_needed != 0:
        raise AssertionError("Planning policy failed to reserve the required side choices")
    return {
        "side_pay": total,
        "contributions": dict(state["contributions"]),
        "selections": dict(selections),
        "appearances": dict(appearances),
    }


def run_random_policy(
    candidate: Candidate,
    sequence: Sequence[RoundDraw],
    config: Mapping[str, Any],
    rng: random.Random,
) -> dict[str, Any]:
    ordinary_count = int(config["rounds"]) - int(config["movie_rounds"])
    side_needed = int(config["side_budget_both"])
    state = initial_policy_state()
    selections = Counter()
    total = 0
    for index, round_data in enumerate(sequence[:ordinary_count]):
        remaining = ordinary_count - index
        choose_side = side_needed == remaining or (
            side_needed > 0 and rng.random() < side_needed / remaining
        )
        choice = rng.choice(round_data.side_tasks) if choose_side else None
        total += apply_side_choice(candidate, state, round_data, choice)
        if choice is not None:
            selections[choice] += 1
            side_needed -= 1
    if side_needed != 0:
        raise AssertionError("Random policy failed to reserve the required side choices")
    return {
        "side_pay": total,
        "contributions": dict(state["contributions"]),
        "selections": dict(selections),
    }


def mean_and_se(values: Sequence[float]) -> tuple[float, float]:
    if not values:
        return math.nan, math.nan
    mean = statistics.fmean(values)
    se = statistics.stdev(values) / math.sqrt(len(values)) if len(values) > 1 else 0.0
    return mean, se


def evaluate_candidate(config: Mapping[str, Any], candidate: Candidate) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    ordinary_distribution = subset_distribution(candidate.non_is_weights, 4)
    run_distribution = subset_distribution(candidate.non_is_weights, 3)
    inclusion_off = inclusion_probabilities(ordinary_distribution)
    inclusion_on = inclusion_probabilities(run_distribution)
    separation = variant_separation_details(config, candidate)
    if not separation["variant_separation_pass"]:
        raise ValueError(f"Candidate {candidate.profile_id} has duplicate A/B variants")
    certificate = derive_bonuses(config, candidate)
    reference_scores = reference_score_distribution(
        candidate,
        ordinary_distribution,
        run_distribution,
        stable_seed(config["seed"], candidate.profile_id, "reference"),
    )

    draws = int(config["sequence_draws_per_candidate"])
    random_repetitions = int(config["random_policy_repetitions"])
    ordinary_count = int(config["rounds"]) - int(config["movie_rounds"])
    start_value_sums = {
        task_id: [0.0] * ordinary_count for task_id in SIDE_TASKS
    }
    start_value_counts = {
        task_id: [0] * ordinary_count for task_id in SIDE_TASKS
    }
    planning_values: list[float] = []
    random_values: list[float] = []
    paired_differences: list[float] = []
    total_appearances = Counter()
    total_selections = Counter()
    total_contributions = Counter()
    selection_mix_vectors: list[list[float]] = []

    for sequence_index in range(draws):
        sequence_rng = random.Random(
            stable_seed(config["seed"], candidate.profile_id, "sequence", sequence_index)
        )
        sequence = draw_sequence(
            candidate,
            int(config["rounds"]),
            sequence_rng,
            ordinary_distribution,
            run_distribution,
        )
        ordinary = sequence[:ordinary_count]
        for round_index, round_data in enumerate(ordinary):
            for task_id in round_data.side_tasks:
                start_value_sums[task_id][round_index] += start_now_points_per_card(
                    candidate,
                    task_id,
                    ordinary,
                    round_index,
                    int(config["side_budget_both"]),
                )
                start_value_counts[task_id][round_index] += 1

        planning = run_planning_policy(candidate, sequence, config, reference_scores)
        random_payoffs = []
        for repetition in range(random_repetitions):
            random_result = run_random_policy(
                candidate,
                sequence,
                config,
                random.Random(
                    stable_seed(
                        config["seed"], candidate.profile_id, "random", sequence_index, repetition
                    )
                ),
            )
            random_payoffs.append(float(random_result["side_pay"]))
        random_mean = statistics.fmean(random_payoffs)
        planning_values.append(float(planning["side_pay"]))
        random_values.append(random_mean)
        paired_differences.append(float(planning["side_pay"]) - random_mean)
        total_appearances.update(planning["appearances"])
        total_selections.update(planning["selections"])
        total_contributions.update(planning["contributions"])
        selection_mix_vectors.append(
            [planning["selections"].get(task_id, 0) / int(config["side_budget_both"]) for task_id in SIDE_TASKS]
        )

    start_values_by_round: dict[str, list[float | None]] = {}
    for task_id in SIDE_TASKS:
        start_values_by_round[task_id] = [
            start_value_sums[task_id][index] / start_value_counts[task_id][index]
            if start_value_counts[task_id][index]
            else None
            for index in range(ordinary_count)
        ]
    start_value_means = {
        task_id: statistics.fmean(value for value in values if value is not None)
        for task_id, values in start_values_by_round.items()
    }
    positive_start_values = [value for value in start_value_means.values() if value > 0]
    balance_ratio = max(positive_start_values) / min(positive_start_values)
    planning_mean = statistics.fmean(planning_values)
    random_mean = statistics.fmean(random_values)
    difference_mean, difference_se = mean_and_se(paired_differences)
    gain_ratio = difference_mean / random_mean if random_mean else math.inf
    lower_95 = difference_mean - 1.96 * difference_se
    mean_mix = [
        statistics.fmean(vector[index] for vector in selection_mix_vectors)
        for index in range(len(SIDE_TASKS))
    ]
    # Half the L1 distance is the share of the twenty side choices that would
    # have to move between tasks to turn one sequence's mix into the mean mix.
    mean_change_in_task_mix = statistics.fmean(
        0.5 * sum(abs(value - mean_mix[index]) for index, value in enumerate(vector))
        for vector in selection_mix_vectors
    )

    targets = config["targets"]
    passes_balance = balance_ratio <= float(targets["maximum_start_now_value_ratio"])
    passes_value = (
        gain_ratio >= float(targets["minimum_planning_gain_over_random"])
        and lower_95 > 0
    )
    passes_variation = mean_change_in_task_mix >= float(
        targets["minimum_mean_change_in_task_mix"]
    )
    profile_row: dict[str, Any] = {
        "search_version": config["search_version"],
        "profile_id": candidate.profile_id,
        "candidate_json": json.dumps(candidate.as_jsonable(), sort_keys=True, separators=(",", ":")),
        "sequence_draws": draws,
        "side_budget_when_both_completed": config["side_budget_both"],
        "start_now_value_min": min(positive_start_values),
        "start_now_value_max": max(positive_start_values),
        "start_now_value_ratio": balance_ratio,
        "planning_policy_mean_side_pay": planning_mean,
        "random_policy_mean_side_pay": random_mean,
        "planning_minus_random": difference_mean,
        "planning_minus_random_se": difference_se,
        "planning_minus_random_lower_95": lower_95,
        "planning_gain_over_random": gain_ratio,
        "mean_change_in_task_mix": mean_change_in_task_mix,
        "passes_start_now_value_balance": passes_balance,
        "passes_planning_value": passes_value,
        "passes_sequence_variation": passes_variation,
        "robust_ordering_certified": certificate["robust_ordering_certified"],
        "meets_all_targets": bool(
            separation["variant_separation_pass"]
            and passes_balance
            and passes_value
            and passes_variation
            and certificate["robust_ordering_certified"]
        ),
        "sequential_evidence_status": "planning-policy diagnostic; not an optimality proof",
        "inclusion_probabilities_without_is": json.dumps(inclusion_off, sort_keys=True),
        "inclusion_probabilities_during_is": json.dumps(inclusion_on, sort_keys=True),
        **separation,
        **certificate,
    }

    task_rows: list[dict[str, Any]] = []
    for task_id in SIDE_TASKS:
        round_values = start_values_by_round[task_id]
        observed_round_values = [value for value in round_values if value is not None]

        def band_mean(start: int, end: int) -> float:
            values = [value for value in round_values[start:end] if value is not None]
            return statistics.fmean(values) if values else math.nan

        appearances = total_appearances[task_id]
        selections = total_selections[task_id]
        contribution = total_contributions[task_id]
        task_rows.append(
            {
                "search_version": config["search_version"],
                "profile_id": candidate.profile_id,
                "task_id": task_id,
                "mean_start_now_points_per_card": start_value_means[task_id],
                "start_now_rounds_1_20_mean": band_mean(0, 20),
                "start_now_rounds_21_60_mean": band_mean(20, 60),
                "start_now_rounds_61_80_mean": band_mean(60, ordinary_count),
                "start_now_round_min": min(observed_round_values),
                "start_now_round_max": max(observed_round_values),
                "start_now_round_coverage": len(observed_round_values) / ordinary_count,
                "mean_ordinary_appearances": appearances / draws,
                "mean_planning_policy_selections": selections / draws,
                "selection_rate_when_available": selections / appearances if appearances else 0,
                "mean_planning_policy_contribution": contribution / draws,
                "inclusion_probability_without_is": inclusion_off.get(task_id, 1.0),
                "inclusion_probability_during_is": 1.0
                if task_id == "infinite_scroll"
                else inclusion_on.get(task_id, 0.0),
            }
        )
    return profile_row, task_rows


def write_csv(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    if not rows:
        path.write_text("")
        return
    fieldnames = list(rows[0])
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def rank_key(row: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        not bool(row["meets_all_targets"]),
        float(row["start_now_value_ratio"]),
        -float(row["planning_gain_over_random"]),
        -float(row["mean_change_in_task_mix"]),
        int(row["derived_main_bonus"]) + int(row["derived_movie_bonus"]),
        str(row["profile_id"]),
    )


def run(config_path: Path, output_dir: Path, limit: int | None = None) -> dict[str, Any]:
    config = load_config(config_path)
    candidates = make_candidates(config)
    if limit is not None:
        candidates = candidates[:limit]
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_rows: list[dict[str, Any]] = []
    task_rows: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates, start=1):
        print(f"[{index:03d}/{len(candidates):03d}] {candidate.profile_id}", flush=True)
        profile_row, candidate_task_rows = evaluate_candidate(config, candidate)
        profile_rows.append(profile_row)
        task_rows.extend(candidate_task_rows)

    profile_rows.sort(key=rank_key)
    for rank, row in enumerate(profile_rows, start=1):
        row["review_rank"] = rank
    task_rows.sort(key=lambda row: (row["profile_id"], SIDE_TASKS.index(str(row["task_id"]))))
    passing = [row for row in profile_rows if row["meets_all_targets"]]
    selected = profile_rows[0]

    write_csv(output_dir / "parameter_profiles.csv", profile_rows)
    write_csv(output_dir / "parameter_task_metrics.csv", task_rows)
    write_csv(output_dir / "parameter_profiles_passing.csv", passing)
    selected_payload = {
        "status": "all targets met" if selected["meets_all_targets"] else "best diagnostic candidate; not all targets met",
        "warning": (
            "This file is a design recommendation, not a Qualtrics runtime profile. "
            "Review it before adapting environment_profile.json."
        ),
        "profile": json.loads(selected["candidate_json"]),
        "recommended_main_bonus": selected["derived_main_bonus"],
        "recommended_movie_bonus": selected["derived_movie_bonus"],
        "metrics": {
            key: value
            for key, value in selected.items()
            if key not in {"candidate_json"}
        },
    }
    (output_dir / "selected_profile.json").write_text(
        json.dumps(selected_payload, indent=2, sort_keys=True) + "\n"
    )
    manifest = {
        "search_version": config["search_version"],
        "config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
        "candidate_count_evaluated": len(profile_rows),
        "passing_count": len(passing),
        "selected_profile_id": selected["profile_id"],
        "outputs": {},
    }
    for name in (
        "parameter_profiles.csv",
        "parameter_task_metrics.csv",
        "parameter_profiles_passing.csv",
        "selected_profile.json",
    ):
        manifest["outputs"][name] = hashlib.sha256((output_dir / name).read_bytes()).hexdigest()
    (output_dir / "search_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--limit",
        type=int,
        help="Evaluate only the first N candidates (useful for a quick check)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = run(args.config.resolve(), args.output_dir.resolve(), args.limit)
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
