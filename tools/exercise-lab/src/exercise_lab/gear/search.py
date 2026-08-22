"""Phase B: ギア配分の反復局所探索。

探索空間は5ステータス×各0〜3枚・合計9枚以下で、**1ユニット802通り、5ユニットで
802⁵ ≈ 3.3×10¹⁴**。5×3=15 > 9 なので「全部上限」は作れず、9枚をどう割るかが本質になる。
汎用の探索アルゴリズムでは届かないので、問題の構造を使う——1手近傍の山登りを反復する。

**起点は現状の手持ち（`--player-data`）である。** 0枚からの積み上げにはしない。0枚付近は
敗北が支配的でスコア分布が潰れ、限界効用の信号が取れないためである。

段は2つで、指標が違う。

- **篩い**は自ユニットの与ダメージ。総スコアより分散が小さく、動かした1枠の効果を
  切り出せる。浅い試行数でも順位が付く。
- **確定**は期待日次ベスト＋保証値（`optimize/fitness.py`）。最大化する量そのもの。

**自ユニット与ダメが伸びていないのに総スコアが伸びた手**はレジーム変更の候補として
記録する（Phase C が使う）。自分のダメージが増えていないのにスコアが増えたということは、
その手が誰か別の枠の取り分を変えた——順位で当て先が決まる効果が動いた——ということである。

山登りは局所解で止まる。「攻撃を下げると一度スコアが落ちてから上がる」谷は越えられず、
それを越えるのは Phase C（`plan.py`）の仕事である。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from ..optimize.evaluator import CandidateRecord, EvaluationPhase
from ..optimize.fitness import Objective
from .allocation import DEFAULT_ADD_RANK, Allocation, GearRank
from .neighborhood import Move, neighborhood

SCREEN_PHASE_NAME = "climb-screen"
CONFIRM_PHASE_NAME = "climb-confirm"

LOCAL_OPTIMUM = "LOCAL_OPTIMUM"
BUDGET_EXHAUSTED = "BUDGET"
MAX_ITERATIONS = "MAX_ITERATIONS"

MISSING_DAMAGE_WARNING = (
    "応答にユニット別与ダメージが無いため、篩いを総スコアで代用した"
    "（分散が大きく、浅い試行数では順位が雑音になりやすい）"
)


@dataclass(frozen=True)
class ClimbSettings:
    """1反復の試行数。既定は評価APIの上限に合わせてある。

    5ユニット×約24手＝約120候補。候補数≦32・候補数×試行数≦300 のもとで、篩いは
    30候補×10試行＝1リクエストに収まる。確定は上位16手を30試行まで積む。
    1反復あたり約1,700試行。
    """

    screen_runs: int = 10
    confirm_runs: int = 30
    survivors: int = 16
    max_iterations: int = 12
    include_rank: bool = False
    add_rank: GearRank = DEFAULT_ADD_RANK


class BudgetedSampleSource[C](Protocol):
    """`Evaluator` のうち探索が使う面。

    `consumed_runs` は予算の見張りに、`record_for` は**評価を発行せずに**既存の履歴を
    読むために要る（枝の到達点を並べるだけで新しい試行を投げないため）。
    """

    @property
    def consumed_runs(self) -> int: ...

    def ensure(
        self, candidates: Sequence[C], target: int, *, phase: EvaluationPhase
    ) -> list[CandidateRecord[C]]: ...

    def record_for(self, candidate: C, phase: EvaluationPhase) -> CandidateRecord[C] | None: ...


def phases_for_climb(settings: ClimbSettings) -> tuple[EvaluationPhase, EvaluationPhase]:
    """篩いと確定の位相。通し試行番号の範囲は重ならない。

    反復をまたいで同じ位相を使い回す。前の反復で評価済みの配分が次の反復の基点になる
    ので、キャッシュがそのまま効いて基点の評価をもう一度払わずに済む。同じ乱数範囲で
    登り続けることになるため、その範囲への過適合は最終選抜（別Issue）で洗う。
    """
    screen = EvaluationPhase(
        name=SCREEN_PHASE_NAME, checkpoints=(settings.screen_runs,), seed_offset=0
    )
    confirm = EvaluationPhase(
        name=CONFIRM_PHASE_NAME,
        checkpoints=(settings.confirm_runs,),
        seed_offset=settings.screen_runs,
    )
    return screen, confirm


def iteration_cost(settings: ClimbSettings, *, move_count: int) -> int:
    """1反復で払いうる最大試行数。何も評価していない状態から始めた場合の額である。

    予算の内訳を実行前に示すのはこの値だが、**見張りに使うのは
    `remaining_iteration_cost`** である。前の反復で測った候補や校正で測った基点は
    キャッシュから読むので、そのぶんを二重に要求しないためである。
    """
    survivors = min(settings.survivors, move_count)
    return (1 + move_count) * settings.screen_runs + (1 + survivors) * settings.confirm_runs


def remaining_iteration_cost(
    current: Allocation,
    moves: Sequence[Move],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    settings: ClimbSettings,
) -> int:
    """この反復がこれから払う試行数の上限。評価済みのぶんを差し引く。"""
    return remaining_round_cost(
        current,
        [applied for move in moves if (applied := move.apply(current)) is not None],
        evaluator,
        settings=settings,
    )


def remaining_round_cost(
    current: Allocation,
    variants: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    settings: ClimbSettings,
) -> int:
    """基点と候補を1巡（篩い→確定）測るのに、これから払う試行数の上限。

    篩いは候補が確定しているので正確に引ける。確定段はどの候補が通るか篩う前には
    決まらないため、上限（`survivors` 件が未評価）のまま見積もる——**多めに見積もる**
    ぶんには予算を食い破らないが、少なく見積もると上限を超える。
    """
    screen_phase, confirm_phase = phases_for_climb(settings)
    screening = sum(
        unpaid_runs(evaluator, candidate, screen_phase, settings.screen_runs)
        for candidate in (current, *variants)
    )
    confirming = (
        unpaid_runs(evaluator, current, confirm_phase, settings.confirm_runs)
        + min(settings.survivors, len(variants)) * settings.confirm_runs
    )
    return screening + confirming


def unpaid_runs(
    evaluator: BudgetedSampleSource[Allocation],
    candidate: Allocation,
    phase: EvaluationPhase,
    target: int,
) -> int:
    """その位相でまだ払っていない試行数。評価は発行しない。"""
    record = evaluator.record_for(candidate, phase)
    if record is None:
        return target
    return max(0, target - record.sample_count)


@dataclass(frozen=True)
class ClimbStep:
    """採用した1手。"""

    iteration: int
    move: Move
    allocation: Allocation
    fitness_gain: float
    damage_gain: float
    score_gain: float


@dataclass(frozen=True)
class RegimeCandidate:
    """自ユニット与ダメが伸びていないのに総スコアが伸びた手。Phase C の入口。"""

    iteration: int
    move: Move
    allocation: Allocation
    damage_gain: float
    score_gain: float


@dataclass(frozen=True)
class ClimbResult:
    start: Allocation
    best: Allocation
    steps: tuple[ClimbStep, ...] = ()
    regime_candidates: tuple[RegimeCandidate, ...] = ()
    stopped_because: str = LOCAL_OPTIMUM
    warnings: tuple[str, ...] = ()

    @property
    def iterations(self) -> int:
        return len(self.steps)


@dataclass
class ScreenedMove:
    """篩いを通った手1つと、そのときのペア差。確定段と単価表の入力になる。"""

    move: Move
    allocation: Allocation
    damage_gain: float
    score_gain: float


def hill_climb(
    start: Allocation,
    evaluator: BudgetedSampleSource[Allocation],
    *,
    settings: ClimbSettings,
    objective: Objective,
    budget_runs: int,
) -> ClimbResult:
    """1手近傍の山登りを、改善が止まるか予算が尽きるまで繰り返す。

    乱数は評価器が持つ（送信seedと位相）。ここは順位の付け方だけを決める決定的な手続き
    であり、同じ評価器と同じ設定なら同じ軌跡になる。
    """
    screen_phase, confirm_phase = phases_for_climb(settings)
    current = start
    steps: list[ClimbStep] = []
    candidates: list[RegimeCandidate] = []
    warnings: list[str] = []
    stopped = MAX_ITERATIONS

    for iteration in range(1, settings.max_iterations + 1):
        moves = neighborhood(
            current, include_rank=settings.include_rank, add_rank=settings.add_rank
        )
        if not moves:
            stopped = LOCAL_OPTIMUM
            break
        remaining = remaining_iteration_cost(current, moves, evaluator, settings=settings)
        if evaluator.consumed_runs + remaining > budget_runs:
            stopped = BUDGET_EXHAUSTED
            break

        variants = [
            (move, applied) for move in moves if (applied := move.apply(current)) is not None
        ]
        screened = screen_variants(
            current, variants, evaluator, settings=settings, phase=screen_phase, warnings=warnings
        )
        candidates.extend(
            RegimeCandidate(
                iteration=iteration,
                move=entry.move,
                allocation=entry.allocation,
                damage_gain=entry.damage_gain,
                score_gain=entry.score_gain,
            )
            for entry in screened
            # 自分のダメージが増えていないのにスコアが増えた手。誰か別の枠の取り分が
            # 変わったということであり、順位で当て先が決まる効果が動いた疑いがある。
            if entry.damage_gain <= 0.0 and entry.score_gain > 0.0
        )

        survivors = screened[: settings.survivors]
        ranked = confirm_variants(
            current,
            survivors,
            evaluator,
            settings=settings,
            phase=confirm_phase,
            objective=objective,
        )
        if not ranked or ranked[0][1] <= 0.0:
            stopped = LOCAL_OPTIMUM
            break
        entry, gain = ranked[0]
        current = entry.allocation
        steps.append(
            ClimbStep(
                iteration=iteration,
                move=entry.move,
                allocation=entry.allocation,
                fitness_gain=gain,
                damage_gain=entry.damage_gain,
                score_gain=entry.score_gain,
            )
        )

    return ClimbResult(
        start=start,
        best=current,
        steps=tuple(steps),
        regime_candidates=tuple(candidates),
        stopped_because=stopped,
        warnings=tuple(dict.fromkeys(warnings)),
    )


def screen_variants(
    current: Allocation,
    variants: Sequence[tuple[Move, Allocation]],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    settings: ClimbSettings,
    phase: EvaluationPhase,
    warnings: list[str],
) -> list[ScreenedMove]:
    """候補を浅く評価し、動かした枠の与ダメージのペア差で並べる。

    手と着いた配分の組で受け取るのは、1手先とは限らない候補（ランク微調整の walk は
    数段先まで進む）を同じ篩いに掛けるためである。与ダメージの列は最後の手の枠で取る。
    """
    records = evaluator.ensure(
        [current, *(allocation for _, allocation in variants)],
        settings.screen_runs,
        phase=phase,
    )
    by_key = {record.candidate.canonical_key(): record for record in records}
    base = by_key[current.canonical_key()]
    screened: list[ScreenedMove] = []
    for move, allocation in variants:
        record = by_key[allocation.canonical_key()]
        count = min(settings.screen_runs, base.sample_count, record.sample_count)
        if count < 1:
            continue
        score_gain = _mean_gain(base.scores_at(count), record.scores_at(count))
        damage_gain = _damage_gain(base, record, move.slot_index, count)
        if damage_gain is None:
            warnings.append(MISSING_DAMAGE_WARNING)
            damage_gain = score_gain
        screened.append(
            ScreenedMove(
                move=move, allocation=allocation, damage_gain=damage_gain, score_gain=score_gain
            )
        )
    screened.sort(key=lambda entry: entry.damage_gain, reverse=True)
    return screened


def confirm_variants(
    current: Allocation,
    survivors: Sequence[ScreenedMove],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    settings: ClimbSettings,
    phase: EvaluationPhase,
    objective: Objective,
) -> list[tuple[ScreenedMove, float]]:
    """篩いを通った手を深く評価し、期待日次ベスト＋保証値のペア差の降順で返す。

    最良の1手だけでなく全件を返す。単価表（`rank_tuning.py`）は採用しなかった手の差も
    要るので、ここで畳むと同じ評価をもう一度読み直すことになる。
    """
    if not survivors:
        return []
    records = evaluator.ensure(
        [current, *(entry.allocation for entry in survivors)], settings.confirm_runs, phase=phase
    )
    by_key = {record.candidate.canonical_key(): record for record in records}
    base = by_key[current.canonical_key()]
    ranked: list[tuple[ScreenedMove, float]] = []
    for entry in survivors:
        record = by_key[entry.allocation.canonical_key()]
        count = min(settings.confirm_runs, base.sample_count, record.sample_count)
        if count < 1:
            continue
        gain = objective.fitness(record.scores_at(count)) - objective.fitness(base.scores_at(count))
        ranked.append((entry, gain))
    ranked.sort(key=lambda pair: pair[1], reverse=True)
    return ranked


def _mean_gain(base: Sequence[int], variant: Sequence[int]) -> float:
    """試行ごとに対応させた差の平均。共通乱数法が効くので分散が小さい。"""
    return sum(variant) / len(variant) - sum(base) / len(base)


def _damage_gain(
    base: CandidateRecord, variant: CandidateRecord, slot_index: int, count: int
) -> float | None:
    """動かした枠の与ダメージのペア差。応答に列が無ければ `None`。"""
    base_damage = base.unit_damage_at(slot_index, count=count)
    variant_damage = variant.unit_damage_at(slot_index, count=count)
    if not base_damage or not variant_damage:
        return None
    return _mean_gain(base_damage, variant_damage)
