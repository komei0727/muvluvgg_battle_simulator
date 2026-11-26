"""参加枠の識別。

同じ `unitDefinitionId` を同一陣営へ複数置ける（R-FRM-03）ため、定義IDは参加者の
識別子にならない。評価APIの試行結果と同じ `(side, formationNumber, unitIndex)` の組で
枠を指す（`10_API設計.md`「BattleEvaluationRunResponse」）。`formation_number` は
総力戦だけが持つ1始まりの編成番号で、他の形式では `None` にする。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

from .formation import FormationSpec, Position

Side = Literal["ALLY", "ENEMY"]
SIDES: tuple[Side, ...] = ("ALLY", "ENEMY")


class SlotKey(BaseModel):
    model_config = ConfigDict(frozen=True)

    side: Side
    formation_number: int | None
    unit_index: int


class ParticipantSlot(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: SlotKey
    unit_definition_id: str
    position: Position


def participant_slots(
    side: Side, formations: Sequence[FormationSpec], *, numbered: bool
) -> list[ParticipantSlot]:
    """陣営の全参加枠を編成順・`units` の順で返す。

    `numbered` は総力戦のように編成番号で枠を区別する形式だけ真にする。編成が1つしか
    ない形式で番号を振ると、APIの試行結果（番号なし）と突き合わせられなくなる。
    """
    if not numbered and len(formations) != 1:
        raise ValueError("編成番号を振らない形式は1陣営1編成でなければならない")
    return [
        ParticipantSlot(
            key=SlotKey(
                side=side,
                formation_number=number if numbered else None,
                unit_index=index,
            ),
            unit_definition_id=unit.unit_definition_id,
            position=unit.position,
        )
        for number, formation in enumerate(formations, start=1)
        for index, unit in enumerate(formation.units)
    ]
