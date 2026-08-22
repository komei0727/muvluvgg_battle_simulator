"""最終選抜。探索で1回も使っていない乱数範囲で、署名ごとのベストを並べ直す。"""

from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.final import (
    FinalSelectionSettings,
    final_phase,
    final_selection_cost,
    select_final,
    signature_bests,
)
from exercise_lab.gear.plan import ObservedSignature
from exercise_lab.gear.regime import RegimeSignature
from exercise_lab.gear.search import ClimbSettings, phases_for_climb
from exercise_lab.optimize.evaluator import Evaluator
from exercise_lab.optimize.fitness import Objective
from test_gear_search import FakeGearEvaluator

OBJECTIVE = Objective(best_of=5)
CLIMB = ClimbSettings(screen_runs=4, confirm_runs=8, survivors=6, max_iterations=8)
SETTINGS = FinalSelectionSettings(pool=4, runs=16)


def piece(stat: str, grade: str = "S") -> GearPiece:
    return GearPiece(stat=stat, tier="III", grade=grade)


def unit(name: str, *pieces: GearPiece) -> UnitAllocation:
    return UnitAllocation(unit_definition_id=name, pieces=pieces)


def allocation(*pieces: GearPiece) -> Allocation:
    return Allocation((unit("UNIT_A", *pieces),))


WEAK = allocation(piece("CRITICAL_RATE"))
STRONG = allocation(piece("ATTACK"))


def signature(recipient: str) -> RegimeSignature:
    return RegimeSignature(assignments={"ACT_RANK_BUFF": recipient})


def measured(evaluator, *allocations):
    """探索の確定段を通したことにする。署名ごとのベスト選びが読む履歴を作る。"""
    _, confirm = phases_for_climb(CLIMB)
    evaluator.ensure(list(allocations), CLIMB.confirm_runs, phase=confirm)


# --- 乱数範囲 ----------------------------------------------------------------


def test_the_final_phase_never_overlaps_the_ranges_the_search_used():
    screen, confirm = phases_for_climb(CLIMB)
    final = final_phase(CLIMB, SETTINGS)

    # 位相の重なりは評価器が拒む。探索と同じ乱数列で選び直さないための約束である。
    Evaluator.validate_phases((screen, confirm, final))
    assert final.span.start >= confirm.span.stop


def test_the_final_selection_evaluates_in_the_final_phase_only():
    evaluator = FakeGearEvaluator()
    measured(evaluator, WEAK, STRONG)
    _, confirm = phases_for_climb(CLIMB)
    before = evaluator.consumed_runs

    select_final(
        [WEAK, STRONG],
        evaluator,
        objective=OBJECTIVE,
        settings=SETTINGS,
        climb=CLIMB,
        budget_runs=1_000_000,
    )

    assert evaluator.consumed_runs == before + 2 * SETTINGS.runs
    # 探索の確定段の履歴は増えない。
    assert evaluator.record_for(STRONG, confirm).sample_count == CLIMB.confirm_runs


def test_the_winner_is_the_strongest_allocation():
    evaluator = FakeGearEvaluator()

    result = select_final(
        [WEAK, STRONG],
        evaluator,
        objective=OBJECTIVE,
        settings=SETTINGS,
        climb=CLIMB,
        budget_runs=1_000_000,
    )

    assert result.best.canonical_key() == STRONG.canonical_key()
    assert result.entries[0].sample_count == SETTINGS.runs


def test_two_allocations_with_the_same_score_series_collapse_into_one():
    # 会心率2枚（10×2）と行動速度1枚（20）は人工目的関数の上で同じ強さになる。
    twins = (
        allocation(piece("CRITICAL_RATE"), piece("CRITICAL_RATE", "A")),
        allocation(piece("ACTION_SPEED")),
    )
    evaluator = FakeGearEvaluator()

    result = select_final(
        list(twins),
        evaluator,
        objective=OBJECTIVE,
        settings=SETTINGS,
        climb=CLIMB,
        budget_runs=1_000_000,
    )

    assert len(result.entries) == 1


def test_a_budget_that_cannot_pay_for_the_selection_returns_nothing():
    evaluator = FakeGearEvaluator()

    result = select_final(
        [WEAK, STRONG],
        evaluator,
        objective=OBJECTIVE,
        settings=SETTINGS,
        climb=CLIMB,
        budget_runs=1,
    )

    assert result.entries == ()
    assert result.best is None
    assert evaluator.consumed_runs == 0
    assert result.warnings


def test_the_cost_is_the_pool_times_the_runs():
    assert final_selection_cost(SETTINGS) == 4 * 16


# --- 署名ごとのベスト --------------------------------------------------------


def test_one_allocation_enters_the_pool_for_each_signature():
    evaluator = FakeGearEvaluator()
    measured(evaluator, WEAK, STRONG)
    observations = (
        ObservedSignature(origin="base", allocation=WEAK, signature=signature("0:UNIT_A")),
        ObservedSignature(origin="base-climb", allocation=STRONG, signature=signature("0:UNIT_A")),
        ObservedSignature(origin="restart1", allocation=WEAK, signature=signature("1:UNIT_B")),
    )

    pool = signature_bests(
        observations, evaluator, climb=CLIMB, objective=OBJECTIVE, required=STRONG, limit=8
    )

    # 署名は2通り。同じ署名の中では確定段で強かった方が残る。
    assert [entry.canonical_key() for entry in pool] == [
        STRONG.canonical_key(),
        WEAK.canonical_key(),
    ]


def test_an_allocation_the_search_never_measured_stays_out_of_the_pool():
    evaluator = FakeGearEvaluator()
    measured(evaluator, STRONG)
    observations = (
        ObservedSignature(origin="base", allocation=STRONG, signature=signature("0:UNIT_A")),
        ObservedSignature(
            origin="restart1-push1", allocation=WEAK, signature=signature("1:UNIT_B")
        ),
    )

    pool = signature_bests(
        observations, evaluator, climb=CLIMB, objective=OBJECTIVE, required=STRONG, limit=8
    )

    assert [entry.canonical_key() for entry in pool] == [STRONG.canonical_key()]


def test_the_pool_is_capped_by_the_limit_and_always_holds_the_search_best():
    evaluator = FakeGearEvaluator()
    others = [allocation(piece(stat)) for stat in ("CRITICAL_RATE", "ACTION_SPEED", "ATTACK")]
    measured(evaluator, STRONG, *others)
    observations = tuple(
        ObservedSignature(
            origin=f"restart{index}", allocation=entry, signature=signature(f"{index}:UNIT")
        )
        for index, entry in enumerate(others)
    )

    pool = signature_bests(
        observations, evaluator, climb=CLIMB, objective=OBJECTIVE, required=STRONG, limit=2
    )

    assert len(pool) == 2
    assert pool[0].canonical_key() == STRONG.canonical_key()
