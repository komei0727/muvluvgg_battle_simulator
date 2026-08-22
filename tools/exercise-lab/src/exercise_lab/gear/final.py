"""最終選抜。探索が1回も使っていない乱数範囲で、到達した配分を並べ直す。

探索は反復をまたいで同じ位相を使い回す——前の反復で測った配分が次の反復の基点になるので、
キャッシュがそのまま効いて基点の評価を払い直さずに済む。その代償として、**探索の順位は
その乱数範囲への過適合を含む**。同じ乱数列で選び直すと「その乱数列にたまたま強かった
配分」をそのまま理論値として報告することになる。

そこで確定は別の位相で行う。位相の重なりは `Evaluator.validate_phases` が拒むので、
範囲が離れていることは実行時に確かめられる（`optimize/evaluator.py`）。

候補は**署名ごとのベスト**である。同じレジームの中の細かい差は探索が既に潰しており、
残っているのは「どのレジームで戦うか」の選択である。同一乱数列でスコア列が完全に一致した
配分は1件へ畳む（`collapse_equivalent`）——共通乱数法のもとで列が一致するなら、その2つは
戦闘の上で同じ配分であり、別々に数えると上位の枠が実質同じ答えで埋まる。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..optimize.evaluator import EvaluationPhase
from ..optimize.fitness import Objective
from ..optimize.racing import RacedCandidate, plan_stages, select_top_k
from .allocation import Allocation
from .search import BudgetedSampleSource, ClimbSettings, phases_for_climb

FINAL_PHASE_NAME = "plan-final"

# 1件でも回す。到達した署名が1通りしか無い実行でも、報告する配分は**探索が使っていない
# 乱数範囲で測り直した値**でなければならない——探索の位相で出した値はその範囲への過適合を
# 含んでおり、そのまま報告すると理論値が実際より高く見える。
MIN_FINAL_POOL = 1

NO_BUDGET_WARNING = (
    "予算の残りが足りず、最終選抜を行えなかった。報告した配分は探索と同じ乱数範囲で"
    "選んだものであり、その範囲への過適合を含む（--budget を増やすか --final-runs を下げる）"
)


@dataclass(frozen=True)
class FinalSelectionSettings:
    """最終選抜へ送る候補数と、そこで積む試行数。"""

    pool: int = 8
    runs: int = 100


@dataclass(frozen=True)
class FinalSelection:
    """最終選抜の結果。候補が1件も測れなかった実行では空になる。"""

    entries: tuple[RacedCandidate[Allocation], ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def best(self) -> Allocation | None:
        return self.entries[0].candidate if self.entries else None


def final_phase(climb: ClimbSettings, settings: FinalSelectionSettings) -> EvaluationPhase:
    """最終選抜の位相。探索が使い切った通し試行番号の先から始める。"""
    _, confirm = phases_for_climb(climb)
    return EvaluationPhase(
        name=FINAL_PHASE_NAME,
        checkpoints=(settings.runs,),
        seed_offset=confirm.span.stop,
    )


def final_selection_cost(settings: FinalSelectionSettings) -> int:
    """最終選抜が使う試行数。予算から先に取り置く量である。

    1段で回すので、候補数×試行数がそのまま額になる。段を刻んで浅い段で篩うこともできるが、
    候補は署名ごとに1件しか残っていない（既定8件）ので、篩う相手がそもそも居ない。
    """
    return settings.pool * settings.runs


def signature_bests(
    observations: Sequence,
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    objective: Objective,
    required: Allocation,
    limit: int,
) -> tuple[Allocation, ...]:
    """署名ごとのベストを、最終選抜へ送る順に並べる。**新しい評価は発行しない。**

    順位は探索の確定段の履歴から作る。ここで測り直すと、最終選抜のために取り置いた予算を
    候補選びで使ってしまう。試行数の違う配分が混ざるので順位は目安だが、確定は最終選抜が
    別の乱数範囲でやり直す——ここで要るのは「どの署名を土俵に上げるか」だけである。

    探索が確定段まで測らなかった配分は入れない（押しの途中で通り過ぎただけの点が該当
    する）。比べる材料が無いまま枠を埋めると、実測された署名が押し出される。
    """
    _, confirm = phases_for_climb(climb)
    best: dict[str, tuple[float, Allocation]] = {}
    for entry in observations:
        record = evaluator.record_for(entry.allocation, confirm)
        if record is None or record.sample_count < 1:
            continue
        fitness = objective.fitness(record.scores)
        digest = entry.signature.digest()
        current = best.get(digest)
        if current is None or fitness > current[0]:
            best[digest] = (fitness, entry.allocation)

    # 適応度の降順。同点は正準キーで固定し、同じ入力から常に同じ並びを出す。
    ranked = sorted(best.values(), key=lambda entry: (-entry[0], entry[1].canonical_key()))
    ordered = [required, *(allocation for _, allocation in ranked)]
    unique: list[Allocation] = []
    seen: set[str] = set()
    for allocation in ordered:
        key = allocation.canonical_key()
        if key in seen:
            continue
        seen.add(key)
        unique.append(allocation)
    return tuple(unique[:limit])


def select_final(
    candidates: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    objective: Objective,
    settings: FinalSelectionSettings,
    climb: ClimbSettings,
    budget_runs: int,
) -> FinalSelection:
    """別の乱数範囲で候補を測り直し、順位を付けて返す。"""
    phase = final_phase(climb, settings)
    affordable = max(0, (budget_runs - evaluator.consumed_runs) // settings.runs)
    pool = list(candidates)[:affordable]
    if len(pool) < MIN_FINAL_POOL:
        return FinalSelection(warnings=(NO_BUDGET_WARNING,))
    warnings: list[str] = []
    if len(pool) < len(candidates):
        warnings.append(
            f"予算の残りが足りず、最終選抜の候補 {len(candidates) - len(pool)} 件を落とした"
        )
    entries = select_top_k(
        pool,
        evaluator,
        policy=objective,
        stages=plan_stages((settings.runs,), objective),
        phase=phase,
        k=len(pool),
    )
    return FinalSelection(entries=tuple(entries), warnings=tuple(dict.fromkeys(warnings)))
