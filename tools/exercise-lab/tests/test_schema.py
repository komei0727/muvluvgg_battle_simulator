"""Catalog から生成する JSON Schema。

エディタ補完のためだけでなく、`R-TEX-11` #1（味方は PLAYABLE、敵は EXERCISE_ENEMY）を
型として表現する。実際に検証器へ通し、期待どおり弾く/通すことを固定する。
"""

import jsonschema
import pytest
import yaml

from exercise_lab.api import Catalog
from exercise_lab.models import ConfigError, load_formation_config
from exercise_lab.schema import build_formation_json_schema

CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "2026-08-16.3",
        "units": [
            {
                "unitDefinitionId": "UNIT_A",
                "displayName": "【あ】アー",
                "characterName": "アー",
                "category": "PLAYABLE",
                "role": "PHYSICAL_ATTACKER",
                "positionAptitudes": ["FRONT"],
            },
            {
                "unitDefinitionId": "UNIT_B",
                "displayName": "【い】イー",
                "characterName": "イー",
                "category": "PLAYABLE",
                "role": "SUPPORT",
                "positionAptitudes": ["BACK"],
            },
            {
                "unitDefinitionId": "UNIT_ENEMY",
                "displayName": "【え】エー",
                "characterName": "エー",
                "category": "EXERCISE_ENEMY",
                "role": "TANK",
                "positionAptitudes": ["FRONT"],
            },
        ],
        "memories": [
            {"memoryDefinitionId": "MEM_A", "displayName": "めもりーA"},
            {"memoryDefinitionId": "MEM_B", "displayName": "めもりーB"},
        ],
    }
)


def document(*, ally_unit="UNIT_A", enemy_unit="UNIT_ENEMY", memories=("MEM_A",)):
    return {
        "ally": {
            "units": [{"unitDefinitionId": ally_unit, "position": {"column": 0, "row": "FRONT"}}],
            "memoryDefinitionIds": list(memories),
        },
        "enemy": {
            "unitDefinitionId": enemy_unit,
            "position": {"column": 1, "row": "FRONT"},
        },
    }


@pytest.fixture(name="schema")
def _schema():
    return build_formation_json_schema(CATALOG)


def validate(schema, value):
    jsonschema.validate(value, schema)


def test_the_schema_itself_is_valid(schema):
    jsonschema.Draft202012Validator.check_schema(schema)


def test_a_valid_formation_passes(schema):
    validate(schema, document())


def test_exercise_enemy_is_rejected_on_the_ally_side(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(ally_unit="UNIT_ENEMY"))


def test_playable_unit_is_rejected_as_the_enemy(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(enemy_unit="UNIT_B"))


def test_unknown_ids_are_rejected(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(ally_unit="UNIT_TYPO"))
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(memories=("MEM_TYPO",)))


def test_enums_are_sorted_so_the_generated_file_is_stable(schema):
    ally_ids = schema["$defs"]["AllyUnitSpec"]["properties"]["unitDefinitionId"]["enum"]
    assert ally_ids == ["UNIT_A", "UNIT_B"]
    assert schema["$defs"]["EnemySpec"]["properties"]["unitDefinitionId"]["enum"] == ["UNIT_ENEMY"]


def test_enum_values_carry_display_names_for_completion(schema):
    unit_property = schema["$defs"]["AllyUnitSpec"]["properties"]["unitDefinitionId"]

    # `enum` と同じ並びで対応する説明を置く（VSCode系エディタが補完候補へ出す）。
    assert unit_property["enum"] == ["UNIT_A", "UNIT_B"]
    assert unit_property["markdownEnumDescriptions"] == [
        "【あ】アー — PHYSICAL_ATTACKER / FRONT",
        "【い】イー — SUPPORT / BACK",
    ]


def test_the_catalog_revision_is_recorded(schema):
    assert "2026-08-16.3" in schema["description"]


def test_generation_is_deterministic():
    assert build_formation_json_schema(CATALOG) == build_formation_json_schema(CATALOG)


def test_unknown_academy_level_keys_are_rejected(schema):
    # `models._reject_unknown_academy_keys` と同じ判定をSchemaでも持つ。
    value = document()
    value["ally"]["academyLevels"] = {"unitTypes": {"PHYSICAL": 60, "MAGIC": 3}, "attributes": {}}

    with pytest.raises(jsonschema.ValidationError):
        validate(schema, value)


def test_known_academy_level_keys_pass(schema):
    value = document()
    value["ally"]["academyLevels"] = {
        "unitTypes": {"PHYSICAL": 60},
        "attributes": {"AGGRESSIVE": 40},
    }

    validate(schema, value)


def test_unit_level_without_academy_levels_is_rejected(schema):
    # `models._validate` と同じく、陣営の強化指定なしにユニットの強化は指定できない
    # （APIが422で拒む組み合わせなので、書いた時点で分かるようにする）。
    value = document()
    value["ally"]["units"][0]["level"] = 240

    with pytest.raises(jsonschema.ValidationError):
        validate(schema, value)


