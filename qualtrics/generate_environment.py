#!/usr/bin/env python3
"""Generate and exactly certify the fixed-round Qualtrics environment bank.

The runtime never solves an optimization problem. This offline calibrator draws
each environment deterministically, solves all four threshold-completion
regimes with OR-Tools CP-SAT, rejects uncertified draws, and writes the compact
bank plus the two review CSVs consumed by the QSF builder.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import csv
import hashlib
import json
import random
import sys
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

try:
    from ortools.sat.python import cp_model
except ModuleNotFoundError:  # hash/output audits do not need the solver
    cp_model = None  # type: ignore[assignment]


QUALTRICS_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILE = QUALTRICS_DIR / "environment_profile.json"
DEFAULT_BANK = QUALTRICS_DIR / "certified_environment_bank.json"
DEFAULT_DETAIL = QUALTRICS_DIR / "validated_sequences.csv"
DEFAULT_SUMMARY = QUALTRICS_DIR / "validated_sequence_summary.csv"
TASK_ORDER = (
    "main",
    "movie",
    "trio_a",
    "trio_b",
    "fives",
    "cumulative_a",
    "cumulative_b",
    "infinite_scroll",
    "simple_a",
    "simple_b",
)
SIDE_TASKS = TASK_ORDER[2:]
TASK_CODE = {task_id: index for index, task_id in enumerate(TASK_ORDER)}
REGIMES = ((0, 0), (0, 1), (1, 0), (1, 1))
PACKED_ROUND_BYTES = 5

DETAIL_COLUMNS = (
    "profile_version", "bank_hash", "sequence_id", "seed", "round", "phase",
    "position", "task_id", "task_type", "is_main", "is_movie", "is_side",
    "color_id", "color_hex", "group_size", "group_bonus", "marginal_base",
    "marginal_increment", "simple_outcomes", "displayed_simple_payoff",
    "availability_run_id", "availability_run_start", "availability_run_end",
    "availability_rounds_remaining", "optimizer_chosen", "reserve_policy_chosen",
    "optimizer_task_state_before", "optimizer_task_state_after",
    "reserve_task_state_before", "reserve_task_state_after",
)


@dataclass(frozen=True)
class Round:
    number: int
    phase: str
    cards: tuple[str, ...]
    simple_payoffs: dict[str, int]
    infinite_run_id: int | None
    infinite_run_start: int | None
    infinite_run_end: int | None


@dataclass
class CertifiedSequence:
    sequence_id: int
    seed: int
    rounds: list[Round]
    color_map: dict[str, int]
    values: dict[str, int]
    canonical_choices: list[str]
    safe_choices: list[str]
    canonical_trace: list[tuple[dict[str, Any], dict[str, Any], int]]
    safe_trace: list[tuple[dict[str, Any], dict[str, Any], int]]
    summary: dict[str, Any]


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_profile(path: Path) -> dict[str, Any]:
    profile = json.loads(path.read_text())
    rounds = int(profile["rounds"])
    movie_rounds = profile["movie_share"] * rounds
    target_main = profile["main_target_share"] * rounds
    errors: list[str] = []
    if rounds % 5:
        errors.append("rounds (R0) must be divisible by 5")
    if not float(movie_rounds).is_integer():
        errors.append("movie_share * R0 must be integral")
    if not float(target_main).is_integer():
        errors.append("main_target_share * R0 (Q) must be integral")
    if not 0.5 < float(profile["main_target_share"]) < 0.8:
        errors.append("main_target_share must be strictly between 0.5 and 0.8")
    if len(profile["side_tasks"]) != 8:
        errors.append("the certified baseline requires exactly eight side tasks")
    if [task["id"] for task in profile["side_tasks"]] != list(SIDE_TASKS):
        errors.append("side task ids/order do not match the runtime contract")
    if abs(sum(task["weight"] for task in profile["side_tasks"]) - 1) > 1e-9:
        errors.append("side-task weights must sum to 1")
    side_cards_raw = profile.get("side_cards_per_round", 0)
    try:
        side_cards_per_round = int(side_cards_raw)
    except (TypeError, ValueError):
        side_cards_per_round = 0
    if (
        side_cards_per_round not in {1, 2, 3, 4}
        or isinstance(side_cards_raw, bool)
        or side_cards_raw != side_cards_per_round
    ):
        errors.append("side_cards_per_round must be an integer from 1 through 4")
    for task in profile["side_tasks"]:
        if task["type"] == "simple" and abs(
            sum(item["probability"] for item in task["outcomes"]) - 1
        ) > 1e-9:
            errors.append(f"{task['id']} outcome probabilities must sum to 1")
    if len(profile["colors"]) < len(TASK_ORDER):
        errors.append("the palette must provide one color per task")
    cumulative_cap = int(profile.get("ordinary_cumulative_appearance_cap", 0))
    if not 0 < cumulative_cap < rounds - int(movie_rounds):
        errors.append("ordinary_cumulative_appearance_cap must be positive and pre-movie")
    if cumulative_cap >= rounds - int(movie_rounds) - int(target_main):
        errors.append("ordinary_cumulative_appearance_cap must be below S to enforce task diversity")
    if errors:
        raise ValueError("Invalid environment profile: " + "; ".join(errors))
    profile["movie_rounds"] = int(movie_rounds)
    profile["main_target"] = int(target_main)
    profile["side_budget"] = rounds - int(movie_rounds) - int(target_main)
    return profile


def weighted_choice(rng: random.Random, choices: Sequence[dict[str, Any]]) -> Any:
    draw = rng.random()
    cumulative = 0.0
    for choice in choices:
        cumulative += float(choice["probability"])
        if draw < cumulative:
            return choice
    return choices[-1]


def weighted_sample_without_replacement(
    rng: random.Random, tasks: Sequence[dict[str, Any]], count: int
) -> list[str]:
    available = list(tasks)
    selected: list[str] = []
    for _ in range(count):
        total = sum(float(task["weight"]) for task in available)
        draw = rng.random() * total
        cumulative = 0.0
        chosen_index = len(available) - 1
        for index, task in enumerate(available):
            cumulative += float(task["weight"])
            if draw < cumulative:
                chosen_index = index
                break
        selected.append(available.pop(chosen_index)["id"])
    return selected


def _place_infinite_runs(
    rng: random.Random, side_counts: Sequence[int], task: dict[str, Any]
) -> tuple[set[int], dict[int, tuple[int, int, int]]]:
    target = round(float(task["weight"]) * sum(side_counts))
    minimum = int(task["run_length_min"])
    maximum = int(task["run_length_max"])
    lengths: list[int] = []
    remaining = target
    while remaining >= minimum:
        feasible = [
            length for length in range(minimum, maximum + 1)
            if remaining - length == 0 or remaining - length >= minimum
        ]
        if not feasible:
            break
        length = feasible[rng.randrange(len(feasible))]
        lengths.append(length)
        remaining -= length
    if remaining and lengths:
        candidate = lengths[-1] + remaining
        if candidate <= maximum:
            lengths[-1] = candidate

    occupied: set[int] = set()
    metadata: dict[int, tuple[int, int, int]] = {}
    for run_id, length in enumerate(lengths, start=1):
        candidates = [
            start for start in range(0, len(side_counts) - length + 1)
            if all((round_index not in occupied) for round_index in range(start, start + length))
            and (start == 0 or start - 1 not in occupied)
            and (start + length == len(side_counts) or start + length not in occupied)
        ]
        if not candidates:
            raise RuntimeError("Could not place non-overlapping Infinite-scroll runs")
        start = candidates[rng.randrange(len(candidates))]
        end = start + length - 1
        for round_index in range(start, end + 1):
            occupied.add(round_index)
            metadata[round_index] = (run_id, start + 1, end + 1)
    return occupied, metadata


def draw_sequence(profile: dict[str, Any], sequence_id: int) -> tuple[int, list[Round], dict[str, int]]:
    seed = (int(profile["base_seed"]) + sequence_id - 1) & 0xFFFFFFFF
    rng = random.Random(seed)
    side_counts = [
        int(profile["side_cards_per_round"])
        for _ in range(int(profile["rounds"]))
    ]
    tasks = {task["id"]: task for task in profile["side_tasks"]}
    infinite_rounds, run_metadata = _place_infinite_runs(
        rng, side_counts, tasks["infinite_scroll"]
    )
    non_infinite_tasks = [
        task for task in profile["side_tasks"] if task["id"] != "infinite_scroll"
    ]
    movie_start = int(profile["rounds"]) - int(profile["movie_rounds"]) + 1
    rounds: list[Round] = []
    ordinary_appearances: Counter[str] = Counter()
    # The convex cumulative tasks must remain scarce enough before the movie
    # phase that a 20-choice side allocation cannot be monopolized by one of
    # them.  The cap is part of the versioned generator, not a runtime rule.
    cumulative_ordinary_cap = int(profile["ordinary_cumulative_appearance_cap"])
    for round_index, side_count in enumerate(side_counts):
        forced_infinite = round_index in infinite_rounds
        eligible_tasks = non_infinite_tasks
        if round_index + 1 < movie_start:
            eligible_tasks = [
                task for task in non_infinite_tasks
                if task["type"] != "cumulative"
                or ordinary_appearances[task["id"]] < cumulative_ordinary_cap
            ]
        selected = weighted_sample_without_replacement(
            rng,
            eligible_tasks,
            side_count - (1 if forced_infinite else 0),
        )
        if forced_infinite:
            selected.append("infinite_scroll")
        if round_index + 1 < movie_start:
            ordinary_appearances.update(selected)
        rng.shuffle(selected)
        simple_payoffs: dict[str, int] = {}
        for task_id in ("simple_a", "simple_b"):
            if task_id in selected:
                simple_payoffs[task_id] = int(
                    weighted_choice(rng, tasks[task_id]["outcomes"])["points"]
                )
        # Side cards occupy the fixed left-hand slots. Main is immediately to
        # their right, and the movie card is appended in the movie phase. This
        # lets the runtime grow the game box rightward without shifting any
        # existing card slot.
        # Keep the pre-layout-change input order so the shuffle consumes the
        # same RNG draw and produces the same relative ordering of side cards.
        cards = ["main", *selected]
        if round_index + 1 >= movie_start:
            cards.append("movie")
        # Consume the same shuffle draw as v2 so later rounds, simple payoffs,
        # and the participant color map retain the certified random stream.
        # Stable partitioning then enforces the visual slot contract.
        rng.shuffle(cards)
        cards = [task_id for task_id in cards if task_id in SIDE_TASKS]
        cards.append("main")
        if round_index + 1 >= movie_start:
            cards.append("movie")
        run = run_metadata.get(round_index)
        rounds.append(
            Round(
                number=round_index + 1,
                phase="movie" if round_index + 1 >= movie_start else "ordinary",
                cards=tuple(cards),
                simple_payoffs=simple_payoffs,
                infinite_run_id=run[0] if run else None,
                infinite_run_start=run[1] if run else None,
                infinite_run_end=run[2] if run else None,
            )
        )
    palette = list(range(len(TASK_ORDER)))
    rng.shuffle(palette)
    color_map = dict(zip(TASK_ORDER, palette))
    return seed, rounds, color_map


def _task_lookup(profile: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {task["id"]: task for task in profile["side_tasks"]}


def _build_model(
    profile: dict[str, Any], rounds: Sequence[Round], regime: tuple[int, int],
    *, model: cp_model.CpModel | None = None, prefix: str = "",
) -> tuple[cp_model.CpModel, dict[tuple[int, str], cp_model.IntVar], cp_model.IntVar, cp_model.LinearExpr]:
    if model is None:
        model = cp_model.CpModel()
    tasks = _task_lookup(profile)
    selected: dict[tuple[int, str], cp_model.IntVar] = {}
    for round_index, round_data in enumerate(rounds):
        variables = []
        for task_id in round_data.cards:
            variable = model.new_bool_var(f"{prefix}x_{round_index}_{task_id}")
            selected[(round_index, task_id)] = variable
            variables.append(variable)
        model.add_exactly_one(variables)

    main_count = sum(selected[(index, "main")] for index in range(len(rounds)))
    movie_variables = [
        selected[(index, "movie")] for index, round_data in enumerate(rounds)
        if "movie" in round_data.cards
    ]
    movie_count = sum(movie_variables)
    main_complete, movie_complete = regime
    if main_complete:
        # A zero-pay threshold card is never needed beyond Q: replacing any
        # excess main choice with a side choice weakly improves side pay.
        model.add(main_count == int(profile["main_target"]))
    else:
        # Likewise, one can choose a displayed side card instead of any
        # zero-pay main card without changing the requested failure regime.
        model.add(main_count == 0)
    if movie_complete:
        model.add(movie_count == int(profile["movie_rounds"]))
    else:
        model.add(movie_count == 0)

    reward_terms: list[cp_model.LinearExpr] = []

    def add_count_reward(
        name: str,
        variables: Sequence[cp_model.IntVar],
        reward_for_count: Any,
    ) -> cp_model.LinearExpr:
        """Encode a finite count-to-reward table with one-hot selectors.

        This is an exact linear CP-SAT formulation.  It is much faster than an
        integer multiplication equality for the convex cumulative tasks.
        """

        count_choices = [
            model.new_bool_var(f"{prefix}{name}_is_{count}")
            for count in range(len(variables) + 1)
        ]
        model.add_exactly_one(count_choices)
        model.add(
            sum(variables)
            == sum(count * choice for count, choice in enumerate(count_choices))
        )
        return sum(
            int(reward_for_count(count)) * choice
            for count, choice in enumerate(count_choices)
        )

    for task_id, task in tasks.items():
        variables = [
            selected[(index, task_id)] for index, round_data in enumerate(rounds)
            if task_id in round_data.cards
        ]
        if task["type"] == "simple":
            reward_terms.extend(
                selected[(index, task_id)] * round_data.simple_payoffs[task_id]
                for index, round_data in enumerate(rounds)
                if task_id in round_data.cards
            )
            continue
        if task["type"] == "run":
            run_ids = sorted(
                {round_data.infinite_run_id for round_data in rounds if round_data.infinite_run_id is not None}
            )
            for run_id in run_ids:
                run_variables = [
                    selected[(index, task_id)]
                    for index, round_data in enumerate(rounds)
                    if round_data.infinite_run_id == run_id
                ]
                base = int(task["marginal_base"])
                increment = int(task["marginal_increment"])
                reward_terms.append(
                    add_count_reward(
                        f"reward_{task_id}_{run_id}",
                        run_variables,
                        lambda count, base=base, increment=increment: (
                            base * count + increment * count * (count - 1) // 2
                        ),
                    )
                )
            continue
        if task["type"] == "group":
            size = int(task["group_size"])
            bonus = int(task["group_bonus"])
            reward_terms.append(
                add_count_reward(
                    f"reward_{task_id}", variables,
                    lambda count, size=size, bonus=bonus: (count // size) * bonus,
                )
            )
        elif task["type"] == "cumulative":
            base = int(task["marginal_base"])
            increment = int(task["marginal_increment"])
            reward_terms.append(
                add_count_reward(
                    f"reward_{task_id}",
                    variables,
                    lambda count, base=base, increment=increment: (
                        base * count + increment * count * (count - 1) // 2
                    ),
                )
            )
        else:  # pragma: no cover - profile validation fixes the task types
            raise ValueError(f"Unsupported task type: {task['type']}")

    side_pay = model.new_int_var(0, 1_000_000, f"{prefix}side_pay")
    model.add(side_pay == sum(reward_terms))
    side_count = sum(
        variable for (round_index, task_id), variable in selected.items()
        if task_id in SIDE_TASKS
    )
    return model, selected, side_pay, side_count


def _solve(
    model: cp_model.CpModel, *, objective: cp_model.LinearExpr, maximize: bool
) -> cp_model.CpSolver:
    if maximize:
        model.maximize(objective)
    else:
        model.minimize(objective)
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.cp_model_presolve = True
    # The payoff tables create strong integer linear constraints. Full
    # linearization is dramatically faster for the dense fixed-four baseline
    # while preserving an exact, deterministic, single-worker proof.
    solver.parameters.linearization_level = 2
    status = solver.solve(model)
    if status != cp_model.OPTIMAL:
        raise RuntimeError(f"CP-SAT did not prove optimality (status={solver.status_name(status)})")
    return solver


def optimize_regime(
    profile: dict[str, Any], rounds: Sequence[Round], regime: tuple[int, int],
    *, canonical: bool = False,
) -> tuple[int, list[str], int]:
    model, selected, side_pay, side_count = _build_model(profile, rounds, regime)
    if canonical:
        tie_cost = sum(
            variable * ((round_index + 1) * 16 + TASK_CODE[task_id])
            for (round_index, task_id), variable in selected.items()
        )
        secondary = side_count * 100_000 + tie_cost
        secondary_upper_bound = int(profile["rounds"]) * 100_000 + (
            int(profile["rounds"]) * (int(profile["rounds"]) + 1) // 2
        ) * 16 + int(profile["rounds"]) * max(TASK_CODE.values())
        solver = _solve(
            model,
            objective=side_pay * (secondary_upper_bound + 1) - secondary,
            maximize=True,
        )
    else:
        solver = _solve(model, objective=side_pay, maximize=True)
    value = solver.value(side_pay)
    choices = [
        next(task_id for task_id in round_data.cards if solver.boolean_value(selected[(index, task_id)]))
        for index, round_data in enumerate(rounds)
    ]
    return value, choices, sum(choice in SIDE_TASKS for choice in choices)


def optimize_all_regimes(
    profile: dict[str, Any], rounds: Sequence[Round]
) -> tuple[dict[str, int], list[str], int]:
    """Prove all four V_ab values and choose a canonical V11 plan at once.

    The four model copies are disjoint. Maximizing their payoff sum therefore
    maximizes each V_ab individually. The secondary term is strictly dominated
    by one point of aggregate payoff and deterministically minimizes the V11
    side count/tie cost without changing any payoff optimum.
    """

    model = cp_model.CpModel()
    regimes: dict[
        str,
        tuple[dict[tuple[int, str], cp_model.IntVar], cp_model.IntVar, cp_model.LinearExpr],
    ] = {}
    for main_complete, movie_complete in REGIMES:
        key = f"V{main_complete}{movie_complete}"
        _model, selected, side_pay, side_count = _build_model(
            profile,
            rounds,
            (main_complete, movie_complete),
            model=model,
            prefix=f"{key}_",
        )
        regimes[key] = (selected, side_pay, side_count)
    selected_v11, _side_pay_v11, side_count_v11 = regimes["V11"]
    tie_cost = sum(
        variable * ((round_index + 1) * 16 + TASK_CODE[task_id])
        for (round_index, task_id), variable in selected_v11.items()
    )
    secondary = side_count_v11 * 100_000 + tie_cost
    secondary_upper_bound = int(profile["rounds"]) * 100_000 + (
        int(profile["rounds"]) * (int(profile["rounds"]) + 1) // 2
    ) * 16 + int(profile["rounds"]) * max(TASK_CODE.values())
    primary_scale = secondary_upper_bound + 1
    primary = sum(side_pay for _selected, side_pay, _count in regimes.values())
    solver = _solve(
        model,
        objective=primary * primary_scale - secondary,
        maximize=True,
    )
    values = {
        key: solver.value(side_pay)
        for key, (_selected, side_pay, _count) in regimes.items()
    }
    choices = [
        next(
            task_id for task_id in round_data.cards
            if solver.boolean_value(selected_v11[(index, task_id)])
        )
        for index, round_data in enumerate(rounds)
    ]
    return values, choices, sum(choice in SIDE_TASKS for choice in choices)


def canonical_complete_both(
    profile: dict[str, Any], rounds: Sequence[Round], optimum: int
) -> tuple[list[str], int]:
    model, selected, side_pay, side_count = _build_model(profile, rounds, (1, 1))
    model.add(side_pay == optimum)
    tie_cost = sum(
        variable * ((round_index + 1) * 16 + TASK_CODE[task_id])
        for (round_index, task_id), variable in selected.items()
    )
    # Any one-card change moves tie_cost by less than 2000; this makes side
    # count the primary secondary objective and leaves a deterministic tertiary
    # preference for earlier task codes/rounds.
    objective = side_count * 100_000 + tie_cost
    solver = _solve(model, objective=objective, maximize=False)
    choices = [
        next(task_id for task_id in round_data.cards if solver.boolean_value(selected[(index, task_id)]))
        for index, round_data in enumerate(rounds)
    ]
    return choices, sum(choice in SIDE_TASKS for choice in choices)


def planning_index(
    task: dict[str, Any], task_id: str, state: dict[str, Any], round_data: Round
) -> float:
    if task["type"] == "group":
        count = int(state["counts"].get(task_id, 0))
        if (count + 1) % int(task["group_size"]) == 0:
            return float(task["group_bonus"])
        return float(task["group_bonus"]) / float(task["group_size"])
    if task["type"] == "cumulative":
        count = int(state["counts"].get(task_id, 0))
        return float(task["marginal_base"] + task["marginal_increment"] * count)
    if task["type"] == "run":
        run_count = int(state["run_counts"].get(str(round_data.infinite_run_id), 0))
        return float(task["marginal_base"] + task["marginal_increment"] * run_count)
    return float(round_data.simple_payoffs[task_id])


def initial_task_state() -> dict[str, Any]:
    return {
        "main": 0,
        "movie": 0,
        "side_pay": 0,
        "counts": {task_id: 0 for task_id in SIDE_TASKS},
        "run_counts": {},
        "contributions": {task_id: 0 for task_id in SIDE_TASKS},
        "completed_bonuses": {"trio_a": 0, "trio_b": 0, "fives": 0},
    }


def public_task_state(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "main": state["main"],
        "movie": state["movie"],
        "side_pay": state["side_pay"],
        "counts": dict(state["counts"]),
        "run_counts": dict(state["run_counts"]),
        "contributions": dict(state["contributions"]),
        "completed_bonuses": dict(state["completed_bonuses"]),
    }


def apply_choice(
    profile: dict[str, Any], state: dict[str, Any], round_data: Round, task_id: str
) -> int:
    if task_id == "main":
        state["main"] += 1
        return 0
    if task_id == "movie":
        state["movie"] += 1
        return 0
    task = _task_lookup(profile)[task_id]
    before_count = int(state["counts"][task_id])
    state["counts"][task_id] = before_count + 1
    if task["type"] == "group":
        reward = int(task["group_bonus"]) if (before_count + 1) % int(task["group_size"]) == 0 else 0
        if reward:
            state["completed_bonuses"][task_id] += 1
    elif task["type"] == "cumulative":
        reward = int(task["marginal_base"] + task["marginal_increment"] * before_count)
    elif task["type"] == "run":
        run_key = str(round_data.infinite_run_id)
        run_count = int(state["run_counts"].get(run_key, 0))
        reward = int(task["marginal_base"] + task["marginal_increment"] * run_count)
        state["run_counts"][run_key] = run_count + 1
    else:
        reward = int(round_data.simple_payoffs[task_id])
    state["side_pay"] += reward
    state["contributions"][task_id] += reward
    return reward


def trace_choices(
    profile: dict[str, Any], rounds: Sequence[Round], choices: Sequence[str]
) -> tuple[list[tuple[dict[str, Any], dict[str, Any], int]], dict[str, Any]]:
    state = initial_task_state()
    trace: list[tuple[dict[str, Any], dict[str, Any], int]] = []
    for round_data, task_id in zip(rounds, choices):
        before = public_task_state(state)
        reward = apply_choice(profile, state, round_data, task_id)
        trace.append((before, public_task_state(state), reward))
    return trace, state


def reserve_policy(
    profile: dict[str, Any], rounds: Sequence[Round]
) -> tuple[list[str], list[tuple[dict[str, Any], dict[str, Any], int]], dict[str, Any]]:
    tasks = _task_lookup(profile)
    state = initial_task_state()
    choices: list[str] = []
    trace: list[tuple[dict[str, Any], dict[str, Any], int]] = []
    movie_start_index = int(profile["rounds"]) - int(profile["movie_rounds"])
    for index, round_data in enumerate(rounds):
        before = public_task_state(state)
        if index >= movie_start_index:
            choice = "movie"
        else:
            remaining_ordinary = movie_start_index - index
            main_needed = int(profile["main_target"]) - int(state["main"])
            if remaining_ordinary <= main_needed:
                choice = "main"
            else:
                side_cards = [task_id for task_id in round_data.cards if task_id in SIDE_TASKS]
                choice = max(
                    side_cards,
                    key=lambda task_id: (
                        planning_index(tasks[task_id], task_id, state, round_data),
                        -TASK_CODE[task_id],
                    ),
                )
        reward = apply_choice(profile, state, round_data, choice)
        choices.append(choice)
        trace.append((before, public_task_state(state), reward))
    return choices, trace, state


def pack_sequence(rounds: Sequence[Round]) -> str:
    raw = bytearray()
    simple_values = {"simple_a": (4, 8, 12), "simple_b": (2, 10, 16)}
    for round_data in rounds:
        side_mask = sum(1 << (TASK_CODE[task_id] - 2) for task_id in round_data.cards if task_id in SIDE_TASKS)
        simple_codes = 0
        for shift, task_id in ((0, "simple_a"), (2, "simple_b")):
            if task_id in round_data.simple_payoffs:
                simple_codes |= simple_values[task_id].index(round_data.simple_payoffs[task_id]) << shift
        ordered_codes = [TASK_CODE[task_id] for task_id in round_data.cards]
        ordered_codes.extend([15] * (6 - len(ordered_codes)))
        raw.extend((side_mask, simple_codes))
        raw.extend(
            (ordered_codes[index] << 4) | ordered_codes[index + 1]
            for index in range(0, 6, 2)
        )
    return base64.b64encode(bytes(raw)).decode("ascii")


def pack_color_map(color_map: dict[str, int]) -> str:
    codes = [color_map[task_id] for task_id in TASK_ORDER]
    raw = bytes((codes[index] << 4) | codes[index + 1] for index in range(0, 10, 2))
    return base64.b64encode(raw).decode("ascii")


def validate_round_structure(profile: dict[str, Any], rounds: Sequence[Round]) -> None:
    movie_start = int(profile["rounds"]) - int(profile["movie_rounds"]) + 1
    if len(rounds) != int(profile["rounds"]):
        raise ValueError("sequence has the wrong round count")
    for round_data in rounds:
        if round_data.cards.count("main") != 1:
            raise ValueError(f"round {round_data.number}: main must appear exactly once")
        side_count = sum(task_id in SIDE_TASKS for task_id in round_data.cards)
        if side_count != int(profile["side_cards_per_round"]):
            raise ValueError(
                f"round {round_data.number}: found {side_count} side cards; "
                f"expected fixed count {profile['side_cards_per_round']}"
            )
        movie_count = round_data.cards.count("movie")
        expected_movie = 1 if round_data.number >= movie_start else 0
        if movie_count != expected_movie:
            raise ValueError(f"round {round_data.number}: movie phase invariant failed")
        if round_data.cards[side_count] != "main":
            raise ValueError(
                f"round {round_data.number}: main is not immediately right of the side cards"
            )
        if expected_movie and round_data.cards[-1] != "movie":
            raise ValueError(
                f"round {round_data.number}: movie is not appended at the right edge"
            )
        expected_size = side_count + 1 + expected_movie
        if len(round_data.cards) != expected_size or len(set(round_data.cards)) != len(round_data.cards):
            raise ValueError(f"round {round_data.number}: invalid/duplicate choice set")


def certify_sequence(profile: dict[str, Any], sequence_id: int) -> CertifiedSequence:
    seed, rounds, color_map = draw_sequence(profile, sequence_id)
    validate_round_structure(profile, rounds)
    values: dict[str, int] = {}
    canonical_choices: list[str] = []
    minimum_optimal_side_count = -1
    for main_complete, movie_complete in REGIMES:
        key = f"V{main_complete}{movie_complete}"
        value, choices, side_count = optimize_regime(
            profile,
            rounds,
            (main_complete, movie_complete),
            canonical=False,
        )
        values[key] = value
        if key == "V11":
            canonical_choices = choices
            minimum_optimal_side_count = side_count
    canonical_trace, canonical_state = trace_choices(profile, rounds, canonical_choices)
    safe_choices, safe_trace, safe_state = reserve_policy(profile, rounds)
    side_budget = int(profile["side_budget"])
    selected_side_types = [
        task_id for task_id, count in canonical_state["counts"].items() if count
    ]
    safe_side = int(safe_state["side_pay"])
    configured_total = int(profile["main_bonus"]) + int(profile["movie_bonus"]) + safe_side
    best_deviation = max(
        int(profile["main_bonus"]) + values["V10"],
        int(profile["movie_bonus"]) + values["V01"],
        values["V00"],
    )
    margin = configured_total - best_deviation
    failures = []
    positive_side_rounds = sum(
        any(
            task_id in SIDE_TASKS
            and _task_lookup(profile)[task_id]["type"] in {"cumulative", "run", "simple"}
            for task_id in round_data.cards
        )
        for round_data in rounds[: int(profile["rounds"]) - int(profile["movie_rounds"])]
    )
    # More than S ordinary rounds contain a card whose first marginal payoff is
    # strictly positive. Therefore any complete-both plan using fewer than S
    # side choices must choose main on at least one such round; switching that
    # choice to the positive side card preserves Q and strictly improves pay.
    # This proves that every complete-both optimum uses exactly S side choices.
    if positive_side_rounds <= side_budget:
        failures.append(
            f"only {positive_side_rounds} ordinary rounds have an immediately positive side option"
        )
    if minimum_optimal_side_count != side_budget:
        failures.append(
            f"canonical complete-both side count is {minimum_optimal_side_count}, expected {side_budget}"
        )
    if values["V11"] <= 0:
        failures.append("complete-both optimum has no side payoff")
    if len(selected_side_types) < 2:
        failures.append("complete-both optimum selects fewer than two side-task types")
    if safe_state["main"] < int(profile["main_target"]) or safe_state["movie"] != int(profile["movie_rounds"]):
        failures.append("reserve policy did not complete both threshold tasks")
    if margin < int(profile["completion_margin"]):
        failures.append(f"completion margin {margin} is below delta")
    if failures:
        raise ValueError(f"sequence {sequence_id} failed certification: " + "; ".join(failures))

    appearances = Counter(task_id for round_data in rounds for task_id in round_data.cards if task_id in SIDE_TASKS)
    optimal_selections = Counter(choice for choice in canonical_choices if choice in SIDE_TASKS)
    safe_selections = Counter(choice for choice in safe_choices if choice in SIDE_TASKS)
    summary = {
        "sequence_id": sequence_id,
        "seed": seed,
        "validation_status": "certified",
        **values,
        "safe_policy_side_payoff": safe_side,
        "safe_policy_total_payoff": configured_total,
        "completion_margin": margin,
        "optimal_main_count": canonical_state["main"],
        "optimal_movie_count": canonical_state["movie"],
        "optimal_side_count": sum(canonical_state["counts"].values()),
        "optimal_side_task_bundle": {task_id: canonical_state["counts"][task_id] for task_id in SIDE_TASKS},
        "optimal_contribution_breakdown": canonical_state["contributions"],
        "task_appearance_counts": {task_id: appearances[task_id] for task_id in SIDE_TASKS},
        "optimal_selection_counts": {task_id: optimal_selections[task_id] for task_id in SIDE_TASKS},
        "safe_selection_counts": {task_id: safe_selections[task_id] for task_id in SIDE_TASKS},
        "completed_structured_bonuses": canonical_state["completed_bonuses"],
        "required_B_min": max(0, values["V01"] - safe_side + int(profile["completion_margin"])),
        "required_M_min": max(0, values["V10"] - safe_side + int(profile["completion_margin"])),
        "required_B_plus_M_min": max(0, values["V00"] - safe_side + int(profile["completion_margin"])),
    }
    return CertifiedSequence(
        sequence_id=sequence_id,
        seed=seed,
        rounds=rounds,
        color_map=color_map,
        values=values,
        canonical_choices=canonical_choices,
        safe_choices=safe_choices,
        canonical_trace=canonical_trace,
        safe_trace=safe_trace,
        summary=summary,
    )


def _static_planning_index(task: dict[str, Any], displayed_payoff: int | None) -> float:
    if task["type"] == "group":
        return float(task["group_bonus"]) / float(task["group_size"])
    if task["type"] == "cumulative":
        return float(task["marginal_base"])
    if task["type"] == "run":
        return float(task["marginal_base"] + 2 * task["marginal_increment"])
    return float(displayed_payoff or 0)


def validate_bank_diagnostics(
    profile: dict[str, Any], sequences: Sequence[CertifiedSequence], *, strict: bool = True
) -> dict[str, Any]:
    diagnostics = profile["diagnostics"]
    tasks = _task_lookup(profile)
    appearances = Counter()
    contributions = Counter()
    narrow = 0
    total_side_cards = 0
    main_rate = float(profile["main_bonus"]) / float(profile["main_target"])
    lower = main_rate * float(diagnostics["narrow_temptation_lower_ratio"])
    upper = main_rate * float(diagnostics["narrow_temptation_upper_ratio"])
    for sequence in sequences:
        contributions.update(sequence.summary["optimal_contribution_breakdown"])
        for round_index, round_data in enumerate(sequence.rounds):
            canonical_before = sequence.canonical_trace[round_index][0]
            for task_id in round_data.cards:
                if task_id not in SIDE_TASKS:
                    continue
                total_side_cards += 1
                appearances[task_id] += 1
                index = planning_index(
                    tasks[task_id], task_id, canonical_before, round_data
                )
                narrow += int(lower <= index <= upper)
    appearance_shares = {
        task_id: appearances[task_id] / total_side_cards for task_id in SIDE_TASKS
    }
    tolerance = float(diagnostics["appearance_share_tolerance"])
    appearance_failures = {
        task_id: share for task_id, share in appearance_shares.items()
        if abs(share - float(tasks[task_id]["weight"])) > tolerance
    }
    total_contribution = sum(contributions.values())
    contribution_shares = {
        task_id: (contributions[task_id] / total_contribution if total_contribution else 0)
        for task_id in SIDE_TASKS
    }
    contributing_types = sum(value > 0 for value in contributions.values())
    maximum_contribution_share = max(contribution_shares.values())
    narrow_frequency = narrow / total_side_cards
    failures = []
    if appearance_failures:
        failures.append(f"appearance shares outside tolerance: {appearance_failures}")
    if maximum_contribution_share > float(diagnostics["maximum_task_contribution_share"]):
        failures.append(f"maximum task contribution share is {maximum_contribution_share:.4f}")
    if contributing_types < int(diagnostics["minimum_contributing_task_types"]):
        failures.append(f"only {contributing_types} task types contribute")
    if not (
        float(diagnostics["narrow_temptation_frequency_min"])
        <= narrow_frequency
        <= float(diagnostics["narrow_temptation_frequency_max"])
    ):
        failures.append(f"narrow temptation frequency is {narrow_frequency:.4f}")
    if failures and strict:
        raise ValueError("Bank diagnostic failure: " + "; ".join(failures))
    return {
        "validation_status": "passed" if not failures else "development_sample_not_evaluated",
        "failures": failures,
        "total_side_card_appearances": total_side_cards,
        "appearance_shares": appearance_shares,
        "contribution_shares": contribution_shares,
        "contributing_task_types": contributing_types,
        "maximum_task_contribution_share": maximum_contribution_share,
        "narrow_temptation_bounds": [lower, upper],
        "narrow_temptation_frequency": narrow_frequency,
    }


def bank_core(profile: dict[str, Any], sequences: Sequence[CertifiedSequence]) -> dict[str, Any]:
    public_profile = {key: value for key, value in profile.items() if key not in {"movie_rounds", "main_target", "side_budget"}}
    public_profile.update(
        {"movie_rounds": profile["movie_rounds"], "main_target": profile["main_target"], "side_budget": profile["side_budget"]}
    )
    return {
        "format_version": "certified-bank-v1",
        "profile": public_profile,
        "task_order": list(TASK_ORDER),
        "packed_round_bytes": PACKED_ROUND_BYTES,
        "sequences": [
            {
                "sequence_id": sequence.sequence_id,
                "seed": sequence.seed,
                "rounds_b64": pack_sequence(sequence.rounds),
                "color_map_b64": pack_color_map(sequence.color_map),
                "benchmark_optimal_payoff": int(profile["main_bonus"]) + int(profile["movie_bonus"]) + sequence.values["V11"],
                "V00": sequence.values["V00"],
                "V01": sequence.values["V01"],
                "V10": sequence.values["V10"],
                "V11": sequence.values["V11"],
                "safe_side_payoff": sequence.summary["safe_policy_side_payoff"],
            }
            for sequence in sequences
        ],
    }


def _state_for_card(state: dict[str, Any], task_id: str, round_data: Round) -> str:
    if task_id == "main":
        payload = {"count": state["main"]}
    elif task_id == "movie":
        payload = {"count": state["movie"]}
    else:
        payload = {
            "count": state["counts"][task_id],
            "contribution": state["contributions"][task_id],
        }
        if task_id == "infinite_scroll":
            payload["run_count"] = state["run_counts"].get(str(round_data.infinite_run_id), 0)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def write_detail_csv(
    path: Path, profile: dict[str, Any], bank_hash: str, sequences: Sequence[CertifiedSequence]
) -> None:
    tasks = _task_lookup(profile)
    colors = profile["colors"]
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=DETAIL_COLUMNS, lineterminator="\n")
        writer.writeheader()
        for sequence in sequences:
            for index, round_data in enumerate(sequence.rounds):
                optimizer_choice = sequence.canonical_choices[index]
                safe_choice = sequence.safe_choices[index]
                optimizer_before, optimizer_after, _ = sequence.canonical_trace[index]
                safe_before, safe_after, _ = sequence.safe_trace[index]
                for position, task_id in enumerate(round_data.cards, start=1):
                    task = tasks.get(task_id, {})
                    color = colors[sequence.color_map[task_id]]
                    writer.writerow(
                        {
                            "profile_version": profile["profile_version"],
                            "bank_hash": bank_hash,
                            "sequence_id": sequence.sequence_id,
                            "seed": sequence.seed,
                            "round": round_data.number,
                            "phase": round_data.phase,
                            "position": position,
                            "task_id": task_id,
                            "task_type": "threshold" if task_id in {"main", "movie"} else task.get("type", ""),
                            "is_main": int(task_id == "main"),
                            "is_movie": int(task_id == "movie"),
                            "is_side": int(task_id in SIDE_TASKS),
                            "color_id": color["id"],
                            "color_hex": color["hex"],
                            "group_size": task.get("group_size", ""),
                            "group_bonus": task.get("group_bonus", ""),
                            "marginal_base": task.get("marginal_base", ""),
                            "marginal_increment": task.get("marginal_increment", ""),
                            "simple_outcomes": json.dumps(task.get("outcomes", ""), separators=(",", ":"), sort_keys=True) if task.get("outcomes") else "",
                            "displayed_simple_payoff": round_data.simple_payoffs.get(task_id, ""),
                            "availability_run_id": round_data.infinite_run_id if task_id == "infinite_scroll" else "",
                            "availability_run_start": round_data.infinite_run_start if task_id == "infinite_scroll" else "",
                            "availability_run_end": round_data.infinite_run_end if task_id == "infinite_scroll" else "",
                            "availability_rounds_remaining": (round_data.infinite_run_end - round_data.number + 1) if task_id == "infinite_scroll" and round_data.infinite_run_end else "",
                            "optimizer_chosen": int(task_id == optimizer_choice),
                            "reserve_policy_chosen": int(task_id == safe_choice),
                            "optimizer_task_state_before": _state_for_card(optimizer_before, task_id, round_data),
                            "optimizer_task_state_after": _state_for_card(optimizer_after, task_id, round_data),
                            "reserve_task_state_before": _state_for_card(safe_before, task_id, round_data),
                            "reserve_task_state_after": _state_for_card(safe_after, task_id, round_data),
                        }
                    )


def write_summary_csv(
    path: Path, profile: dict[str, Any], bank_hash: str, sequences: Sequence[CertifiedSequence]
) -> None:
    scalar_fields = [
        "sequence_id", "seed", "validation_status", "V00", "V01", "V10", "V11",
        "safe_policy_side_payoff", "safe_policy_total_payoff", "completion_margin",
        "optimal_main_count", "optimal_movie_count", "optimal_side_count",
        "required_B_min", "required_M_min", "required_B_plus_M_min",
    ]
    json_fields = [
        "optimal_side_task_bundle", "optimal_contribution_breakdown", "task_appearance_counts",
        "optimal_selection_counts", "safe_selection_counts", "completed_structured_bonuses",
    ]
    fieldnames = ["profile_version", "bank_hash", *scalar_fields, *json_fields]
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for sequence in sequences:
            row = {
                "profile_version": profile["profile_version"],
                "bank_hash": bank_hash,
                **{field: sequence.summary[field] for field in scalar_fields},
                **{
                    field: json.dumps(sequence.summary[field], separators=(",", ":"), sort_keys=True)
                    for field in json_fields
                },
            }
            writer.writerow(row)


def generate(
    profile: dict[str, Any], bank_size: int, *, progress: bool = True, workers: int = 1,
    executor_mode: str = "threads",
) -> list[CertifiedSequence]:
    sequence_ids = range(1, bank_size + 1)
    if workers <= 1:
        iterator: Iterable[CertifiedSequence] = (
            certify_sequence(profile, sequence_id) for sequence_id in sequence_ids
        )
        executor = None
    else:
        executor_class = (
            concurrent.futures.ProcessPoolExecutor
            if executor_mode == "processes"
            else concurrent.futures.ThreadPoolExecutor
        )
        executor = executor_class(max_workers=workers)
        iterator = executor.map(
            certify_sequence,
            [profile] * bank_size,
            sequence_ids,
            chunksize=1,
        )
    sequences = []
    try:
        for completed, sequence in enumerate(iterator, start=1):
            sequences.append(sequence)
            if progress and (completed == 1 or completed % 64 == 0 or completed == bank_size):
                print(f"Certified {completed}/{bank_size} sequences", file=sys.stderr, flush=True)
    finally:
        if executor is not None:
            executor.shutdown(cancel_futures=True)
    return sequences


def write_outputs(
    profile: dict[str, Any], sequences: Sequence[CertifiedSequence], bank_path: Path,
    detail_path: Path, summary_path: Path,
) -> dict[str, Any]:
    diagnostics = validate_bank_diagnostics(
        profile,
        sequences,
        strict=len(sequences) == int(profile["bank_size"]),
    )
    core = bank_core(profile, sequences)
    bank_hash = hashlib.sha256(canonical_json(core)).hexdigest()
    write_detail_csv(detail_path, profile, bank_hash, sequences)
    write_summary_csv(summary_path, profile, bank_hash, sequences)
    certificate = {
        "bank_hash": bank_hash,
        "validated_sequences_sha256": sha256_path(detail_path),
        "validated_sequence_summary_sha256": sha256_path(summary_path),
        "sequence_count": len(sequences),
        "validation_status": "certified",
        "required_B_min": max(sequence.summary["required_B_min"] for sequence in sequences),
        "required_M_min": max(sequence.summary["required_M_min"] for sequence in sequences),
        "required_B_plus_M_min": max(sequence.summary["required_B_plus_M_min"] for sequence in sequences),
        "minimum_completion_margin": min(sequence.summary["completion_margin"] for sequence in sequences),
        "diagnostics": diagnostics,
    }
    if not int(profile["main_bonus"]) > int(certificate["required_B_min"]):
        raise ValueError("Configured B does not exceed the bank-wide required minimum")
    if not int(profile["movie_bonus"]) > int(certificate["required_M_min"]):
        raise ValueError("Configured M does not exceed the bank-wide required minimum")
    if not int(profile["main_bonus"]) + int(profile["movie_bonus"]) > int(certificate["required_B_plus_M_min"]):
        raise ValueError("Configured B+M does not exceed the bank-wide required minimum")
    output = {**core, "certificate": certificate}
    bank_path.write_text(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return certificate


def verify_files(profile: dict[str, Any], bank_path: Path, detail_path: Path, summary_path: Path) -> None:
    bank = json.loads(bank_path.read_text())
    certificate = bank["certificate"]
    core = {key: value for key, value in bank.items() if key != "certificate"}
    actual_bank_hash = hashlib.sha256(canonical_json(core)).hexdigest()
    if actual_bank_hash != certificate["bank_hash"]:
        raise ValueError("certified_environment_bank.json bank hash is invalid")
    if sha256_path(detail_path) != certificate["validated_sequences_sha256"]:
        raise ValueError("validated_sequences.csv hash is invalid")
    if sha256_path(summary_path) != certificate["validated_sequence_summary_sha256"]:
        raise ValueError("validated_sequence_summary.csv hash is invalid")
    expected_profile = {
        **{key: value for key, value in profile.items() if key not in {"movie_rounds", "main_target", "side_budget"}},
        "movie_rounds": profile["movie_rounds"],
        "main_target": profile["main_target"],
        "side_budget": profile["side_budget"],
    }
    if bank["profile"] != expected_profile:
        raise ValueError("bank profile does not exactly match environment_profile.json")
    if len(bank["sequences"]) != int(profile["bank_size"]):
        raise ValueError("bank does not contain the profile's requested sequence count")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--bank", type=Path, default=DEFAULT_BANK)
    parser.add_argument("--detail", type=Path, default=DEFAULT_DETAIL)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--bank-size", type=int, help="development-only sequence count override")
    parser.add_argument(
        "--workers", type=int,
        default=max(1, min(8, os.cpu_count() or 1)),
        help="independent deterministic CP-SAT worker processes (default: up to 8)",
    )
    parser.add_argument(
        "--executor", choices=("threads", "processes"), default="threads",
        help="parallel executor; processes are fastest outside restricted sandboxes",
    )
    parser.add_argument("--verify-files", action="store_true", help="verify existing bank and CSV hashes without resolving")
    parser.add_argument("--quiet", action="store_true")
    arguments = parser.parse_args(argv)
    profile = load_profile(arguments.profile)
    if arguments.verify_files:
        verify_files(profile, arguments.bank, arguments.detail, arguments.summary)
        print("OK: certified bank and both review CSV hashes are valid")
        return 0
    if cp_model is None:
        raise SystemExit(
            "OR-Tools is required only for offline calibration. Install it with "
            "python3 -m pip install -r qualtrics/requirements-calibration.txt"
        )
    bank_size = arguments.bank_size or int(profile["bank_size"])
    if bank_size <= 0 or bank_size > int(profile["bank_size"]):
        parser.error("--bank-size must be between 1 and profile.bank_size")
    if arguments.workers <= 0:
        parser.error("--workers must be positive")
    sequences = generate(
        profile,
        bank_size,
        progress=not arguments.quiet,
        workers=arguments.workers,
        executor_mode=arguments.executor,
    )
    certificate = write_outputs(profile, sequences, arguments.bank, arguments.detail, arguments.summary)
    print(json.dumps(certificate, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
