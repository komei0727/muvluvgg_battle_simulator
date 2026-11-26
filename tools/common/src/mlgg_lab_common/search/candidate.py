"""探索の候補（味方側の編成）と、その識別・由来・編成への展開。

候補は味方のユニット（定義ID・配置・ギア）とメモリー列だけを持つ。育成条件（レベル・
ランク・モジュール・学園レベル）は持たず、探索問題の `training` からユニットIDで引く。
入れ替えで枠に入ったユニットへも同じ規則で育成条件が当たり、枠に残った値が別のユニットへ
移ることはない。

意味の保持:

- ユニット・メモリーは並べた順のまま送る（`FormationSpec` と同じ）。順序が違えば別の候補。
- 枠の `gears=None` は「育成条件のギアを使う」、`gears=()` は「ギアなし」で、別の意味。
- 候補IDは候補の内容だけから決まる。同じスコア・勝敗が返っても別の候補を統合しない。
  候補ID・要求IDは評価APIのseedへ混ぜない（戦闘の乱数は `(seed, runIndex)` だけで決まる）。
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any, Literal

from pydantic import ConfigDict, Field

from ..models.formation import (
    MAX_FORMATION_UNITS,
    MAX_GEARS,
    MAX_MEMORIES,
    FormationSpec,
    FormationUnitSpec,
    Gear,
    Position,
    Spec,
)

if TYPE_CHECKING:
    from .problem import SearchProblem


class _Frozen(Spec):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)


class CandidateUnit(_Frozen):
    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position
    # `None` は育成条件のギア、空は「ギアなし」の明示。
    gears: tuple[Gear, ...] | None = Field(default=None, max_length=MAX_GEARS)


class Candidate(_Frozen):
    units: tuple[CandidateUnit, ...] = Field(min_length=1, max_length=MAX_FORMATION_UNITS)
    memory_definition_ids: tuple[str, ...] = Field(
        default=(), alias="memoryDefinitionIds", max_length=MAX_MEMORIES
    )

    @property
    def candidate_id(self) -> str:
        return candidate_id(self)

    def unit_ids(self) -> list[str]:
        return [unit.unit_definition_id for unit in self.units]


def dump_candidate(candidate: Candidate) -> dict[str, Any]:
    return candidate.model_dump(mode="json", by_alias=True, exclude_none=True)


def candidate_id(candidate: Candidate) -> str:
    """候補の内容（並び順を含む）のハッシュ。

    `exclude_none` で落とすので、`gears=None`（育成条件）と `()`（ギアなし）は別のIDになる。
    """
    canonical = json.dumps(
        dump_candidate(candidate), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return "c-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


OriginKind = Literal["START", "PROPOSED"]


class Origin(_Frozen):
    """候補がどこから来たか。同じ候補が複数の経路から提案されれば、由来も複数残る。

    `operations` は操作の名前（例: `replace_unit`）、`parents` は元にした候補のID。
    `note` は手法が残したい付帯情報（JSON）で、共通基盤は解釈しない。
    """

    kind: OriginKind
    proposer: str | None = None
    operations: tuple[str, ...] = ()
    parents: tuple[str, ...] = ()
    note: dict[str, Any] = Field(default_factory=dict)


def candidate_from_formation(formation: FormationSpec) -> Candidate:
    """解決済みの編成から、配置・ユニット順・メモリー順を写した候補を作る。

    ギア・レベル等の育成値は写さない（候補の育成条件は探索問題の `training` が持つ）。
    """
    return Candidate(
        units=tuple(
            CandidateUnit(unitDefinitionId=unit.unit_definition_id, position=unit.position)
            for unit in formation.units
        ),
        memoryDefinitionIds=tuple(formation.memory_definition_ids),
    )


def materialize(problem: SearchProblem, candidate: Candidate) -> FormationSpec:
    """候補へ育成条件を当てて、送信する味方編成にする。検証はしない（`constraints` が行う）。"""
    training = problem.training
    units = []
    for unit in candidate.units:
        trained = training.for_unit(unit.unit_definition_id)
        gears = list(unit.gears) if unit.gears is not None else trained.gears
        units.append(
            FormationUnitSpec(
                unitDefinitionId=unit.unit_definition_id,
                position=unit.position,
                level=trained.level,
                rank=trained.rank,
                gears=gears,
                module=trained.module,
            )
        )
    return FormationSpec(
        units=units,
        memoryDefinitionIds=list(candidate.memory_definition_ids),
        academyLevels=training.academy_levels,
    )


def effective_gears(problem: SearchProblem, unit: CandidateUnit) -> list[Gear]:
    """その枠で実際に送るギア（調整したギアか、育成条件のギア）。"""
    if unit.gears is not None:
        return list(unit.gears)
    return list(problem.training.for_unit(unit.unit_definition_id).gears or [])
