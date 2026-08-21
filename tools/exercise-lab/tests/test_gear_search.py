"""Phase B: ギア配分の反復局所探索。篩いは自ユニット与ダメ、確定は期待日次ベスト。"""

from dataclasses import replace

from exercise_lab.gear.allocation import (
    MAX_PIECES_PER_STAT,
    MAX_PIECES_PER_UNIT,
    Allocation,
    GearPiece,
    UnitAllocation,
)
from exercise_lab.gear.neighborhood import neighborhood
from exercise_lab.gear.search import (
    ClimbSettings,
    hill_climb,
    iteration_cost,
    phases_for_climb,
    remaining_iteration_cost,
)
from exercise_lab.optimize.evaluator import CandidateRecord, EvaluationPhase
from exercise_lab.optimize.fitness import Objective

OBJECTIVE = Objective(best_of=5)

# 1枚あたりの効き目。攻撃が最も高く、会心率が最も低い単調な人工目的関数。
WEIGHTS = {
    "ATTACK": 100,
    "CRITICAL_DAMAGE_BONUS": 60,
    "AFFINITY_BONUS": 40,
    "ACTION_SPEED": 20,
    "CRITICAL_RATE": 10,
}


def piece(stat: str, grade: str = "S") -> GearPiece:
    return GearPiece(stat=stat, tier="III", grade=grade)


def allocation(*counts: dict[str, int]) -> Allocation:
    return Allocation(
        tuple(
            UnitAllocation(
                unit_definition_id=f"UNIT_{chr(ord('A') + index)}",
                pieces=tuple(
                    piece(stat, grade)
                    for stat, count in unit.items()
                    for grade in ("S", "A", "B")[:count]
                ),
            )
            for index, unit in enumerate(counts)
        )
    )


class FakeGearEvaluator:
    """人工の評価API。ユニットごとの強さの和をスコアにし、与ダメージも枠別に返す。

    ノイズは試行番号だけで決まる（実サーバーが乱数を候補indexに依らず決めるのと同じ）。
    ペア差を取ると相殺するので、順位が雑音で決まらない。
    """

    def __init__(self, unit_strength=None, phase_scale=1):
        self._unit_strength = unit_strength or self._default_strength
        self.consumed_runs = 0
        self.evaluated: list[Allocation] = []
        self._records: dict[tuple[str, str], CandidateRecord] = {}

    @staticmethod
    def _default_strength(unit: UnitAllocation, allocation: Allocation) -> int:
        return sum(WEIGHTS[piece.stat] for piece in unit.pieces if piece.stat in WEIGHTS)

    def record_for(self, candidate, phase: EvaluationPhase):
        return self._records.get((phase.name, candidate.canonical_key()))

    def ensure(self, candidates, target, *, phase: EvaluationPhase):
        records = []
        seen = set()
        for candidate in candidates:
            self._reject_invalid(candidate)
            key = candidate.canonical_key()
            if key in seen:
                continue
            seen.add(key)
            record = self._records.setdefault(
                (phase.name, key), CandidateRecord(candidate=candidate)
            )
            if record.sample_count == 0:
                self.evaluated.append(candidate)
            while record.sample_count < target:
                run = record.sample_count
                damages = tuple(
                    self._unit_strength(unit, candidate) * 10 + run for unit in candidate.units
                )
                record.scores.append(sum(damages) + (run % 3))
                record.break_counts.append(0)
                record.completion_reasons.append("TURN_LIMIT_REACHED")
                record.unit_damage_totals.append(damages)
                self.consumed_runs += 1
            records.append(record)
        return records

    @staticmethod
    def _reject_invalid(candidate: Allocation) -> None:
        violations = candidate.violations()
        assert violations == [], violations
        for unit in candidate.units:
            assert unit.total <= MAX_PIECES_PER_UNIT
            for count in unit.counts().values():
                assert count <= MAX_PIECES_PER_STAT


SETTINGS = ClimbSettings(screen_runs=4, confirm_runs=8, survivors=6, max_iterations=10)


