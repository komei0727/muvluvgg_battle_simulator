"""探索が最大化する量。「1日k回挑戦してベストで競う」形式に合わせ、期待日次ベストで測る。

スコアアタックは1日k回（既定5回）挑戦でき、その日の成績は最大値で決まる。したがって
最大化すべきは平均ではなく **E[k回中のベスト]** である。平均を使うと向きが2つ狂う——
会心で伸びる上振れ（ベスト勝負では資産）が評価されず、稀な崩壊（k回中1回無駄になる
だけで、全滅は p^k でしか起きない）を実際以上に恐れることになる。

期待日次ベストは順序統計量の重み付き和で不偏推定できる。n個の標本からランダムに
k個引いたときの最大値が昇順 i 番目になる確率は C(i-1, k-1)/C(n, k) なので

    E[best-of-k] = Σ_i C(i-1, k-1)/C(n, k) · x_(i)

日次ベストの分位点は閉形式で1試行分布へ写る: P(日次ベスト ≤ x) = F(x)^k より、
日次ベストの q 分位点 = 1試行スコアの q^(1/k) 分位点。「悪い日でもこれ以上は出る」
保証値として適応度へ混ぜ、ごく稀な外れ値1本で期待値が吊り上がる編成への防波堤にする。

重みが上位の標本へ集中するため、実効サンプル数は n ではなくおよそ n(2k-1)/k²
（k=5 で n の約36%）。少ない試行数では順位が雑音になるので、どの評価段でこの適応度を
判定へ使えるかは `is_reliable` / レーシング側の閾値が決める。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

# 探索設定YAMLの既定値。bestOf はスコアアタックの1日の挑戦回数。
DEFAULT_BEST_OF = 5
# `lambda`（YAMLのキー名）と同じ量。期待日次ベストへ掛ける重みであることを名前で示す。
DEFAULT_EXPECTED_WEIGHT = 0.5
# 保証値に使う日次ベストの下側分位点。0.25 なら「4日に3日はこれ以上出る」。
DEFAULT_GUARD_QUANTILE = 0.25

# 適応度を最終結果の報告に使うために要る実効サンプル数。これを下回る試行数の値は
# 上位数標本への依存が強く、順位付けには使えても値そのものは信用できない。
MIN_RELIABLE_EFFECTIVE_SAMPLES = 10


def expected_best(scores: Sequence[float], *, best_of: int) -> float:
    """期待日次ベスト（n標本からk個引いたときの最大値の期待値、不偏）。

    n < k の部分結果では標本の最大値へ落とす。復元なしに k 個引けない以上この推定量は
    定義できず、最大値は低めに偏るが、順位付けの入力としては壊れない。

    順序統計量ベースの推定量は小標本で偏るため、**件数の異なる候補同士をこの値で
    比べてはいけない**。比較する候補の n を揃えるのは呼び出し側の責務である。
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


@dataclass(frozen=True)
class Objective:
    """何を最大化するか。探索・レーシング・最終選抜が同じ物差しを共有する。"""

    best_of: int = DEFAULT_BEST_OF
    expected_weight: float = DEFAULT_EXPECTED_WEIGHT
    guard_quantile: float = DEFAULT_GUARD_QUANTILE

    def __post_init__(self) -> None:
        _reject_invalid_best_of(self.best_of)
        if not 0.0 <= self.expected_weight <= 1.0:
            raise ValueError(
                f"expected_weight は0以上1以下でなければならない（{self.expected_weight}）"
            )
        if not 0.0 < self.guard_quantile < 1.0:
            raise ValueError(
                f"guard_quantile は0より大きく1未満でなければならない（{self.guard_quantile}）"
            )

    def mean(self, scores: Sequence[float]) -> float:
        _reject_empty(len(scores))
        return sum(scores) / len(scores)

    def median(self, scores: Sequence[float]) -> float:
        """実効サンプル数が足りない評価段の足切りに使う統計量。

        平均を使わないのは、稀な崩壊が平均を線形に引き下げるためである。日次ベスト勝負
        では崩壊のコストはほぼ消える（全滅は p^k）ので、平均で篩うと「たまに崩れるが
        天井の高い編成」を浅い段で系統的に殺してしまう。中央値は崩壊率が5割を下回る限り
        下振れに動かされず、目的関数と足切りの向きが揃う。
        """
        _reject_empty(len(scores))
        ordered = sorted(scores)
        position = 0.5 * (len(ordered) - 1)
        low = math.floor(position)
        fraction = position - low
        if low + 1 >= len(ordered):
            return float(ordered[-1])
        return ordered[low] + fraction * (ordered[low + 1] - ordered[low])

    def expected_best(self, scores: Sequence[float]) -> float:
        return expected_best(scores, best_of=self.best_of)

    def guard(self, scores: Sequence[float]) -> float:
        """悪い日の保証値。日次ベストの `guard_quantile` 分位点。"""
        return best_quantile(scores, best_of=self.best_of, quantile=self.guard_quantile)

    def median_best(self, scores: Sequence[float]) -> float:
        """日次ベストの中央値（k=5 なら1試行分布の約p87）。レポートで使う。"""
        return best_quantile(scores, best_of=self.best_of, quantile=0.5)

    def fitness(self, scores: Sequence[float]) -> float:
        """`λ·E[best-of-k] + (1−λ)·保証値`。

        期待値だけにしないのが既定なのは、順序統計量の重みが最上位の標本に k/n 掛かる
        ためである。ごく稀な外れ値1本で期待値が吊り上がった編成を、より頑健な分位点が
        引き戻す。λ=1 にすれば純粋な期待日次ベストになる。
        """
        if self.expected_weight == 1.0:
            return self.expected_best(scores)
        return self.expected_weight * self.expected_best(scores) + (
            1.0 - self.expected_weight
        ) * self.guard(scores)

    def effective_samples(self, count: int) -> float:
        return effective_samples(count, best_of=self.best_of)

    def is_reliable(self, count: int) -> bool:
        """この試行数の適応度を最終結果として報告してよいか。"""
        return self.effective_samples(count) >= MIN_RELIABLE_EFFECTIVE_SAMPLES


def _reject_invalid_best_of(best_of: int) -> None:
    if best_of < 1:
        raise ValueError(f"best_of は1以上でなければならない（{best_of}）")


def _reject_empty(count: int) -> None:
    if count <= 0:
        raise ValueError("適応度を出すには1件以上のスコアが要る")
