"""予算配分——レーシングと最終選抜。

全候補へ同じ試行数を配るのは最も割の悪い配り方である。見込みの薄い候補にも深い評価を
払うことになり、同じ予算で見られる候補の数が減る。そこで浅い評価で広く篩い、生き残りに
だけ試行数を積む（Successive Halving）。

判定に使う統計量は段によって変える。CVaRの実効サンプル数は `n` ではなく尾部の件数 `αn`
なので、浅い段では尾部が数件しかなく順位が雑音になる。そこで尾部が育つまでは平均で篩い、
育ってから下振れを見る。

最終選抜（top-k）は探索とは別の位相で回す。探索が使ったのと同じ乱数列で選ぶと、
「その乱数列にたまたま強かった候補」をそのまま最終結果にしてしまう。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from .candidate import Candidate
from .evaluator import CandidateRecord, EvaluationPhase, common_sample_count
from .fitness import RiskPolicy

Statistic = Literal["mean", "fitness"]

# この件数まで尾部が育ってからCVaRを判定へ混ぜる。1〜4件の尾部で順位を決めると、
# 崩れやすさではなく「たまたま崩れたか」を見ることになる。
# 最終結果として報告してよい水準は別で、`fitness.MIN_RELIABLE_TAIL_SAMPLES`（10件）。
MIN_TAIL_SAMPLES_FOR_RACING = 5

# 各段で次へ送る割合。半分ずつ落とす標準的なレーシング。
SURVIVAL_RATIO = 0.5
# 最終選抜で深い段へ送る割合。上位kは必ず残す。
FINAL_SURVIVAL_DIVISOR = 3


class SampleSource(Protocol):
    """`Evaluator.ensure` だけを使う。レーシングはHTTPもseedも知らない。"""

    def ensure(
        self,
        candidates: Sequence[Candidate],
        target: int,
        *,
        phase: EvaluationPhase,
    ) -> list[CandidateRecord]: ...


@dataclass(frozen=True)
class RacingStage:
    runs: int
    statistic: Statistic


@dataclass(frozen=True)
class RacedCandidate:
    """1候補の評価結果。順位付けに使った試行数も一緒に持つ。

    `sample_count` を添えるのは、CVaRの比較が同じ試行数どうしでしか成り立たないためで、
    レポートを読む側がどの条件で並べた順位かを確かめられるようにする。
    """

    candidate: Candidate
    record: CandidateRecord
    sample_count: int
    mean: float
    cvar: float
    fitness: float
    defeat_rate: float

    def value(self, statistic: Statistic) -> float:
        return self.mean if statistic == "mean" else self.fitness


def plan_stages(stage_runs: Sequence[int], policy: RiskPolicy) -> tuple[RacingStage, ...]:
    """各段で使う統計量を決める。切り替えの根拠は試行数ではなく尾部の件数。"""
    if not stage_runs:
        raise ValueError("評価スケジュールには1段以上が要る")
    return tuple(
        RacingStage(
            runs=runs,
            statistic="fitness"
            if policy.tail_size(runs) >= MIN_TAIL_SAMPLES_FOR_RACING
            else "mean",
        )
        for runs in stage_runs
    )


def successive_halving(
    candidates: Sequence[Candidate],
    evaluator: SampleSource,
    *,
    policy: RiskPolicy,
    stages: Sequence[RacingStage],
    phase: EvaluationPhase,
) -> list[RacedCandidate]:
    """段ごとに上位半分だけを次へ送る。最終段は篩わず、順位を付けて返す。"""
    survivors = list(candidates)
    ranked: list[RacedCandidate] = []
    for index, stage in enumerate(stages):
        if not survivors:
            break
        ranked = rank(
            evaluator.ensure(survivors, stage.runs, phase=phase),
            policy,
            stage.statistic,
            target=stage.runs,
        )
        is_last = index == len(stages) - 1
        if is_last:
            break
        keep = max(1, math.ceil(len(ranked) * SURVIVAL_RATIO))
        survivors = [entry.candidate for entry in ranked[:keep]]
    return ranked


def select_top_k(
    candidates: Sequence[Candidate],
    evaluator: SampleSource,
    *,
    policy: RiskPolicy,
    stages: Sequence[RacingStage],
    phase: EvaluationPhase,
    k: int,
) -> list[RacedCandidate]:
    """最終選抜。段階的に棄却し、最後に上位k件へ深い評価を積んでから確定する。

    上位1件だけを再評価して確定する方式にはしない。報告するのはk件であり、
    2位以下も「ノイズで紛れ込んだ候補」ではないことを同じ強さで確かめる必要がある。
    """
    survivors = list(candidates)
    ranked: list[RacedCandidate] = []
    for index, stage in enumerate(stages):
        if not survivors:
            break
        # 深い段は必ず全員が同じ試行数で比べられる状態にしてから順位を付ける。
        ranked = rank(
            evaluator.ensure(survivors, stage.runs, phase=phase),
            policy,
            stage.statistic,
            target=stage.runs,
        )
        is_last = index == len(stages) - 1
        if is_last:
            break
        keep = max(k, math.ceil(len(ranked) / FINAL_SURVIVAL_DIVISOR))
        survivors = [entry.candidate for entry in ranked[:keep]]
    return collapse_equivalent(ranked)[:k]


def collapse_equivalent(ranked: Sequence[RacedCandidate]) -> list[RacedCandidate]:
    """同じ乱数列で同じスコア列になった候補を1件へ畳む。

    共通乱数法のもとでスコア列が完全に一致するなら、その2つは戦闘の上で同じ編成である
    ——効果が出ないメモリーを入れ替えただけ、一度も行動しないユニットを差し替えただけ、
    といった組み合わせが該当する。別々に数えると上位k件の枠が実質同じ編成で埋まり、
    「どれを使うか選ぶ」という目的に対して役に立たなくなる。

    残すのは順位が上の方（同点なら先に出た方）である。
    """
    seen: set[tuple[int, ...]] = set()
    unique: list[RacedCandidate] = []
    for entry in ranked:
        behaviour = tuple(entry.record.scores_at(entry.sample_count))
        if behaviour in seen:
            continue
        seen.add(behaviour)
        unique.append(entry)
    return unique


def rank(
    records: Sequence[CandidateRecord],
    policy: RiskPolicy,
    statistic: Statistic,
    *,
    target: int = 0,
) -> list[RacedCandidate]:
    """同じ試行数へ揃えて並べる。

    試行数の違う候補を生の値で比べない。経験CVaRは小標本で下方バイアスを持つため、
    多く回した候補ほど不当に低く見える。そのラウンドで最も短い履歴へ揃えて比べる。

    サーバーは期限に達すると完了ぶんだけを返す（Q-TEX-18）ので、段の試行数に届かない
    候補が混ざり得る。届いた候補が1つでもあるならそれだけで比べる——欠けた候補へ深さを
    合わせると、その段に払った予算がまるごと無駄になる。1つも届かなければ、揃う深さまで
    下げてでも順位を付ける。サーバーが重いだけで候補の優劣が消えるわけではない。
    """
    sampled = [record for record in records if record.sample_count > 0]
    if not sampled:
        return []
    completed = [record for record in sampled if record.sample_count >= target]
    compared = completed or sampled
    count = common_sample_count(compared)
    entries = [_measure(record, policy, count) for record in compared]
    return sorted(entries, key=lambda entry: entry.value(statistic), reverse=True)


def _measure(record: CandidateRecord, policy: RiskPolicy, count: int) -> RacedCandidate:
    scores = record.scores_at(count)
    return RacedCandidate(
        candidate=record.candidate,
        record=record,
        sample_count=count,
        mean=policy.mean(scores),
        cvar=policy.cvar(scores),
        fitness=policy.fitness(scores),
        defeat_rate=record.defeat_rate(count),
    )
