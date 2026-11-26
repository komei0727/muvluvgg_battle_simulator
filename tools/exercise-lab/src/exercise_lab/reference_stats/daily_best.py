"""日次ベスト指標。「1日k回挑戦してベストで競う」形式の成績を、1試行の標本から推定する。

UIの `daily-best.ts` はこの関数群の移植であり、両者の一致は
`scripts/export_ui_parity_fixture.py` が書き出すfixtureで検証する。

スコアアタックは1日k回（既定5回）挑戦でき、その日の成績は最大値で決まる。期待日次
ベストは順序統計量の重み付き和で不偏推定できる。n個の標本からランダムにk個引いたときの
最大値が昇順 i 番目になる確率は C(i-1, k-1)/C(n, k) なので

    E[best-of-k] = Σ_i C(i-1, k-1)/C(n, k) · x_(i)

日次ベストの分位点は閉形式で1試行分布へ写る: P(日次ベスト ≤ x) = F(x)^k より、
日次ベストの q 分位点 = 1試行スコアの q^(1/k) 分位点。

重みが上位の標本へ集中するため、実効サンプル数は n ではなくおよそ n(2k-1)/k²
（k=5 で n の約36%）。
"""

from __future__ import annotations

import math
from collections.abc import Sequence

# スコアアタックの1日の挑戦回数。
DEFAULT_BEST_OF = 5

# 値そのものを信用してよいとみなす実効サンプル数。これを下回る試行数の値は
# 上位数標本への依存が強く、順位付けには使えても値そのものは信用できない。
MIN_RELIABLE_EFFECTIVE_SAMPLES = 10


def expected_best(scores: Sequence[float], *, best_of: int) -> float:
    """期待日次ベスト（n標本からk個引いたときの最大値の期待値、不偏）。

    n < k の部分結果では標本の最大値へ落とす。復元なしに k 個引けない以上この推定量は
    定義できず、最大値は低めに偏るが、表示の入力としては壊れない。

    順序統計量ベースの推定量は小標本で偏るため、**件数の異なる標本同士をこの値で
    比べてはいけない**。
    """
    _reject_invalid_best_of(best_of)
    _reject_empty(len(scores))
    ordered = sorted(scores)
    count = len(ordered)
    if count < best_of:
        return float(ordered[-1])
    total = math.comb(count, best_of)
    # C(i-1, k-1) は i < k で0になるので、下位の標本は自然に重み0で消える。
    return sum(math.comb(index, best_of - 1) * value for index, value in enumerate(ordered)) / total


def best_quantile(scores: Sequence[float], *, best_of: int, quantile: float) -> float:
    """日次ベストの q 分位点。1試行分布の q^(1/k) 分位点として引く（線形補間）。"""
    _reject_invalid_best_of(best_of)
    _reject_empty(len(scores))
    if not 0.0 < quantile < 1.0:
        raise ValueError(f"quantile は0より大きく1未満でなければならない（{quantile}）")
    ordered = sorted(scores)
    level = quantile ** (1.0 / best_of)
    position = level * (len(ordered) - 1)
    low = math.floor(position)
    fraction = position - low
    if low + 1 >= len(ordered):
        return float(ordered[-1])
    return ordered[low] + fraction * (ordered[low + 1] - ordered[low])


def effective_samples(count: int, *, best_of: int) -> float:
    """この試行数が持つ実効サンプル数 ≈ n(2k-1)/k²（連続近似）。

    重みが上位2割前後へ集中するため、n をそのまま信頼度として読むと過大評価になる。
    """
    _reject_invalid_best_of(best_of)
    return count * (2 * best_of - 1) / (best_of**2)


def is_reliable(count: int, *, best_of: int) -> bool:
    return effective_samples(count, best_of=best_of) >= MIN_RELIABLE_EFFECTIVE_SAMPLES


def _reject_invalid_best_of(best_of: int) -> None:
    if best_of < 1:
        raise ValueError(f"best_of は1以上でなければならない（{best_of}）")


def _reject_empty(count: int) -> None:
    if count <= 0:
        raise ValueError("日次ベスト指標を出すには1件以上のスコアが要る")
