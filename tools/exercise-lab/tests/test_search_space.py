"""戦術演習の探索空間: 固定した演習対象に対して、通常戦闘と同じ実行制御で味方編成を評価する。"""

import json

import pytest

from exercise_lab.inputs.exercise import resolve_exercise_input
from exercise_lab.search_space import EXERCISE_SEARCH, exercise_search_problem
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

FORMATION = """\
ally:
  units:
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    - { unitDefinitionId: UNIT_B, position: { column: 1, row: REAR } }
  memoryDefinitionIds: [MEM_A]
enemy:
  unitDefinitionId: UNIT_T
  position: { column: 1, row: REAR }
"""
GEAR = {"stat": "CRITICAL_RATE", "tier": "II", "grade": "S"}
PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {}, "attributes": {"CUTE": 40}},
    "units": {"UNIT_B": {"level": 260, "gears": [GEAR, None]}},
}
CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "rev-1",
        "units": [
            {"unitDefinitionId": unit_id, "displayName": unit_id, "category": "PLAYABLE"}
            for unit_id in ("UNIT_A", "UNIT_B", "UNIT_C")
        ]
        + [{"unitDefinitionId": "UNIT_T", "displayName": "T", "category": "EXERCISE_ENEMY"}],
        "memories": [
            {"memoryDefinitionId": memory_id, "displayName": memory_id}
            for memory_id in ("MEM_A", "MEM_Z")
        ],
    }
)


def build(tmp_path, method, *, gear=None, pool=("UNIT_A", "UNIT_B", "UNIT_C")):
    formation_path = tmp_path / "formation.yaml"
    formation_path.write_text(FORMATION, encoding="utf-8")
    data_path = tmp_path / "player-data.json"
    data_path.write_text(json.dumps(PLAYER_DATA), encoding="utf-8")
    resolved = resolve_exercise_input(formation_path)
    training, warnings = training_from_player_data(pool, load_player_data(data_path))
    problem = exercise_search_problem(
        resolved,
        space=SearchSpace(unitPool=list(pool), memoryPool=["MEM_A", "MEM_Z"], maxUnits=3),
        training=training,
        gear=gear,
        execution=SearchExecution(
            candidateSeed="gen", battleSeed="t-1", budget={"maxSubmittedRuns": 50}
        ),
        method=method.binding(),
    )
    return problem, warnings


def test_candidates_are_evaluated_against_the_fixed_exercise_target(tmp_path):
    problem, warnings = build(tmp_path, scripted_method([], []))
    assert [w.split(" ")[0] for w in warnings] == ["UNIT_A", "UNIT_C"]
    start = problem.starts[0]
    grown = ops.add_memory(
        ops.add_unit(start, "UNIT_C", Position(column=2, row="FRONT")), "MEM_Z", 0
    )
    method = scripted_method(
        [[Proposal(grown, Origin(kind="PROPOSED", operations=("add_unit", "add_memory")))]],
        [
            Allocation(requests=(TrialRequest(grown.candidate_id, run_indices=(10, 2)),)),
            Allocation(requests=(TrialRequest(start.candidate_id, runs=1),)),
        ],
    )
    server = FakeEvaluationServer()
    directory, store = create_search(
        tmp_path / "searches", problem, EXERCISE_SEARCH, search_id="x", catalog=CATALOG
    )
    with store:
        report = run_search(store, method, EXERCISE_SEARCH, server, sleep=lambda _: None)
        assert report.stop_reason is SearchStopReason.METHOD_FINISHED
        assert report.budget.used == 3

    assert all(r["seed"] == "t-1" for r in server.requests)
    cases = [case for request in server.requests for case in request["cases"]]
    for case in cases:
        assert case["enemyFormation"] == {
            "units": [{"unitDefinitionId": "UNIT_T", "position": {"column": 1, "row": "REAR"}}],
            "memoryDefinitionIds": [],
        }
        assert "turnLimit" not in case
    grown_case, start_case = cases
    assert grown_case["allyFormation"]["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert [u["unitDefinitionId"] for u in grown_case["allyFormation"]["units"]] == [
        "UNIT_A",
        "UNIT_B",
        "UNIT_C",
    ]
    assert grown_case["allyFormation"]["units"][1]["enhancement"] == {
        "level": 260,
        "gears": [GEAR],
    }
    # 段階2は結果の無い番号を昇順に送る（要求した集合は同じ）。
    assert grown_case["runIndices"] == [2, 10]
    assert start_case["runIndices"] == [0]

    # 演習の観測（スコア・ブレイク）がそのまま要求元へ返る。
    outcome = method.allocator.feedback[0].outcomes[0]
    assert sorted(o.observation["runIndex"] for o in outcome.observations) == [2, 10]
    assert all("totalScore" in o.observation for o in outcome.observations)
    with open_search(directory) as reopened:
        assert [r.status for r in reopened.rounds()] == ["CLOSED", "CLOSED"]


def test_gear_modes_and_exercise_pools(tmp_path):
    problem, _ = build(tmp_path, scripted_method([], []))
    tuned = ops.set_gears(problem.starts[0], 0, [Gear(stat="ATTACK", tier="II", grade="S")])
    assert check_candidate(problem, EXERCISE_SEARCH, tuned) == [
        "units[0]: ギア固定の探索でギアを変更している（UNIT_A）"
    ]
    adjustable, _ = build(
        tmp_path,
        scripted_method([], []),
        gear=GearPolicy(mode="ADJUSTABLE", allowedStats=["DEFENSE"]),
    )
    assert check_candidate(adjustable, EXERCISE_SEARCH, tuned) == [
        "units[0]（UNIT_A）.gears[0]: 能力 ATTACK は許可されていない"
    ]

    wrong_pool, _ = build(tmp_path, scripted_method([], []), pool=("UNIT_A", "UNIT_B", "UNIT_T"))
    with pytest.raises(SearchProblemError, match="UNIT_T は category=EXERCISE_ENEMY"):
        create_search(tmp_path / "searches", wrong_pool, EXERCISE_SEARCH, catalog=CATALOG)
