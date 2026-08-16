"""レーシング（Successive Halving）と最終選抜（SAR型）。固定スコアを注入して判定を見る。"""

import pytest

from exercise_lab.optimize.candidate import Candidate, Cell, Placement
from exercise_lab.optimize.evaluator import FINAL_PHASE, SEARCH_PHASE, CandidateRecord
from exercise_lab.optimize.fitness import RiskPolicy
from exercise_lab.optimize.racing import (
    plan_stages,
    select_top_k,
    successive_halving,
)

POLICY = RiskPolicy(alpha=0.2, mean_weight=0.5)


def candidate(name: str) -> Candidate:
    return Candidate((Placement(name, Cell(column=0, row="FRONT")),), ())


class FakeEvaluator:
    """候補ごとの固定スコア列を返す。昇格・脱落だけを見るため乱数を持たない。"""

    def __init__(self, scores: dict[str, list[int]]):
        self._scores = scores
        self.calls: list[tuple[str, int, int]] = []

    def ensure(self, candidates, target, *, phase=SEARCH_PHASE):
        self.calls.append((phase.name, target, len(candidates)))
        return [
            CandidateRecord(
                candidate=item,
                scores=list(self._scores[item.unit_definition_ids[0]][:target]),
                break_counts=[0] * min(target, len(self._scores[item.unit_definition_ids[0]])),
                completion_reasons=["TURN_LIMIT_REACHED"]
                * min(target, len(self._scores[item.unit_definition_ids[0]])),
            )
            for item in candidates
        ]


def flat(value: int, count: int = 120) -> list[int]:
    return [value] * count


def with_tail(value: int, tail: int, count: int = 120) -> list[int]:
    """5回に1回だけ崩れる列。戦闘不能で大きく沈む編成を模す。

    崩れた試行を先頭へ固めない。段ごとに先頭から切り取って使うため、固めると
    浅い段では「崩れてばかりの編成」に、深い段では「崩れない編成」に見えてしまう。
    """
    return [tail if index % 5 == 0 else value for index in range(count)]


def test_the_first_stage_ranks_by_the_mean_because_the_tail_is_too_thin():
    stages = plan_stages((8, 24, 72), POLICY)

    assert [stage.statistic for stage in stages] == ["mean", "fitness", "fitness"]
    assert [stage.runs for stage in stages] == [8, 24, 72]


def test_a_stage_switches_to_the_fitness_once_the_tail_holds_enough_samples():
    """判定に使うのは n ではなく尾部の件数 αn 。alpha を下げれば切り替えも後ろへ動く。

    alpha=0.1 では 24試行でも尾部は3件しかなく、72試行（8件）まで平均で篩う。
    """
    stages = plan_stages((8, 24, 72), RiskPolicy(alpha=0.1, mean_weight=0.5))

    assert [stage.statistic for stage in stages] == ["mean", "mean", "fitness"]


def test_successive_halving_keeps_the_top_half_at_every_stage():
    names = [f"UNIT_{index}" for index in range(8)]
    evaluator = FakeEvaluator({name: flat(1000 + index) for index, name in enumerate(names)})

    survivors = successive_halving(
        [candidate(name) for name in names],
        evaluator,
        policy=POLICY,
        stages=plan_stages((8, 24, 72), POLICY),
        phase=SEARCH_PHASE,
    )

    assert [call[2] for call in evaluator.calls] == [8, 4, 2]
    assert [entry.candidate.unit_definition_ids[0] for entry in survivors] == ["UNIT_7", "UNIT_6"]


