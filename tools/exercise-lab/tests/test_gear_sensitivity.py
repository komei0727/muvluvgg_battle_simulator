"""ギア1手の限界効用分析。篩い・確定・確認走の指標と、ペア差の信頼区間。"""

import math

import pytest

from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.neighborhood import neighborhood
from exercise_lab.gear.sensitivity import (
    SensitivitySettings,
    analyse,
    detectable_margins,
    expected_best_weights,
    paired_difference,
    phases_for,
    planned_runs,
)
from exercise_lab.optimize.evaluator import CandidateRecord
from exercise_lab.optimize.fitness import Objective, expected_best


def piece(stat: str, tier: str = "III", grade: str = "S") -> GearPiece:
    return GearPiece(stat=stat, tier=tier, grade=grade)


BASE = Allocation((UnitAllocation("UNIT_A", (piece("ATTACK"), piece("ACTION_SPEED"))),))
OBJECTIVE = Objective(best_of=5)


def record(scores, *, reasons=None) -> CandidateRecord:
    return CandidateRecord(
        candidate=BASE,
        scores=list(scores),
        break_counts=[0] * len(scores),
        completion_reasons=list(reasons or ["TURN_LIMIT_REACHED"] * len(scores)),
    )


class ScriptedEvaluator:
    """`Evaluator.ensure` だけを持つ代役。手ごとのスコア列を台本で与える。"""

    def __init__(self, script):
        self._script = script
        self.calls: list[tuple[str, int, tuple[str, ...]]] = []
        self._records: dict[tuple[str, str], CandidateRecord] = {}

    def ensure(self, candidates, target, *, phase):
        self.calls.append(
            (phase.name, target, tuple(candidate.canonical_key() for candidate in candidates))
        )
        results = []
        seen = set()
        for candidate in candidates:
            key = candidate.canonical_key()
            if key in seen:
                continue
            seen.add(key)
            entry = self._records.setdefault(
                (phase.name, key),
                CandidateRecord(candidate=candidate),
            )
            while entry.sample_count < target:
                index = entry.sample_count
                entry.scores.append(self._script(key, phase.name, index))
                entry.break_counts.append(0)
                entry.completion_reasons.append("TURN_LIMIT_REACHED")
            results.append(entry)
        return results


def test_the_confirmation_run_uses_a_random_range_the_screening_never_touched():
    screen, confirm, verify = phases_for(
        SensitivitySettings(screen_runs=8, confirm_runs=20, verify_runs=30)
    )

    spans = [phase.span for phase in (screen, confirm, verify)]
    for index, span in enumerate(spans):
        for other in spans[index + 1 :]:
            assert span.stop <= other.start or other.stop <= span.start
    assert verify.seed_offset == screen.checkpoints[-1] + confirm.checkpoints[-1]


def test_the_vectorised_weights_reproduce_the_fitness_definition():
    scores = [10, 40, 20, 30, 55, 5, 70]

    weighted = float(expected_best_weights(len(scores), best_of=3) @ sorted(scores))

    assert weighted == pytest.approx(expected_best(scores, best_of=3))


def test_the_weights_fall_back_to_the_maximum_when_the_sample_is_shorter_than_best_of():
    weights = expected_best_weights(3, best_of=5)

    assert list(weights) == [0.0, 0.0, 1.0]


def test_a_paired_difference_is_measured_run_by_run():
    base = record([100, 200, 300, 400])
    variant = record([110, 210, 310, 410])

    diff = paired_difference(base, variant, count=4, objective=OBJECTIVE, seed="s")

    assert diff.count == 4
    assert diff.mean_diff == pytest.approx(10.0)
    # 差が一定なら分散は0で、区間は点へ潰れる。
    assert diff.mean_ci_low == pytest.approx(10.0)
    assert diff.mean_ci_high == pytest.approx(10.0)
    assert diff.expected_best_diff == pytest.approx(10.0)


def test_a_difference_whose_interval_covers_zero_is_not_significant():
    base = record([100, 100, 100, 100, 100, 100])
    variant = record([400, 0, 350, 10, 380, 20])

    diff = paired_difference(base, variant, count=6, objective=OBJECTIVE, seed="s")

    assert diff.mean_ci_low < 0 < diff.mean_ci_high
    assert not diff.mean_significant


