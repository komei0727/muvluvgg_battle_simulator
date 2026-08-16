"""ブラウザに溜まった育成状態（localStorage `mlgg:player-data`）の取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `StoredPlayerData` を
そのまま写す。UIが同じキーへ書き続ける限り、編成YAMLへレベル・ギアを書き写さずに
実際の手持ちで評価できる。

YAMLに書かれた値が常に優先する。手持ちデータは「書かなかった項目の既定値」であり、
明示した値を上書きすると、YAMLを読んでも何を評価したのか分からなくなる。
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import Field, ValidationError

from .models import (
    MAX_GEARS,
    AcademyLevels,
    AllyUnitSpec,
    FormationConfig,
    Gear,
    _Spec,
)

# `persistence.ts` の `PERSISTENCE_SCHEMA_VERSION`。異なる版は読み替えず落とす。
SUPPORTED_SCHEMA_VERSION = 1


class PlayerDataError(Exception):
    """手持ちデータが契約から外れている。"""


class StoredUnitEnhancement(_Spec):
    level: int
    # 枠は9固定で、空枠はJSON上 `null` として並ぶ。
    gears: list[Gear | None]


class PlayerData(_Spec):
    schema_version: int = Field(alias="schemaVersion")
    academy_levels: AcademyLevels = Field(alias="academyLevels")
    units: dict[str, StoredUnitEnhancement]


def load_player_data(path: Path) -> PlayerData:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise PlayerDataError(f"{path}: JSONとして読めない: {error}") from error
    if not isinstance(raw, dict):
        raise PlayerDataError(f"{path}: トップレベルはオブジェクトでなければならない")
    version = raw.get("schemaVersion")
    if version != SUPPORTED_SCHEMA_VERSION:
        raise PlayerDataError(
            f"{path}: 未対応の schemaVersion={version!r}"
            f"（このツールは {SUPPORTED_SCHEMA_VERSION} だけを読む）"
        )
    try:
        return PlayerData.model_validate(raw)
    except ValidationError as error:
        raise PlayerDataError(f"{path}: {error}") from error


def apply_player_data(
    config: FormationConfig, data: PlayerData
) -> tuple[FormationConfig, list[str]]:
    """手持ちデータを編成へ適用し、適用後の編成と警告一覧を返す。

    警告は握り潰さず呼び出し側へ返す。手持ちに無いユニットはレベル200・ギアなしで
    評価されるため、黙って進むと「育成済みのつもりの編成」の統計が出てしまう。
    """
    warnings: list[str] = []
    units = [_apply_unit(unit, data, warnings) for unit in config.ally.units]
    ally = config.ally.model_copy(
        update={
            "units": units,
            "academy_levels": config.ally.academy_levels or data.academy_levels,
        }
    )
    return config.model_copy(update={"ally": ally}), warnings


def _apply_unit(unit: AllyUnitSpec, data: PlayerData, warnings: list[str]) -> AllyUnitSpec:
    stored = data.units.get(unit.unit_definition_id)
    if stored is None:
        warnings.append(
            f"{unit.unit_definition_id} は手持ちデータに無い（レベル200・ギアなしとして評価する）"
        )
        return unit
    if len(stored.gears) > MAX_GEARS:
        raise PlayerDataError(
            f"{unit.unit_definition_id}: ギア枠が{MAX_GEARS}件を超えている（{len(stored.gears)}件）"
        )
    update = {}
    if unit.level is None:
        update["level"] = stored.level
    if unit.gears is None:
        # 空枠を除いた枠順のまま送る（`request-mapper.ts` の `buildUnitEnhancement` と同じ）。
        update["gears"] = [gear for gear in stored.gears if gear is not None]
    return unit.model_copy(update=update) if update else unit