def test_successive_halving_never_empties_the_field():
    evaluator = FakeEvaluator({"UNIT_A": flat(1000)})

    survivors = successive_halving(
        [candidate("UNIT_A")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((8, 24, 72), POLICY),
        phase=SEARCH_PHASE,
    )

    assert len(survivors) == 1


def test_a_candidate_with_a_great_mean_but_a_collapsing_tail_falls_once_the_tail_counts():
    """下振れペナルティが効く段を分けたことの現れ。

    平均だけを見る第1段では首位に立つが、尾部が育った第2段では最下位へ落ちる。
    """
    evaluator = FakeEvaluator(
        {
            # 平均は最も高いが、5回に1回スコアが0になる
            "UNIT_VOLATILE": with_tail(1600, 0),
            "UNIT_STEADY": flat(1100),
            "UNIT_WEAK": flat(900),
            "UNIT_WORST": flat(800),
        }
    )
    names = ["UNIT_VOLATILE", "UNIT_STEADY", "UNIT_WEAK", "UNIT_WORST"]

    def race(stage_runs):
        return [
            entry.candidate.unit_definition_ids[0]
            for entry in successive_halving(
                [candidate(name) for name in names],
                evaluator,
                policy=POLICY,
                stages=plan_stages(stage_runs, POLICY),
                phase=SEARCH_PHASE,
            )
        ]

    assert race((8,))[0] == "UNIT_VOLATILE"
    assert race((8, 24))[-1] == "UNIT_VOLATILE"


def test_candidates_are_compared_at_the_shortest_history_in_the_round():
    """比べるときは短い方へ切り詰める。多く回した候補の余分な試行を数えない。

    どちらも段の試行数（12）に届いていないので、揃う5件まで下げて比べる。
    """
    evaluator = FakeEvaluator(
        {
            # 8件しか返らない候補。先頭5件は 1000、以降は 5000
            "UNIT_SHORT": [1000] * 5 + [5000] * 3,
            # 5件しか返らない候補
            "UNIT_SHORTER": [1200] * 5,
        }
    )

    survivors = successive_halving(
        [candidate("UNIT_SHORT"), candidate("UNIT_SHORTER")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((12,), POLICY),
        phase=SEARCH_PHASE,
    )

    # 共通の5件で比べれば 1200 > 1000 。後ろの 5000 を数えると逆転する
    assert survivors[0].candidate.unit_definition_ids[0] == "UNIT_SHORTER"
    assert survivors[0].sample_count == 5


def test_select_top_k_returns_exactly_k_in_fitness_order():
    names = [f"UNIT_{index}" for index in range(24)]
    evaluator = FakeEvaluator({name: flat(1000 + index) for index, name in enumerate(names)})

    selected = select_top_k(
        [candidate(name) for name in names],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50, 100), POLICY),
        phase=FINAL_PHASE,
        k=5,
    )

    assert [entry.candidate.unit_definition_ids[0] for entry in selected] == [
        "UNIT_23",
        "UNIT_22",
        "UNIT_21",
        "UNIT_20",
        "UNIT_19",
    ]


def test_select_top_k_runs_on_the_final_phase():
    """最終選抜は探索で使っていないseed範囲で回す。"""
    evaluator = FakeEvaluator({f"UNIT_{index}": flat(1000 + index) for index in range(6)})

    select_top_k(
        [candidate(f"UNIT_{index}") for index in range(6)],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50, 100), POLICY),
        phase=FINAL_PHASE,
        k=5,
    )

    assert {call[0] for call in evaluator.calls} == {"final"}


def test_select_top_k_narrows_the_pool_before_spending_the_deepest_stage():
    """全件を最大試行数まで回さない。深い段は生き残りにだけ払う。"""
    names = [f"UNIT_{index}" for index in range(24)]
    evaluator = FakeEvaluator({name: flat(1000 + index) for index, name in enumerate(names)})

    select_top_k(
        [candidate(name) for name in names],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50, 100), POLICY),
        phase=FINAL_PHASE,
        k=5,
    )

    assert [(call[1], call[2]) for call in evaluator.calls] == [(50, 24), (100, 8)]


def test_select_top_k_collapses_formations_that_behave_identically():
    """同じ乱数列で同じスコア列になる候補は、実質同じ編成である。

    メモリーの並びを変えても結果が動かない組み合わせは珍しくない。別物として数えると、
    上位5件の枠が「並びだけ違う同じ編成」で埋まり、選択肢として役に立たなくなる。
    """
    evaluator = FakeEvaluator(
        {
            "UNIT_A": flat(1000),
            "UNIT_A_REORDERED": flat(1000),
            "UNIT_B": flat(900),
        }
    )

    selected = select_top_k(
        [candidate(name) for name in ("UNIT_A", "UNIT_A_REORDERED", "UNIT_B")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50,), POLICY),
        phase=FINAL_PHASE,
        k=3,
    )

    assert [entry.candidate.unit_definition_ids[0] for entry in selected] == ["UNIT_A", "UNIT_B"]


def test_select_top_k_keeps_formations_whose_scores_differ_anywhere():
    evaluator = FakeEvaluator({"UNIT_A": flat(1000), "UNIT_B": [*flat(1000, 49), 1001]})

    selected = select_top_k(
        [candidate("UNIT_A"), candidate("UNIT_B")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50,), POLICY),
        phase=FINAL_PHASE,
        k=3,
    )

    assert len(selected) == 2


