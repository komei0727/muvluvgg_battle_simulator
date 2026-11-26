"""編成YAML用の JSON Schema を Catalog から生成する部品と、編成ライブラリ1件のSchema。

狙いはエディタ補完（YAML Language Server）である。IDを手で書き写す代わりに、
書いているその場所で実IDの候補が出るようにする。

骨格は pydantic モデルから起こす。宣言的な制約（型・件数・値域）を手書きで
二重定義すると、実装だけ直してSchemaが取り残される。Catalog 由来の情報は「どのIDが
存在するか」だけを後から差し込む。形式ごとの入力ファイル（演習の編成YAML等）の
Schemaは各ラボが、ここの部品を使って組み立てる。

**Schemaはローダーの受理条件をすべては表さない。** `models.formation.validate_formation`
の判定のうち、学園レベルのキー（{@link restrict_academy_level_keys}）と
`academyLevels` なしのユニット強化（{@link require_academy_levels_for_unit_enhancement}）は
Schemaへ移せるが、配置の重複は表せない。要素の一部（`position`）についての一意性であり、
`uniqueItems`（要素全体の一意性）では表せないためである。
"""

from __future__ import annotations

from typing import Any

from ..models.formation import ATTRIBUTES, UNIT_TYPES
from .catalog import PLAYABLE, Catalog, CatalogUnit
from .library import FormationLibraryEntry

JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def build_formation_library_json_schema(catalog: Catalog) -> dict[str, Any]:
    """編成ライブラリ（`configs/formations/<id>.yaml`）1ファイル用のSchema。"""
    schema: dict[str, Any] = FormationLibraryEntry.model_json_schema(by_alias=True)
    definitions = schema["$defs"]

    definitions["FormationUnitSpec"]["properties"]["unitDefinitionId"] = unit_enum(
        catalog, PLAYABLE
    )
    schema["properties"]["memoryDefinitionIds"]["items"] = memory_enum(catalog)

    return finish_schema(schema, catalog, title="formation library entry")


def finish_schema(schema: dict[str, Any], catalog: Catalog, *, title: str) -> dict[str, Any]:
    schema["$schema"] = JSON_SCHEMA_DIALECT
    schema["title"] = title
    schema["description"] = (
        f"`exercise-lab schema` が catalogRevision {catalog.catalog_revision} から生成した。"
        "Catalog が更新されたら生成し直す。"
    )
    return schema


def unit_enum(catalog: Catalog, category: str) -> dict[str, Any]:
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


def memory_enum(catalog: Catalog) -> dict[str, Any]:
    memories = sorted(catalog.memories, key=lambda memory: memory.memory_definition_id)
    return {
        "type": "string",
        "description": "Catalog のメモリー。",
        "enum": [memory.memory_definition_id for memory in memories],
        "markdownEnumDescriptions": [memory.display_name for memory in memories],
    }


def restrict_academy_level_keys(academy_levels: dict[str, Any]) -> None:
    """学園レベルのキーを9種へ固定する（`models.formation.validate_formation` と同じ判定）。

    pydanticが出すのは「任意のキー→整数」なので、綴り違いがSchemaを通ってしまう。
    キーを列挙しておくと、弾けるだけでなくキー名自体も補完候補に出る。
    """
    for group, keys in (("unitTypes", UNIT_TYPES), ("attributes", ATTRIBUTES)):
        academy_levels["properties"][group] = {
            "type": "object",
            "additionalProperties": False,
            "properties": {key: {"type": "integer", "minimum": 1} for key in keys},
        }


def require_academy_levels_for_unit_enhancement(formation: dict[str, Any]) -> None:
    """`academyLevels` が無い編成のユニットへ
    `level` / `rank` / `gears` / `module` を書けないようにする。

    陣営の強化指定なしにユニットの強化だけ送るとAPIが422で拒む
    （`10_API設計.md`「FormationUnitRequest」）。`validate_formation` が実行時に見ている
    のと同じ条件を、書いた時点で分かるようにする。

    判定はキーの有無ではなく**非nullの値があるか**で組む。YAMLは `academyLevels:` と
    書くだけで `null` になり、pydanticはそれを未指定と同じ `None` として読む。キーの
    有無で見ると、`academyLevels: null` + `level: 240`（Schemaは通すがローダーは拒否）と
    `level: null` 単体（Schemaは拒否するがローダーは通す）で判定が逆転する。
    """
    formation["if"] = {"not": _present("academyLevels")}
    formation["then"] = {
        "properties": {
            "units": {
                "items": {
                    "not": {
                        "anyOf": [
                            _present("level"),
                            _present("rank"),
                            _present("gears"),
                            _present("module"),
                        ]
                    }
                },
            }
        }
    }


def _present(field: str) -> dict[str, Any]:
    """その項目が非nullの値を持つ、という条件。"""
    return {"required": [field], "properties": {field: {"not": {"type": "null"}}}}
