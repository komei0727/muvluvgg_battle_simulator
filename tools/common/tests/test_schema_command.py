"""各ラボの `schema` コマンドの共通部。共通Schema（編成ライブラリ1件・評価設定）と
ラボ固有のSchemaを、tools ルートの `.schema/` へ書き出す。"""

import dataclasses
import json

import httpx
import respx
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from mlgg_lab_common.cli import LabCommands, build_lab_app
from mlgg_lab_common.inputs.catalog import CATALOG_PATH, DEFAULT_BASE_URL
from mlgg_lab_common.inputs.schema import (
    FORMATION_LIBRARY_SCHEMA,
    SchemaFile,
    finish_schema,
    schema_name,
)
from mlgg_lab_common.reporting import FormatAnalyzer

CATALOG_BODY = {
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
}

LAB_SCHEMA = "fake.match.schema.json"
EVALUATION_SCHEMA = "battle.evaluation.schema.json"


def test_the_file_names_carry_the_format_prefix():
    assert schema_name("BATTLE", "match") == "battle.match.schema.json"
    assert schema_name("TOTAL_WAR", "evaluation") == "total-war.evaluation.schema.json"
    assert schema_name("TACTICAL_EXERCISE", "search") == "exercise.search.schema.json"


def _unused_planner(config_path, *, evaluation_id=None):
    raise AssertionError("schema は計画を作らない")


LAB = LabCommands(
    name="fake-lab",
    format="BATTLE",
    planner=_unused_planner,
    analyzer=FormatAnalyzer(
        format="BATTLE",
        statistics_version=1,
        completion_reasons=(),
        case_statistics=lambda observations: {},
        describe_statistics=lambda statistics: [],
        describe_match=lambda match: "",
    ),
    schemas=(
        SchemaFile(
            name=LAB_SCHEMA,
            label="対戦入力YAML",
            build=lambda catalog: finish_schema({"type": "object"}, catalog, title="fake match"),
        ),
    ),
)
app = build_lab_app(LAB, help="fake")
other_app = build_lab_app(
    dataclasses.replace(LAB, name="other-lab", format="TOTAL_WAR", schemas=()), help="other"
)
runner = CliRunner()


def mock_catalog():
    return respx.get(f"{DEFAULT_BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(200, json=CATALOG_BODY)
    )


def make_workspace(tmp_path):
    root = tmp_path / "tools"
    (root / "lab").mkdir(parents=True)
    (root / "pyproject.toml").write_text("[tool.uv.workspace]\nmembers = []\n", encoding="utf-8")
    return root


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


@respx.mock
def test_the_common_and_the_lab_schemas_are_written(tmp_path):
    mock_catalog()

    result = runner.invoke(app, ["schema", "--out", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        [EVALUATION_SCHEMA, FORMATION_LIBRARY_SCHEMA, LAB_SCHEMA]
    )


@respx.mock
def test_the_default_output_is_the_tools_root_wherever_it_runs(tmp_path, monkeypatch):
    mock_catalog()
    root = make_workspace(tmp_path)
    monkeypatch.chdir(root / "lab")

    result = runner.invoke(app, ["schema"])

    assert result.exit_code == 0, result.output
    assert (root / ".schema" / FORMATION_LIBRARY_SCHEMA).exists()
    assert not (root / "lab" / ".schema").exists()


def test_outside_a_workspace_the_output_must_be_given(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    # Catalogを取りに行く前に止める（respxで偽物を置いていないので、取りに行けば別の失敗になる）。
    result = runner.invoke(app, ["schema"])

    assert result.exit_code == 1
    assert "--out" in result.output
    assert not (tmp_path / ".schema").exists()


@respx.mock
def test_the_output_directory_is_created(tmp_path):
    mock_catalog()
    out = tmp_path / "nested" / ".schema"

    result = runner.invoke(app, ["schema", "--out", str(out)])

    assert result.exit_code == 0, result.output
    assert (out / LAB_SCHEMA).exists()


@respx.mock
def test_the_library_schema_carries_the_catalog_enums(tmp_path):
    mock_catalog()

    runner.invoke(app, ["schema", "--out", str(tmp_path)])

    schema = read(tmp_path / FORMATION_LIBRARY_SCHEMA)
    Draft202012Validator.check_schema(schema)
    assert schema["$defs"]["FormationUnitSpec"]["properties"]["unitDefinitionId"]["enum"] == [
        "UNIT_A"
    ]
    assert schema["properties"]["memoryDefinitionIds"]["items"]["enum"] == ["MEM_A"]
    assert "2026-08-16.3" in schema["description"]


@respx.mock
def test_the_evaluation_schema_accepts_only_the_lab_format(tmp_path):
    mock_catalog()
    runner.invoke(app, ["schema", "--out", str(tmp_path)])

    schema = read(tmp_path / EVALUATION_SCHEMA)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    config = {
        "format": "BATTLE",
        "seed": "s",
        "budget": {"maxSubmittedRuns": 10},
        "inputs": {"formationsDir": "../../data/inputs/formations"},
        "cases": [{"caseId": "a", "match": "match.yaml", "runs": 3}],
    }
    assert validator.is_valid(config), list(validator.iter_errors(config))
    assert not validator.is_valid(config | {"format": "TOTAL_WAR"})
    assert not validator.is_valid(config | {"unknown": 1})
    assert not validator.is_valid(config | {"cases": []})


@respx.mock
def test_the_console_shows_the_directive_line_for_each_schema(tmp_path):
    mock_catalog()

    result = runner.invoke(app, ["schema", "--out", str(tmp_path)])

    for name in (EVALUATION_SCHEMA, FORMATION_LIBRARY_SCHEMA, LAB_SCHEMA):
        assert name in result.output
    assert "yaml-language-server" in result.output


@respx.mock
def test_an_unreachable_server_is_reported_without_a_traceback(tmp_path):
    respx.get(f"{DEFAULT_BASE_URL}{CATALOG_PATH}").mock(side_effect=httpx.ConnectError("refused"))

    result = runner.invoke(app, ["schema", "--out", str(tmp_path)])

    assert result.exit_code == 1
    assert "APIへ到達できない" in result.output


@respx.mock
def test_labs_sharing_the_output_keep_their_own_evaluation_schemas(tmp_path):
    mock_catalog()

    runner.invoke(app, ["schema", "--out", str(tmp_path)])
    runner.invoke(other_app, ["schema", "--out", str(tmp_path)])

    battle = read(tmp_path / "battle.evaluation.schema.json")
    total_war = read(tmp_path / "total-war.evaluation.schema.json")
    assert battle["properties"]["format"]["const"] == "BATTLE"
    assert total_war["properties"]["format"]["const"] == "TOTAL_WAR"
