"""保存済みの観測値を確かめるための記述統計（標準ライブラリだけで計算する）。

評価実行の `summarize` / `export` が使う。順位づけ・採否・目的関数は持たない。

定義:

- 分位点は線形補間（標本を昇順に並べ、位置 `(n-1)×p` を前後の値で補間する）。`numpy.percentile`
  の既定・`statistics.quantiles(method="inclusive")` と同じ定義で、UIの統計（`descriptive.py`）とも
  一致する。表示する分位点は 5・25・75・95%。
- 標準偏差は不偏分散（n−1）の平方根。標本1件では定義できないので `None`。
- 比率の分母は、そのケースの完了した固有試行数。未完了・失敗した試行は分母にも分子にも入れない。
- 標本0件のときは関数を呼ばない（呼ぶと `ValueError`）。0で埋めた統計量を作らない。
"""

from __future__ import annotations

import math
import statistics
from collections import Counter
from collections.abc import Hashable, Sequence
from dataclasses import dataclass
from typing import Any

QUANTILES = (0.05, 0.25, 0.75, 0.95)


@dataclass(frozen=True)
class NumericSummary:
    count: int
    mean: float
    median: float
    stdev: float | None
    minimum: float
    maximum: float
    p05: float
    p25: float
    p75: float
    p95: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "count": self.count,
            "mean": self.mean,
            "median": self.median,
            "stdev": self.stdev,
            "min": self.minimum,
            "max": self.maximum,
            "p05": self.p05,
            "p25": self.p25,
            "p75": self.p75,
            "p95": self.p95,
        }


def quantile(sorted_values: Sequence[float], p: float) -> float:
    if not sorted_values:
        raise ValueError("分位点を出すには1件以上の値が要る")
    position = (len(sorted_values) - 1) * p
    lower = math.floor(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return float(sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * weight)


def numeric_summary(values: Sequence[float]) -> NumericSummary:
    if len(values) == 0:
        raise ValueError("統計を出すには1件以上の値が要る")
    ordered = sorted(float(v) for v in values)
    p05, p25, p75, p95 = (quantile(ordered, p) for p in QUANTILES)
    return NumericSummary(
        count=len(ordered),
        mean=statistics.fmean(ordered),
        median=quantile(ordered, 0.5),
        stdev=statistics.stdev(ordered) if len(ordered) >= 2 else None,
        minimum=ordered[0],
        maximum=ordered[-1],
        p05=p05,
        p25=p25,
        p75=p75,
        p95=p95,
    )


def category_counts(
    values: Sequence[Hashable], categories: Sequence[Hashable] = ()
) -> dict[str, dict[str, Any]]:
    """カテゴリごとの件数と比率。`categories` に挙げたものは0件でも載せる（載っていない
    ＝起こらなかった、を読み手に推測させない）。それ以外に現れた値も後ろへ足す。"""
    if len(values) == 0:
        raise ValueError("比率を出すには1件以上の値が要る")
    counter = Counter(values)
    order = list(categories) + sorted(
        (v for v in counter if v not in categories), key=lambda v: str(v)
    )
    return {
        str(value): {"count": counter[value], "ratio": counter[value] / len(values)}
        for value in order
    }


def frequency(values: Sequence[int]) -> list[dict[str, Any]]:
    """値ごとの件数と比率（値の昇順）。ターン数・撃破数のような離散値の分布に使う。"""
    if len(values) == 0:
        raise ValueError("分布を出すには1件以上の値が要る")
    counter = Counter(values)
    return [
        {"value": value, "count": counter[value], "ratio": counter[value] / len(values)}
        for value in sorted(counter)
    ]
