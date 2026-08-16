"""探索アルゴリズム。人工の目的関数で比較・再現性・予算・中断再開を確かめる。"""

import json
from random import Random

import pytest

from exercise_lab.optimize.algorithms import (
    ALGORITHMS,
    IteratedLocalSearch,
    RandomSearch,
    SearchContext,
    SearchSettings,
    final_selection_cost,
    optimize,
    racing_cost,
)
from exercise_lab.optimize.evaluator import Evaluator, phases_for
from exercise_lab.optimize.search_config import load_search_config
from helpers import (
    IDEAL_MEMORIES,
    IDEAL_SCORE,
    IDEAL_UNITS,
    ArenaClient,
    search_config_document,
    write_yaml,
)

SMALL_SCHEDULE = {"populationSize": 12, "stageRuns": [4, 12], "finalPoolSize": 6, "topK": 3}
SMALL_FINAL = {"finalStageRuns": [50]}


def make_config(tmp_path, **schedule):
    document = search_config_document(
        schedule={**SMALL_SCHEDULE, **SMALL_FINAL, **schedule},
        knownFormations=[
            {
                "units": [
                    {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
                    {"unitDefinitionId": "UNIT_G", "position": {"column": 1, "row": "REAR"}},
                ],
                "memoryDefinitionIds": ["MEM_1", "MEM_5"],
            }
        ],
    )
    return load_search_config(write_yaml(tmp_path, document))


def make_context(config, client, *, budget=6000, seed=7, state_path=None):
    search_phase, final_phase = phases_for(config.schedule)
    evaluator = Evaluator(
        client,
        config,
        base_seed="arena",
        phases=(search_phase, final_phase),
        max_candidates=8,
        max_total_runs=200,
    )
    return SearchContext(
        config=config,
        evaluator=evaluator,
        search_phase=search_phase,
        final_phase=final_phase,
        rng=Random(seed),
        settings=SearchSettings(budget_runs=budget, patience=config.schedule.patience),
        state_path=state_path,
    )


def test_the_registry_holds_the_three_comparable_algorithms():
    assert set(ALGORITHMS) == {"local-search", "random", "optuna"}


def test_local_search_beats_random_search_on_most_seeds(tmp_path):
    """同じ予算・同じ評価器で、反復局所探索がランダムサーチを上回る。

    1つのseedでの勝敗は運で決まるので多数決で見る。確率的な探索を単発の比較で
    固定すると、実装を変えていないのに落ちるテストになる。
    """
    config = make_config(tmp_path)

    wins = 0
    for seed in range(7):
        local = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), seed=seed))
        chance = optimize(RandomSearch(), make_context(config, ArenaClient(), seed=seed))
        wins += local.top[0].fitness > chance.top[0].fitness

    assert wins >= 5


def test_local_search_approaches_the_known_optimum(tmp_path):
    # 既定のpatienceは数世代の停滞で止まる。最適解の近くまで詰める余地を与える。
    config = make_config(tmp_path, patience=30)

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=12000))

    best = result.top[0].candidate
    assert len(set(best.unit_definition_ids) & set(IDEAL_UNITS)) >= 4
    assert set(IDEAL_MEMORIES).issubset(best.memory_definition_ids)
    assert result.top[0].mean > IDEAL_SCORE * 0.8


def test_the_search_avoids_a_formation_that_collapses_in_one_run_out_of_five(tmp_path):
    """理想編成に必須のユニットが下振れ源のとき、平均だけなら選ぶが適応度では避ける。"""
    config = make_config(tmp_path)
    client = ArenaClient(collapse_units=frozenset({"UNIT_A"}))

    result = optimize(IteratedLocalSearch(), make_context(config, client, budget=12000))

    assert "UNIT_A" not in result.top[0].candidate.unit_definition_ids


def test_the_same_seed_reproduces_the_same_result(tmp_path):
    config = make_config(tmp_path)

    first = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), seed=99))
    second = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), seed=99))

    assert [entry.candidate.canonical_key() for entry in first.top] == [
        entry.candidate.canonical_key() for entry in second.top
    ]
    assert first.consumed_runs == second.consumed_runs


def test_a_different_seed_explores_differently(tmp_path):
    config = make_config(tmp_path)

    first = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), seed=1))
    second = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), seed=2))

    assert first.history != second.history


@pytest.mark.parametrize("budget", [700, 900, 1500, 3000, 9000])
def test_the_search_never_exceeds_its_budget(tmp_path, budget):
    """予算は打ち切りの目安ではなく上限である。

    世代の途中で使い切る形にすると、最後の1世代ぶんまるごと超過する。世代を始める前に
    「その世代を回しきれるか」を見て決める。
    """
    config = make_config(tmp_path)

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=budget))

    assert result.consumed_runs <= budget


def test_the_budget_reserves_enough_for_the_final_selection(tmp_path):
    config = make_config(tmp_path)

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=3000))

    # 最終選抜が予算切れで走らなかったのなら top は空になる
    assert final_selection_cost(config.schedule) == 6 * 50
    assert result.top


def test_a_budget_that_cannot_cover_one_generation_is_rejected_with_the_minimum(tmp_path):
    config = make_config(tmp_path)
    minimum = final_selection_cost(config.schedule) + racing_cost(
        config.schedule.population_size, config.schedule.stage_runs
    )

    with pytest.raises(ValueError, match=str(minimum)):
        optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=minimum - 1))


