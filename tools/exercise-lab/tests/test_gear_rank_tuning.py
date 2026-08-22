"""Phase D: ランクの微調整。署名で絞った枠だけを、1枚ずつ1段下げて閾値の直下を探す。"""

from dataclasses import replace

from exercise_lab.gear.allocation import Allocation, GearPiece, GearRank, UnitAllocation
from exercise_lab.gear.rank_tuning import (
    BUDGET_EXHAUSTED,
    IMPROVED,
    LOCAL_OPTIMUM,
    NO_TARGET,
    SIGNATURE_CHANGED,
    FocusTarget,
    RankTuningSettings,
    focus_targets,
    rank_moves,
    tune_ranks,
)
from exercise_lab.gear.ranks import EMPTY_LADDER
from exercise_lab.gear.regime import RegimeSignature
from exercise_lab.gear.search import ClimbSettings
from exercise_lab.optimize.fitness import Objective
from test_gear_ranks import attack_ladder
from test_gear_search import FakeGearEvaluator

OBJECTIVE = Objective(best_of=5)
LADDER = attack_ladder()
COMPONENT = "ACT_RANK_BUFF"

# 受け先になったときの跳ね上がり。誰が受けるかで額が違うので、当て先が動くと総和が変わる。
REGIME_BONUS = {"UNIT_A": 300, "UNIT_B": 900, "UNIT_C": 0}
# 攻撃力1ptあたりの強さ。梯子の隣接差 0.04pt が 4 の差になる。
POINTS_WEIGHT = 100


def piece(stat: str, tier: str = "III", grade: str = "S") -> GearPiece:
    return GearPiece(stat=stat, tier=tier, grade=grade)


def unit(name: str, *pieces: GearPiece) -> UnitAllocation:
    return UnitAllocation(unit_definition_id=name, pieces=tuple(pieces))


# UNIT_A が 9.99pt、UNIT_B が 9.15pt。UNIT_C は署名のどの成分の当て先でもない。
START = Allocation(
    (
        unit("UNIT_A", *(piece("ATTACK") for _ in range(3))),
        unit("UNIT_B", piece("ATTACK"), piece("ATTACK"), piece("ATTACK", tier="II")),
        unit("UNIT_C", piece("ATTACK"), piece("CRITICAL_RATE")),
    )
)


def attack_points(entry: UnitAllocation) -> float:
    return sum(
        LADDER.points("ATTACK", item.rank) or 0.0 for item in entry.pieces if item.stat == "ATTACK"
    )


def recipient_index(allocation: Allocation) -> int:
    """攻撃力の合計補正が最も高い枠が受け先。同点は若い枠が取る。"""
    scores = [attack_points(entry) for entry in allocation.units]
    return scores.index(max(scores))


def recipient_of(allocation: Allocation) -> str:
    index = recipient_index(allocation)
    return f"{index}:{allocation.units[index].unit_definition_id}"


def strength(entry: UnitAllocation, allocation: Allocation) -> int:
    value = int(attack_points(entry) * POINTS_WEIGHT)
    if allocation.units[recipient_index(allocation)] is entry:
        value += REGIME_BONUS[entry.unit_definition_id]
    return value


def monotone(entry: UnitAllocation, allocation: Allocation) -> int:
    """レジームを持たない目的関数。ランクを下げる手はすべて純損になる。"""
    return int(attack_points(entry) * POINTS_WEIGHT)


class FakeObserver:
    def __init__(self):
        self.calls: list[Allocation] = []

    def observe(self, allocation: Allocation) -> RegimeSignature:
        self.calls.append(allocation)
        return RegimeSignature(assignments={COMPONENT: recipient_of(allocation)})


def signature(recipient: str) -> RegimeSignature:
    return RegimeSignature(assignments={COMPONENT: recipient})


CLIMB = ClimbSettings(screen_runs=4, confirm_runs=8, survivors=6, max_iterations=8)
SETTINGS = RankTuningSettings(steps=3)

BOUNDARY = (signature("0:UNIT_A"), signature("1:UNIT_B"))


def tune(settings=SETTINGS, budget=1_000_000, targets=None, ladder=LADDER, unit_strength=strength):
    evaluator = FakeGearEvaluator(unit_strength=unit_strength)
    observer = FakeObserver()
    result = tune_ranks(
        START,
        evaluator,
        observer,
        ladder=ladder,
        targets=focus_targets(BOUNDARY) if targets is None else targets,
        settings=settings,
        climb=CLIMB,
        objective=OBJECTIVE,
        budget_runs=budget,
    )
    return result, evaluator, observer


# --- 絞り込み ---------------------------------------------------------------


def test_a_component_that_never_moved_its_recipient_is_not_a_boundary():
    assert focus_targets((signature("0:UNIT_A"), signature("0:UNIT_A"))) == ()


def test_a_single_observation_names_no_boundary():
    assert focus_targets((signature("0:UNIT_A"),)) == ()


