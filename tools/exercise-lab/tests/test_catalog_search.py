"""カタログ検索（`lab units` / `lab memories`）の絞り込みと出力形式。"""

import json

import httpx
import pytest
import respx
from typer.testing import CliRunner

from exercise_lab.api import CATALOG_PATH, Catalog, search_memories, search_units
from exercise_lab.cli import app

BASE_URL = "http://localhost:3000"

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

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {
        "unitTypes": {"PHYSICAL": 99, "ENERGY": 100, "AGILE": 101},
        "attributes": {
            "AGGRESSIVE": 102,
            "SHY": 103,
            "CUTE": 101,
            "SMART": 102,
            "COMICAL": 26,
            "CLEVER": 27,
        },
    },
    "units": {"UNIT_KOTOHA_REBEL": {"level": 297, "gears": [None] * 9}},
}

CATALOG = Catalog.model_validate(CATALOG_BODY)
runner = CliRunner()


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


@respx.mock
def test_units_command_yaml_output_is_pasteable(tmp_path):
    _mock_catalog()

    result = runner.invoke(app, ["units", "--grep", "反逆", "--yaml", "--base-url", BASE_URL])

    assert result.exit_code == 0, result.output
    assert "- unitDefinitionId: UNIT_KOTOHA_REBEL" in result.output


@respx.mock
def test_memories_command_yaml_output_is_pasteable():
    _mock_catalog()

    result = runner.invoke(app, ["memories", "--grep", "心", "--yaml", "--base-url", BASE_URL])

    assert result.exit_code == 0, result.output
    assert "- MEM_HEART_COLOR" in result.output


@respx.mock
def test_units_command_owned_filter_uses_the_player_data(tmp_path):
    _mock_catalog()
    player_data = tmp_path / "player-data.json"
    player_data.write_text(json.dumps(PLAYER_DATA), encoding="utf-8")

    result = runner.invoke(
        app,
        ["units", "--owned", "--player-data", str(player_data), "--base-url", BASE_URL],
    )

    assert result.exit_code == 0, result.output
    assert "UNIT_KOTOHA_REBEL" in result.output
    assert "UNIT_SHOUKA_BEACH" not in result.output


@respx.mock
def test_owned_without_player_data_is_an_explained_error():
    _mock_catalog()

    result = runner.invoke(app, ["units", "--owned", "--base-url", BASE_URL])

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)


@respx.mock
def test_no_match_is_reported_rather_than_printing_an_empty_table():
    _mock_catalog()

    result = runner.invoke(app, ["units", "--grep", "存在しない", "--base-url", BASE_URL])

    assert result.exit_code == 1


def _mock_catalog() -> None:
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG_BODY))


@pytest.fixture(autouse=True)
def _wide_console(monkeypatch):
    # richがターミナル幅でIDを折り返すと、出力の検査が幅に依存してしまう。
    monkeypatch.setenv("COLUMNS", "200")


@respx.mock
def test_ids_stay_intact_on_one_line_on_a_narrow_terminal(monkeypatch):
    # IDを引くための道具なので、幅が足りないときに削ってよいのは表示名の側だけ。
    # 省略も折り返しもされずに1行へ収まっていないと、出力からそのままコピーできない。
    monkeypatch.setenv("COLUMNS", "60")
    _mock_catalog()

    result = runner.invoke(app, ["units", "--grep", "反逆", "--base-url", BASE_URL])

    assert result.exit_code == 0, result.output
    assert _has_line_containing(result.output, "UNIT_KOTOHA_REBEL")


@respx.mock
def test_memory_ids_stay_intact_on_one_line_on_a_narrow_terminal(monkeypatch):
    monkeypatch.setenv("COLUMNS", "40")
    _mock_catalog()

    result = runner.invoke(app, ["memories", "--grep", "絶対", "--base-url", BASE_URL])

    assert result.exit_code == 0, result.output
    assert _has_line_containing(result.output, "MEM_ABSOLUTE_ORDER")


def _has_line_containing(output: str, needle: str) -> bool:
    return any(needle in line for line in output.splitlines())