def climb(start, evaluator, *, settings=SETTINGS, budget=1_000_000):
    return hill_climb(
        start,
        evaluator,
        settings=settings,
        objective=OBJECTIVE,
        budget_runs=budget,
    )


def test_it_climbs_to_the_optimum_of_a_monotone_objective():
    start = allocation({"CRITICAL_RATE": 3})
    evaluator = FakeGearEvaluator()

    result = climb(start, evaluator)

    # 上限は同一ステータス3枚。会心率3枚は攻撃3枚へ入れ替わるのが最適。
    assert result.best.units[0].counts()["ATTACK"] == MAX_PIECES_PER_STAT
    assert result.best.units[0].counts()["CRITICAL_RATE"] == 0
    assert result.stopped_because == "LOCAL_OPTIMUM"


def test_it_fills_empty_slots_when_that_is_the_best_move():
    start = allocation({"ATTACK": 3})
    evaluator = FakeGearEvaluator()

    result = climb(start, evaluator, settings=replace(SETTINGS, max_iterations=2))

    assert result.best.units[0].total > start.units[0].total


def test_each_step_records_the_move_and_its_confirmed_gain():
    start = allocation({"CRITICAL_RATE": 1})
    evaluator = FakeGearEvaluator()

    result = climb(start, evaluator)

    assert result.steps
    first = result.steps[0]
    assert first.iteration == 1
    assert first.fitness_gain > 0
    assert first.allocation.canonical_key() != start.canonical_key()
    assert [step.allocation.canonical_key() for step in result.steps][-1] == (
        result.best.canonical_key()
    )


def test_a_start_that_cannot_be_improved_stops_at_the_first_iteration():
    # 全ユニットが上限まで最良のステータスを積んだ配分。どの手も損になる。
    start = allocation({"ATTACK": 3, "CRITICAL_DAMAGE_BONUS": 3, "AFFINITY_BONUS": 3})
    evaluator = FakeGearEvaluator()

    result = climb(start, evaluator)

    assert result.steps == ()
    assert result.best.canonical_key() == start.canonical_key()
    assert result.stopped_because == "LOCAL_OPTIMUM"


def partner_scaling_strength(unit: UnitAllocation, whole: Allocation) -> int:
    """UNIT_A の攻撃力が相方の与ダメージを押し上げる盤面。

    順位で当て先が決まるバフの代わりであり、「自分の与ダメは落ちるのに総スコアは伸びる」
    手を作る。篩いが与ダメージではなく総スコアで並べていれば、この手が1位に来る。
    """
    if unit.unit_definition_id == "UNIT_A":
        return 30 * unit.count("CRITICAL_RATE")
    return 30 * unit.count("CRITICAL_RATE") + 200 * whole.units[0].count("ATTACK")


def test_screening_ranks_by_the_damage_of_the_unit_that_moved():
    start = allocation({"CRITICAL_RATE": 1}, {"CRITICAL_RATE": 1})
    evaluator = FakeGearEvaluator(unit_strength=partner_scaling_strength)

    # 通すのは1手だけ。篩いが選んだ手がそのまま採用される。
    result = climb(start, evaluator, settings=replace(SETTINGS, max_iterations=1, survivors=1))

    step = result.steps[0]
    assert step.damage_gain > 0
    # 総スコアで並べていれば、自分の与ダメを落として相方を伸ばす攻撃力の手が1位になる。
    assert step.move.gained_stat() != "ATTACK"


def test_a_move_that_raises_the_score_without_raising_its_own_damage_is_flagged():
    start = allocation({"CRITICAL_RATE": 1}, {"CRITICAL_RATE": 1})
    evaluator = FakeGearEvaluator(unit_strength=partner_scaling_strength)

    result = climb(start, evaluator, settings=replace(SETTINGS, max_iterations=1))

    flagged = [entry.move for entry in result.regime_candidates]
    assert flagged
    assert all(entry.score_gain > 0 for entry in result.regime_candidates)
    assert all(entry.damage_gain <= 0 for entry in result.regime_candidates)


