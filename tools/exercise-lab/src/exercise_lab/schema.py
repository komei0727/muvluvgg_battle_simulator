"""編成YAML用の JSON Schema を Catalog から生成する。

狙いはエディタ補完（YAML Language Server）である。IDを手で書き写す代わりに、
書いているその場所で実IDの候補が出るようにする。

骨格は `models.py` の pydantic モデルから起こす。手書きで二重定義すると、YAML の
受理条件が実装とSchemaで食い違い、エディタが通したものをツールが弾く（逆も）ことになる。
Catalog 由来の情報は「どのIDが存在するか」だけを後から差し込む。

`R-TEX-11` #1（味方は `PLAYABLE`、敵は `EXERCISE_ENEMY`）は、味方枠と敵枠へ別々の
enum を入れることで型として表現する——実行してAPIの422を待たずにエディタ上で分かる。
"""

from __future__ import annotations

from typing import Any

from .api import EXERCISE_ENEMY, PLAYABLE, Catalog, CatalogUnit
from .models import FormationConfig

JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def build_formation_json_schema(catalog: Catalog) -> dict[str, Any]:
    schema: dict[str, Any] = FormationConfig.model_json_schema(by_alias=True)
    definitions = schema["$defs"]

    definitions["AllyUnitSpec"]["properties"]["unitDefinitionId"] = _unit_enum(catalog, PLAYABLE)
    definitions["EnemySpec"]["properties"]["unitDefinitionId"] = _unit_enum(catalog, EXERCISE_ENEMY)
    definitions["AllySpec"]["properties"]["memoryDefinitionIds"]["items"] = _memory_enum(catalog)

    schema["$schema"] = JSON_SCHEMA_DIALECT
    schema["title"] = "exercise-lab formation"
    schema["description"] = (
        f"`lab schema` が catalogRevision {catalog.catalog_revision} から生成した。"
        "Catalog が更新されたら生成し直す。"
    )
    return schema


def _unit_enum(catalog: Catalog, category: str) -> dict[str, Any]:
    units = sorted(
        (unit for unit in catalog.units if unit.category == category),
        key=lambda unit: unit.unit_definition_id,
    )
    return {
        "type": "string",
        "description": f"Catalog の {category} ユニット。",
        # 検証は `enum` で行う。`enum` はどのJSON Schema実装でも補完候補として読めるため、
        # 表示名は補助的な注釈キーワードで添える（知らない実装は無視するだけで壊れない）。
        "enum": [unit.unit_definition_id for unit in units],
        "markdownEnumDescriptions": [_unit_description(unit) for unit in units],
    }


def _unit_description(unit: CatalogUnit) -> str:
    aptitudes = "/".join(unit.position_aptitudes)
    return f"{unit.display_name} — {unit.role} / {aptitudes}"


def _memory_enum(catalog: Catalog) -> dict[str, Any]:
    memories = sorted(catalog.memories, key=lambda memory: memory.memory_definition_id)
    return {
        "type": "string",
        "description": "Catalog のメモリー。",
        "enum": [memory.memory_definition_id for memory in memories],
        "markdownEnumDescriptions": [memory.display_name for memory in memories],
    }
