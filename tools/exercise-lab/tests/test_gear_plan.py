"""Phase C: レジーム再スタート。山登りが越えられない谷の向こう側を探す。"""

from dataclasses import replace

from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.plan import (
    PlanSettings,
    minimum_budget,
    observation_count,
    plan_budget,
    plan_gear_allocation,
)
from exercise_lab.gear.regime import RegimeSignature
from exercise_lab.gear.search import ClimbSettings, hill_climb
from exercise_lab.optimize.fitness import Objective
from test_gear_search import FakeGearEvaluator

OBJECTIVE = Objective(best_of=5)

# 谷を作る重み。埋まった9枠から1枚を攻撃力へ移すたびに70ずつ損をするが、
# 攻撃力が3枚に達するとレジームが変わって600の跳ね上がりがある。
VALLEY_WEIGHTS = {"CRITICAL_RATE": 100, "CRITICAL_DAMAGE_BONUS": 100, "AFFINITY_BONUS": 100}
ATTACK_WEIGHT = 30
REGIME_BONUS = 600
REGIME_COMPONENT = "ACT_RANK_BUFF"


def piece(stat: str, grade: str) -> GearPiece:
    return GearPiece(stat=stat, tier="III", grade=grade)


def full_unit(name: str) -> UnitAllocation:
    return UnitAllocation(
        unit_definition_id=name,
        pieces=tuple(piece(stat, grade) for stat in VALLEY_WEIGHTS for grade in ("S", "A", "B")),
    )


START = Allocation((full_unit("UNIT_A"), full_unit("UNIT_B")))


def recipient_of(allocation: Allocation) -> str:
    """攻撃力が3枚に届くまでは UNIT_A が受け先。届くと相方へ移る。"""
    return "1:UNIT_B" if allocation.units[0].count("ATTACK") >= 3 else "0:UNIT_A"


def valley_strength(unit: UnitAllocation, allocation: Allocation) -> int:
    strength = sum(VALLEY_WEIGHTS.get(entry.stat, 0) for entry in unit.pieces)
    strength += ATTACK_WEIGHT * unit.count("ATTACK")
    if unit is allocation.units[0] and recipient_of(allocation) == "1:UNIT_B":
        strength += REGIME_BONUS
    return strength


class FakeObserver:
    """単発実行の代わり。配分から署名を決めて返す。"""

    def __init__(self):
        self.calls: list[Allocation] = []

    def observe(self, allocation: Allocation) -> RegimeSignature:
        self.calls.append(allocation)
        return RegimeSignature(
            action_order=("0:UNIT_A", "1:UNIT_B"),
            assignments={REGIME_COMPONENT: recipient_of(allocation)},
            consumers={},
            holders={},
        )


CLIMB = ClimbSettings(screen_runs=4, confirm_runs=8, survivors=6, max_iterations=8)
SETTINGS = PlanSettings(climb=CLIMB, restarts=2, push_steps=4)


def run_plan(settings=SETTINGS, budget=1_000_000, evaluator=None, observer=None):
    evaluator = evaluator or FakeGearEvaluator(unit_strength=valley_strength)
    observer = observer or FakeObserver()
    result = plan_gear_allocation(
        START,
        evaluator,
        observer,
        settings=settings,
        objective=OBJECTIVE,
        budget_runs=budget,
    )
    return result, evaluator, observer


def test_the_hill_climb_alone_cannot_cross_the_valley():
    evaluator = FakeGearEvaluator(unit_strength=valley_strength)

    climbed = hill_climb(
        START, evaluator, settings=CLIMB, objective=OBJECTIVE, budget_runs=1_000_000
    )

    assert climbed.best.canonical_key() == START.canonical_key()
    assert climbed.stopped_because == "LOCAL_OPTIMUM"


def test_a_regime_restart_reaches_the_solution_beyond_the_valley():
    result, _, _ = run_plan()

    assert result.best.units[0].count("ATTACK") == 3
    assert result.best.canonical_key() != START.canonical_key()
    assert result.base_climb.best.canonical_key() == START.canonical_key()


