"""`lab gear-plan` の中断・再開。保存した状態から同じ軌跡で続きを回すための道具。"""

import json

import pytest

from exercise_lab.api import EvaluationResponse
from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.plan import PlanSettings
from exercise_lab.gear.regime import CachingObserver, RegimeSignature
from exercise_lab.gear.search import ClimbSettings, phases_for_climb
from exercise_lab.gear.state import (
    PlanCheckpoint,
    plan_digest,
    plan_phases,
    read_plan_state,
)
from exercise_lab.optimize.evaluator import Evaluator

SETTINGS = PlanSettings(climb=ClimbSettings(screen_runs=4, confirm_runs=8, survivors=2))


def piece(stat: str) -> GearPiece:
    return GearPiece(stat=stat, tier="III", grade="S")


START = Allocation(
    (
        UnitAllocation(unit_definition_id="UNIT_A", pieces=(piece("ATTACK"),)),
        UnitAllocation(unit_definition_id="UNIT_B", pieces=(piece("CRITICAL_RATE"),)),
    )
)

SIGNATURE = RegimeSignature(
    action_order=("0:UNIT_A", "1:UNIT_B"),
    assignments={"ACT_RANK_BUFF": "0:UNIT_A"},
    consumers={"ACT_DEBUFF": "1:UNIT_B"},
    holders={"ACT_DEBUFF": "enemy:UNIT_ENEMY"},
)


class FakeClient:
    """一括評価の代わり。枠別の与ダメージも返す（ギア探索の篩いが読む列）。"""

    def __init__(self):
        self.requests: list[dict] = []

    def evaluate(self, body: dict) -> EvaluationResponse:
        self.requests.append(body)
        runs = body["runsPerCandidate"]
        units = len(body["candidates"][0]["allyFormation"]["units"])
        damage = [[100 + run + index for index in range(units)] for run in range(runs)]
        return EvaluationResponse.model_validate(
            {
                "catalogRevision": "test-revision",
                "seed": body["seed"],
                "runsPerCandidate": runs,
                "candidates": [
                    {
                        "completedRuns": runs,
                        "scores": [sum(row) for row in damage],
                        "breakCounts": [1] * runs,
                        "completedTurns": [5] * runs,
                        "completionReasons": ["TURN_LIMIT_REACHED"] * runs,
                        "allyUnitDamageTotals": damage,
                        "allyUnitBreakCounts": [[0] * units for _ in range(runs)],
                    }
                    for _ in body["candidates"]
                ],
            }
        )


class RaisingClient:
    """1件でも送ろうとしたら落ちるクライアント。再開が再評価しないことを固定する。"""

    def evaluate(self, body: dict) -> EvaluationResponse:
        raise AssertionError("再開したのに評価を発行した")

    def simulate_exercise(self, body: dict):
        raise AssertionError("再開したのに単発実行を発行した")


class StubSource:
    def enemy_formation(self) -> dict:
        return {"units": []}

    def ally_formation(self, allocation: Allocation) -> dict:
        return {
            "units": [{"unitDefinitionId": unit.unit_definition_id} for unit in allocation.units],
            "memoryDefinitionIds": [],
        }


def make_evaluator(client) -> Evaluator:
    return Evaluator(client, StubSource(), base_seed="abc", phases=plan_phases(SETTINGS))


def make_checkpoint(tmp_path, evaluator, observer, *, seed="abc", digest=None) -> PlanCheckpoint:
    return PlanCheckpoint(
        path=tmp_path / "state.json",
        evaluator=evaluator,
        observer=observer,
        seed=seed,
        digest=digest if digest is not None else plan_digest(START, SETTINGS),
        phases=plan_phases(SETTINGS),
    )


def make_observer(client) -> CachingObserver:
    return CachingObserver(client=client, source=StubSource())


