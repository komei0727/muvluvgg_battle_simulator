"""ギア配分の型と制約検証。

配分は「ユニット → ステータス別の枚数とランク」で持つ。**9つの枠は区別しない** ——
同じ種別・ランクのギアはどの枠に挿さっていても戦闘の結果が同じであり、枠を区別すると
同じ構成へ二重に予算を払うことになる。正準キーもこの前提に立つ。

制約（`R-ENH-04` #1/#6）はAPI側でも422として効くが、ここでも同じ規則を持って**送信前に
落とす**。数千件の近傍を投げてから422で返されると、どの手が実在しない構成だったのかを
応答から数え直すことになる。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import get_args

from ..models import MAX_GEARS, Gear, GearGrade, GearStat, GearTier

# 探索対象のステータス。ダメージと順位へ効く5種に限る。
SEARCHED_STATS: tuple[GearStat, ...] = (
    "ATTACK",
    "ACTION_SPEED",
    "CRITICAL_RATE",
    "CRITICAL_DAMAGE_BONUS",
    "AFFINITY_BONUS",
)
# 探索対象外。スコアは与ダメージで決まり、HP・防御は生存を通してしか効かない——
# 基点編成が敗北しない限り限界効用がほぼ0になり、1手の差を見るには分散が大きすぎる。
# 既に挿さっている枚数は動かさずそのまま送る（9枠を占めることは配分へ効く）。
EXCLUDED_STATS: tuple[GearStat, ...] = ("MAXIMUM_HP", "DEFENSE")

# `R-ENH-04` #6: 同一の対象ステータスは最大3個。#1: 1ユニット最大9個。
MAX_PIECES_PER_STAT = 3
MAX_PIECES_PER_UNIT = MAX_GEARS

TIERS: tuple[GearTier, ...] = get_args(GearTier)
GRADES: tuple[GearGrade, ...] = get_args(GearGrade)

_STAT_ORDER = {stat: index for index, stat in enumerate((*SEARCHED_STATS, *EXCLUDED_STATS))}
_TIER_ORDER = {tier: index for index, tier in enumerate(TIERS)}
_GRADE_ORDER = {grade: index for index, grade in enumerate(GRADES)}


class GearAllocationError(Exception):
    """配分が契約から外れている。評価を1件も投げる前に落とす。"""


@dataclass(frozen=True)
class GearRank:
    """ギア1枚の種別とランク。対象ステータスを持たない「単価」の側。"""

    tier: GearTier
    grade: GearGrade

    @property
    def label(self) -> str:
        return f"{self.tier}-{self.grade}"

    def with_stat(self, stat: GearStat) -> GearPiece:
        return GearPiece(stat=stat, tier=self.tier, grade=self.grade)

    def sort_key(self) -> tuple[int, int]:
        return (_TIER_ORDER[self.tier], _GRADE_ORDER[self.grade])


ALL_RANKS: tuple[GearRank, ...] = tuple(
    GearRank(tier=tier, grade=grade) for tier in TIERS for grade in GRADES
)
# 追加の手（`add`）が挿す1枚の既定。ステータス間を同じ単価で比べるための基準であり、
# 「次に狙う1枚」としては最上位を仮定する。`--add-rank` で下げられる。
DEFAULT_ADD_RANK = GearRank(tier="III", grade="S")


@dataclass(frozen=True)
class GearPiece:
    """ギア1枚。挿さっている枠は持たない（枠は結果を変えないため）。"""

    stat: GearStat
    tier: GearTier
    grade: GearGrade

    def __post_init__(self) -> None:
        if self.stat not in _STAT_ORDER:
            raise GearAllocationError(f"未知の対象ステータス: {self.stat}")
        if self.tier not in _TIER_ORDER:
            raise GearAllocationError(f"未知の種別: {self.tier}")
        if self.grade not in _GRADE_ORDER:
            raise GearAllocationError(f"未知のランク: {self.grade}")

    @property
    def rank(self) -> GearRank:
        return GearRank(tier=self.tier, grade=self.grade)

    @property
    def label(self) -> str:
        return f"{self.stat}:{self.tier}-{self.grade}"

    def to_gear(self) -> Gear:
        return Gear.model_construct(stat=self.stat, tier=self.tier, grade=self.grade)

    def sort_key(self) -> tuple[int, int, int]:
        return (_STAT_ORDER[self.stat], _TIER_ORDER[self.tier], _GRADE_ORDER[self.grade])


def piece_from_gear(gear: Gear) -> GearPiece:
    return GearPiece(stat=gear.stat, tier=gear.tier, grade=gear.grade)


def rank_from_label(label: str) -> GearRank:
    """`II-C` 形式の指定をランクへ直す。CLIオプションの入口。"""
    for rank in ALL_RANKS:
        if rank.label == label:
            return rank
    raise GearAllocationError(
        f"未知のギアランク: {label}（{', '.join(rank.label for rank in ALL_RANKS)} のいずれか）"
    )


@dataclass(frozen=True)
class UnitAllocation:
    """1ユニットぶんの配分。枠を区別しないので、駒は常に正準順へ並べ替えて持つ。"""

    unit_definition_id: str
    pieces: tuple[GearPiece, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "pieces", tuple(sorted(self.pieces, key=GearPiece.sort_key)))

    @property
    def total(self) -> int:
        return len(self.pieces)

    def count(self, stat: GearStat) -> int:
        return sum(1 for piece in self.pieces if piece.stat == stat)

    def counts(self) -> dict[GearStat, int]:
        return {stat: self.count(stat) for stat in (*SEARCHED_STATS, *EXCLUDED_STATS)}

    def distinct_pieces(self) -> tuple[GearPiece, ...]:
        """種類ごとに1つだけ。同じ駒が2枚挿さっていても手は1つである。"""
        seen: list[GearPiece] = []
        for piece in self.pieces:
            if piece not in seen:
                seen.append(piece)
        return tuple(seen)

    def replaced(self, *, removed: GearPiece | None, added: GearPiece | None) -> UnitAllocation:
        """1枚を外して1枚を挿した配分。どちらも省略できる（`add` / `remove`）。"""
        pieces = list(self.pieces)
        if removed is not None:
            if removed not in pieces:
                raise GearAllocationError(
                    f"{self.unit_definition_id} は {removed.label} を持たない"
                )
            pieces.remove(removed)
        if added is not None:
            pieces.append(added)
        return UnitAllocation(unit_definition_id=self.unit_definition_id, pieces=tuple(pieces))

    def canonical_key(self) -> str:
        return f"{self.unit_definition_id}[{','.join(piece.label for piece in self.pieces)}]"

    def to_gears(self) -> list[Gear]:
        return [piece.to_gear() for piece in self.pieces]

    def violations(self, *, slot_index: int) -> list[str]:
        found: list[str] = []
        where = f"units[{slot_index}] {self.unit_definition_id}"
        if self.total > MAX_PIECES_PER_UNIT:
            found.append(
                f"{where}: ギアが{self.total}枚で上限{MAX_PIECES_PER_UNIT}枚を超える（R-ENH-04 #1）"
            )
        for stat, count in self.counts().items():
            if count > MAX_PIECES_PER_STAT:
                found.append(
                    f"{where}: {stat} が{count}枚で上限{MAX_PIECES_PER_STAT}枚を超える"
                    "（R-ENH-04 #6）"
                )
        return found


@dataclass(frozen=True)
class Allocation:
    """編成全体の配分。索引は基点編成の `allyFormation.units` の並びと同じ。

    同じユニットを2マスへ置ける（`allowDuplicateUnits`）以上、枠はIDでは特定できない。
    索引を鍵にしておかないと、2枠のうちどちらへ挿した手なのかが正準キーから消える。
    """

    units: tuple[UnitAllocation, ...] = field(default_factory=tuple)

    def canonical_key(self) -> str:
        return "|".join(f"{index}:{unit.canonical_key()}" for index, unit in enumerate(self.units))

    def with_unit(self, slot_index: int, unit: UnitAllocation) -> Allocation:
        units = list(self.units)
        units[slot_index] = unit
        return Allocation(units=tuple(units))

    def violations(self) -> list[str]:
        return [
            violation
            for index, unit in enumerate(self.units)
            for violation in unit.violations(slot_index=index)
        ]

    def total(self) -> int:
        return sum(unit.total for unit in self.units)


def build_allocation(units: Iterable[tuple[str, Sequence[Gear]]]) -> Allocation:
    """`(unitDefinitionId, gears)` の並びから配分を組む。編成順を索引にする。"""
    return Allocation(
        units=tuple(
            UnitAllocation(
                unit_definition_id=unit_definition_id,
                pieces=tuple(piece_from_gear(gear) for gear in gears),
            )
            for unit_definition_id, gears in units
        )
    )