def test_a_component_whose_recipient_moved_targets_both_ends_of_the_boundary():
    targets = focus_targets(BOUNDARY)

    assert [(target.slot_index, target.stat) for target in targets] == [
        (0, "ATTACK"),
        (1, "ATTACK"),
    ]
    assert all(target.components == (COMPONENT,) for target in targets)


def test_an_enemy_recipient_produces_no_target():
    targets = focus_targets((signature("enemy:UNIT_ENEMY"), signature("1:UNIT_B")))

    assert [target.slot_index for target in targets] == [1]


def test_a_consumer_that_moved_is_a_boundary_too():
    targets = focus_targets(
        (
            RegimeSignature(consumers={"ACT_DEBUFF": "0:UNIT_A"}),
            RegimeSignature(consumers={"ACT_DEBUFF": "2:UNIT_C"}),
        )
    )

    assert [(target.slot_index, target.stat) for target in targets] == [
        (0, "ATTACK"),
        (2, "ATTACK"),
    ]


def test_the_holder_and_the_consumer_of_one_effect_are_not_the_same_component():
    # 単発消費デバフは敵が保持し、消費するのは攻撃した側である。同じ定義IDでも別の
    # 成分として数えないと、当て先が動いていなくても「2通り観測した」が常に立つ。
    steady = (
        RegimeSignature(
            assignments={"ACT_DEBUFF": "enemy:UNIT_ENEMY"}, consumers={"ACT_DEBUFF": "0:UNIT_A"}
        ),
        RegimeSignature(
            assignments={"ACT_DEBUFF": "enemy:UNIT_ENEMY"}, consumers={"ACT_DEBUFF": "0:UNIT_A"}
        ),
    )

    assert focus_targets(steady) == ()


def test_a_unit_no_signature_component_points_at_receives_no_rank_move():
    moves = rank_moves(START, focus_targets(BOUNDARY), LADDER)

    assert moves
    assert {move.slot_index for move in moves} == {0, 1}
    assert all(move.unit_definition_id != "UNIT_C" for move in moves)


def test_only_the_targeted_stat_is_lowered():
    targets = (FocusTarget(slot_index=2, stat="ATTACK", components=(COMPONENT,)),)

    moves = rank_moves(START, targets, LADDER)

    assert [move.removed.stat for move in moves] == ["ATTACK"]
    assert all(move.added.stat == "ATTACK" for move in moves)


def test_the_action_order_component_targets_action_speed_on_the_slots_that_moved():
    first = RegimeSignature(action_order=("0:UNIT_A", "1:UNIT_B", "2:UNIT_C"))
    second = RegimeSignature(action_order=("1:UNIT_B", "0:UNIT_A", "2:UNIT_C"))

    targets = focus_targets((first, second))

    assert [(target.slot_index, target.stat) for target in targets] == [
        (0, "ACTION_SPEED"),
        (1, "ACTION_SPEED"),
    ]
    assert all(target.components == ("actionOrder",) for target in targets)


def test_an_empty_ladder_produces_no_rank_move():
    assert rank_moves(START, focus_targets(BOUNDARY), EMPTY_LADDER) == ()


# --- 境界 -------------------------------------------------------------------


def test_the_generated_step_is_the_next_rank_down_and_satisfies_the_constraints():
    base = Allocation((unit("UNIT_A", piece("ATTACK", tier="II", grade="B")),))
    targets = (FocusTarget(slot_index=0, stat="ATTACK", components=(COMPONENT,)),)

    moves = rank_moves(base, targets, LADDER)

    # Ⅱ-B(1.62) の1つ下は Ⅲ-B(2.16) でも Ⅱ-C(1.18) でもなく Ⅲ-C(1.58)。差は 0.04pt。
    assert [move.added.rank for move in moves] == [GearRank(tier="III", grade="C")]
    applied = moves[0].apply(base)
    assert applied is not None
    assert applied.violations() == []
    assert applied.units[0].total == base.units[0].total


def test_the_finest_step_is_taken_first():
    result, _, _ = tune()

    # UNIT_B の Ⅱ-S(2.49) → Ⅲ-B(2.16) は 0.33pt 落ち、Ⅲ-S → Ⅲ-A の 0.58pt より細かい。
    walk = next(walk for walk in result.walks if walk.target.slot_index == 1)
    assert walk.stops[0].move.removed.rank == GearRank(tier="II", grade="S")
    assert walk.stops[0].move.added.rank == GearRank(tier="III", grade="B")


def test_identical_pieces_produce_one_step_per_rank():
    moves = rank_moves(START, focus_targets(BOUNDARY), LADDER)

    # UNIT_A は Ⅲ-S が3枚。1段下げる手は「そのうち1枚」の1手だけである。
    assert sum(1 for move in moves if move.slot_index == 0) == 1


# --- 探索 -------------------------------------------------------------------