def test_the_defeat_rate_of_both_sides_is_carried_along():
    base = record([100, 100], reasons=["ALLY_DEFEATED", "TURN_LIMIT_REACHED"])
    variant = record([100, 100], reasons=["TURN_LIMIT_REACHED", "TURN_LIMIT_REACHED"])

    diff = paired_difference(base, variant, count=2, objective=OBJECTIVE, seed="s")

    assert diff.base_defeat_rate == pytest.approx(0.5)
    assert diff.defeat_rate == pytest.approx(0.0)


def test_the_paired_bootstrap_is_reproducible():
    base = record([100, 120, 90, 500, 80, 130, 110, 95])
    variant = record([150, 90, 200, 100, 400, 105, 130, 90])

    first = paired_difference(base, variant, count=8, objective=OBJECTIVE, seed="abc")
    second = paired_difference(base, variant, count=8, objective=OBJECTIVE, seed="abc")
    other = paired_difference(base, variant, count=8, objective=OBJECTIVE, seed="xyz")

    assert first.expected_best_ci_low == second.expected_best_ci_low
    assert first.expected_best_ci_low != other.expected_best_ci_low


def test_the_budget_is_broken_down_before_the_sweep():
    settings = SensitivitySettings(
        screen_runs=10, confirm_runs=20, verify_runs=30, survivors=4, top_moves=2
    )

    plan = planned_runs(settings, move_count=6)

    assert plan["screen"] == (1 + 6) * 10
    assert plan["confirm"] == (1 + 4) * 20
    # 確認走は基点・上位2手・同時適用の1件。
    assert plan["verify"] == (1 + 2 + 1) * 30
    assert plan["total"] == plan["screen"] + plan["confirm"] + plan["verify"]


def test_the_detectable_margin_shrinks_with_the_square_root_of_the_runs():
    scores = [1000, 1200, 800, 1100, 900]

    small = detectable_margins(scores, runs=100, objective=OBJECTIVE)
    large = detectable_margins(scores, runs=400, objective=OBJECTIVE)

    assert large.mean_absolute == pytest.approx(small.mean_absolute / 2)
    assert small.mean_ratio == pytest.approx(small.mean_absolute / small.base_mean)
    # 期待日次ベストは実効サンプルが n の36%（k=5）しかないぶん粗くしか見えない。
    assert small.expected_best_absolute > small.mean_absolute
    assert small.expected_best_absolute == pytest.approx(
        small.mean_absolute * math.sqrt(100 / OBJECTIVE.effective_samples(100))
    )


# --- 篩いと確定の指標 -------------------------------------------------------
#
# 平均が高い手と、期待日次ベストが高い手を別々に作る。両者の向きは揃わない（安定した
# 小さな上げ幅は平均に効き、上振れの頻度は日次ベストに効く）ため、段が指標を取り違えて
# いれば順位が入れ替わって出る。2手は別々の駒を動かすので、同時適用でも衝突しない。

MOVES = neighborhood(BASE)
STEADY = next(
    move
    for move in MOVES
    if move.removed
    and move.removed.stat == "ACTION_SPEED"
    and move.gained_stat() == "CRITICAL_RATE"
)
SPIKY = next(
    move
    for move in MOVES
    if move.removed
    and move.removed.stat == "ATTACK"
    and move.gained_stat() == "CRITICAL_DAMAGE_BONUS"
)


def scripted(key, phase, index):
    if key == BASE.canonical_key():
        return 1000
    if key == STEADY.apply(BASE).canonical_key():
        # 常に +100。平均のペア差では最も強い。
        return 1100
    if key == SPIKY.apply(BASE).canonical_key():
        # 5回中3回は +200、残りは −100。平均では STEADY に負けるが、1日5回のベストで
        # 競うなら上振れの頻度が効いてこちらが勝つ。
        return 1200 if index % 5 < 3 else 900
    return 900


@pytest.fixture
def result():
    evaluator = ScriptedEvaluator(scripted)
    settings = SensitivitySettings(
        screen_runs=10, confirm_runs=20, verify_runs=20, survivors=4, top_moves=2
    )
    return (
        analyse(
            BASE,
            MOVES,
            evaluator,
            settings=settings,
            objective=OBJECTIVE,
            seed="abc",
        ),
        evaluator,
    )


