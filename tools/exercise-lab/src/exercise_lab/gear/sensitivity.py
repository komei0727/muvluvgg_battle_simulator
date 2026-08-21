"""ギア1手の限界効用分析。

基点編成に対し1手近傍を総当たりし、基点との**ペア差**で並べる。共通乱数法（同一送信
seed・同一試行数なら候補が違っても同じ乱数列）が効くので、候補ごとに独立な統計量を
比べるより分散がはるかに小さい。

ただし**同期は完全ではない**。ギアを変えると会心判定や確率PSの発動回数が変わり、乱数の
消費順そのものが動くためである。分散は下がるが、独立seedと完全同期の中間だと思うこと。

段は2つある。向きが違う2つの指標を意図的に使い分けている。

- **篩い**は平均のペア差。分散が最小で、浅い試行数でも順位が付く。
- **確定**は期待日次ベスト＋保証値（`optimize/fitness.py` の `Objective.fitness`）。
  スコアアタックは1日k回のベストで競うので、最大化すべきはこちらである。

両者は向きが違う——稀な崩壊は平均だけを線形に下げるが、日次ベストではk回に1回を無駄に
するだけで済む。したがって**篩いの足切りは緩くする**。明確に悪い手だけを落とし、有意で
ないだけの手は確定へ通す。落とした手も敗北率つきで報告し、機械的に消えないようにする。

上位手は**探索で使っていない乱数範囲**で確認走を行う（勝者の呪い対策。`optimize/racing.py`
の最終選抜と同じ方針）。上位k手を同時に適用した構成も1候補として評価する——1手ずつの
効果は加法ではない。
"""

from __future__ import annotations

import math
import zlib
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Protocol

import numpy as np

from ..models import GearStat
from ..optimize.evaluator import CandidateRecord, EvaluationPhase
from ..optimize.fitness import Objective
from ..stats import NORMAL_QUANTILE_95
from .allocation import (
    DEFAULT_ADD_RANK,
    MAX_PIECES_PER_STAT,
    SEARCHED_STATS,
    Allocation,
    GearRank,
)
from .neighborhood import Move

# ペア差の信頼区間の水準。`stats.py` の平均の区間と揃える（同じレポートに並ぶため）。
CONFIDENCE_QUANTILE = NORMAL_QUANTILE_95
# 確認走で同時適用の構成が占める枠。基点と上位k手に加えて1件。
COMBINED_CANDIDATES = 1

SCREEN_PHASE_NAME = "screen"
CONFIRM_PHASE_NAME = "confirm"
VERIFY_PHASE_NAME = "verify"


@dataclass(frozen=True)
class SensitivitySettings:
    """試行数の配り方と近傍の広さ。予算はこの4つの積でほぼ決まる。"""

    screen_runs: int = 60
    confirm_runs: int = 200
    verify_runs: int = 200
    # 確定へ通す手の上限。足切りそのものは緩く、ここは予算の頭打ちとして効く。
    survivors: int = 10
    top_moves: int = 5
    include_rank: bool = False
    add_rank: GearRank = DEFAULT_ADD_RANK
    bootstrap_samples: int = 1000


class SampleSource[C](Protocol):
    """`Evaluator.ensure` だけを使う。分析はHTTPもseedも知らない。"""

    def ensure(
        self, candidates: Sequence[C], target: int, *, phase: EvaluationPhase
    ) -> list[CandidateRecord[C]]: ...


def phases_for(
    settings: SensitivitySettings,
) -> tuple[EvaluationPhase, EvaluationPhase, EvaluationPhase]:
    """3つの位相。通し試行番号の範囲は重ならない。

    確認走が篩い・確定と同じ乱数列を引くと、「その乱数列にたまたま強かった手」を
    そのまま結論にしてしまう（勝者の呪い）。範囲を分けることがその対策そのものである。
    """
    screen = EvaluationPhase(
        name=SCREEN_PHASE_NAME, checkpoints=(settings.screen_runs,), seed_offset=0
    )
    confirm = EvaluationPhase(
        name=CONFIRM_PHASE_NAME,
        checkpoints=(settings.confirm_runs,),
        seed_offset=settings.screen_runs,
    )
    verify = EvaluationPhase(
        name=VERIFY_PHASE_NAME,
        checkpoints=(settings.verify_runs,),
        seed_offset=settings.screen_runs + settings.confirm_runs,
    )
    return screen, confirm, verify


