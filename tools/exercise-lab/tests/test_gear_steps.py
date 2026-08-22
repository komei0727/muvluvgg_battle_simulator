"""到達手順。現状から理論値までの差分を、累積Δと谷のグループ化つきで並べる。"""

from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.search import ClimbSettings
from exercise_lab.gear.steps import (
    apply_all,
    build_step_plan,
    diff_moves,
    group_numbers,
    max_step_count,
    step_plan_cost,
)
from exercise_lab.optimize.fitness import Objective
from test_gear_search import FakeGearEvaluator

OBJECTIVE = Objective(best_of=5)
CLIMB = ClimbSettings(screen_runs=4, confirm_runs=8, survivors=6, max_iterations=8)


def piece(stat: str, grade: str = "S", tier: str = "III") -> GearPiece:
    return GearPiece(stat=stat, tier=tier, grade=grade)


def unit(name: str, *pieces: GearPiece) -> UnitAllocation:
    return UnitAllocation(unit_definition_id=name, pieces=pieces)


START = Allocation(
    (
        unit("UNIT_A", piece("CRITICAL_RATE"), piece("CRITICAL_RATE", "A")),
        unit("UNIT_B", piece("ACTION_SPEED")),
    )
)
TARGET = Allocation(
    (
        unit("UNIT_A", piece("ATTACK"), piece("CRITICAL_RATE", "A")),
        unit("UNIT_B", piece("ACTION_SPEED"), piece("AFFINITY_BONUS")),
    )
)


def plan(start=START, target=TARGET, evaluator=None, budget=1_000_000):
    evaluator = evaluator or FakeGearEvaluator()
    return (
        build_step_plan(
            start,
            target,
            evaluator,
            climb=CLIMB,
            objective=OBJECTIVE,
            budget_runs=budget,
        ),
        evaluator,
    )


# --- 差分の切り出し ----------------------------------------------------------


def test_an_identical_target_produces_no_steps():
    result, evaluator = plan(target=START)

    assert result.steps == ()
    assert result.is_empty
    # 差分が無いなら評価も1件も要らない。
    assert evaluator.consumed_runs == 0


def test_an_empty_path_has_no_group_to_stop_at():
    result, _ = plan(target=START)

    assert result.group_ends() == ()


def test_a_replacement_becomes_one_step_that_swaps_the_piece():
    moves = diff_moves(START, TARGET)

    swap = next(move for move in moves if move.slot_index == 0)
    assert swap.removed == piece("CRITICAL_RATE")
    assert swap.added == piece("ATTACK")
    added = next(move for move in moves if move.slot_index == 1)
    assert added.removed is None
    assert added.added == piece("AFFINITY_BONUS")
    assert len(moves) == 2


def test_a_rank_change_pairs_with_the_same_stat_rather_than_another():
    start = Allocation((unit("UNIT_A", piece("ATTACK", "S"), piece("CRITICAL_RATE")),))
    target = Allocation((unit("UNIT_A", piece("ATTACK", "C"), piece("AFFINITY_BONUS")),))

    moves = diff_moves(start, target)

    pairs = {(move.removed.stat, move.added.stat) for move in moves}
    assert pairs == {("ATTACK", "ATTACK"), ("CRITICAL_RATE", "AFFINITY_BONUS")}


def test_the_last_step_arrives_at_the_target():
    result, _ = plan()

    assert result.steps
    assert result.steps[-1].allocation.canonical_key() == TARGET.canonical_key()


def test_no_intermediate_allocation_breaks_the_gear_rule():
    start = Allocation((unit("UNIT_A", *(piece("CRITICAL_RATE", grade) for grade in "SAB")),))
    target = Allocation((unit("UNIT_A", *(piece("ATTACK", grade) for grade in "SAB")),))

    result, _ = plan(start=start, target=target)

    assert len(result.steps) == 3
    for step in result.steps:
        assert step.allocation.violations() == []


# --- 並びと累積 --------------------------------------------------------------


def test_the_steps_are_ordered_by_their_standalone_delta():
    result, _ = plan()

    deltas = [step.solo_delta for step in result.steps]
    assert deltas == sorted(deltas, reverse=True)


def test_the_cumulative_delta_of_the_last_step_measures_the_whole_path():
    result, evaluator = plan()

    last = result.steps[-1]
    base = evaluator.record_for(START, result.phase)
    reached = evaluator.record_for(TARGET, result.phase)
    count = min(base.sample_count, reached.sample_count)
    expected = OBJECTIVE.expected_best(reached.scores_at(count)) - OBJECTIVE.expected_best(
        base.scores_at(count)
    )
    assert last.cumulative_delta == expected


# --- 谷のグループ化 ----------------------------------------------------------


def test_a_step_that_gains_on_its_own_closes_its_group():
    assert group_numbers([5.0, 3.0], [5.0, 8.0]) == (1, 2)


def test_a_step_that_loses_ground_on_its_own_is_grouped_with_the_next():
    # 単独では下がる2手。まとめて適用してはじめて現状を超える。
    assert group_numbers([4.0, -1.0, -2.0], [4.0, 3.0, 9.0]) == (1, 2, 2)