def test_lowering_the_rank_hands_the_effect_over_and_is_adopted():
    result, _, _ = tune()

    assert result.stopped_because == IMPROVED
    assert result.best.canonical_key() != START.canonical_key()
    assert recipient_of(result.best) == "1:UNIT_B"
    assert result.best_gain > 0.0


def test_the_walk_stops_as_soon_as_the_signature_changes():
    result, _, _ = tune()

    walk = next(walk for walk in result.walks if walk.target.slot_index == 0)
    assert walk.stopped_because == SIGNATURE_CHANGED
    # Ⅲ-S ×3（9.99pt）から細かい段を順に使い、3段目の 8.82pt で UNIT_B(9.15pt) を下回る。
    assert [stop.changed for stop in walk.stops] == [False, False, True]


def test_a_step_that_changes_the_signature_is_recorded_under_that_signature():
    result, _, _ = tune()

    digests = {entry.digest for entry in result.signatures}
    assert len(digests) == 2
    handed_over = [
        entry for entry in result.signatures if entry.signature.recipient(COMPONENT) == "1:UNIT_B"
    ]
    assert len(handed_over) == 1
    assert handed_over[0].allocation.canonical_key() == result.best.canonical_key()
    assert handed_over[0].move is not None


def test_the_base_signature_is_recorded_with_the_starting_allocation():
    result, _, _ = tune()

    base = next(
        entry for entry in result.signatures if entry.signature.recipient(COMPONENT) == "0:UNIT_A"
    )
    assert base.allocation.canonical_key() == START.canonical_key()
    assert base.move is None
    assert base.fitness == 0.0


def test_no_target_issues_no_evaluation():
    result, evaluator, observer = tune(targets=())

    assert result.stopped_because == NO_TARGET
    assert evaluator.consumed_runs == 0
    assert observer.calls == []
    assert result.best.canonical_key() == START.canonical_key()


def test_a_budget_that_cannot_pay_for_one_step_issues_no_evaluation():
    result, evaluator, observer = tune(budget=1)

    assert result.stopped_because == BUDGET_EXHAUSTED
    assert evaluator.consumed_runs == 0
    # 観測は別勘定だが、評価できないと分かっている実行では1回も投げない。
    assert observer.calls == []
    assert result.best.canonical_key() == START.canonical_key()


def test_the_budget_is_never_exceeded_and_the_dropped_stops_are_reported():
    result, evaluator, _ = tune(budget=60)

    assert evaluator.consumed_runs <= 60
    assert any("予算" in warning for warning in result.warnings)


def test_the_number_of_steps_is_capped_by_the_setting():
    result, _, _ = tune(settings=replace(SETTINGS, steps=1))

    assert all(len(walk.stops) <= 1 for walk in result.walks)


def test_a_pass_that_cannot_improve_keeps_the_starting_allocation():
    result, _, _ = tune(unit_strength=monotone)

    assert result.stopped_because == LOCAL_OPTIMUM
    assert result.best.canonical_key() == START.canonical_key()
    assert result.walks


def test_the_same_input_reproduces_the_same_pass():
    first, _, _ = tune()
    second, _, _ = tune()

    assert first.best.canonical_key() == second.best.canonical_key()
    assert [stop.move.canonical_key() for walk in first.walks for stop in walk.stops] == [
        stop.move.canonical_key() for walk in second.walks for stop in walk.stops
    ]


# --- 単価表 -----------------------------------------------------------------


def test_the_price_table_reads_in_the_upgrade_direction():
    result, _, _ = tune()

    price = next(
        entry for entry in result.prices if entry.slot_index == 1 and entry.step_index == 1
    )
    # Ⅲ-B → Ⅱ-S で何点、という向き（在庫の1枚を挿す側の問い）で並べる。
    assert price.rank_step.higher == GearRank(tier="II", grade="S")
    assert price.rank_step.lower == GearRank(tier="III", grade="B")
    assert price.rank_step.label == "III-B → II-S"
    assert price.stat == "ATTACK"
    assert price.runs == CLIMB.confirm_runs
    assert price.expected_best_delta > 0


def test_a_step_that_crosses_the_threshold_has_a_negative_price():
    result, _, _ = tune()

    # 閾値を跨いだ段だけは「上げ直すと損をする」。ここがランクを下げる理由である。
    crossing = next(
        entry for entry in result.prices if entry.slot_index == 0 and entry.step_index == 3
    )
    assert crossing.expected_best_delta < 0
    assert crossing.fitness_delta < 0


def test_every_measured_step_appears_in_the_price_table():
    result, _, _ = tune()

    measured = [
        stop for walk in result.walks for stop in walk.stops if stop.fitness_gain is not None
    ]
    assert len(result.prices) == len(measured)
    assert {(entry.slot_index, entry.step_index) for entry in result.prices} == {
        (stop.move.slot_index, stop.step) for stop in measured
    }
