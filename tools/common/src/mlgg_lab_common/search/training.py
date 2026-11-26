"""探索問題の育成条件（`AllyTraining`）を手持ちデータから作る。

使用可能プールの全ユニットについて、手持ちデータ（`mlgg:player-data`）を1体ずつ解決して
写し取る。解決の規則（レベルリンク・ランク・ギア枠の空き・モジュール補正の単位変換）は
評価入力と同じ `inputs.player_data.apply_player_data` を使い、ここで書き直さない。
探索問題へ写した後は手持ちデータを読み直さない。
"""

from __future__ import annotations

from collections.abc import Sequence

from ..inputs.player_data import PlayerData, apply_player_data
from ..models.formation import AcademyLevels, FormationSpec, FormationUnitSpec, Position
from .problem import AllyTraining, UnitTraining

_ANY_POSITION = Position(column=0, row="FRONT")


def training_from_player_data(
    unit_ids: Sequence[str],
    data: PlayerData,
    *,
    academy_levels: AcademyLevels | None = None,
) -> tuple[AllyTraining, list[str]]:
    """プールのユニットの育成条件と、手持ちに無いユニット等の警告を返す。

    `academy_levels` を渡すと手持ちデータの学園レベルより優先する（編成へ明示したときと同じ）。
    """
    units: dict[str, UnitTraining] = {}
    warnings: list[str] = []
    for unit_id in dict.fromkeys(unit_ids):
        formation = FormationSpec(
            units=[FormationUnitSpec(unitDefinitionId=unit_id, position=_ANY_POSITION)],
            academyLevels=academy_levels,
        )
        applied, unit_warnings = apply_player_data(formation, data)
        resolved = applied.units[0]
        units[unit_id] = UnitTraining(
            level=resolved.level, rank=resolved.rank, gears=resolved.gears, module=resolved.module
        )
        warnings.extend(unit_warnings)
    return (
        AllyTraining(
            academyLevels=data.academy_levels if academy_levels is None else academy_levels,
            units=units,
        ),
        warnings,
    )
