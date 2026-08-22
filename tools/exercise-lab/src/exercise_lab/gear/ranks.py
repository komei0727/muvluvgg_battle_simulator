"""ギアランクの梯子。「1段下げる」を補正値の昇順で定義する。

種別とランクの字面（Ⅱ-D…Ⅱ-S、Ⅲ-D…Ⅲ-S）は補正値の順ではない。攻撃力なら昇順は
0.75 / 1.0 / 1.18 / 1.58 / 1.62 / 2.06 / 2.16 / 2.49 / 2.75 / 3.33 であり、Ⅲ-C の1つ上は
Ⅲ-B ではなく **Ⅱ-B**（差 0.04pt）である。順位の境界を刻むにはこの並びが要る。

**並びはステータスごとに違う。** 攻撃力は Ⅱ-B(1.62) > Ⅲ-C(1.58) だが、会心率は
Ⅱ-B(3.59) > Ⅲ-C(3.5) と間隔が別で、会心ダメージ・属性相性はさらに別である
（`R-ENH-04` #3）。1つの並びを全ステータスへ流用すると、下げたつもりで上げる手が出る。

**表はCatalog APIから取る**（`gearEffects`）。Python側へ写すと、表を直したときに
片方だけ古いまま「1段下」を計算し続ける。値の正本はDomainの1つに保つ。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..api import Catalog
from ..models import GearStat
from .allocation import GearPiece, GearRank


@dataclass(frozen=True)
class RankValue:
    """梯子の1段。ランクと、その補正値（パーセントポイント）。"""

    rank: GearRank
    points: float


@dataclass(frozen=True)
class RankStep:
    """隣り合う2段。`higher` から `lower` へ落とすのが1段下げる手である。"""

    stat: GearStat
    lower: GearRank
    higher: GearRank
    points_delta: float

    @property
    def label(self) -> str:
        """単価表の見出し。**上げる向き**で書く（在庫を挿す側の問いに合わせる）。"""
        return f"{self.lower.label} → {self.higher.label}"


@dataclass(frozen=True)
class RankLadder:
    """ステータス → 補正値の昇順に並べたランク。"""

    rungs: Mapping[GearStat, tuple[RankValue, ...]] = field(default_factory=dict)

    def is_empty(self) -> bool:
        return not any(self.rungs.values())

    def ranks(self, stat: GearStat) -> tuple[GearRank, ...]:
        return tuple(value.rank for value in self.rungs.get(stat, ()))

    def points(self, stat: GearStat, rank: GearRank) -> float | None:
        return next(
            (value.points for value in self.rungs.get(stat, ()) if value.rank == rank), None
        )

    def one_lower(self, stat: GearStat, rank: GearRank) -> GearRank | None:
        """1つ下の段。最下段と、表に無いランク・ステータスでは `None`。"""
        rungs = self.rungs.get(stat, ())
        index = next((i for i, value in enumerate(rungs) if value.rank == rank), None)
        if index is None or index == 0:
            return None
        return rungs[index - 1].rank

    def step_down(self, piece: GearPiece) -> RankStep | None:
        """この駒を1段下げる手。梯子の外なら `None`。"""
        lower = self.one_lower(piece.stat, piece.rank)
        if lower is None:
            return None
        higher_points = self.points(piece.stat, piece.rank)
        lower_points = self.points(piece.stat, lower)
        assert higher_points is not None and lower_points is not None
        return RankStep(
            stat=piece.stat,
            lower=lower,
            higher=piece.rank,
            points_delta=higher_points - lower_points,
        )


EMPTY_LADDER = RankLadder()


def rank_ladder_from_catalog(catalog: Catalog) -> RankLadder:
    """Catalog の効果表を梯子へ直す。

    同点は起こらない前提だが、起こっても並びが揺れないよう種別・ランクの字面順を
    第2キーに置く（同じCatalogから常に同じ梯子が出る）。
    """
    return RankLadder(
        rungs={
            effect.stat: tuple(
                sorted(
                    (
                        RankValue(
                            rank=GearRank(tier=value.tier, grade=value.grade),
                            points=value.percentage_points,
                        )
                        for value in effect.values
                    ),
                    key=lambda value: (value.points, value.rank.sort_key()),
                )
            )
            for effect in catalog.gear_effects
        }
    )
