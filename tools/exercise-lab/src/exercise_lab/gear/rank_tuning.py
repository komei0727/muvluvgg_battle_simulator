"""Phase D: ギアのランク微調整。

理論値は「全枠Ⅲ-S」ではない。順位で対象が決まる効果があるので、**意図的にランクを下げて
閾値の直下に置く**構成が勝つことがある。攻撃力の補正値は昇順に
0.75 / 1.0 / 1.18 / 1.58 / 1.62 / 2.06 / 2.16 / 2.49 / 2.75 / 3.33 で、隣接差は最小 0.04pt
（Ⅲ-C → Ⅱ-B）。この刻みで順位の境界を作れる（`ranks.py`）。

**ランクを全ユニット・全枠へ開かない。** 1枚あたり9通りの替えがあるので、近傍が2桁増える。
ランクが意味を持つのは順位の境界に関わる箇所だけなので、Phase B/C で配分が収束した後に、
**署名で絞り込んだ枠**に限って行う。

絞り込みは観測から決める。**「順位セレクタかどうか」はAPIから判別できない**（`regime.py`）
——分かるのは「観測のあいだに当て先が動いた成分がある」ことだけである。当て先が動いた成分の
両端（動く前の受け先と、動いた後の受け先）が境界に関わる枠であり、そこだけを対象にする。
1度も動かなかった成分は定数であり、境界の証拠が無い。

手の進め方は Phase C と同じ「押して越える」である。山登りにしないのは、閾値を跨ぐまで
スコアが下がり続けるためで、改善を条件に採ると1段目で止まる。**刻みの細かい段から先に
使う** ——閾値の直下へ置くには、跨いだ瞬間の落差が小さいほどよい。

副産物として**単価表**を出す。同一ステータス内のランク1段のΔを、**上げる向き**
（「Ⅲ-A → Ⅲ-S で何点」）で並べたものである。閾値を跨ぐ段だけは単価が負になる——そこが
ランクを下げる理由であり、在庫の使い道を決めるのに要る。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..models import GearStat
from ..optimize.evaluator import EvaluationPhase
from ..optimize.fitness import Objective
from .allocation import Allocation
from .neighborhood import Move, deduplicated
from .ranks import RankLadder, RankStep
from .regime import (
    ACTION_ORDER_COMPONENT,
    RegimeSignature,
    SignatureObserver,
    slot_index_of,
)
from .search import (
    BudgetedSampleSource,
    ClimbSettings,
    ScreenedMove,
    confirm_variants,
    phases_for_climb,
    remaining_round_cost,
    screen_variants,
    unpaid_runs,
)

NO_TARGET = "NO_TARGET"
NO_MOVE = "NO_MOVE"
BUDGET_EXHAUSTED = "BUDGET"
LOCAL_OPTIMUM = "LOCAL_OPTIMUM"
IMPROVED = "IMPROVED"
SIGNATURE_CHANGED = "SIGNATURE_CHANGED"
MAX_STEPS = "MAX_STEPS"

# 成分ごとに、その順位を決めるステータス。行動順は行動速度で決まり、それ以外の順位
# セレクタは攻撃力で決まるものが大半である（`plan.py` の `PUSH_STAT` と同じ前提）。
ACTION_ORDER_STAT: GearStat = "ACTION_SPEED"
DEFAULT_TARGET_STAT: GearStat = "ATTACK"

# 1枠が対象になりうるステータス。順位効果の境界（攻撃力）と行動順の境界（行動速度）は
# 別の成分から来るので、**同じ枠が両方の対象になり得る**。
TARGET_STATS: tuple[GearStat, ...] = (DEFAULT_TARGET_STAT, ACTION_ORDER_STAT)


@dataclass(frozen=True)
class RankTuningSettings:
    """1本の walk で下げる最大段数。0 で微調整そのものを行わない。"""

    steps: int = 4


@dataclass(frozen=True)
class FocusTarget:
    """微調整の対象1つ。枠とステータス、そう判断した根拠の成分。"""

    slot_index: int
    stat: GearStat
    components: tuple[str, ...]


@dataclass(frozen=True)
class RankStop:
    """walk の途中の1点。1段下げた結果と、そこで観測した署名。"""

    target: FocusTarget
    step: int
    move: Move
    rank_step: RankStep
    allocation: Allocation
    signature: RegimeSignature
    changed: bool
    # 確定段まで届かなかった点（予算で落とした・篩いで残らなかった）は `None`。
    fitness_gain: float | None = None
    expected_best_gain: float | None = None


@dataclass(frozen=True)
class RankWalk:
    """1つの対象を下へ辿った1本。署名が変わった時点で止める。"""

    target: FocusTarget
    stops: tuple[RankStop, ...] = ()
    stopped_because: str = MAX_STEPS


@dataclass(frozen=True)
class RankPrice:
    """単価表の1行。**上げる向き**（`lower` → `higher`）で読む。

    閾値を跨ぐ段では負になる。「上げ直すと損をする」＝そこがランクを下げる理由である。
    1段の単価は測った時点の配分に依存する（1手ずつの効果は加法ではない）ので、どの段で
    測ったかを `step_index` に残す。
    """

    step_index: int
    slot_index: int
    unit_definition_id: str
    stat: GearStat
    rank_step: RankStep
    fitness_delta: float
    expected_best_delta: float
    runs: int


@dataclass(frozen=True)
class SignatureBest:
    """到達した署名1つと、その署名でのベスト。基点は `move` が `None`。"""

    digest: str
    signature: RegimeSignature
    allocation: Allocation
    fitness: float
    move: Move | None = None


@dataclass(frozen=True)
class RankTuningResult:
    start: Allocation
    best: Allocation
    best_gain: float = 0.0
    targets: tuple[FocusTarget, ...] = ()
    walks: tuple[RankWalk, ...] = ()
    prices: tuple[RankPrice, ...] = ()
    signatures: tuple[SignatureBest, ...] = ()
    stopped_because: str = NO_TARGET
    warnings: tuple[str, ...] = ()


def focus_targets(signatures: Sequence[RegimeSignature]) -> tuple[FocusTarget, ...]:
    """順位の境界に関わる枠。**当て先が動いた成分の両端だけ**を返す。

    「順位セレクタかどうか」は判別できないので、動いた事実を証拠に使う。1度も動かなかった
    成分の受け先まで含めると、自分へバフを掛けるだけの効果も境界に数え、対象が全枠へ
    広がってしまう。敵は除く——ギアでは動かせない。
    """
    found: dict[tuple[int, GearStat], set[str]] = {}
    for component, stat, labels in _moved_components(signatures):
        for label in labels:
            slot_index = slot_index_of(label)
            if slot_index is None:
                continue
            found.setdefault((slot_index, stat), set()).add(component)
    return tuple(
        FocusTarget(slot_index=slot_index, stat=stat, components=tuple(sorted(components)))
        for (slot_index, stat), components in sorted(found.items())
    )


def _moved_components(
    signatures: Sequence[RegimeSignature],
) -> list[tuple[str, GearStat, tuple[str, ...]]]:
    """当て先が2通り以上観測された成分と、そこへ現れた当て先すべて。

    行動順は**予約順の位置ごと**に見る。列そのものを1つの成分として扱うと、1枠でも
    入れ替わった時点で列に居る全員が境界に見えてしまう。位置が変わっていない枠は、
    その入れ替わりに関わっていない。
    """
    seen: dict[tuple[str, str, GearStat], list[str]] = {}
    for signature in signatures:
        # 付与先と消費者は同じ定義IDでも別の成分である。束ねると、敵が保持し攻撃側が
        # 消費する単発デバフで「当て先が2通り」が常に立ち、境界が全枠へ広がる。
        for kind, mapping in (("assign", signature.assignments), ("consume", signature.consumers)):
            for component, label in mapping.items():
                seen.setdefault((f"{kind}:{component}", component, DEFAULT_TARGET_STAT), []).append(
                    label
                )
        for position, label in enumerate(signature.action_order):
            seen.setdefault(
                (f"{ACTION_ORDER_COMPONENT}#{position}", ACTION_ORDER_COMPONENT, ACTION_ORDER_STAT),
                [],
            ).append(label)
    return [
        (component, stat, tuple(sorted(set(labels))))
        for (_, component, stat), labels in sorted(seen.items())
        if len(set(labels)) > 1
    ]


def rank_moves(
    allocation: Allocation, targets: Sequence[FocusTarget], ladder: RankLadder
) -> tuple[Move, ...]:
    """対象の枠・ステータスについて、1枚を1段下げる手すべて。"""
    return deduplicated(
        [move for target in targets for move, _ in _lowering_moves(allocation, target, ladder)],
        allocation,
    )


def _lowering_moves(
    allocation: Allocation, target: FocusTarget, ladder: RankLadder
) -> list[tuple[Move, RankStep]]:
    """1つの対象について、1枚を1段下げる手と、その段。

    枠を区別しないので、同じ駒が2枚挿さっていても手は1つである（`distinct_pieces`）。
    """
    unit = allocation.units[target.slot_index]
    return [
        (
            Move(
                kind="rank",
                slot_index=target.slot_index,
                unit_definition_id=unit.unit_definition_id,
                removed=piece,
                added=step.lower.with_stat(piece.stat),
            ),
            step,
        )
        for piece in unit.distinct_pieces()
        if piece.stat == target.stat and (step := ladder.step_down(piece)) is not None
    ]


def max_target_count(unit_count: int) -> int:
    """実行前に見積もれる対象数の上限。

    対象は `(枠, ステータス)` 単位であり、1枠につき境界は最大 `TARGET_STATS` 本ある。
    枠数をそのまま上限に使うと、予算の内訳・所要時間の見積り・進捗バーの総数が
    最大で半分に過小評価される（`--budget` 自体は実行時に見張るので超えない）。
    """
    return unit_count * len(TARGET_STATS)


def observation_count(settings: RankTuningSettings, *, target_count: int) -> int:
    """単発実行の回数の上限。基点1回と、対象ごとの walk の各段。"""
    if settings.steps < 1 or target_count < 1:
        return 0
    return 1 + target_count * settings.steps


def rank_round_cost(
    settings: RankTuningSettings, climb: ClimbSettings, *, target_count: int
) -> int:
    """1巡（篩い→確定）で払いうる最大試行数。

    実行前は対象が決まっていない（署名を観測してから決まる）ので、呼び出し側は
    `max_target_count` の数を渡す。少なく見積もると予算の内訳が上限として機能しない。
    """
    if settings.steps < 1 or target_count < 1:
        return 0
    candidates = target_count * settings.steps
    return (1 + candidates) * climb.screen_runs + (
        1 + min(climb.survivors, candidates)
    ) * climb.confirm_runs


def tune_ranks(
    start: Allocation,
    evaluator: BudgetedSampleSource[Allocation],
    observer: SignatureObserver,
    *,
    ladder: RankLadder,
    targets: Sequence[FocusTarget],
    settings: RankTuningSettings,
    climb: ClimbSettings,
    objective: Objective,
    budget_runs: int,
) -> RankTuningResult:
    """収束した配分から、境界に関わる枠のランクだけを下へ辿る。"""
    if not targets or settings.steps < 1 or ladder.is_empty():
        return RankTuningResult(start=start, best=start, stopped_because=NO_TARGET)
    screen_phase, confirm_phase = phases_for_climb(climb)
    if evaluator.consumed_runs + _one_stop_cost(start, evaluator, climb=climb) > budget_runs:
        # 1点も測れない予算では観測も投げない。単発実行は試行数とは別勘定だが、
        # 評価できないと分かっている実行へ待ち時間を払わせる理由が無い。
        return RankTuningResult(
            start=start, best=start, targets=tuple(targets), stopped_because=BUDGET_EXHAUSTED
        )

    base_signature = observer.observe(start)
    walked = [
        _walk(start, target, ladder, observer, base_signature, settings=settings)
        for target in targets
    ]
    kept, warnings = _within_budget(
        start,
        [stop for walk in walked for stop in walk.stops],
        evaluator,
        climb=climb,
        budget_runs=budget_runs,
    )
    measured = _measure(
        start,
        kept,
        evaluator,
        climb=climb,
        objective=objective,
        screen_phase=screen_phase,
        confirm_phase=confirm_phase,
        warnings=warnings,
    )
    walks = [_with_measurements(walk, measured) for walk in walked]
    best, best_gain = _best_of(start, walks)
    return RankTuningResult(
        start=start,
        best=best,
        best_gain=best_gain,
        targets=tuple(targets),
        walks=tuple(walks),
        prices=_prices(walks, climb=climb),
        signatures=_signature_bests(start, base_signature, walks),
        stopped_because=IMPROVED if best_gain > 0.0 else LOCAL_OPTIMUM,
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _one_stop_cost(
    start: Allocation, evaluator: BudgetedSampleSource[Allocation], *, climb: ClimbSettings
) -> int:
    """候補1件を測るのに要る最小額。基点は既に払っている場合があるので引く。"""
    screen_phase, confirm_phase = phases_for_climb(climb)
    return (
        unpaid_runs(evaluator, start, screen_phase, climb.screen_runs)
        + climb.screen_runs
        + unpaid_runs(evaluator, start, confirm_phase, climb.confirm_runs)
        + climb.confirm_runs
    )


def _walk(
    start: Allocation,
    target: FocusTarget,
    ladder: RankLadder,
    observer: SignatureObserver,
    base_signature: RegimeSignature,
    *,
    settings: RankTuningSettings,
) -> RankWalk:
    """1つの対象を1段ずつ下げ、署名が変わったら止める。スコアは見ない。"""
    allocation = start
    stops: list[RankStop] = []
    for step in range(1, settings.steps + 1):
        stepped = _finest_step(allocation, target, ladder)
        if stepped is None:
            return RankWalk(target=target, stops=tuple(stops), stopped_because=NO_MOVE)
        move, rank_step = stepped
        applied = move.apply(allocation)
        if applied is None:
            return RankWalk(target=target, stops=tuple(stops), stopped_because=NO_MOVE)
        allocation = applied
        signature = observer.observe(allocation)
        changed = bool(signature.differences(base_signature))
        stops.append(
            RankStop(
                target=target,
                step=step,
                move=move,
                rank_step=rank_step,
                allocation=allocation,
                signature=signature,
                changed=changed,
            )
        )
        if changed:
            return RankWalk(target=target, stops=tuple(stops), stopped_because=SIGNATURE_CHANGED)
    return RankWalk(target=target, stops=tuple(stops), stopped_because=MAX_STEPS)


def _finest_step(
    allocation: Allocation, target: FocusTarget, ladder: RankLadder
) -> tuple[Move, RankStep] | None:
    """次に下げる1枚。落差の最も小さい段を選ぶ（閾値の直下へ寄せるため）。"""
    candidates = _lowering_moves(allocation, target, ladder)
    if not candidates:
        return None
    return min(candidates, key=lambda pair: (pair[1].points_delta, pair[0].removed.sort_key()))


def _within_budget(
    start: Allocation,
    stops: Sequence[RankStop],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    budget_runs: int,
) -> tuple[list[RankStop], list[str]]:
    """予算に収まる点まで削る。**黙って切らない**——落とした件数を警告に残す。"""
    kept = list(stops)
    while kept and evaluator.consumed_runs + _cost_of(start, kept, evaluator, climb=climb) > (
        budget_runs
    ):
        kept.pop()
    dropped = len(stops) - len(kept)
    if not dropped:
        return kept, []
    return kept, [
        f"予算の残りが足りず、ランク微調整の候補 {dropped} 件を測らずに落とした"
        "（--budget を増やすか --rank-steps を下げる）"
    ]


def _cost_of(
    start: Allocation,
    stops: Sequence[RankStop],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
) -> int:
    return remaining_round_cost(
        start, [stop.allocation for stop in stops], evaluator, settings=climb
    )


def _measure(
    start: Allocation,
    stops: Sequence[RankStop],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    objective: Objective,
    screen_phase: EvaluationPhase,
    confirm_phase: EvaluationPhase,
    warnings: list[str],
) -> Mapping[str, tuple[float, float]]:
    """篩い→確定を前段と同じ手順で通し、配分ごとの利得を返す。

    walk の点は基点から数段先にあるので、篩いには「最後の手と着いた配分」の組を渡す。
    与ダメージのペア差はその手の枠で取る——下げたのはその枠だけである。
    """
    if not stops:
        return {}
    screened = screen_variants(
        start,
        [(stop.move, stop.allocation) for stop in stops],
        evaluator,
        settings=climb,
        phase=screen_phase,
        warnings=warnings,
    )
    ranked = confirm_variants(
        start,
        screened[: climb.survivors],
        evaluator,
        settings=climb,
        phase=confirm_phase,
        objective=objective,
    )
    return {
        entry.allocation.canonical_key(): (
            gain,
            _expected_best_gain(start, entry, evaluator, objective, confirm_phase, climb),
        )
        for entry, gain in ranked
    }


def _expected_best_gain(
    start: Allocation,
    entry: ScreenedMove,
    evaluator: BudgetedSampleSource[Allocation],
    objective: Objective,
    phase: EvaluationPhase,
    climb: ClimbSettings,
) -> float:
    """期待日次ベストのペア差。**新しい評価は発行しない**（確定段の履歴を読む）。"""
    base = evaluator.record_for(start, phase)
    record = evaluator.record_for(entry.allocation, phase)
    if base is None or record is None:
        return 0.0
    count = min(climb.confirm_runs, base.sample_count, record.sample_count)
    if count < 1:
        return 0.0
    return objective.expected_best(record.scores_at(count)) - objective.expected_best(
        base.scores_at(count)
    )


def _with_measurements(walk: RankWalk, measured: Mapping[str, tuple[float, float]]) -> RankWalk:
    return RankWalk(
        target=walk.target,
        stops=tuple(
            _stop_with(stop, measured.get(stop.allocation.canonical_key())) for stop in walk.stops
        ),
        stopped_because=walk.stopped_because,
    )


def _stop_with(stop: RankStop, gains: tuple[float, float] | None) -> RankStop:
    if gains is None:
        return stop
    fitness_gain, expected_best_gain = gains
    return RankStop(
        target=stop.target,
        step=stop.step,
        move=stop.move,
        rank_step=stop.rank_step,
        allocation=stop.allocation,
        signature=stop.signature,
        changed=stop.changed,
        fitness_gain=fitness_gain,
        expected_best_gain=expected_best_gain,
    )


def _best_of(start: Allocation, walks: Sequence[RankWalk]) -> tuple[Allocation, float]:
    """測れた点のうち最も良いもの。基点に勝てなければ基点を返す。"""
    best = start
    best_gain = 0.0
    for walk in walks:
        for stop in walk.stops:
            if stop.fitness_gain is not None and stop.fitness_gain > best_gain:
                best = stop.allocation
                best_gain = stop.fitness_gain
    return best, best_gain


def _prices(walks: Sequence[RankWalk], *, climb: ClimbSettings) -> tuple[RankPrice, ...]:
    """単価表。walk 上の隣り合う2点の差が、その1段のΔである。

    差を取ると基点への利得が相殺し、その段そのものの値になる。前の点が測れていない段は
    出さない——1段の単価は2点の差でしか決まらない。
    """
    prices: list[RankPrice] = []
    for walk in walks:
        previous = (0.0, 0.0)
        for stop in walk.stops:
            if stop.fitness_gain is None or stop.expected_best_gain is None:
                break
            prices.append(
                RankPrice(
                    step_index=stop.step,
                    slot_index=stop.move.slot_index,
                    unit_definition_id=stop.move.unit_definition_id,
                    stat=stop.target.stat,
                    rank_step=stop.rank_step,
                    # 下げた手の符号を反転して「1段上げると幾ら増えるか」にする。
                    fitness_delta=previous[0] - stop.fitness_gain,
                    expected_best_delta=previous[1] - stop.expected_best_gain,
                    runs=climb.confirm_runs,
                )
            )
            previous = (stop.fitness_gain, stop.expected_best_gain)
    return tuple(prices)


def _signature_bests(
    start: Allocation, base_signature: RegimeSignature, walks: Sequence[RankWalk]
) -> tuple[SignatureBest, ...]:
    """署名ごとのベスト。ランク変更で署名が変わった点は別の署名として数える。"""
    bests: dict[str, SignatureBest] = {
        base_signature.digest(): SignatureBest(
            digest=base_signature.digest(),
            signature=base_signature,
            allocation=start,
            fitness=0.0,
        )
    }
    for walk in walks:
        for stop in walk.stops:
            if stop.fitness_gain is None:
                continue
            digest = stop.signature.digest()
            current = bests.get(digest)
            if current is not None and current.fitness >= stop.fitness_gain:
                continue
            bests[digest] = SignatureBest(
                digest=digest,
                signature=stop.signature,
                allocation=stop.allocation,
                fitness=stop.fitness_gain,
                move=stop.move,
            )
    return tuple(sorted(bests.values(), key=lambda entry: (-entry.fitness, entry.digest)))
