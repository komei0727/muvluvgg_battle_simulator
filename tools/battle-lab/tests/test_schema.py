"""通常戦闘の対戦入力YAML用の JSON Schema と、`battle-lab schema` の出力。

ローダー（`load_battle_match_file`）が受理する形——インライン編成と `{ library: <id> }`
参照、規定ターン数の値域、両陣営とも `PLAYABLE`——を実際に検証器へ通して固定する。
"""

import json
from pathlib import Path

import httpx
import respx
import yaml
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from battle_lab.cli import app
from battle_lab.schema import build_battle_match_json_schema
from mlgg_lab_common.inputs.catalog import CATALOG_PATH, DEFAULT_BASE_URL
from mlgg_lab_common.inputs.schema import FORMATION_LIBRARY_SCHEMA
from mlgg_lab_common.testing import catalog_of_references

CONFIGS = Path(__file__).resolve().parents[1] / "configs"
EXAMPLE = yaml.safe_load((CONFIGS / "match.example.yaml").read_text(encoding="utf-8"))
CATALOG = catalog_of_references(EXAMPLE)
VALIDATOR = Draft202012Validator(build_battle_match_json_schema(CATALOG))
UNIT = EXAMPLE["allyFormation"]["units"][0]["unitDefinitionId"]


def match(**overrides):
    document = {
        "turnLimit": 15,
        "allyFormation": {
            "units": [{"unitDefinitionId": UNIT, "position": {"column": 0, "row": "FRONT"}}]
        },
        "enemyFormation": {"library": "rival"},
    }
    return document | overrides


def test_the_schema_is_valid_json_schema():
    Draft202012Validator.check_schema(build_battle_match_json_schema(CATALOG))


def test_the_example_passes():
    assert VALIDATOR.is_valid(EXAMPLE), list(VALIDATOR.iter_errors(EXAMPLE))


def test_a_library_reference_is_accepted_but_not_mixed_with_contents():
    assert VALIDATOR.is_valid(match())
    assert not VALIDATOR.is_valid(match(enemyFormation={"library": "rival", "units": []}))
    assert not VALIDATOR.is_valid(match(enemyFormation={"library": ""}))


def test_an_unknown_unit_is_rejected():
    ally = {"units": [{"unitDefinitionId": "UNIT_NOPE", "position": {"column": 0, "row": "FRONT"}}]}

    assert not VALIDATOR.is_valid(match(allyFormation=ally))


def test_the_turn_limit_range_is_enforced():
    assert VALIDATOR.is_valid(match(turnLimit=1))
    assert VALIDATOR.is_valid(match(turnLimit=99))
    assert not VALIDATOR.is_valid(match(turnLimit=0))
    assert not VALIDATOR.is_valid(match(turnLimit=100))
    assert not VALIDATOR.is_valid({k: v for k, v in match().items() if k != "turnLimit"})


def test_unit_enhancement_needs_academy_levels():
    unit = {"unitDefinitionId": UNIT, "position": {"column": 0, "row": "FRONT"}, "level": 240}

    assert not VALIDATOR.is_valid(match(allyFormation={"units": [unit]}))


def test_unknown_keys_are_rejected():
    assert not VALIDATOR.is_valid(match(turnLimits=15))


@respx.mock
def test_the_schema_command_writes_the_common_and_the_battle_schemas(tmp_path):
    respx.get(f"{DEFAULT_BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(200, json=CATALOG.model_dump(by_alias=True))
    )

    result = CliRunner().invoke(app, ["schema", "--out", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        ["battle.evaluation.schema.json", FORMATION_LIBRARY_SCHEMA, "battle.match.schema.json"]
    )
    evaluation = json.loads(
        (tmp_path / "battle.evaluation.schema.json").read_text(encoding="utf-8")
    )
    assert evaluation["properties"]["format"]["const"] == "BATTLE"