def planned_runs(settings: SensitivitySettings, *, move_count: int) -> dict[str, int]:
    """段ごとの試行数の上限。実行前に内訳を出すためにある。

    上限であって実測ではない。篩いで落ちた手は確定へ進まないので、実際の消費はこれ以下
    になる。
    """
    survivors = min(settings.survivors, move_count)
    top = min(settings.top_moves, move_count)
    screen = (1 + move_count) * settings.screen_runs
    confirm = (1 + survivors) * settings.confirm_runs
    verify = (1 + top + COMBINED_CANDIDATES) * settings.verify_runs
    return {
        "screen": screen,
        "confirm": confirm,
        "verify": verify,
        "total": screen + confirm + verify,
    }


@dataclass(frozen=True)
class DetectableMargins:
    """この予算で見える差の下限。基点のばらつきから見積もる。"""

    runs: int
    base_mean: float
    mean_absolute: float
    mean_ratio: float
    expected_best_absolute: float
    expected_best_ratio: float


def detectable_margins(
    scores: Sequence[int], *, runs: int, objective: Objective
) -> DetectableMargins:
    """「この試行数だと ±X までしか見えない」。

    ペア差の標準偏差は実際には共通乱数法で下がるが、事前には測れないので**独立を仮定した
    上限** `√2·σ` で見積もる。楽観的な数字を先に出して「差が無い」と読ませるより、
    保守的な側へ倒す。

    期待日次ベストは重みが上位標本へ集中し、実効サンプル数が n ではなく n(2k−1)/k²
    （k=5 で約36%）しかない。平均と同じ精度を得るには約3倍の試行数が要る。
    """
    values = np.asarray(scores, dtype=np.float64)
    if values.size < 2:
        raise ValueError("見える差を見積もるには2件以上のスコアが要る")
    stdev = float(values.std(ddof=1))
    mean = float(values.mean())
    paired = CONFIDENCE_QUANTILE * math.sqrt(2.0) * stdev / math.sqrt(runs)
    inflation = math.sqrt(runs / objective.effective_samples(runs))
    return DetectableMargins(
        runs=runs,
        base_mean=mean,
        mean_absolute=paired,
        mean_ratio=paired / mean if mean else float("inf"),
        expected_best_absolute=paired * inflation,
        expected_best_ratio=paired * inflation / mean if mean else float("inf"),
    )


def expected_best_weights(count: int, *, best_of: int) -> np.ndarray:
    """昇順に並べた標本へ掛ける、期待日次ベストの重み。

    `fitness.expected_best` と同じ定義（C(i, k−1)/C(n, k)）をベクトル化したものである。
    ブートストラップは同じ推定量を数千回引き直すため、素の実装ではコストが釣り合わない。
    定義の正本は `fitness.py` 側であり、両者が黙って乖離しないようテストで縛ってある。
    """
    if count <= 0:
        raise ValueError("重みを出すには1件以上の標本が要る")
    weights = np.zeros(count, dtype=np.float64)
    if count < best_of:
        # 復元なしにk個引けない部分結果。`fitness.expected_best` と同じく最大値へ落とす。
        weights[-1] = 1.0
        return weights
    total = math.comb(count, best_of)
    for index in range(count):
        weights[index] = math.comb(index, best_of - 1) / total
    return weights


@dataclass(frozen=True)
class PairedDiff:
    """基点と1候補の、試行ごとに対応させた差。"""

    count: int
    mean_diff: float
    mean_ci_low: float
    mean_ci_high: float
    expected_best_diff: float
    expected_best_ci_low: float
    expected_best_ci_high: float
    guard_diff: float
    fitness_diff: float
    base_mean: float
    defeat_rate: float
    base_defeat_rate: float

    @property
    def mean_significant(self) -> bool:
        return self.mean_ci_low > 0.0 or self.mean_ci_high < 0.0

    @property
    def expected_best_significant(self) -> bool:
        """信頼区間が0を跨いでいないか。

        「効果ゼロ」と「この試行数では見えなかった」を同じ表記にしないために要る。
        """
        return self.expected_best_ci_low > 0.0 or self.expected_best_ci_high < 0.0


