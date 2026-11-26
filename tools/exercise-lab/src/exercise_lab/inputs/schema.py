"""演習の編成定義YAML用の JSON Schema を Catalog から生成する。

部品（実IDのenum・学園レベルのキー・強化指定の組み合わせ）は
`mlgg_lab_common.inputs.schema` が持ち、ここは演習の形（味方 + 敵1体）へ当てはめる。

`R-TEX-11` #1（味方は `PLAYABLE`、敵は `EXERCISE_ENEMY`）は、味方枠と敵枠へ別々の
enum を入れることで型として表現する——実行してAPIの422を待たずにエディタ上で分かる。

味方の配置重複はJSON Schemaで表せないため、Schemaは通しローダーの `ConfigError` で
落ちる。この非対称は `tests/test_schema.py` の
`test_duplicate_ally_positions_are_a_documented_gap` で固定してある。
"""

from __future__ import annotations

from typing import Any

from mlgg_lab_common.inputs.catalog import EXERCISE_ENEMY, PLAYABLE, Catalog
from mlgg_lab_common.inputs.schema import (
    finish_schema,
    memory_enum,
    require_academy_levels_for_unit_enhancement,
    restrict_academy_level_keys,
    unit_enum,
)

from .exercise import FormationConfig


def build_formation_json_schema(catalog: Catalog) -> dict[str, Any]:
    schema: dict[str, Any] = FormationConfig.model_json_schema(by_alias=True)
    definitions = schema["$defs"]

    definitions["FormationUnitSpec"]["properties"]["unitDefinitionId"] = unit_enum(
        catalog, PLAYABLE
    )
    definitions["EnemySpec"]["properties"]["unitDefinitionId"] = unit_enum(catalog, EXERCISE_ENEMY)
    definitions["FormationSpec"]["properties"]["memoryDefinitionIds"]["items"] = memory_enum(
        catalog
    )
    restrict_academy_level_keys(definitions["AcademyLevels"])
    require_academy_levels_for_unit_enhancement(definitions["FormationSpec"])

    return finish_schema(schema, catalog, title="exercise-lab formation")
