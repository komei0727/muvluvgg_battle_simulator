"""通常戦闘の探索空間: 固定した相手に対して共通の実行制御で味方編成を評価する。"""

import json

import pytest

from battle_lab.inputs import load_battle_match_file, resolve_battle_input
from battle_lab.search_space import BATTLE_SEARCH, battle_search_problem
from mlgg_lab_common.experiments.layout import create_search, open_search
from mlgg_lab_common.inputs.catalog import Catalog
from mlgg_lab_common.inputs.player_data import load_player_data
from mlgg_lab_common.models import Gear, Position
from mlgg_lab_common.search import operations as ops
from mlgg_lab_common.search.candidate import Origin
from mlgg_lab_common.search.constraints import check_candidate
from mlgg_lab_common.search.method import Allocation, Proposal, TrialRequest
from mlgg_lab_common.search.problem import (
    GearPolicy,
    SearchExecution,
    SearchProblemError,
    SearchSpace,
)
from mlgg_lab_common.search.runner import SearchStopReason, run_search
from mlgg_lab_common.search.training import training_from_player_data
from mlgg_lab_common.testing import FakeEvaluationServer, scripted_method

MATCH = """\
turnLimit: 9
allyFormation:
  units:
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    - { unitDefinitionId: UNIT_B, position: { column: 2, row: REAR } }
  memoryDefinitionIds: [MEM_Z, MEM_A]
enemyFormation:
  units:
    - { unitDefinitionId: UNIT_C, position: { column: 1, row: REAR } }
  memoryDefinitionIds: [MEM_A]
"""
GEAR = {"stat": "ATTACK", "tier": "III", "grade": "S"}
PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {"PHYSICAL": 80}, "attributes": {}},
    "units": {
        "UNIT_A": {"level": 300, "gears": [GEAR] + [None] * 8},
        "UNIT_D": {"level": 420, "rank": 2, "gears": []},
    },
}
CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "rev-1",
        "units": [
            {"unitDefinitionId": unit_id, "displayName": unit_id, "category": "PLAYABLE"}
            for unit_id in ("UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D")
        ]
        + [{"unitDefinitionId": "UNIT_T", "displayName": "T", "category": "EXERCISE_ENEMY"}],
        "memories": [
            {"memoryDefinitionId": memory_id, "displayName": memory_id}
            for memory_id in ("MEM_A", "MEM_Z")
        ],
    }
)


def build(tmp_path, method, *, gear=None, pool=("UNIT_A", "UNIT_B", "UNIT_D")):
    match_path = tmp_path / "match.yaml"
    match_path.write_text(MATCH, encoding="utf-8")
    data_path = tmp_path / "player-data.json"
    data_path.write_text(json.dumps(PLAYER_DATA), encoding="utf-8")
    resolved = resolve_battle_input(load_battle_match_file(match_path))
    training, _ = training_from_player_data(pool, load_player_data(data_path))
    problem = battle_search_problem(
        resolved,
        space=SearchSpace(unitPool=list(pool), memoryPool=["MEM_A", "MEM_Z"]),
        training=training,
        gear=gear,
        execution=SearchExecution(
            candidateSeed="gen", battleSeed="b-1", budget={"maxSubmittedRuns": 50}
        ),
        method=method.binding(),
    )
    # 元ファイルを書き換えても、作成済みの探索問題は変わらない。
    match_path.write_text(MATCH.replace("turnLimit: 9", "turnLimit: 3"), encoding="utf-8")
    return problem