def paired_difference(
    base: CandidateRecord,
    variant: CandidateRecord,
    *,
    count: int,
    objective: Objective,
    seed: str,
    bootstrap_samples: int = SensitivitySettings.bootstrap_samples,
) -> PairedDiff:
    """試行ごとのペア差。件数は両者の短い方へ揃える（期限で欠けた候補が混ざり得る）。"""
    pairs = min(count, base.sample_count, variant.sample_count)
    if pairs < 1:
        raise ValueError("ペア差を出すには1件以上の対応する試行が要る")
    base_scores = np.asarray(base.scores_at(pairs), dtype=np.float64)
    variant_scores = np.asarray(variant.scores_at(pairs), dtype=np.float64)
    differences = variant_scores - base_scores
    mean_diff = float(differences.mean())
    half_width = 0.0
    if pairs >= 2:
        half_width = CONFIDENCE_QUANTILE * float(differences.std(ddof=1)) / math.sqrt(pairs)
    low, high = _bootstrap_expected_best_interval(
        base_scores,
        variant_scores,
        best_of=objective.best_of,
        samples=bootstrap_samples,
        seed=seed,
    )
    base_list = base_scores.tolist()
    variant_list = variant_scores.tolist()
    return PairedDiff(
        count=pairs,
        mean_diff=mean_diff,
        mean_ci_low=mean_diff - half_width,
        mean_ci_high=mean_diff + half_width,
        expected_best_diff=objective.expected_best(variant_list)
        - objective.expected_best(base_list),
        expected_best_ci_low=low,
        expected_best_ci_high=high,
        guard_diff=objective.guard(variant_list) - objective.guard(base_list),
        fitness_diff=objective.fitness(variant_list) - objective.fitness(base_list),
        base_mean=float(base_scores.mean()),
        defeat_rate=variant.defeat_rate(pairs),
        base_defeat_rate=base.defeat_rate(pairs),
    )


def _bootstrap_expected_best_interval(
    base: np.ndarray,
    variant: np.ndarray,
    *,
    best_of: int,
    samples: int,
    seed: str,
) -> tuple[float, float]:
    """期待日次ベストのペア差の信頼区間（対応を保ったブートストラップ）。

    順序統計量の重み付き和には閉形式の分散が無いため、再標本化で出す。**試行の対応を
    崩さない**——基点と候補で同じ試行番号を引くことが共通乱数法の効きそのものであり、
    別々に引き直すと差の分散が独立標本の水準まで膨らむ。

    seedから乱数を起こすので、同じ入力からは常に同じ区間が出る。
    """
    pairs = len(base)
    if pairs < 2 or samples < 1:
        # 1件では再標本化しても同じ値しか出ない。区間を作らず点で返す。
        weights = expected_best_weights(pairs, best_of=best_of)
        point = float(np.sort(variant) @ weights - np.sort(base) @ weights)
        return point, point
    weights = expected_best_weights(pairs, best_of=best_of)
    rng = np.random.default_rng(zlib.crc32(seed.encode("utf-8")))
    indices = rng.integers(0, pairs, size=(samples, pairs))
    differences = (np.sort(variant[indices], axis=1) - np.sort(base[indices], axis=1)) @ weights
    low, high = np.percentile(differences, [2.5, 97.5])
    return float(low), float(high)


@dataclass(frozen=True)
class MoveEntry:
    """1手の測定結果。段ごとに別の位相で測るので、深さの違う3つを並べて持つ。"""

    move: Move
    allocation: Allocation
    screen: PairedDiff
    confirm: PairedDiff | None = None
    verify: PairedDiff | None = None

    @property
    def deepest(self) -> PairedDiff:
        return self.verify or self.confirm or self.screen

    @property
    def deepest_stage(self) -> str:
        if self.verify is not None:
            return VERIFY_PHASE_NAME
        if self.confirm is not None:
            return CONFIRM_PHASE_NAME
        return SCREEN_PHASE_NAME


@dataclass(frozen=True)
class CombinedResult:
    """上位k手を同時に適用した構成。1手ずつの効果は加法ではない。"""

    allocation: Allocation
    applied: tuple[Move, ...]
    skipped: tuple[Move, ...]
    difference: PairedDiff


@dataclass(frozen=True)
class UtilityCell:
    """限界効用マップの1マス（ユニット枠 × ステータス）。"""

    slot_index: int
    unit_definition_id: str
    stat: GearStat
    entry: MoveEntry | None
    at_limit: bool

    @property
    def unavailable_because(self) -> str | None:
        if self.entry is not None:
            return None
        return f"上限{MAX_PIECES_PER_STAT}枚" if self.at_limit else "手が無い"


