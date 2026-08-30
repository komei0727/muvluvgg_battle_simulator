"""編成YAML用の JSON Schema を Catalog から生成する。

狙いはエディタ補完（YAML Language Server）である。IDを手で書き写す代わりに、
書いているその場所で実IDの候補が出るようにする。

骨格は `models.py` の pydantic モデルから起こす。宣言的な制約（型・件数・値域）を手書きで
二重定義すると、実装だけ直してSchemaが取り残される。Catalog 由来の情報は「どのIDが
存在するか」だけを後から差し込む。

`R-TEX-11` #1（味方は `PLAYABLE`、敵は `EXERCISE_ENEMY`）は、味方枠と敵枠へ別々の
enum を入れることで型として表現する——実行してAPIの422を待たずにエディタ上で分かる。

**Schemaは `load_formation_config` の受理条件をすべては表さない。** pydanticのモデルに
現れない `models._validate` の判定のうち、次はSchemaへ移してある。

- 学園レベルのキー（{@link _restrict_academy_level_keys}）
- `academyLevels` なしのユニット強化（{@link _require_academy_levels_for_unit_enhancement}）

次はJSON Schemaで表せないため、Schemaは通し `lab stats` の `ConfigError` で落ちる。

- 味方の配置重複。要素の一部（`position`）についての一意性であり、`uniqueItems`
  （要素全体の一意性）では表せない。

この非対称は `tests/test_schema.py` の
`test_duplicate_ally_positions_are_a_documented_gap` で固定してある。制約を足したら
そちらも更新する。
"""

from __future__ import annotations

from typing import Any

from .api import EXERCISE_ENEMY, PLAYABLE, Catalog, CatalogUnit
from .models import ATTRIBUTES, UNIT_TYPES, FormationConfig
from .optimize.search_config import INTERNAL_FIELDS, SearchConfig

JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def build_formation_json_schema(catalog: Catalog) -> dict[str, Any]:
    schema: dict[str, Any] = FormationConfig.model_json_schema(by_alias=True)
    definitions = schema["$defs"]

    definitions["AllyUnitSpec"]["properties"]["unitDefinitionId"] = _unit_enum(catalog, PLAYABLE)
    definitions["EnemySpec"]["properties"]["unitDefinitionId"] = _unit_enum(catalog, EXERCISE_ENEMY)
    definitions["AllySpec"]["properties"]["memoryDefinitionIds"]["items"] = _memory_enum(catalog)
    _restrict_academy_level_keys(definitions["AcademyLevels"])
    _require_academy_levels_for_unit_enhancement(definitions["AllySpec"])

    return _finish(schema, catalog, title="exercise-lab formation")


def build_search_json_schema(catalog: Catalog) -> dict[str, Any]:
    """探索設定YAML用のSchema。

    実IDを書く場所は編成YAMLより多い——候補プール2つ、敵、固定・必須の指定、既知の
    良編成。どれか1か所でも打ち間違えると、そのIDは黙って探索から外れる（プール外の
    IDは矯正で落とされる）ため、書いている場所で候補が出ることの効きが大きい。
    """
    schema: dict[str, Any] = SearchConfig.model_json_schema(by_alias=True)
    definitions = schema["$defs"]
    properties = schema["properties"]

    playable = _unit_enum(catalog, PLAYABLE)
    memory = _memory_enum(catalog)

    properties["unitPool"]["items"] = playable
    properties["memoryPool"]["items"] = memory
    definitions["EnemySpec"]["properties"]["unitDefinitionId"] = _unit_enum(catalog, EXERCISE_ENEMY)
    definitions["FixedPlacementSpec"]["properties"]["unitDefinitionId"] = playable
    definitions["ConstraintsSpec"]["properties"]["requiredUnits"]["items"] = playable
    definitions["ConstraintsSpec"]["properties"]["requiredMemories"]["items"] = memory
    definitions["SeedFormationSpec"]["properties"]["memoryDefinitionIds"]["items"] = memory
    # 既知の良編成のユニットは編成YAMLと同じ `AllyUnitSpec` を使う。
    definitions["AllyUnitSpec"]["properties"]["unitDefinitionId"] = playable
    _restrict_academy_level_keys(definitions["AcademyLevels"])
    _drop_internal_fields(schema)

    return _finish(schema, catalog, title="exercise-lab search")


def _finish(schema: dict[str, Any], catalog: Catalog, *, title: str) -> dict[str, Any]:
    schema["$schema"] = JSON_SCHEMA_DIALECT
    schema["title"] = title
    schema["description"] = (
        f"`lab schema` が catalogRevision {catalog.catalog_revision} から生成した。"
        "Catalog が更新されたら生成し直す。"
    )
    return schema


def _drop_internal_fields(schema: dict[str, Any]) -> None:
    """実行時にだけ埋まる枠を補完候補から外す（`search_config.INTERNAL_FIELDS`）。

    pydanticの `exclude=True` は書き出し側の指定で、検証用のSchemaには残る。
    残したままだと、YAMLでは書けない項目をエディタが勧めることになる。
    """
    for field in INTERNAL_FIELDS:
        schema["properties"].pop(field, None)
        if field in schema.get("required", []):
            schema["required"].remove(field)


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


def _restrict_academy_level_keys(academy_levels: dict[str, Any]) -> None:
    """学園レベルのキーを9種へ固定する（`models._reject_unknown_academy_keys` と同じ判定）。

    pydanticが出すのは「任意のキー→整数」なので、綴り違いがSchemaを通ってしまう。
    キーを列挙しておくと、弾けるだけでなくキー名自体も補完候補に出る。
    """
    for group, keys in (("unitTypes", UNIT_TYPES), ("attributes", ATTRIBUTES)):
        academy_levels["properties"][group] = {
            "type": "object",
            "additionalProperties": False,
            "properties": {key: {"type": "integer", "minimum": 1} for key in keys},
        }


def _require_academy_levels_for_unit_enhancement(ally: dict[str, Any]) -> None:
    """`ally.academyLevels` が無いユニットへ `level` / `rank` / `gears` を書けないようにする。

    陣営の強化指定なしにユニットの強化だけ送るとAPIが422で拒む
    （`10_API設計.md`「FormationUnitRequest」）。`models._validate` が実行時に見ている
    のと同じ条件を、書いた時点で分かるようにする。

    判定はキーの有無ではなく**非nullの値があるか**で組む。YAMLは `academyLevels:` と
    書くだけで `null` になり、pydanticはそれを未指定と同じ `None` として読む。キーの
    有無で見ると、`academyLevels: null` + `level: 240`（Schemaは通すがローダーは拒否）と
    `level: null` 単体（Schemaは拒否するがローダーは通す）で判定が逆転する。
    """
    ally["if"] = {"not": _present("academyLevels")}
    ally["then"] = {
        "properties": {
            "units": {
                "items": {
                    "not": {"anyOf": [_present("level"), _present("rank"), _present("gears")]}
                },
            }
        }
    }


def _present(field: str) -> dict[str, Any]:
    """その項目が非nullの値を持つ、という条件。"""
    return {"required": [field], "properties": {field: {"not": {"type": "null"}}}}
