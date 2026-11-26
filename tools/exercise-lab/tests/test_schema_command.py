"""`lab schema` の出力。演習の編成YAMLと編成ライブラリのSchemaを書き出す。"""

import json

import httpx
import respx
from typer.testing import CliRunner

from exercise_lab.cli import app
from exercise_lab.inputs.catalog import CATALOG_PATH

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
def test_the_formation_and_library_schemas_are_written(tmp_path):
    mock_catalog()
    out = tmp_path / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert result.exit_code == 0, result.output
    # 編成ライブラリのSchema名は既存の `configs/formations/*.yaml` が指している名前を保つ。
    assert sorted(path.name for path in out.iterdir()) == [
        "formation-seed.schema.json",
        "formation.schema.json",
    ]


@respx.mock
def test_the_library_schema_carries_the_catalog_enums(tmp_path):
    mock_catalog()
    out = tmp_path / ".schema"

    runner.invoke(app, ["schema", "--out", str(out)])

    schema = json.loads((out / "formation-seed.schema.json").read_text(encoding="utf-8"))
    assert schema["$defs"]["AllyUnitSpec"]["properties"]["unitDefinitionId"]["enum"] == ["UNIT_A"]
    assert schema["properties"]["memoryDefinitionIds"]["items"]["enum"] == ["MEM_A"]
    assert "enemy" not in schema["properties"]


@respx.mock
def test_the_console_shows_the_directive_line_for_each_schema(tmp_path):
    mock_catalog()
    out = tmp_path / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert "formation.schema.json" in result.output
    assert "formation-seed.schema.json" in result.output
    assert "yaml-language-server" in result.output


@respx.mock
def test_the_output_directory_is_created(tmp_path):
    mock_catalog()
    out = tmp_path / "nested" / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert result.exit_code == 0, result.output
    assert (out / "formation.schema.json").exists()


@respx.mock
def test_an_unreachable_server_is_reported_without_a_traceback(tmp_path):
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(side_effect=httpx.ConnectError("refused"))

    result = runner.invoke(app, ["schema", "--out", str(tmp_path / ".schema")])

    assert result.exit_code == 1
    assert "APIへ到達できない" in result.output