def test_a_step_whose_cumulative_stays_below_the_current_does_not_close_a_group():
    # 単独では上がる手でも、そこで止めると現状より弱いならセットで適用させる。
    assert group_numbers([4.0, 3.0], [-1.0, 6.0]) == (1, 1)


def test_a_step_without_a_measurement_never_closes_a_group():
    # 測れなかった手で止めてよいかは分からない。分からないまま区切りを打たない。
    assert group_numbers([4.0, None, 2.0], [4.0, None, 9.0]) == (1, 2, 2)


def test_the_valley_is_reported_as_one_group_in_the_plan():
    # 攻撃力が2枚に届くと跳ね上がる盤面。1枚だけ挿すと会心率を1枚失って損をする。
    def strength(unit_allocation, allocation):
        attack = unit_allocation.count("ATTACK")
        value = 100 * unit_allocation.count("CRITICAL_RATE") + 10 * attack
        return value + (500 if attack >= 2 else 0)

    start = Allocation((unit("UNIT_A", *(piece("CRITICAL_RATE", grade) for grade in "SAB")),))
    target = Allocation(
        (unit("UNIT_A", piece("ATTACK"), piece("ATTACK", "A"), piece("CRITICAL_RATE", "B")),)
    )

    result, _ = plan(
        start=start, target=target, evaluator=FakeGearEvaluator(unit_strength=strength)
    )

    assert [step.solo_delta < 0 for step in result.steps] == [True, True]
    assert {step.group for step in result.steps} == {1}


def test_reordering_within_a_group_leaves_the_group_end_unchanged():
    def strength(unit_allocation, allocation):
        attack = unit_allocation.count("ATTACK")
        value = 100 * unit_allocation.count("CRITICAL_RATE") + 10 * attack
        return value + (500 if attack >= 2 else 0)

    start = Allocation((unit("UNIT_A", *(piece("CRITICAL_RATE", grade) for grade in "SAB")),))
    target = Allocation(
        (unit("UNIT_A", piece("ATTACK"), piece("ATTACK", "A"), piece("CRITICAL_RATE", "B")),)
    )

    result, _ = plan(
        start=start, target=target, evaluator=FakeGearEvaluator(unit_strength=strength)
    )

    # 1グループ＝セットで適用する単位。集合が同じなら、どの順で重ねても着く先は変わらない。
    moves = [step.move for step in result.steps]
    assert len({step.group for step in result.steps}) == 1
    assert list(result.group_ends()) == [target.canonical_key()]
    assert apply_all(start, list(reversed(moves))).canonical_key() == target.canonical_key()


# --- 予算 --------------------------------------------------------------------


def test_a_budget_that_cannot_pay_for_the_path_leaves_it_empty_with_a_warning():
    result, evaluator = plan(budget=1)

    assert result.steps == ()
    assert evaluator.consumed_runs == 0
    assert result.warnings


def test_the_estimated_cost_covers_the_widest_possible_difference():
    # 5枠すべてが9枚とも入れ替わる場合が上限。
    assert max_step_count(5) == 45
    assert step_plan_cost(CLIMB, step_count=3) == (1 + 3 + 3) * CLIMB.confirm_runs


def test_a_path_whose_end_is_not_its_best_point_says_so():
    # 会心率が2枚を超えると崩れる盤面。理論値まで進めると経路の途中より弱くなる。
    def strength(unit_allocation, allocation):
        rate = unit_allocation.count("CRITICAL_RATE")
        return 100 * min(rate, 2) - 60 * max(0, rate - 2)

    start = Allocation((unit("UNIT_A"),))
    target = Allocation((unit("UNIT_A", *(piece("CRITICAL_RATE", grade) for grade in "SAB")),))

    result, _ = plan(
        start=start, target=target, evaluator=FakeGearEvaluator(unit_strength=strength)
    )

    assert result.steps[-1].cumulative_delta < max(step.cumulative_delta for step in result.steps)
    assert any("最良ではない" in warning for warning in result.warnings)


class PartialEvaluator(FakeGearEvaluator):
    """期限に達して要求より少ない試行しか返さないサーバー（Q-TEX-18）の代わり。"""

    def __init__(self, cap: int):
        super().__init__()
        self._cap = cap

    def ensure(self, candidates, target, *, phase):
        return super().ensure(candidates, min(target, self._cap), phase=phase)


def test_the_deltas_are_computed_from_the_runs_that_actually_completed():
    evaluator = PartialEvaluator(cap=3)

    result, _ = plan(evaluator=evaluator)

    base = evaluator.record_for(START, result.phase)
    assert base.sample_count == 3
    reached = evaluator.record_for(TARGET, result.phase)
    expected = OBJECTIVE.expected_best(reached.scores_at(3)) - OBJECTIVE.expected_best(
        base.scores_at(3)
    )
    assert result.steps[-1].cumulative_delta == expected
