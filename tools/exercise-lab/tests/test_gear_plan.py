"""Phase C: レジーム再スタート。山登りが越えられない谷の向こう側を探す。"""

from dataclasses import replace

from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.final import FinalSelectionSettings, final_phase
from exercise_lab.gear.plan import (
    PlanSettings,
    minimum_budget,
    observation_count,
    plan_budget,
    plan_gear_allocation,
    reserved_budget,
)
from exercise_lab.gear.rank_tuning import (
    RankTuningSettings,
    focus_targets,
    max_target_count,
)
from exercise_lab.gear.ranks import EMPTY_LADDER
from exercise_lab.gear.regime import RegimeSignature
from exercise_lab.gear.search import ClimbSettings, hill_climb, phases_for_climb
from exercise_lab.optimize.evaluator import Evaluator
from exercise_lab.optimize.fitness import Objective
from test_gear_ranks import attack_ladder
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


def run_plan(settings=SETTINGS, budget=1_000_000, evaluator=None, observer=None, ladder=None):
    evaluator = evaluator or FakeGearEvaluator(unit_strength=valley_strength)
    observer = observer or FakeObserver()
    result = plan_gear_allocation(
        START,
        evaluator,
        observer,
        settings=settings,
        objective=OBJECTIVE,
        budget_runs=budget,
        ladder=EMPTY_LADDER if ladder is None else ladder,
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
    # 枠数が分からない呼び方では到達手順の額が立たない（0件と見なす）。
    assert plan["total"] == per_iteration * 12 * (1 + 4) + plan["finalSelection"]
    assert observation_count(settings) == 1 + 1 + 4 * (4 + 1)


def test_the_minimum_budget_is_one_iteration_plus_what_is_reserved():
    settings = PlanSettings(
        climb=ClimbSettings(screen_runs=10, confirm_runs=30, survivors=16, max_iterations=12),
        restarts=4,
    )

    minimum = minimum_budget(settings, move_count=120, unit_count=5)

    # 校正で測る基点は1反復の篩いがキャッシュから読む。二重には数えない。
    plan = plan_budget(settings, move_count=120, unit_count=5)
    assert minimum == plan["perIteration"] + reserved_budget(settings, unit_count=5)


def test_the_same_input_reproduces_the_same_plan():
    first, _, _ = run_plan()
    second, _, _ = run_plan()

    assert first.best.canonical_key() == second.best.canonical_key()
    assert [attempt.direction for attempt in first.restarts] == [
        attempt.direction for attempt in second.restarts
    ]


# --- Phase D: ランク微調整 ---------------------------------------------------


def test_without_an_effect_table_the_rank_pass_does_not_run():
    result, _, _ = run_plan()

    assert result.rank_tuning is None


def test_the_rank_pass_targets_the_slots_the_restart_moved_the_effect_between():
    result, _, _ = run_plan(ladder=attack_ladder())

    tuning = result.rank_tuning
    assert tuning is not None
    # 再スタートで受け先が 0:UNIT_A → 1:UNIT_B へ動いた。境界はその両端である。
    assert {target.slot_index for target in tuning.targets} == {0, 1}
    assert all(target.stat == "ATTACK" for target in tuning.targets)


def test_the_rank_pass_starts_from_the_allocation_the_earlier_phases_reached():
    result, _, _ = run_plan(ladder=attack_ladder())

    assert result.rank_tuning is not None
    assert result.rank_tuning.start.canonical_key() != START.canonical_key()


def test_the_rank_pass_signatures_are_listed_with_where_they_came_from():
    result, _, _ = run_plan(ladder=attack_ladder())

    origins = {entry.origin for entry in result.signatures}
    assert any(origin.startswith("rank") for origin in origins)


def test_turning_the_rank_pass_off_skips_it_even_with_an_effect_table():
    settings = replace(SETTINGS, rank=RankTuningSettings(steps=0))

    result, _, _ = run_plan(settings=settings, ladder=attack_ladder())

    assert result.rank_tuning is None


def test_the_budget_breakdown_counts_the_rank_pass():
    settings = PlanSettings(
        climb=ClimbSettings(screen_runs=10, confirm_runs=30, survivors=16, max_iterations=12),
        restarts=4,
        rank=RankTuningSettings(steps=4),
    )

    plan = plan_budget(settings, move_count=120, unit_count=5)

    # 対象は (枠, ステータス) 単位である。同じ枠が順位効果（攻撃力）と行動順
    # （行動速度）の両方の境界に現れ得るので、上限は1枠あたり2本になる。
    targets = 5 * 2
    candidates = targets * 4
    rank = (1 + candidates) * 10 + (1 + min(16, candidates)) * 30
    assert plan["rankTuning"] == rank
    assert plan["total"] == (plan["perClimb"] * 5 + rank + plan["steps"] + plan["finalSelection"])
    assert observation_count(settings, unit_count=5) == 1 + 1 + 4 * (4 + 1) + 1 + targets * 4


def test_the_estimated_target_count_covers_a_slot_on_two_boundaries():
    """1枠が2本の境界に現れる署名。見積りの上限がこれを下回ってはいけない。"""
    signatures = (
        RegimeSignature(
            action_order=("0:UNIT_A", "1:UNIT_B"), assignments={REGIME_COMPONENT: "0:UNIT_A"}
        ),
        RegimeSignature(
            action_order=("1:UNIT_B", "0:UNIT_A"), assignments={REGIME_COMPONENT: "1:UNIT_B"}
        ),
    )

    targets = focus_targets(signatures)

    assert len(targets) == max_target_count(2)
    assert {(target.slot_index, target.stat) for target in targets} == {
        (0, "ATTACK"),
        (1, "ATTACK"),
        (0, "ACTION_SPEED"),
        (1, "ACTION_SPEED"),
    }


def test_the_rank_pass_never_pushes_the_run_past_the_budget():
    result, evaluator, _ = run_plan(budget=2_000, ladder=attack_ladder())

    assert evaluator.consumed_runs <= 2_000
    assert result.consumed_runs == evaluator.consumed_runs


# --- 最終選抜と到達手順 ------------------------------------------------------


FINAL = FinalSelectionSettings(pool=4, runs=16)
WITH_FINAL = replace(SETTINGS, final=FINAL)


def test_the_final_selection_uses_a_range_the_search_never_touched():
    result, evaluator, _ = run_plan(settings=WITH_FINAL)

    assert result.final.entries
    phase = final_phase(WITH_FINAL.climb, FINAL)
    assert evaluator.record_for(result.best, phase) is not None
    # 探索の位相と重ならない（重なりは評価器が拒む）。
    Evaluator.validate_phases((*phases_for_climb(WITH_FINAL.climb), phase))


def test_the_reported_best_comes_from_the_final_selection():
    result, _, _ = run_plan(settings=WITH_FINAL)

    assert result.final.best is not None
    assert result.best.canonical_key() == result.final.best.canonical_key()


def test_the_reach_path_runs_from_the_current_allocation_to_the_reported_best():
    result, _, _ = run_plan(settings=WITH_FINAL)

    assert result.steps is not None
    assert not result.steps.is_empty
    assert result.steps.start.canonical_key() == START.canonical_key()
    assert result.steps.steps[-1].allocation.canonical_key() == result.best.canonical_key()


def test_an_answer_equal_to_the_current_allocation_leaves_the_path_empty():
    result, _, _ = run_plan(settings=replace(WITH_FINAL, restarts=0))

    assert result.best.canonical_key() == START.canonical_key()
    assert result.steps is not None
    assert result.steps.is_empty


def test_the_best_so_far_curve_never_goes_down():
    result, _, _ = run_plan(settings=WITH_FINAL)

    assert result.history
    fitnesses = [point.best_fitness for point in result.history]
    assert fitnesses == sorted(fitnesses)
    consumed = [point.consumed_runs for point in result.history]
    assert consumed == sorted(consumed)


def test_the_budget_breakdown_reserves_the_final_selection_and_the_path():
    settings = PlanSettings(
        climb=ClimbSettings(screen_runs=10, confirm_runs=30, survivors=16, max_iterations=12),
        restarts=4,
        final=FinalSelectionSettings(pool=8, runs=100),
    )

    plan = plan_budget(settings, move_count=120, unit_count=5)

    assert plan["finalSelection"] == 8 * 100
    assert plan["steps"] == (1 + 2 * 45) * 30
    assert plan["total"] == plan["perClimb"] * 5 + plan["rankTuning"] + 800 + plan["steps"]
    assert minimum_budget(settings, move_count=120, unit_count=5) == (
        plan["perIteration"] + 800 + plan["steps"]
    )


def test_the_search_never_spends_the_reserved_budget():
    settings = replace(WITH_FINAL, restarts=0)
    budget = 900

    result, evaluator, _ = run_plan(settings=settings, budget=budget)

    reserve = reserved_budget(settings, unit_count=len(START.units))
    # 探索が使い切ってから「最終選抜のぶんが無い」とならないよう先に取り置く。
    assert evaluator.consumed_runs <= budget
    assert result.base_climb.best is not None
    assert reserve > 0
