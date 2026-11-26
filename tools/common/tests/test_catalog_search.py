"""Catalogの検索（ID・表示名・キャラクター名の部分一致、カテゴリ・手持ちの絞り込み）。"""

from mlgg_lab_common.inputs.catalog import Catalog, search_memories, search_units

CATALOG_BODY = {
    "schemaVersion": 1,
    "catalogRevision": "2026-08-16.3",
    "units": [
        {
            "unitDefinitionId": "UNIT_KOTOHA_REBEL",
            "displayName": "【世界への反逆者】コトハ",
            "characterName": "コトハ",
            "category": "PLAYABLE",
            "role": "PHYSICAL_ATTACKER",
            "positionAptitudes": ["FRONT"],
        },
        {
            "unitDefinitionId": "UNIT_SHOUKA_BEACH",
            "displayName": "【渚の小花】ショウカ",
            "characterName": "ショウカ",
            "category": "PLAYABLE",
            "role": "SUPPORT",
            "positionAptitudes": ["BACK"],
        },
        {
            "unitDefinitionId": "UNIT_AOI_GUARDIAN_TEX",
            "displayName": "【守護者】アオイ",
            "characterName": "アオイ",
            "category": "EXERCISE_ENEMY",
            "role": "TANK",
            "positionAptitudes": ["FRONT"],
            "exerciseActive": True,
        },
    ],
    "memories": [
        {"memoryDefinitionId": "MEM_HEART_COLOR", "displayName": "心の色"},
        {"memoryDefinitionId": "MEM_ABSOLUTE_ORDER", "displayName": "絶対命令行使権！"},
    ],
    "gearEffects": [],
}

CATALOG = Catalog.model_validate(CATALOG_BODY)


def test_units_are_searched_by_display_name_character_name_and_id():
    assert [unit.unit_definition_id for unit in search_units(CATALOG, query="反逆")] == [
        "UNIT_KOTOHA_REBEL"
    ]
    assert [unit.unit_definition_id for unit in search_units(CATALOG, query="ショウカ")] == [
        "UNIT_SHOUKA_BEACH"
    ]
    assert [unit.unit_definition_id for unit in search_units(CATALOG, query="GUARDIAN")] == [
        "UNIT_AOI_GUARDIAN_TEX"
    ]


def test_unit_search_ignores_case_for_ids():
    assert [unit.unit_definition_id for unit in search_units(CATALOG, query="kotoha")] == [
        "UNIT_KOTOHA_REBEL"
    ]


def test_units_can_be_limited_to_a_category():
    found = search_units(CATALOG, category="EXERCISE_ENEMY")

    assert [unit.unit_definition_id for unit in found] == ["UNIT_AOI_GUARDIAN_TEX"]


def test_units_can_be_limited_to_the_owned_roster():
    found = search_units(CATALOG, owned_ids={"UNIT_KOTOHA_REBEL"})

    assert [unit.unit_definition_id for unit in found] == ["UNIT_KOTOHA_REBEL"]


def test_unit_results_are_sorted_by_id():
    assert [unit.unit_definition_id for unit in search_units(CATALOG)] == [
        "UNIT_AOI_GUARDIAN_TEX",
        "UNIT_KOTOHA_REBEL",
        "UNIT_SHOUKA_BEACH",
    ]


def test_memories_are_searched_by_display_name_and_id():
    assert [memory.memory_definition_id for memory in search_memories(CATALOG, query="心")] == [
        "MEM_HEART_COLOR"
    ]
    assert [memory.memory_definition_id for memory in search_memories(CATALOG, query="ORDER")] == [
        "MEM_ABSOLUTE_ORDER"
    ]
