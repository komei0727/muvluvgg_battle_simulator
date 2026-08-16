"""Catalog から生成する JSON Schema。

エディタ補完のためだけでなく、`R-TEX-11` #1（味方は PLAYABLE、敵は EXERCISE_ENEMY）を
型として表現する。実際に検証器へ通し、期待どおり弾く/通すことを固定する。
"""

import jsonschema
import pytest

from exercise_lab.api import Catalog
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