@dataclass(frozen=True)
class SensitivityResult:
    base_allocation: Allocation
    moves: tuple[MoveEntry, ...]
    top_moves: tuple[MoveEntry, ...]
    combined: CombinedResult | None
    base_records: dict[str, CandidateRecord]
    warnings: tuple[str, ...] = ()

    def screening_order(self) -> tuple[MoveEntry, ...]:
        """篩いの順位。平均のペア差で並べる。"""
        return tuple(sorted(self.moves, key=lambda entry: entry.screen.mean_diff, reverse=True))

    def utility_map(self) -> tuple[UtilityCell, ...]:
        """ユニット × ステータスの限界効用。

        マスの値は「そのステータスへ1枚積む手のうち最良のΔ」である。手が無いマスは
        `entry is None` になり、上限に達しているのか（`at_limit`）そもそも積む余地が
        無いのかを区別できる。「効果が無い」と「手が存在しない」を同じ表記にしない。
        """
        cells: list[UtilityCell] = []
        for slot_index, unit in enumerate(self.base_allocation.units):
            for stat in SEARCHED_STATS:
                gains = [entry for entry in self.moves if _gains(entry.move, slot_index, stat)]
                best = max(gains, key=lambda entry: entry.deepest.expected_best_diff, default=None)
                cells.append(
                    UtilityCell(
                        slot_index=slot_index,
                        unit_definition_id=unit.unit_definition_id,
                        stat=stat,
                        entry=best,
                        at_limit=unit.count(stat) >= MAX_PIECES_PER_STAT,
                    )
                )
        return tuple(cells)


def _gains(move: Move, slot_index: int, stat: GearStat) -> bool:
    return move.slot_index == slot_index and move.gained_stat() == stat


def analyse(
    base: Allocation,
    moves: Sequence[Move],
    evaluator: SampleSource[Allocation],
    *,
    settings: SensitivitySettings,
    objective: Objective,
    seed: str,
) -> SensitivityResult:
    """篩い → 確定 → 確認走。各段の位相が使う乱数範囲は重ならない。"""
    screen_phase, confirm_phase, verify_phase = phases_for(settings)
    variants = [(move, applied) for move in moves if (applied := move.apply(base)) is not None]
    base_records: dict[str, CandidateRecord] = {}
    warnings: list[str] = []

    screened, base_records[SCREEN_PHASE_NAME] = _measure(
        base,
        variants,
        evaluator,
        phase=screen_phase,
        runs=settings.screen_runs,
        settings=settings,
        objective=objective,
        seed=seed,
        warnings=warnings,
    )
    entries = [
        MoveEntry(move=move, allocation=allocation, screen=diff)
        for (move, allocation), diff in screened
    ]

    survivors = _survivors(entries, settings)
    confirmed, base_records[CONFIRM_PHASE_NAME] = _measure(
        base,
        [(entry.move, entry.allocation) for entry in survivors],
        evaluator,
        phase=confirm_phase,
        runs=settings.confirm_runs,
        settings=settings,
        objective=objective,
        seed=seed,
        warnings=warnings,
    )
    # 篩いで落ちた手は `confirm` が `None` のまま残る。値を作らずに残すのは、
    # 「深く測って効果が無かった」と「浅い段で落とした」を区別するためである。
    by_move = {move.canonical_key(): diff for (move, _), diff in confirmed}
    entries = [replace(entry, confirm=by_move.get(entry.move.canonical_key())) for entry in entries]

    top = _top_moves(entries, settings)
    if not top:
        # 確定まで届いた手が1つも無い（期限で全滅した等）。基点だけを深く測っても
        # 比べる相手が居ないので、確認走の予算を使わずに終える。
        return SensitivityResult(
            base_allocation=base,
            moves=tuple(entries),
            top_moves=(),
            combined=None,
            base_records=base_records,
            warnings=tuple(warnings),
        )
    combined = _combine(base, [entry.move for entry in top])
    verified, base_records[VERIFY_PHASE_NAME] = _measure(
        base,
        [(entry.move, entry.allocation) for entry in top]
        + ([(None, combined[0])] if combined is not None else []),
        evaluator,
        phase=verify_phase,
        runs=settings.verify_runs,
        settings=settings,
        objective=objective,
        seed=seed,
        warnings=warnings,
    )
    verified_by_move = {
        move.canonical_key(): diff for (move, _), diff in verified if move is not None
    }
    entries = [
        replace(entry, verify=verified_by_move.get(entry.move.canonical_key())) for entry in entries
    ]
    by_key = {entry.move.canonical_key(): entry for entry in entries}
    top = tuple(by_key[entry.move.canonical_key()] for entry in top)

    combined_result = None
    if combined is not None:
        allocation, applied, skipped = combined
        combined_diff = next((diff for (move, _), diff in verified if move is None), None)
        if combined_diff is not None:
            combined_result = CombinedResult(
                allocation=allocation,
                applied=applied,
                skipped=skipped,
                difference=combined_diff,
            )
    return SensitivityResult(
        base_allocation=base,
        moves=tuple(entries),
        top_moves=top,
        combined=combined_result,
        base_records=base_records,
        warnings=tuple(warnings),
    )