def test_unit_gears_without_academy_levels_are_rejected(schema):
    value = document()
    value["ally"]["units"][0]["gears"] = [{"stat": "ATTACK", "tier": "III", "grade": "S"}]

    with pytest.raises(jsonschema.ValidationError):
        validate(schema, value)


def test_unit_rank_without_academy_levels_is_rejected(schema):
    # `models._validate` と同じく、陣営の強化指定なしにユニットの強化は指定できない。
    value = document()
    value["ally"]["units"][0]["rank"] = 3

    with pytest.raises(jsonschema.ValidationError):
        validate(schema, value)


def test_unit_rank_with_academy_levels_passes(schema):
    value = document()
    value["ally"]["academyLevels"] = {"unitTypes": {"PHYSICAL": 60}, "attributes": {}}
    value["ally"]["units"][0]["rank"] = 3

    validate(schema, value)


def test_unit_level_with_academy_levels_passes(schema):
    value = document()
    value["ally"]["academyLevels"] = {"unitTypes": {"PHYSICAL": 60}, "attributes": {}}
    value["ally"]["units"][0]["level"] = 240

    validate(schema, value)


def test_duplicate_ally_positions_are_a_documented_gap(schema):
    """Schemaで表現できない制約はここに列挙し、差異を明示的に固定する。

    「配置が重複しないこと」は要素の一部（`position`）についての一意性で、
    JSON Schema の `uniqueItems` では表せない。エディタ上は通り、`lab stats` の
    `ConfigError` で落ちる——この非対称を黙って持たず、テストで見えるようにする。
    """
    value = document()
    value["ally"]["units"] = [
        {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
        {"unitDefinitionId": "UNIT_B", "position": {"column": 0, "row": "FRONT"}},
    ]

    validate(schema, value)  # Schemaは通す

    import tempfile
    from pathlib import Path

    import yaml as pyyaml

    from exercise_lab.models import ConfigError, load_formation_config

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "formation.yaml"
        path.write_text(pyyaml.safe_dump(value), encoding="utf-8")
        with pytest.raises(ConfigError, match="重複"):
            load_formation_config(path)  # ローダーは弾く


# YAMLでは `academyLevels:` と書くだけで `null` になる。キーの有無ではなく
# 「非nullの値があるか」で判定を組まないと、Schemaとローダーの判定が逆転する。


def test_null_academy_levels_with_a_unit_level_is_rejected(schema):
    value = document()
    value["ally"]["academyLevels"] = None
    value["ally"]["units"][0]["level"] = 240

    with pytest.raises(jsonschema.ValidationError):
        validate(schema, value)


def test_null_academy_levels_with_null_unit_gears_passes(schema):
    value = document()
    value["ally"]["academyLevels"] = None
    value["ally"]["units"][0]["gears"] = None

    validate(schema, value)


def test_null_unit_level_without_academy_levels_passes(schema):
    value = document()
    value["ally"]["units"][0]["level"] = None

    validate(schema, value)


def test_null_unit_gears_without_academy_levels_pass(schema):
    value = document()
    value["ally"]["units"][0]["gears"] = None

    validate(schema, value)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(
            lambda value: (
                value["ally"].__setitem__("academyLevels", None)
                or value["ally"]["units"][0].__setitem__("level", 240)
            ),
            id="null-academy-levels-with-level",
        ),
        pytest.param(
            lambda value: value["ally"]["units"][0].__setitem__("level", None),
            id="null-level",
        ),
        pytest.param(
            lambda value: value["ally"]["units"][0].__setitem__("gears", None),
            id="null-gears",
        ),
        pytest.param(
            lambda value: (
                value["ally"].__setitem__("academyLevels", None)
                or value["ally"]["units"][0].__setitem__("gears", None)
            ),
            id="null-academy-levels-with-null-gears",
        ),
        pytest.param(
            lambda value: (
                value["ally"].__setitem__(
                    "academyLevels", {"unitTypes": {"PHYSICAL": 60}, "attributes": {}}
                )
                or value["ally"]["units"][0].__setitem__("level", 240)
            ),
            id="academy-levels-with-level",
        ),
    ],
)
def test_schema_and_loader_agree_on_null_shaped_documents(schema, mutate, tmp_path):
    """Schemaが通す/弾く方向とローダーの判定を一致させる。

    片方だけが通ると、エディタで直したのに実行で落ちる（またはその逆）になる。
    """
    value = document()
    mutate(value)

    schema_accepts = True
    try:
        validate(schema, value)
    except jsonschema.ValidationError:
        schema_accepts = False

    path = tmp_path / "formation.yaml"
    path.write_text(yaml.safe_dump(value, allow_unicode=True), encoding="utf-8")
    loader_accepts = True
    try:
        load_formation_config(path)
    except ConfigError:
        loader_accepts = False

    assert schema_accepts == loader_accepts
