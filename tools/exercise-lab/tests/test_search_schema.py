"""探索設定YAML用の JSON Schema。

編成YAMLと同じく、エディタ補完のためだけでなく `R-TEX-11` #1（味方は PLAYABLE、
敵は EXERCISE_ENEMY）を型として表現する。実際に検証器へ通して固定する。
"""

from pathlib import Path

import jsonschema
import pytest
import yaml

from exercise_lab.api import Catalog
from exercise_lab.models import ConfigError
from exercise_lab.optimize.search_config import load_search_config
from exercise_lab.schema import build_search_json_schema

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


def document(**overrides):
    base = {
        "enemy": {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "REAR"}},
        "unitPool": ["UNIT_A", "UNIT_B"],
        "memoryPool": ["MEM_A", "MEM_B"],
    }
    base.update(overrides)
    return base


@pytest.fixture
def schema():
    return build_search_json_schema(CATALOG)


def validate(schema, doc):
    jsonschema.validate(doc, schema)


def test_the_schema_itself_is_valid(schema):
    jsonschema.Draft202012Validator.check_schema(schema)


def test_a_valid_search_config_passes(schema):
    validate(schema, document())


def test_the_exercise_enemy_is_rejected_in_the_unit_pool(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(unitPool=["UNIT_ENEMY"]))


def test_a_playable_unit_is_rejected_as_the_enemy(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(
            schema,
            document(
                enemy={"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}}
            ),
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"unitPool": ["UNIT_GONE"]},
        {"memoryPool": ["MEM_GONE"]},
        {"constraints": {"requiredUnits": ["UNIT_GONE"]}},
        {"constraints": {"requiredMemories": ["MEM_GONE"]}},
        {
            "constraints": {
                "fixedPlacements": [
                    {"unitDefinitionId": "UNIT_GONE", "position": {"column": 0, "row": "FRONT"}}
                ]
            }
        },
        {
            "knownFormations": [
                {
                    "units": [
                        {"unitDefinitionId": "UNIT_GONE", "position": {"column": 0, "row": "FRONT"}}
                    ],
                    "memoryDefinitionIds": [],
                }
            ]
        },
        {
            "knownFormations": [
                {
                    "units": [
                        {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}}
                    ],
                    "memoryDefinitionIds": ["MEM_GONE"],
                }
            ]
        },
    ],
)
def test_unknown_ids_are_rejected_everywhere_they_can_be_written(schema, overrides):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(**overrides))


def test_known_ids_pass_everywhere_they_can_be_written(schema):
    validate(
        schema,
        document(
            constraints={
                "requiredUnits": ["UNIT_A"],
                "requiredMemories": ["MEM_A"],
                "fixedPlacements": [
                    {"unitDefinitionId": "UNIT_B", "position": {"column": 0, "row": "FRONT"}}
                ],
            },
            knownFormations=[
                {
                    "units": [
                        {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}}
                    ],
                    "memoryDefinitionIds": ["MEM_B"],
                }
            ],
        ),
    )


def test_enums_are_sorted_so_the_generated_file_is_stable(schema):
    pool = schema["properties"]["unitPool"]["items"]["enum"]
    memories = schema["properties"]["memoryPool"]["items"]["enum"]

    assert pool == sorted(pool)
    assert memories == sorted(memories)


def test_enum_values_carry_display_names_for_completion(schema):
    pool = schema["properties"]["unitPool"]["items"]

    assert pool["enum"] == ["UNIT_A", "UNIT_B"]
    assert pool["markdownEnumDescriptions"] == [
        "【あ】アー — PHYSICAL_ATTACKER / FRONT",
        "【い】イー — SUPPORT / BACK",
    ]


def test_the_catalog_revision_is_recorded(schema):
    assert "2026-08-16.3" in schema["description"]


def test_generation_is_deterministic():
    assert build_search_json_schema(CATALOG) == build_search_json_schema(CATALOG)


def test_unknown_academy_level_keys_are_rejected(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(academyLevels={"unitTypes": {"TYPO": 3}}))


def test_known_academy_level_keys_pass(schema):
    validate(
        schema, document(academyLevels={"unitTypes": {"PHYSICAL": 3}, "attributes": {"SHY": 2}})
    )


def test_an_unknown_top_level_key_is_rejected(schema):
    with pytest.raises(jsonschema.ValidationError):
        validate(schema, document(unknownKey=1))


def test_the_internal_enhancement_field_is_not_offered_as_a_yaml_key(schema):
    """`unit_enhancements` は `--player-data` の取り込み結果を持つ内部の枠である。

    育成状態の正本を2か所へ置かないためYAMLからは書けず、補完候補にも出さない。
    """
    assert "unit_enhancements" not in schema["properties"]


def test_the_loader_rejects_the_internal_enhancement_field(tmp_path):
    path = tmp_path / "search.yaml"
    path.write_text(
        yaml.safe_dump({**document(), "unit_enhancements": {}}, allow_unicode=True),
        encoding="utf-8",
    )

    with pytest.raises(ConfigError, match="--player-data"):
        load_search_config(path)


def test_the_bundled_example_matches_the_schema():
    """同梱サンプルがSchemaの形と食い違わないこと。

    IDそのものは現行Catalogのものなので、サンプルに出てくるIDだけを載せた
    Catalogを組んで構造を検証する。
    """
    example = Path(__file__).parent.parent / "configs" / "search.example.yaml"
    document = yaml.safe_load(example.read_text(encoding="utf-8"))
    catalog = Catalog.model_validate(
        {
            "catalogRevision": "example",
            "units": [
                *(
                    {"unitDefinitionId": unit_id, "displayName": unit_id, "category": "PLAYABLE"}
                    for unit_id in document["unitPool"]
                ),
                {
                    "unitDefinitionId": document["enemy"]["unitDefinitionId"],
                    "displayName": "enemy",
                    "category": "EXERCISE_ENEMY",
                },
            ],
            "memories": [
                {"memoryDefinitionId": memory_id, "displayName": memory_id}
                for memory_id in document["memoryPool"]
            ],
        }
    )

    jsonschema.validate(document, build_search_json_schema(catalog))