def _measure(
    base: Allocation,
    variants: Sequence[tuple[Move | None, Allocation]],
    evaluator: SampleSource[Allocation],
    *,
    phase: EvaluationPhase,
    runs: int,
    settings: SensitivitySettings,
    objective: Objective,
    seed: str,
    warnings: list[str],
) -> tuple[list[tuple[tuple[Move | None, Allocation], PairedDiff]], CandidateRecord]:
    """基点と候補群を同じ位相・同じ試行数で評価し、ペア差を出す。"""
    records = evaluator.ensure(
        [base, *(allocation for _, allocation in variants)], runs, phase=phase
    )
    by_key = {record.candidate.canonical_key(): record for record in records}
    base_record = by_key[base.canonical_key()]
    measured: list[tuple[tuple[Move | None, Allocation], PairedDiff]] = []
    for move, allocation in variants:
        record = by_key[allocation.canonical_key()]
        pairs = min(runs, base_record.sample_count, record.sample_count)
        if pairs < 1:
            # 期限到達で1件も返らなかった候補。値を作らず、消えたことを報告する。
            warnings.append(
                f"{phase.name}: {_describe(move, allocation)} は完了した試行が0件で比べられない"
            )
            continue
        measured.append(
            (
                (move, allocation),
                paired_difference(
                    base_record,
                    record,
                    count=pairs,
                    objective=objective,
                    seed=f"{seed}#{phase.name}#{allocation.canonical_key()}",
                    bootstrap_samples=settings.bootstrap_samples,
                ),
            )
        )
    return measured, base_record


def _describe(move: Move | None, allocation: Allocation) -> str:
    return allocation.canonical_key() if move is None else f"{move.unit_definition_id} {move.label}"


def _survivors(entries: Sequence[MoveEntry], settings: SensitivitySettings) -> list[MoveEntry]:
    """確定へ通す手。足切りは緩くする。

    落とすのは**明確に悪い**手（平均のペア差の信頼区間が丸ごと0未満）だけである。有意で
    ないだけの手を切ると、稀な上振れで稼ぐ手——日次ベスト勝負では上位に立つべき手——が
    平均の物差しで系統的に消える。残す件数の頭打ちは予算の都合であって統計の判断ではない。
    """
    ordered = sorted(entries, key=lambda entry: entry.screen.mean_diff, reverse=True)
    plausible = [entry for entry in ordered if entry.screen.mean_ci_high >= 0.0]
    # 全部が明確に悪くても、最良の手だけは深く確かめる（基点が既に局所最適という結論も
    # 同じ強さで確かめる必要がある）。
    kept = plausible or ordered[: settings.survivors]
    return kept[: settings.survivors]


def _top_moves(entries: Sequence[MoveEntry], settings: SensitivitySettings) -> list[MoveEntry]:
    """確定の順位。期待日次ベスト＋保証値（`Objective.fitness`）で並べる。"""
    confirmed = [entry for entry in entries if entry.confirm is not None]
    ordered = sorted(confirmed, key=lambda entry: entry.confirm.fitness_diff, reverse=True)
    return ordered[: settings.top_moves]


def _combine(
    base: Allocation, moves: Sequence[Move]
) -> tuple[Allocation, tuple[Move, ...], tuple[Move, ...]] | None:
    """上位手を順に重ねる。重ねられなかった手は数え上げて返す。

    先の手が前提を崩すことがある（同じ駒を2度動かす手など）。黙って落とすと「k手を
    適用した」という報告が実際と食い違うので、適用できた手と落ちた手を分けて持つ。
    """
    if not moves:
        return None
    allocation = base
    applied: list[Move] = []
    skipped: list[Move] = []
    for move in moves:
        candidate = move.apply(allocation)
        if candidate is None:
            skipped.append(move)
            continue
        allocation = candidate
        applied.append(move)
    if not applied or allocation.canonical_key() == base.canonical_key():
        return None
    return allocation, tuple(applied), tuple(skipped)
