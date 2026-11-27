"""`exercise-lab schema` の出力。共通Schemaに加えて、演習の編成定義と探索設定のSchemaを書き出す。

出力先・共通Schemaの中身・失敗の伝え方は共通部（`common/tests/test_schema_command.py`）で固定する。
ここは演習が渡すSchemaの一覧と中身だけを見る。"""

import json

import httpx
import respx
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from exercise_lab.cli import app
from mlgg_lab_common.inputs.catalog import CATALOG_PATH
from mlgg_lab_common.inputs.schema import FORMATION_LIBRARY_SCHEMA

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
def test_the_common_and_the_exercise_schemas_are_written(tmp_path):
    mock_catalog()

    result = runner.invoke(app, ["schema", "--out", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        [
            "exercise.evaluation.schema.json",
            FORMATION_LIBRARY_SCHEMA,
            "exercise.match.schema.json",
            "exercise.search.schema.json",
        ]
    )


@respx.mock
def test_the_evaluation_schema_is_fixed_to_the_exercise_format(tmp_path):
    mock_catalog()
    runner.invoke(app, ["schema", "--out", str(tmp_path)])

    schema = json.loads((tmp_path / "exercise.evaluation.schema.json").read_text(encoding="utf-8"))
    assert schema["properties"]["format"]["const"] == "TACTICAL_EXERCISE"


@respx.mock
def test_the_match_schema_separates_the_ally_and_the_enemy_pools(tmp_path):
    mock_catalog()
    runner.invoke(app, ["schema", "--out", str(tmp_path)])

    schema = json.loads((tmp_path / "exercise.match.schema.json").read_text(encoding="utf-8"))
    definitions = schema["$defs"]
    assert definitions["FormationUnitSpec"]["properties"]["unitDefinitionId"]["enum"] == ["UNIT_A"]
    assert definitions["EnemySpec"]["properties"]["unitDefinitionId"]["enum"] == ["UNIT_ENEMY"]


@respx.mock
def test_the_search_schema_carries_the_catalog_enums_and_requires_enabled_pools(tmp_path):
    mock_catalog()
    result = runner.invoke(app, ["schema", "--out", str(tmp_path)])
    assert result.exit_code == 0, result.output

    schema = json.loads((tmp_path / "exercise.search.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    space = schema["$defs"]["ConfiguredSpace"]["properties"]
    assert space["unitPool"]["items"]["enum"] == ["UNIT_A"]
    assert space["memoryPool"]["items"]["enum"] == ["MEM_A"]
    assert schema["$defs"]["EnemySpec"]["properties"]["unitDefinitionId"]["enum"] == ["UNIT_ENEMY"]
    config = {
        "enemy": {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "FRONT"}},
        "starts": ["team", "variant"],
        "moves": {"replaceUnits": True, "replaceMemories": True},
        "objective": {"metric": "MEAN_SCORE"},
        "trials": {
            "screeningRuns": 10,
            "finalists": 1,
            "confirmationRuns": 20,
            "confirmationSeed": "c",
        },
        "execution": {"candidateSeed": "a", "battleSeed": "b", "budget": {"maxSubmittedRuns": 100}},
        "output": {"searchesDir": "searches"},
    }
    validator = Draft202012Validator(schema)
    assert not validator.is_valid(config)
    with_pools = config | {"space": {"unitPool": ["UNIT_A"], "memoryPool": ["MEM_A"]}}
    assert validator.is_valid(with_pools)
    assert not validator.is_valid(with_pools | {"starts": []})
