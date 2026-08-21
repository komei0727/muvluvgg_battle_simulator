"""ギア配分の1手近傍。

手は4種類ある。

| 手       | 内容                                                     |
| -------- | -------------------------------------------------------- |
| `move`   | 1枚のステータスを別ステータスへ移す（移動先が3枚未満）   |
| `add`    | 空枠へ1枚追加する                                        |
| `remove` | 1枚外す                                                  |
| `rank`   | 1枚の種別・ランクを変更する（Ⅱ／Ⅲ × D〜S）               |

`remove` を外さないこと。ステータスとしては純損だが、順位で当て先が決まる効果
（`HIGHEST_ATTACK` / `LOWEST_ATTACK` や単発消費デバフ）の受け先を作り替えるのはこの手
だけである。純粋なステータス増がスコアを下げることがあるのと同じ理由で、純損の手が
スコアを上げることがある。

`rank` は既定では含めない。単価表（同じ枠へ挿す1枚の質を上げると幾ら増えるか）の用途で
あり、限界効用マップの「どのステータスへ積むか」とは問いが違う。

手は「1枚外して1枚挿す」で統一して持つ。4種はその特殊形（`add` は外さない、`remove` は
挿さない）であり、適用と正準キーを1か所で書けば、手の種類が増えても崩れない。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..models import GearStat
from .allocation import (
    ALL_RANKS,
    DEFAULT_ADD_RANK,
    MAX_PIECES_PER_STAT,
    MAX_PIECES_PER_UNIT,
    SEARCHED_STATS,
    Allocation,
    GearAllocationError,
    GearPiece,
    GearRank,
)

MoveKind = Literal["move", "add", "remove", "rank"]

# 表示と正準キーの並び。近傍の生成順もこれに従う（同じ配分から常に同じ順で出す）。
KIND_ORDER: tuple[MoveKind, ...] = ("move", "add", "remove", "rank")


@dataclass(frozen=True)
class Move:
    """1手。適用先の枠（`slot_index`）と、外す駒・挿す駒だけを持つ。"""

    kind: MoveKind
    slot_index: int
    unit_definition_id: str
    removed: GearPiece | None
    added: GearPiece | None

    def apply(self, allocation: Allocation) -> Allocation | None:
        """適用した配分。適用できない・制約を破るなら `None`。

        複数の手を重ねる（上位k手の同時適用）ときに、先の手が前提を崩すことがある。
        例外にせず `None` を返すのは、重ねられなかった手を数え上げて報告するためで、
        黙って落とすと「k手を適用した」という報告が実際と食い違う。
        """
        unit = allocation.units[self.slot_index]
        try:
            replaced = unit.replaced(removed=self.removed, added=self.added)
        except GearAllocationError:
            return None
        applied = allocation.with_unit(self.slot_index, replaced)
        if applied.violations():
            return None
        return applied

    def gained_stat(self) -> GearStat | None:
        """この手で枚数が増えるステータス。限界効用マップの列を決める。"""
        if self.added is None:
            return None
        if self.removed is not None and self.removed.stat == self.added.stat:
            return None
        return self.added.stat

    def canonical_key(self) -> str:
        removed = "-" if self.removed is None else self.removed.label
        added = "-" if self.added is None else self.added.label
        return f"{self.slot_index}:{self.kind}:{removed}>{added}"

    @property
    def label(self) -> str:
        if self.kind == "move":
            return f"{self.removed.label} → {self.added.stat}"
        if self.kind == "add":
            return f"+ {self.added.label}"
        if self.kind == "remove":
            return f"− {self.removed.label}"
        return f"{self.removed.label} → {self.added.rank.label}"


def neighborhood(
    allocation: Allocation,
    *,
    include_rank: bool = False,
    add_rank: GearRank = DEFAULT_ADD_RANK,
) -> tuple[Move, ...]:
    """1手で到達できる配分すべて。同じ結果になる手は1つへ畳む。

    枠を区別しないため、同じ駒が2枚挿さっていても手は1つである。枠ごとに数えると、
    まったく同じ配分の候補へ2度予算を払うことになる。
    """
    moves: list[Move] = []
    for slot_index, unit in enumerate(allocation.units):
        for kind in KIND_ORDER:
            if kind == "rank" and not include_rank:
                continue
            moves.extend(_moves_of_kind(kind, slot_index, unit, add_rank))
    return _deduplicated(moves, allocation)


def _moves_of_kind(kind: MoveKind, slot_index: int, unit, add_rank: GearRank) -> list[Move]:
    build = _Builder(kind=kind, slot_index=slot_index, unit_definition_id=unit.unit_definition_id)
    # 動かせるのは探索対象の5種だけ。HP・防御の枚数は基点のまま送る（`allocation.py`）。
    movable = [piece for piece in unit.distinct_pieces() if piece.stat in SEARCHED_STATS]
    if kind == "move":
        return [
            build(removed=piece, added=piece.rank.with_stat(stat))
            for piece in movable
            for stat in SEARCHED_STATS
            if stat != piece.stat and unit.count(stat) < MAX_PIECES_PER_STAT
        ]
    if kind == "add":
        if unit.total >= MAX_PIECES_PER_UNIT:
            return []
        return [
            build(removed=None, added=add_rank.with_stat(stat))
            for stat in SEARCHED_STATS
            if unit.count(stat) < MAX_PIECES_PER_STAT
        ]
    if kind == "remove":
        return [build(removed=piece, added=None) for piece in movable]
    return [
        build(removed=piece, added=rank.with_stat(piece.stat))
        for piece in movable
        for rank in _other_ranks(piece)
    ]


def _other_ranks(piece: GearPiece) -> list[GearRank]:
    return [rank for rank in ALL_RANKS if rank != piece.rank]


@dataclass(frozen=True)
class _Builder:
    kind: MoveKind
    slot_index: int
    unit_definition_id: str

    def __call__(self, *, removed: GearPiece | None, added: GearPiece | None) -> Move:
        return Move(
            kind=self.kind,
            slot_index=self.slot_index,
            unit_definition_id=self.unit_definition_id,
            removed=removed,
            added=added,
        )


def _deduplicated(moves: list[Move], allocation: Allocation) -> tuple[Move, ...]:
    """同じ配分へ着く手と、適用できない手を落とす。並びは生成順のまま。"""
    seen: set[str] = set()
    unique: list[Move] = []
    for move in moves:
        applied = move.apply(allocation)
        if applied is None or applied.canonical_key() == allocation.canonical_key():
            continue
        key = applied.canonical_key()
        if key in seen:
            continue
        seen.add(key)
        unique.append(move)
    return tuple(unique)