def test_candidates_are_evaluated_against_the_fixed_enemy_and_turn_limit(tmp_path):
    method = scripted_method([], [])
    problem = build(tmp_path, method)
    start = problem.starts[0]
    swapped = ops.swap_memories(ops.replace_unit(start, 1, "UNIT_D"), 0, 1)
    origin = Origin(kind="PROPOSED", operations=("replace_unit", "swap_memories"))
    method = scripted_method(
        [[Proposal(swapped, origin)]],
        [
            Allocation(
                requests=(
                    TrialRequest(start.candidate_id, runs=2),
                    TrialRequest(swapped.candidate_id, run_indices=(3, 8)),
                )
            )
        ],
    )
    server = FakeEvaluationServer()
    directory, store = create_search(
        tmp_path / "searches", problem, BATTLE_SEARCH, search_id="s", catalog=CATALOG
    )
    with store:
        report = run_search(store, method, BATTLE_SEARCH, server, sleep=lambda _: None)
        assert report.stop_reason is SearchStopReason.METHOD_FINISHED

    (request,) = server.requests
    first, second = request["cases"]
    for case in (first, second):
        assert case["turnLimit"] == 9
        assert case["enemyFormation"] == {
            "units": [{"unitDefinitionId": "UNIT_C", "position": {"column": 1, "row": "REAR"}}],
            "memoryDefinitionIds": ["MEM_A"],
        }
    assert first["allyFormation"]["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert second["allyFormation"]["memoryDefinitionIds"] == ["MEM_A", "MEM_Z"]
    # 入れ替えた枠には入ったユニットの育成条件が当たる（配置は枠のまま）。
    unit_a, unit_d = second["allyFormation"]["units"]
    assert unit_a["enhancement"] == {"level": 300, "gears": [GEAR]}
    assert unit_d == {
        "unitDefinitionId": "UNIT_D",
        "position": {"column": 2, "row": "REAR"},
        "enhancement": {"level": 420, "gears": [], "rank": 2},
    }
    assert (first["runIndices"], second["runIndices"]) == ([0, 1], [3, 8])

    feedback = method.allocator.feedback[0]
    assert [len(o.observations) for o in feedback.outcomes] == [2, 2]
    assert {o.observation["runIndex"] for o in feedback.outcomes[1].observations} == {3, 8}
    with open_search(directory) as reopened:
        assert reopened.load_problem() == problem


def test_gear_modes_hold_or_adjust_gears_within_the_policy(tmp_path):
    fixed = build(tmp_path, scripted_method([], []))
    start = fixed.starts[0]
    tuned = ops.set_gears(start, 1, [Gear(stat="DEFENSE", tier="II", grade="B")])
    assert check_candidate(fixed, BATTLE_SEARCH, tuned) == [
        "units[1]: ギア固定の探索でギアを変更している（UNIT_B）"
    ]

    adjustable = build(
        tmp_path,
        scripted_method([], []),
        gear=GearPolicy(mode="ADJUSTABLE", allowedTiers=["II"], resourceLimits=[{"maxCount": 1}]),
    )
    assert check_candidate(adjustable, BATTLE_SEARCH, tuned) == [
        "ギア資源の上限を超える（全ギア: 2 個 > 1 個）"
    ]
    untuned = ops.set_gears(tuned, 0, [])
    assert check_candidate(adjustable, BATTLE_SEARCH, untuned) == []


def test_pools_and_the_fixed_enemy_are_checked_against_the_catalog(tmp_path):
    problem = build(tmp_path, scripted_method([], []), pool=("UNIT_A", "UNIT_B", "UNIT_T"))
    with pytest.raises(SearchProblemError) as error:
        create_search(tmp_path / "searches", problem, BATTLE_SEARCH, catalog=CATALOG)
    assert error.value.problems == [
        "catalog: space.unitPool: UNIT_T は category=EXERCISE_ENEMY であり PLAYABLE ではない"
        "（R-TEX-11 #3）"
    ]


def test_the_fixed_conditions_cannot_be_moved_by_candidates(tmp_path):
    problem = build(tmp_path, scripted_method([], []))
    # 相手の配置重複のような固定条件の誤りは探索問題の作成時に落ちる。
    broken = problem.model_copy(
        update={
            "fixed": {
                **problem.fixed,
                "enemyFormation": {
                    "units": [
                        {"unitDefinitionId": "UNIT_C", "position": {"column": 1, "row": "REAR"}},
                        {"unitDefinitionId": "UNIT_A", "position": {"column": 1, "row": "REAR"}},
                    ]
                },
            }
        }
    )
    with pytest.raises(SearchProblemError, match="配置が重複"):
        create_search(tmp_path / "searches", broken, BATTLE_SEARCH)
    # 候補は味方側だけを持つので、候補から相手を変える手段が無い。
    assert set(problem.starts[0].model_dump()) == {"units", "memory_definition_ids"}
    assert ops.ALL_POSITIONS[0] == Position(column=0, row="FRONT")
