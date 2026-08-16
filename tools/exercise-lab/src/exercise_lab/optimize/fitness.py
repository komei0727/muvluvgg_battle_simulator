"""探索が最大化する量。平均と下振れ（分布の左裾）の複合で測る。

平均だけを最大化すると、ユニットの戦闘不能で稀に大きく崩れる編成を過大評価する——
崩壊する試行は少数なので平均をわずかしか下げないが、実際に引くと取り返しがつかない。
そこで経験CVaR（下位 `⌈αn⌉` 件の平均）を混ぜ、左裾の重い編成を沈める。

分散ペナルティ（`mean - k*σ`）を採らないのは、上振れも等しく罰するためである。
会心で伸びる編成と戦闘不能で崩れる編成が同じ扱いになり、罰したい側だけを狙えない。

CVaRの実効サンプル数は `n` ではなく `αn`（尾部の件数）であり、少ない試行数では
順位付けに使えない。どの評価段でCVaRを判定に使えるかは `cvar_is_reliable` が決める。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

# 探索設定YAMLの既定値。alphaを下げるほど尾部が細り、同じ試行数での推定が荒くなる。
DEFAULT_ALPHA = 0.2
# `lambda`（YAMLのキー名）と同じ量。平均へ掛ける重みであることを名前で示す。
DEFAULT_MEAN_WEIGHT = 0.5

# CVaRを選抜の判定に使うために要る尾部の件数。これを下回る段では平均で判定する。
# 純CVaRが標本の (1-α) を捨てるのと同じ理屈で、尾部が数件しかない段のCVaRは
# 上位候補の取り違えを生む。
MIN_RELIABLE_TAIL_SAMPLES = 10


def tail_size(count: int, *, alpha: float) -> int:
    """CVaRが平均する尾部の件数 `⌈αn⌉`。1件を下回らせない。

    0件にすると alpha を小さくしただけで CVaR が定義できなくなる。1件まで縮めば
    最悪値そのもの（`WorstCase`）になり、意味が連続して繋がる。
    """
    _reject_invalid_alpha(alpha)
    _reject_empty(count)
    return max(1, math.ceil(alpha * count))


def cvar(scores: Sequence[float], *, alpha: float) -> float:
    """経験CVaR。昇順の下位 `⌈αn⌉` 件の平均。

    小標本では下方バイアスを持つ（尾部が偶然浅いと過小評価される）。バイアスは件数が
    同じなら候補間でおおむね揃うため順位付けには使えるが、**件数の異なる候補同士を
    この値で比べてはいけない**。比較する候補の `n` を揃えるのは呼び出し側の責務である。
    """
    ordered = sorted(scores)
    size = tail_size(len(ordered), alpha=alpha)
    return sum(ordered[:size]) / size


def cvar_is_reliable(count: int, *, alpha: float) -> bool:
    """この試行数のCVaRを選抜の判定に使えるか。見るのは `n` ではなく尾部の件数。"""
    return tail_size(count, alpha=alpha) >= MIN_RELIABLE_TAIL_SAMPLES


@dataclass(frozen=True)
class RiskPolicy:
    """下振れをどれだけ罰するか。探索・レーシング・最終選抜が同じ物差しを共有する。"""

    alpha: float = DEFAULT_ALPHA
    mean_weight: float = DEFAULT_MEAN_WEIGHT

    def __post_init__(self) -> None:
        _reject_invalid_alpha(self.alpha)
        if not 0.0 <= self.mean_weight <= 1.0:
            raise ValueError(f"mean_weight は0以上1以下でなければならない（{self.mean_weight}）")

    def mean(self, scores: Sequence[float]) -> float:
        """尾部を見ない統計量。実効サンプル数がCVaRに足りない評価段で使う。"""
        _reject_empty(len(scores))
        return sum(scores) / len(scores)

    def cvar(self, scores: Sequence[float]) -> float:
        return cvar(scores, alpha=self.alpha)

    def fitness(self, scores: Sequence[float]) -> float:
        """`λ·mean + (1−λ)·CVaR_α`。

        純CVaR（`mean_weight=0`）にしないのが既定なのは、標本の (1-α) を捨てて
        「上振れへの盲目」を招くためである。平均と混ぜると、崩れにくさを見ながら
        伸びしろも拾える。
        """
        if self.mean_weight == 1.0:
            # 尾部を計算しない。alphaが何であれ結果は平均であり、
            # 尾部件数の下限（1件以上）を理由に落とす必要もない。
            return self.mean(scores)
        return self.mean_weight * self.mean(scores) + (1.0 - self.mean_weight) * self.cvar(scores)

    def tail_size(self, count: int) -> int:
        return tail_size(count, alpha=self.alpha)

    def cvar_is_reliable(self, count: int) -> bool:
        return cvar_is_reliable(count, alpha=self.alpha)


def _reject_invalid_alpha(alpha: float) -> None:
    if not 0.0 < alpha <= 1.0:
        raise ValueError(f"alpha は0より大きく1以下でなければならない（{alpha}）")


def _reject_empty(count: int) -> None:
    if count <= 0:
        raise ValueError("適応度を出すには1件以上のスコアが要る")
