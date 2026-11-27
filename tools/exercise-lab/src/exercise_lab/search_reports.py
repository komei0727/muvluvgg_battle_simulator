"""共通乱数の試行を対応付け、スコア差と詳細再生用の参照を返す。"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from statistics import mean
from typing import Any

from mlgg_lab_common.api.contracts import ExecutionEnvironment
from mlgg_lab_common.evaluation.models import ExecutionSettings
from mlgg_lab_common.experiments.search_store import SqliteSearchStore
from mlgg_lab_common.models import ConfigError
from mlgg_lab_common.search.candidate import Candidate, dump_candidate, effective_gears
from mlgg_lab_common.search.problem import SearchProblem
from mlgg_lab_common.storage.layout import open_evaluation
from mlgg_lab_common.storage.repository import StoredResult

from .search_config import SearchObjective
from .search_round import Phase, phase_seed, saved_candidates
from .statistics.daily_best import expected_best

BOOTSTRAP_SAMPLES = 1_000


@dataclass(frozen=True)
class SavedTrial:
    evaluation_id: str
    candidate_id: str
    seed: str
    result: StoredResult
    environment: ExecutionEnvironment
    match_request: dict[str, Any]
    settings: ExecutionSettings

    def reference(self) -> dict:
        return {
            "evaluationId": self.evaluation_id,
            "candidateId": self.candidate_id,
            "seed": self.seed,
            "runIndex": self.result.run_index,
            "caseId": self.result.case_id,
        }

    @property
    def score(self) -> int:
        return self.result.observation["totalScore"]


def trial_results(
    store: SqliteSearchStore,
    *,
    seed: str | None = None,
    candidate_ids: set[str] | None = None,
    run_indices: set[int] | None = None,
) -> Iterator[SavedTrial]:
    saved_rounds = store.rounds()
    requests = defaultdict(dict)
    for request in store.requests():
        if candidate_ids is None or request.candidate_id in candidate_ids:
            requests[request.round_number][request.case_id] = request
    pinned = None
    for round_ in saved_rounds:
        with (
            open_evaluation(store.evaluations_dir / round_.evaluation_id) as repo,
            repo.read_transaction(),
        ):
            environment = repo.environment()
            if environment is None:
                continue
            if pinned is None:
                pinned = environment
            if pinned.differences(environment) or not requests[round_.round_number]:
                continue
            plan = repo.load_plan()
            if seed is not None and plan.seed != seed:
                continue
            cases = {case.case_id: case for case in plan.cases}
            for result in repo.results():
                request = requests[round_.round_number].get(result.case_id)
                if request is None or (
                    run_indices is not None and result.run_index not in run_indices
                ):
                    continue
                if request.completed is not None and result.run_index not in request.completed:
                    continue
                yield SavedTrial(
                    round_.evaluation_id,
                    request.candidate_id,
                    plan.seed,
                    result,
                    environment,
                    cases[result.case_id].match_request,
                    plan.settings,
                )


def _percentile(sorted_values: Sequence[float], probability: float) -> float:
    position = (len(sorted_values) - 1) * probability
    low = int(position)
    high = min(low + 1, len(sorted_values) - 1)
    return sorted_values[low] + (position - low) * (sorted_values[high] - sorted_values[low])


def _bootstrap(
    before: Sequence[int], after: Sequence[int], best_of: int
) -> tuple[list[float] | None, list[float] | None]:
    count = len(before)
    if count < 2:
        return None, None
    rng = random.Random(0)
    population = range(count)
    mean_deltas, best_deltas = [], []
    differences = [b - a for a, b in zip(before, after, strict=True)]
    weights = None
    if count >= best_of:
        divisor = math.comb(count, best_of)
        weights = [math.comb(i, best_of - 1) / divisor for i in population]
    for _ in range(BOOTSTRAP_SAMPLES):
        # 同じ標本番号を両候補から復元抽出する。
        sample = rng.choices(population, k=count)
        mean_deltas.append(sum(differences[i] for i in sample) / count)
        if weights is not None:
            a = sorted(before[i] for i in sample)
            b = sorted(after[i] for i in sample)
            best_deltas.append(sum(w * (y - x) for w, x, y in zip(weights, a, b, strict=True)))
    mean_deltas.sort()
    best_deltas.sort()
    return (
        [_percentile(mean_deltas, q) for q in (0.025, 0.975)],
        [_percentile(best_deltas, q) for q in (0.025, 0.975)] if best_deltas else None,
    )


def _metric(a: float | None, b: float | None, interval: list[float] | None) -> dict:
    return {
        "baseline": a,
        "candidate": b,
        "delta": None if a is None or b is None else b - a,
        "confidenceInterval95": interval,
    }


def _representatives(pairs: list[tuple[SavedTrial, SavedTrial]]) -> dict:
    if not pairs:
        return {}
    ranked = sorted(
        pairs, key=lambda pair: (pair[1].score - pair[0].score, pair[0].result.run_index)
    )
    by_score = sorted(pairs, key=lambda pair: (pair[1].score, pair[1].result.run_index))
    examples = {
        "largestGain": ranked[-1],
        "largestLoss": ranked[0],
        "medianDelta": ranked[(len(ranked) - 1) // 2],
        "upperTail": by_score[math.ceil(0.95 * len(by_score)) - 1],
    }
    return {
        kind: {
            "baseline": a.reference(),
            "candidate": b.reference(),
            "baselineScore": a.score,
            "candidateScore": b.score,
            "delta": b.score - a.score,
        }
        for kind, (a, b) in examples.items()
    }


def _formation_changes(problem: SearchProblem, baseline: Candidate, candidate: Candidate) -> dict:
    a, b = dump_candidate(baseline), dump_candidate(candidate)
    units = []
    for index in range(max(len(baseline.units), len(candidate.units))):
        configurations = []
        for side, spec in ((baseline, a), (candidate, b)):
            if index >= len(side.units):
                configurations.append(None)
            else:
                gears = effective_gears(problem, side.units[index])
                configurations.append(
                    spec["units"][index]
                    | {"gears": [gear.model_dump(mode="json") for gear in gears]}
                )
        before, after = configurations
        if before != after:
            units.append({"index": index, "before": before, "after": after})
    return {
        "units": units,
        "memories": {
            "before": a["memoryDefinitionIds"],
            "after": b["memoryDefinitionIds"],
        }
        if a["memoryDefinitionIds"] != b["memoryDefinitionIds"]
        else None,
    }


def compare_candidates(
    store: SqliteSearchStore, baseline: str, candidates: Sequence[str], phase: Phase
) -> dict:
    registered = saved_candidates(store)
    selected = list(dict.fromkeys(candidates or [cid for cid in registered if cid != baseline]))
    for cid in [baseline, *selected]:
        if cid not in registered:
            raise ConfigError(f"候補 {cid} が見つからない")
    problem = store.load_problem()
    objective = SearchObjective.model_validate(
        problem.method.settings.get("objective", {"metric": "EXPECTED_DAILY_BEST"})
    )
    seed = phase_seed(problem, phase)
    observations: dict[str, dict[int, SavedTrial]] = defaultdict(dict)
    for trial in trial_results(store, seed=seed, candidate_ids={baseline, *selected}):
        observations[trial.candidate_id][trial.result.run_index] = trial
    origins = defaultdict(list)
    for proposal in store.proposals():
        if proposal.accepted:
            origins[proposal.candidate_id].append(proposal.origin.model_dump(mode="json"))

    results = []
    reference = observations[baseline]
    for cid in selected:
        candidate = observations[cid]
        overlap = sorted(reference.keys() & candidate.keys())
        pairs = [(reference[i], candidate[i]) for i in overlap]
        a = [first.score for first, _ in pairs]
        b = [second.score for _, second in pairs]
        mean_interval, best_interval = _bootstrap(a, b, objective.best_of)
        enough = len(overlap) >= objective.best_of
        results.append(
            {
                "candidateId": cid,
                "origins": origins[cid],
                "changes": _formation_changes(problem, registered[baseline], registered[cid]),
                "pairedRuns": len(overlap),
                "candidateRuns": len(candidate),
                "meanScore": _metric(mean(a) if a else None, mean(b) if b else None, mean_interval),
                "expectedBest": _metric(
                    expected_best(a, best_of=objective.best_of) if enough else None,
                    expected_best(b, best_of=objective.best_of) if enough else None,
                    best_interval,
                ),
                "representativeTrials": _representatives(pairs),
            }
        )
    metric = "meanScore" if objective.metric == "MEAN_SCORE" else "expectedBest"
    results.sort(
        key=lambda row: (
            row[metric]["delta"] is None,
            -(row[metric]["delta"] or 0),
            row["candidateId"],
        )
    )
    return {
        "baselineId": baseline,
        "baselineRuns": len(reference),
        "phase": phase,
        "seed": seed,
        "bestOf": objective.best_of,
        "rankedBy": metric,
        "bootstrapSamples": BOOTSTRAP_SAMPLES,
        "comparisons": results,
    }
