"""`lab schema` の出力。編成YAMLと探索設定YAMLの両方のSchemaを書き出す。"""

import json

import httpx
import respx
from typer.testing import CliRunner

from exercise_lab.api import CATALOG_PATH
from exercise_lab.cli import app

BASE_URL = "http://localhost:3000"

CATALOG_BODY = {
    "schemaVersion": 1,
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
            "unitDefinitionId": "UNIT_ENEMY",
            "displayName": "【え】エー",
            "characterName": "エー",
            "category": "EXERCISE_ENEMY",
            "role": "TANK",
            "positionAptitudes": ["FRONT"],
        },
    ],
    "memories": [{"memoryDefinitionId": "MEM_A", "displayName": "めもりーA"}],
    "gearEffects": [],
}

runner = CliRunner()


def mock_catalog():
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG_BODY))


@respx.mock
def test_both_schemas_are_written(tmp_path):
    mock_catalog()
    out = tmp_path / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in out.iterdir()) == [
        "formation.schema.json",
        "search.schema.json",
    ]


@respx.mock
def test_the_search_schema_carries_the_pool_enums(tmp_path):
    mock_catalog()
    out = tmp_path / ".schema"

    runner.invoke(app, ["schema", "--out", str(out)])

    schema = json.loads((out / "search.schema.json").read_text(encoding="utf-8"))
    assert schema["properties"]["unitPool"]["items"]["enum"] == ["UNIT_A"]
    assert schema["properties"]["memoryPool"]["items"]["enum"] == ["MEM_A"]


@respx.mock
def test_the_console_shows_the_directive_line_for_each_schema(tmp_path):
    mock_catalog()
    out = tmp_path / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert "formation.schema.json" in result.output
    assert "search.schema.json" in result.output
    assert "yaml-language-server" in result.output


@respx.mock
def test_the_output_directory_is_created(tmp_path):
    mock_catalog()
    out = tmp_path / "nested" / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert result.exit_code == 0, result.output
    assert (out / "search.schema.json").exists()


@respx.mock
def test_an_unreachable_server_is_reported_without_a_traceback(tmp_path):
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(side_effect=httpx.ConnectError("refused"))

    result = runner.invoke(app, ["schema", "--out", str(tmp_path / ".schema")])

    assert result.exit_code == 1
    assert "APIへ到達できない" in result.output


@respx.mock
def test_the_console_says_which_commands_read_the_formation_schema(tmp_path):
    """ギア分析（gear-sensitivity / gear-plan）が読むのも編成定義YAMLである。"""
    mock_catalog()

    result = runner.invoke(app, ["schema", "--out", str(tmp_path / ".schema")])

    assert "ギア分析" in result.output
