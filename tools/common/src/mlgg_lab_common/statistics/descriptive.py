"""試行ごとの生値から出す記述統計。

サーバーは統計量を返さない（`10_API設計.md`「TacticalExerciseCandidateEvaluationResponse」、
Q-TEX-16。大量試行APIも試行ごとの値だけを返す）。戦闘形式には依らない。UIの
`descriptive-statistics.ts` はこの関数群の移植であり、両者の一致は
`tools/exercise-lab/scripts/export_ui_parity_fixture.py` が書き出すfixtureで検証する。
定義・数値計算法を変えるときは、UI側の移植とfixtureを同時に更新する。
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

# 平均の信頼区間は正規近似で出す。t分布を使わないのは依存（scipy）を増やさないためで、
# 想定する試行数（数百〜数千）では両者の差が表示桁に出ない。
CONFIDENCE_LEVEL = 0.95
NORMAL_QUANTILE_95 = 1.959963984540054

ALLY_DEFEATED = "ALLY_DEFEATED"

# ヒストグラムのビン数の上限。
MAX_HISTOGRAM_BINS = 60


@dataclass(frozen=True)
class ScoreSummary:
    count: int
    mean: float
    median: float
    # 試行1回では散らばりが定義できないため `None` にする。0を返すと
    # 「ばらつきが無い」という別の意味になる。
    stdev: float | None
    minimum: int
    maximum: int
    p05: float
    p25: float
    p75: float
    p95: float
    ci_low: float | None
    ci_high: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize_scores(scores: Sequence[int]) -> ScoreSummary:
    if len(scores) == 0:
        raise ValueError("統計を出すには1件以上のスコアが要る")
    values = np.asarray(scores, dtype=np.float64)
    mean = float(values.mean())
    stdev = float(values.std(ddof=1)) if len(scores) >= 2 else None
    half_width = None if stdev is None else NORMAL_QUANTILE_95 * stdev / float(np.sqrt(len(scores)))
    p05, p25, p75, p95 = (float(value) for value in np.percentile(values, [5, 25, 75, 95]))
    return ScoreSummary(
        count=len(scores),
        mean=mean,
        median=float(np.median(values)),
        stdev=stdev,
        minimum=int(min(scores)),
        maximum=int(max(scores)),
        p05=p05,
        p25=p25,
        p75=p75,
        p95=p95,
        ci_low=None if half_width is None else mean - half_width,
        ci_high=None if half_width is None else mean + half_width,
    )


def defeat_rate(completion_reasons: Sequence[str]) -> float:
    """`ALLY_DEFEATED` で終わった試行の割合。規定ターンを走り切れない編成を弾くための指標。"""
    if len(completion_reasons) == 0:
        raise ValueError("敗北率を出すには1件以上の完了理由が要る")
    defeated = sum(1 for reason in completion_reasons if reason == ALLY_DEFEATED)
    return defeated / len(completion_reasons)


def break_count_distribution(break_counts: Sequence[int]) -> dict[int, int]:
    """ブレイク回数ごとの試行数。回数の昇順で返し、表示側の並べ替えに依存させない。"""
    counter = Counter(break_counts)
    return {count: counter[count] for count in sorted(counter)}


def histogram_bin_count(scores: Sequence[int]) -> int:
    """試行数からビン数を決める（Sturges）。試行数だけで決まるので、同じ入力なら
    同じ図になる。"""
    return max(1, min(MAX_HISTOGRAM_BINS, int(np.ceil(np.log2(len(scores)) + 1))))