def saved_checkpoint(tmp_path):
    """1巡だけ評価と観測を済ませ、その状態を書き出す。"""
    evaluator = make_evaluator(FakeClient())
    observer = make_observer(RaisingClient())
    observer.cache[START.canonical_key()] = SIGNATURE
    screen, _ = phases_for_climb(SETTINGS.climb)
    evaluator.ensure([START], SETTINGS.climb.screen_runs, phase=screen)
    checkpoint = make_checkpoint(tmp_path, evaluator, observer)
    checkpoint.save()
    return checkpoint


def test_the_saved_state_is_readable_json(tmp_path):
    saved_checkpoint(tmp_path)

    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))

    assert state["version"] == 1
    assert state["seed"] == "abc"
    assert state["consumedRuns"] == SETTINGS.climb.screen_runs
    assert state["requestedRuns"] == SETTINGS.climb.screen_runs
    assert state["records"]["climb-screen"]
    assert state["signatures"]


def test_restoring_replays_the_records_without_evaluating_again(tmp_path):
    saved_checkpoint(tmp_path)
    evaluator = make_evaluator(RaisingClient())
    observer = make_observer(RaisingClient())
    make_checkpoint(tmp_path, evaluator, observer).restore()

    screen, _ = phases_for_climb(SETTINGS.climb)
    records = evaluator.ensure([START], SETTINGS.climb.screen_runs, phase=screen)

    assert records[0].sample_count == SETTINGS.climb.screen_runs
    assert evaluator.consumed_runs == SETTINGS.climb.screen_runs
    assert evaluator.requested_runs == SETTINGS.climb.screen_runs


def test_the_restored_records_keep_the_per_unit_damage(tmp_path):
    """枠別の与ダメージは篩いの指標そのものなので落とせない。"""
    saved_checkpoint(tmp_path)
    evaluator = make_evaluator(RaisingClient())
    make_checkpoint(tmp_path, evaluator, make_observer(RaisingClient())).restore()

    screen, _ = phases_for_climb(SETTINGS.climb)
    record = evaluator.ensure([START], SETTINGS.climb.screen_runs, phase=screen)[0]

    assert record.unit_damage_at(0, count=4) == [100, 101, 102, 103]


def test_the_restored_signatures_are_reused_instead_of_observing_again(tmp_path):
    saved_checkpoint(tmp_path)
    observer = make_observer(RaisingClient())
    make_checkpoint(tmp_path, make_evaluator(RaisingClient()), observer).restore()

    assert observer.observe(START).digest() == SIGNATURE.digest()
    assert observer.calls == 0


def test_the_restored_state_does_not_count_its_runs_before_they_are_asked_for(tmp_path):
    """復元しただけでは消費に数えない。数えると曲線の横軸が再開の時点で跳ね上がる。"""
    saved_checkpoint(tmp_path)
    evaluator = make_evaluator(RaisingClient())

    make_checkpoint(tmp_path, evaluator, make_observer(RaisingClient())).restore()

    assert evaluator.consumed_runs == 0


def test_a_state_saved_from_another_base_is_rejected(tmp_path):
    saved_checkpoint(tmp_path)
    checkpoint = make_checkpoint(
        tmp_path,
        make_evaluator(RaisingClient()),
        make_observer(RaisingClient()),
        digest="別の基点",
    )

    with pytest.raises(ValueError, match="基点編成"):
        checkpoint.restore()


def test_a_state_saved_with_another_seed_is_rejected(tmp_path):
    saved_checkpoint(tmp_path)
    checkpoint = make_checkpoint(
        tmp_path, make_evaluator(RaisingClient()), make_observer(RaisingClient()), seed="xyz"
    )

    with pytest.raises(ValueError, match="seed"):
        checkpoint.restore()


def test_an_unknown_state_version_is_rejected(tmp_path):
    saved_checkpoint(tmp_path)
    path = tmp_path / "state.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["version"] = 99
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="99"):
        read_plan_state(path)


def test_the_digest_changes_with_the_settings():
    other = PlanSettings(climb=ClimbSettings(screen_runs=6, confirm_runs=8, survivors=2))

    assert plan_digest(START, SETTINGS) != plan_digest(START, other)
    assert plan_digest(START, SETTINGS) == plan_digest(START, SETTINGS)