def test_screening_ranks_by_the_paired_mean_difference(result):
    analysis, _ = result

    screened = analysis.screening_order()

    assert screened[0].move == STEADY
    assert screened[0].screen.mean_diff > screened[1].screen.mean_diff


def test_the_confirmation_stage_ranks_by_expected_daily_best_and_the_floor(result):
    analysis, _ = result

    # 篩いの1位と確定の1位が別の手であることが、指標の取り違えに対する回帰になる。
    assert analysis.top_moves[0].move == SPIKY
    assert analysis.screening_order()[0].move == STEADY
    assert analysis.top_moves[0].screen.mean_diff < analysis.screening_order()[0].screen.mean_diff
    assert analysis.top_moves[0].confirm.expected_best_diff > 0
    assert analysis.top_moves[0].confirm.guard_diff > 0


def test_a_move_that_screening_dropped_keeps_its_screening_estimate(result):
    analysis, _ = result

    dropped = [entry for entry in analysis.moves if entry.confirm is None]
    assert dropped
    assert all(entry.deepest_stage == "screen" for entry in dropped)
    assert all(entry.deepest.count == 10 for entry in dropped)


def test_screening_does_not_drop_a_move_merely_because_it_is_not_significant(result):
    analysis, _ = result
    survivors = [entry for entry in analysis.moves if entry.confirm is not None]

    assert SPIKY in [entry.move for entry in survivors]


def test_the_top_moves_are_confirmed_on_the_untouched_random_range(result):
    analysis, evaluator = result

    assert all(entry.verify is not None for entry in analysis.top_moves)
    assert analysis.top_moves[0].verify.count == 20
    verified = next(call for call in evaluator.calls if call[0] == "verify")
    # 確認走が測るのは基点・上位2手・同時適用の1件だけ。篩いの全手を測り直さない。
    assert len(verified[2]) == 1 + 2 + 1
    screened = next(call for call in evaluator.calls if call[0] == "screen")
    assert len(screened[2]) == 1 + len(MOVES)


def test_the_top_moves_are_also_evaluated_applied_together(result):
    analysis, _ = result

    assert analysis.combined is not None
    assert [move for move in analysis.combined.applied] == [
        entry.move for entry in analysis.top_moves
    ]
    assert analysis.combined.difference.count == 20


def test_a_top_move_that_no_longer_fits_after_the_others_is_reported_as_skipped():
    evaluator = ScriptedEvaluator(lambda key, phase, index: 1000 + len(key))
    base = Allocation((UnitAllocation("UNIT_A", (piece("ATTACK"),)),))
    moves = neighborhood(base)
    removals = [move for move in moves if move.kind == "remove"]
    # 同じ駒を2度外す手は重ねられない。
    settings = SensitivitySettings(
        screen_runs=4, confirm_runs=4, verify_runs=4, survivors=8, top_moves=4
    )

    analysis = analyse(
        base, (*removals, *removals), evaluator, settings=settings, objective=OBJECTIVE, seed="s"
    )

    assert analysis.combined is not None
    assert len(analysis.combined.applied) < len(analysis.top_moves)
    assert analysis.combined.skipped


def test_the_marginal_utility_map_marks_cells_without_a_move(result):
    analysis, _ = result

    cells = analysis.utility_map()
    filled = [cell for cell in cells if cell.slot_index == 0]

    assert {cell.stat for cell in filled} >= {"ATTACK", "CRITICAL_RATE"}
    assert all(cell.entry is not None or cell.unavailable_because for cell in filled)


def test_the_map_marks_a_stat_that_already_holds_three_pieces():
    base = Allocation((UnitAllocation("UNIT_A", tuple(piece("ATTACK", grade=g) for g in "SAB")),))
    moves = neighborhood(base)
    evaluator = ScriptedEvaluator(lambda key, phase, index: 1000)
    settings = SensitivitySettings(
        screen_runs=4, confirm_runs=4, verify_runs=4, survivors=2, top_moves=1
    )

    analysis = analyse(base, moves, evaluator, settings=settings, objective=OBJECTIVE, seed="s")

    attack = next(cell for cell in analysis.utility_map() if cell.stat == "ATTACK")
    assert attack.entry is None
    assert attack.at_limit