def test_the_reached_signatures_are_listed_with_where_they_came_from():
    result, _, _ = run_plan()

    digests = {entry.signature.digest() for entry in result.signatures}
    assert len(digests) == 2
    assert {entry.origin for entry in result.signatures} >= {"base"}
    assert any(entry.origin.startswith("restart") for entry in result.signatures)


def test_a_restart_that_never_changes_the_signature_is_reported_as_untouched():
    class FrozenObserver(FakeObserver):
        def observe(self, allocation):
            super().observe(allocation)
            return RegimeSignature(assignments={REGIME_COMPONENT: "0:UNIT_A"})

    result, _, _ = run_plan(observer=FrozenObserver())

    assert result.restarts
    assert all(not attempt.changed for attempt in result.restarts)
    assert all(attempt.climb is None for attempt in result.restarts)
    assert result.best.canonical_key() == START.canonical_key()


def test_pushing_never_produces_an_invalid_allocation():
    result, _, _ = run_plan()

    for attempt in result.restarts:
        for allocation in attempt.pushed:
            assert allocation.violations() == []


def test_both_directions_are_tried_for_the_same_component():
    result, _, _ = run_plan()

    assert {attempt.direction for attempt in result.restarts} == {"UP", "DOWN"}
    assert all(attempt.component == REGIME_COMPONENT for attempt in result.restarts)


def test_the_number_of_restarts_is_capped_by_the_setting():
    result, _, _ = run_plan(settings=replace(SETTINGS, restarts=1))

    assert len(result.restarts) == 1


def test_no_restart_leaves_the_base_climb_as_the_answer():
    result, _, observer = run_plan(settings=replace(SETTINGS, restarts=0))

    assert result.restarts == ()
    assert result.best.canonical_key() == result.base_climb.best.canonical_key()
    # 基点の観測だけは行う（到達した署名の一覧に基点が要る）。
    assert observer.calls


def test_a_budget_that_cannot_pay_for_one_iteration_issues_no_evaluation():
    result, evaluator, _ = run_plan(budget=1)

    assert evaluator.consumed_runs == 0
    assert result.best.canonical_key() == START.canonical_key()
    assert result.ranking == ()


def test_the_budget_is_never_exceeded():
    budget = 400
    result, evaluator, _ = run_plan(budget=budget)

    assert evaluator.consumed_runs <= budget
    assert result.consumed_runs == evaluator.consumed_runs


def test_the_budget_breakdown_counts_every_climb():
    settings = PlanSettings(
        climb=ClimbSettings(screen_runs=10, confirm_runs=30, survivors=16, max_iterations=12),
        restarts=4,
        push_steps=4,
    )

    plan = plan_budget(settings, move_count=120)

    per_iteration = (1 + 120) * 10 + (1 + 16) * 30
    assert plan["perIteration"] == per_iteration
    assert plan["perClimb"] == per_iteration * 12
    assert plan["total"] == per_iteration * 12 * (1 + 4)
    assert observation_count(settings) == 1 + 1 + 4 * (4 + 1)


def test_the_minimum_budget_covers_the_calibration_and_one_iteration():
    settings = PlanSettings(
        climb=ClimbSettings(screen_runs=10, confirm_runs=30, survivors=16, max_iterations=12),
        restarts=4,
    )

    minimum = minimum_budget(settings, move_count=120)

    # 校正は基点を篩いの深さで測る1回ぶん。反復を始める前の見張りは1反復の上限で
    # 判定するので、その手前で使ったぶんだけ余裕が要る。
    assert minimum == 10 + plan_budget(settings, move_count=120)["perIteration"]


def test_the_same_input_reproduces_the_same_plan():
    first, _, _ = run_plan()
    second, _, _ = run_plan()

    assert first.best.canonical_key() == second.best.canonical_key()
    assert [attempt.direction for attempt in first.restarts] == [
        attempt.direction for attempt in second.restarts
    ]
