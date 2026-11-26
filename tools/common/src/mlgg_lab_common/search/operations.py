"""候補操作の部品。どれも元の候補を変えず、新しい候補を返す。

操作は形の上で成立するか（添字の範囲・空き枠・人数の上下限）だけを見る。使用可能プール・
固定指定・ギアの許可範囲などの合法性は `constraints.candidate_problems` と各ラボのアダプターが
判定する。分けておくと、手法が「操作 → 検証 → 採否」を自分の方針で組める。

どの操作をどの順番・頻度で使うか、近傍を全部並べるかは接続する手法の責務で、ここでは決めない。
操作しなかった枠・メモリーの順序と値はそのまま残る。
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import ValidationError

from ..models.formation import MAX_FORMATION_UNITS, MAX_MEMORIES, Gear, Position
from .candidate import Candidate, CandidateUnit

# R-FRM-02: 横3列 × 前後2行。
ALL_POSITIONS: tuple[Position, ...] = tuple(
    Position(column=column, row=row) for row in ("FRONT", "REAR") for column in range(3)
)


class OperationError(ValueError):
    """候補操作が形の上で成立しない（添字の範囲外・埋まった枠への移動等）。"""


def _key(position: Position) -> tuple[int, str]:
    return (position.column, position.row)


def empty_positions(
    candidate: Candidate, allowed: Sequence[Position] | None = None
) -> list[Position]:
    """候補が使っていない配置。`allowed` を渡すとその中から（盤面順に）返す。"""
    occupied = {_key(unit.position) for unit in candidate.units}
    pool = ALL_POSITIONS if allowed is None else allowed
    return [position for position in pool if _key(position) not in occupied]


def _rebuild(candidate: Candidate, **update: object) -> Candidate:
    try:
        return Candidate.model_validate({**candidate.model_dump(by_alias=False), **update})
    except ValidationError as error:
        raise OperationError(f"操作した候補が成立しない: {error}") from error


def _unit_index(candidate: Candidate, index: int) -> None:
    if not 0 <= index < len(candidate.units):
        raise OperationError(f"ユニットの添字 {index} が範囲外（0～{len(candidate.units) - 1}）")


def _memory_index(candidate: Candidate, index: int, *, inserting: bool = False) -> None:
    upper = len(candidate.memory_definition_ids) + (1 if inserting else 0)
    if not 0 <= index < upper:
        raise OperationError(f"メモリーの添字 {index} が範囲外（0～{upper - 1}）")


def _require_empty(candidate: Candidate, position: Position, *, ignore: int | None = None) -> None:
    for index, unit in enumerate(candidate.units):
        if index != ignore and _key(unit.position) == _key(position):
            raise OperationError(
                f"配置 column={position.column}, row={position.row} は埋まっている"
                f"（{unit.unit_definition_id}）"
            )


# -- ユニットの選抜・交換・配置 ------------------------------------------------------


def add_unit(candidate: Candidate, unit_definition_id: str, position: Position) -> Candidate:
    """空き枠へユニットを加える（末尾に並ぶ）。"""
    if len(candidate.units) >= MAX_FORMATION_UNITS:
        raise OperationError(f"これ以上ユニットを加えられない（{MAX_FORMATION_UNITS}体まで）")
    _require_empty(candidate, position)
    unit = CandidateUnit(unitDefinitionId=unit_definition_id, position=position)
    return _rebuild(candidate, units=(*candidate.units, unit))


def remove_unit(candidate: Candidate, index: int) -> Candidate:
    _unit_index(candidate, index)
    if len(candidate.units) == 1:
        raise OperationError("最後の1体は外せない（R-FRM-01）")
    return _rebuild(candidate, units=candidate.units[:index] + candidate.units[index + 1 :])


def replace_unit(candidate: Candidate, index: int, unit_definition_id: str) -> Candidate:
    """枠のユニットを別のユニットへ入れ替える。配置と並び順は保つ。

    枠に指定していたギアは引き継がない（`None` に戻す）。ギアはユニットの育成条件に属し、
    前のユニット向けの調整を新しいユニットへ黙って移さない。
    """
    _unit_index(candidate, index)
    units = list(candidate.units)
    units[index] = CandidateUnit(
        unitDefinitionId=unit_definition_id, position=units[index].position
    )
    return _rebuild(candidate, units=tuple(units))


def move_unit(candidate: Candidate, index: int, position: Position) -> Candidate:
    """ユニットを空き枠へ動かす。ギア・並び順は保つ。"""
    _unit_index(candidate, index)
    _require_empty(candidate, position, ignore=index)
    units = list(candidate.units)
    units[index] = units[index].model_copy(update={"position": position})
    return _rebuild(candidate, units=tuple(units))


def swap_positions(candidate: Candidate, first: int, second: int) -> Candidate:
    """2体の配置を交換する。ユニット・ギア・並び順はそのまま。"""
    _unit_index(candidate, first)
    _unit_index(candidate, second)
    if first == second:
        raise OperationError("同じ枠どうしは交換できない")
    units = list(candidate.units)
    a, b = units[first], units[second]
    units[first] = a.model_copy(update={"position": b.position})
    units[second] = b.model_copy(update={"position": a.position})
    return _rebuild(candidate, units=tuple(units))


# -- メモリーの選抜・交換・並べ替え ------------------------------------------------------


def add_memory(
    candidate: Candidate, memory_definition_id: str, index: int | None = None
) -> Candidate:
    """メモリーを加える。`index` を省くと末尾。"""
    memories = list(candidate.memory_definition_ids)
    if len(memories) >= MAX_MEMORIES:
        raise OperationError(f"これ以上メモリーを加えられない（{MAX_MEMORIES}件まで）")
    position = len(memories) if index is None else index
    _memory_index(candidate, position, inserting=True)
    memories.insert(position, memory_definition_id)
    return _rebuild(candidate, memory_definition_ids=tuple(memories))


def remove_memory(candidate: Candidate, index: int) -> Candidate:
    _memory_index(candidate, index)
    memories = list(candidate.memory_definition_ids)
    del memories[index]
    return _rebuild(candidate, memory_definition_ids=tuple(memories))


def replace_memory(candidate: Candidate, index: int, memory_definition_id: str) -> Candidate:
    _memory_index(candidate, index)
    memories = list(candidate.memory_definition_ids)
    memories[index] = memory_definition_id
    return _rebuild(candidate, memory_definition_ids=tuple(memories))


def move_memory(candidate: Candidate, source: int, destination: int) -> Candidate:
    """メモリーを `source` から抜いて `destination` へ差し込む（他の相対順は保つ）。"""
    _memory_index(candidate, source)
    _memory_index(candidate, destination)
    memories = list(candidate.memory_definition_ids)
    memories.insert(destination, memories.pop(source))
    return _rebuild(candidate, memory_definition_ids=tuple(memories))


def swap_memories(candidate: Candidate, first: int, second: int) -> Candidate:
    _memory_index(candidate, first)
    _memory_index(candidate, second)
    if first == second:
        raise OperationError("同じ位置どうしは交換できない")
    memories = list(candidate.memory_definition_ids)
    memories[first], memories[second] = memories[second], memories[first]
    return _rebuild(candidate, memory_definition_ids=tuple(memories))


# -- ギア --------------------------------------------------------------------------


def set_gears(candidate: Candidate, index: int, gears: Sequence[Gear] | None) -> Candidate:
    """枠のギアを指定する。`None` は育成条件のギアへ戻す、空はギアなし。

    許可範囲・資源制約・固定モードかどうかは見ない（`constraints` が判定する）。
    """
    _unit_index(candidate, index)
    units = list(candidate.units)
    units[index] = units[index].model_copy(
        update={"gears": None if gears is None else tuple(gears)}
    )
    return _rebuild(candidate, units=tuple(units))
