"""`exercise-lab units` / `exercise-lab memories` の出力形式。"""

import json

import httpx
import pytest
import respx
from typer.testing import CliRunner

from exercise_lab.cli import app
from mlgg_lab_common.inputs.catalog import CATALOG_PATH

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

runner = CliRunner()


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
def test_owned_level_column_shows_the_resolved_level_with_a_link_marker(tmp_path):
    """リンク由来の値には印を付ける。YAMLへ書き写すときの取り違えを減らす。"""
    _mock_catalog()
    player_data = tmp_path / "player-data.json"
    player_data.write_text(
        json.dumps({**PLAYER_DATA, "levelLink": {"enabled": True, "level": 250}}),
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        ["units", "--owned", "--player-data", str(player_data), "--base-url", BASE_URL],
    )

    assert result.exit_code == 0, result.output
    assert "250*" in result.output
    assert "297" not in result.output


@respx.mock
def test_owned_level_column_shows_the_stored_level_without_a_link(tmp_path):
    _mock_catalog()
    player_data = tmp_path / "player-data.json"
    player_data.write_text(json.dumps(PLAYER_DATA), encoding="utf-8")

    result = runner.invoke(
        app,
        ["units", "--owned", "--player-data", str(player_data), "--base-url", BASE_URL],
    )

    assert result.exit_code == 0, result.output
    assert "297" in result.output
    assert "*" not in result.output


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