def test_select_top_k_returns_everything_when_the_pool_is_smaller_than_k():
    evaluator = FakeEvaluator({"UNIT_A": flat(1000), "UNIT_B": flat(900)})

    selected = select_top_k(
        [candidate("UNIT_A"), candidate("UNIT_B")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50, 100), POLICY),
        phase=FINAL_PHASE,
        k=5,
    )

    assert len(selected) == 2


def test_select_top_k_ranks_by_the_tail_when_the_means_are_equal():
    """同じ平均でも、崩れる側を下に置く。これが下振れを罰する目的関数の要点。"""
    evaluator = FakeEvaluator({"UNIT_VOLATILE": with_tail(1000, 500), "UNIT_STEADY": flat(900)})

    steady, volatile = select_top_k(
        [candidate("UNIT_VOLATILE"), candidate("UNIT_STEADY")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((50, 100), POLICY),
        phase=FINAL_PHASE,
        k=2,
    )

    assert steady.candidate.unit_definition_ids[0] == "UNIT_STEADY"
    assert steady.sample_count == 100
    assert (steady.mean, steady.cvar, steady.fitness) == pytest.approx((900.0, 900.0, 900.0))
    # 平均は同じ 900 でも、下位2割が 500 に沈むぶん適応度が下がる
    assert (volatile.mean, volatile.cvar, volatile.fitness) == pytest.approx((900.0, 500.0, 700.0))


def test_a_candidate_the_server_could_not_finish_does_not_drag_the_round_down():
    """期限で試行が欠けた候補に、段の深さを合わせない。

    サーバーは期限に達すると完了ぶんだけを返す（Q-TEX-18）。8試行しか終わらなかった候補へ
    全員を揃えると、72試行まで積んだ候補の深い評価がまるごと無駄になる。
    """
    evaluator = FakeEvaluator(
        {
            # 期限に掛かって8件で止まった候補。浅いところだけ見れば首位に見える
            "UNIT_STALLED": [9000] * 8,
            "UNIT_DEEP": flat(1000),
            "UNIT_DEEPER": flat(1100),
        }
    )

    survivors = successive_halving(
        [candidate(name) for name in ("UNIT_STALLED", "UNIT_DEEP", "UNIT_DEEPER")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((8, 24), POLICY),
        phase=SEARCH_PHASE,
    )

    assert [entry.candidate.unit_definition_ids[0] for entry in survivors] == ["UNIT_DEEPER"]
    assert survivors[0].sample_count == 24


def test_the_round_still_ranks_when_nobody_reached_the_target():
    """全員が欠けたときは、揃う深さまで下げてでも順位を付ける。

    ここで空を返すと探索が「進みようがない」状態になる。サーバーが重いだけで
    候補の優劣が消えるわけではない。
    """
    evaluator = FakeEvaluator({"UNIT_A": [1000] * 5, "UNIT_B": [1200] * 6})

    survivors = successive_halving(
        [candidate("UNIT_A"), candidate("UNIT_B")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((8,), POLICY),
        phase=SEARCH_PHASE,
    )

    assert [entry.candidate.unit_definition_ids[0] for entry in survivors] == [
        "UNIT_B",
        "UNIT_A",
    ]
    assert survivors[0].sample_count == 5


def test_a_round_where_nothing_completed_ranks_nothing():
    evaluator = FakeEvaluator({"UNIT_A": [], "UNIT_B": []})

    survivors = successive_halving(
        [candidate("UNIT_A"), candidate("UNIT_B")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((8,), POLICY),
        phase=SEARCH_PHASE,
    )

    assert survivors == []


def test_candidates_with_no_samples_are_ignored_rather_than_zeroing_the_round():
    """1件も返らなかった候補が混ざっても、他の候補の順位付けは成立する。"""
    evaluator = FakeEvaluator({"UNIT_EMPTY": [], "UNIT_A": flat(1000), "UNIT_B": flat(1100)})

    survivors = successive_halving(
        [candidate(name) for name in ("UNIT_EMPTY", "UNIT_A", "UNIT_B")],
        evaluator,
        policy=POLICY,
        stages=plan_stages((8,), POLICY),
        phase=SEARCH_PHASE,
    )

    assert [entry.candidate.unit_definition_ids[0] for entry in survivors] == ["UNIT_B", "UNIT_A"]


def test_plan_stages_rejects_an_empty_schedule():
    with pytest.raises(ValueError, match="1段以上"):
        plan_stages((), POLICY)