def test_the_minimum_budget_is_enough_to_produce_a_report(tmp_path):
    config = make_config(tmp_path)
    minimum = final_selection_cost(config.schedule) + racing_cost(
        config.schedule.population_size, config.schedule.stage_runs
    )

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=minimum))

    assert result.top
    assert result.consumed_runs <= minimum


def test_the_search_stops_after_the_patience_runs_out(tmp_path):
    config = make_config(tmp_path, patience=1)

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=20000))

    assert result.stopped_because == "patience"
    assert result.consumed_runs < 20000


def test_the_best_so_far_curve_never_goes_down(tmp_path):
    config = make_config(tmp_path)

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=8000))

    best = [point.best_fitness for point in result.history]
    assert best == sorted(best)
    assert [point.consumed_runs for point in result.history] == sorted(
        point.consumed_runs for point in result.history
    )


def test_the_final_selection_reports_at_most_the_requested_number_of_distinct_formations(tmp_path):
    """返すのは「別物である上位k件」。同じ結果になる編成は畳むので k を下回り得る。"""
    config = make_config(tmp_path, topK=3)

    result = optimize(IteratedLocalSearch(), make_context(config, ArenaClient()))

    assert 0 < len(result.top) <= 3
    keys = [entry.candidate.canonical_key() for entry in result.top]
    behaviours = [tuple(entry.record.scores_at(entry.sample_count)) for entry in result.top]
    assert len(set(keys)) == len(keys)
    assert len(set(behaviours)) == len(behaviours)


def test_the_final_selection_uses_samples_the_search_never_saw(tmp_path):
    config = make_config(tmp_path)
    context = make_context(config, ArenaClient())

    result = optimize(IteratedLocalSearch(), context)

    # 最終位相は探索位相と別のseed範囲で積む
    assert all(entry.sample_count == 50 for entry in result.top)
    for entry in result.top:
        search_record = context.evaluator.record_for(entry.candidate, context.search_phase)
        assert search_record is not None
        assert search_record.scores != entry.record.scores


def test_resuming_from_a_saved_state_reproduces_the_uninterrupted_trajectory(tmp_path):
    config = make_config(tmp_path)
    state_path = tmp_path / "state.json"

    whole = optimize(IteratedLocalSearch(), make_context(config, ArenaClient(), budget=8000))

    interrupted = make_context(config, ArenaClient(), budget=8000, state_path=state_path)
    interrupted.settings = SearchSettings(budget_runs=2500, patience=config.schedule.patience)
    optimize(IteratedLocalSearch(), interrupted)
    assert state_path.exists()

    resumed_context = make_context(config, ArenaClient(), budget=8000, state_path=state_path)
    resumed = optimize(IteratedLocalSearch(), resumed_context, resume=True)

    assert [entry.candidate.canonical_key() for entry in resumed.top] == [
        entry.candidate.canonical_key() for entry in whole.top
    ]
    assert resumed.consumed_runs == whole.consumed_runs


def test_the_saved_state_is_readable_json(tmp_path):
    config = make_config(tmp_path)
    state_path = tmp_path / "state.json"

    optimize(
        IteratedLocalSearch(),
        make_context(config, ArenaClient(), budget=3000, state_path=state_path),
    )

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["algorithm"] == "local-search"
    assert state["generation"] >= 1
    assert state["population"]


def test_random_search_also_returns_a_ranked_top_list(tmp_path):
    config = make_config(tmp_path)

    result = optimize(RandomSearch(), make_context(config, ArenaClient()))

    assert len(result.top) == config.schedule.top_k
    assert list(result.top) == sorted(result.top, key=lambda entry: entry.fitness, reverse=True)


class StarvedClient(ArenaClient):
    """期限に達して1件も返せないサーバー。`completedRuns: 0` は正当な応答（Q-TEX-18）。"""

    def _evaluate_one(self, formation, seed, runs):
        del formation, seed, runs
        return {
            "completedRuns": 0,
            "scores": [],
            "breakCounts": [],
            "completedTurns": [],
            "completionReasons": [],
        }


def test_a_server_that_completes_nothing_stops_the_search_instead_of_crashing(tmp_path):
    config = make_config(tmp_path)

    result = optimize(IteratedLocalSearch(), make_context(config, StarvedClient(), budget=6000))

    assert result.top == ()
    assert result.stopped_because == "exhausted"


class FlakyClient(ArenaClient):
    """1候補だけ期限で切れるサーバー。1件の欠けが探索全体を止めてはならない。"""

    def _evaluate_one(self, formation, seed, runs):
        evaluated = super()._evaluate_one(formation, seed, runs)
        units = {unit["unitDefinitionId"] for unit in formation["units"]}
        if "UNIT_H" in units:
            for key in ("scores", "breakCounts", "completedTurns", "completionReasons"):
                evaluated[key] = evaluated[key][:1]
            evaluated["completedRuns"] = 1
        return evaluated


def test_a_partially_evaluated_candidate_does_not_stop_the_search(tmp_path):
    config = make_config(tmp_path)

    result = optimize(IteratedLocalSearch(), make_context(config, FlakyClient(), budget=6000))

    assert result.top
    assert all(entry.sample_count == 50 for entry in result.top)


def test_the_optuna_baseline_runs_within_the_same_budget(tmp_path):
    optuna_search = pytest.importorskip(
        "exercise_lab.optimize.optuna_search", reason="optuna が入っていない"
    )
    config = make_config(tmp_path)

    result = optimize(optuna_search.OptunaSearch(), make_context(config, ArenaClient()))

    assert result.algorithm == "optuna"
    assert result.consumed_runs <= 6000
    assert result.top