def test_it_stops_before_starting_an_iteration_it_cannot_pay_for():
    start = allocation({"CRITICAL_RATE": 3})
    evaluator = FakeGearEvaluator()
    moves = 1 + 24
    budget = iteration_cost(SETTINGS, move_count=moves) + 10

    result = climb(start, evaluator, budget=budget)

    assert result.stopped_because == "BUDGET"
    assert evaluator.consumed_runs <= budget


def test_an_already_evaluated_base_is_not_paid_for_twice():
    """校正で基点を先に測っても、1反復ぶんの予算で1反復が回りきること。

    篩いは基点をキャッシュから読むので、校正のぶんは1反復の費用に含まれている。
    見張りが素の上限で判定すると、その重なりぶんだけ余分な予算を要求してしまう。
    """
    start = allocation({"CRITICAL_RATE": 3})
    evaluator = FakeGearEvaluator()
    moves = len(neighborhood(start))
    budget = iteration_cost(SETTINGS, move_count=moves)
    screen_phase, _ = phases_for_climb(SETTINGS)
    # 校正リクエスト相当。基点だけを篩いの深さで先に測る。
    evaluator.ensure([start], SETTINGS.screen_runs, phase=screen_phase)

    result = climb(start, evaluator, settings=replace(SETTINGS, max_iterations=1), budget=budget)

    assert len(result.steps) == 1
    assert evaluator.consumed_runs <= budget


def test_the_guard_counts_only_the_runs_that_are_not_cached_yet():
    start = allocation({"CRITICAL_RATE": 3})
    evaluator = FakeGearEvaluator()
    moves = neighborhood(start)
    screen_phase, _ = phases_for_climb(SETTINGS)
    evaluator.ensure([start], SETTINGS.screen_runs, phase=screen_phase)

    remaining = remaining_iteration_cost(start, moves, evaluator, settings=SETTINGS)

    # 基点の篩いは済んでいる。残りはその1候補ぶんだけ安い。
    assert remaining == iteration_cost(SETTINGS, move_count=len(moves)) - SETTINGS.screen_runs


def test_a_budget_too_small_for_one_iteration_stops_without_evaluating():
    start = allocation({"CRITICAL_RATE": 3})
    evaluator = FakeGearEvaluator()

    result = climb(start, evaluator, budget=1)

    assert evaluator.consumed_runs == 0
    assert result.steps == ()
    assert result.stopped_because == "BUDGET"


def test_the_iteration_limit_is_respected():
    start = allocation({"CRITICAL_RATE": 1})
    evaluator = FakeGearEvaluator()

    result = climb(start, evaluator, settings=replace(SETTINGS, max_iterations=1))

    assert len(result.steps) == 1
    assert result.stopped_because == "MAX_ITERATIONS"


def test_the_cost_of_an_iteration_is_the_upper_bound_of_its_two_stages():
    cost = iteration_cost(
        ClimbSettings(screen_runs=10, confirm_runs=30, survivors=16), move_count=120
    )

    assert cost == (1 + 120) * 10 + (1 + 16) * 30


def test_the_same_seed_reproduces_the_same_climb():
    start = allocation({"CRITICAL_RATE": 2})

    first = climb(start, FakeGearEvaluator())
    second = climb(start, FakeGearEvaluator())

    assert [step.move.canonical_key() for step in first.steps] == [
        step.move.canonical_key() for step in second.steps
    ]


def test_an_evaluator_without_per_unit_damage_falls_back_to_the_total_score():
    class NoDamage(FakeGearEvaluator):
        def ensure(self, candidates, target, *, phase):
            records = super().ensure(candidates, target, phase=phase)
            for record in records:
                record.unit_damage_totals.clear()
            return records

    start = allocation({"CRITICAL_RATE": 3})

    result = climb(start, NoDamage(), settings=replace(SETTINGS, max_iterations=1))

    assert result.warnings
    assert result.steps
