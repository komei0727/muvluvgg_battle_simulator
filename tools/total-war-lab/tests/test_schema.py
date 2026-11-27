"""総力戦の対戦入力YAML用の JSON Schema と、`total-war-lab schema` の出力。

ローダー（`load_total_war_match_file`）が受理する形——各陣営1～3編成の出撃順の列、
各要素はインライン編成か `{ library: <id> }` 参照、規定ターン数は書けない——を固定する。
編成内の重複（R-TWR-01 #3／#4）はJSON Schemaで表せないため、ローダーだけが落とす。
"""

import json
from pathlib import Path

import httpx
import respx
import yaml
from jsonschema import Draft202012Validator
from typer.testing import CliRunner

from mlgg_lab_common.inputs.catalog import CATALOG_PATH, DEFAULT_BASE_URL
from mlgg_lab_common.inputs.schema import FORMATION_LIBRARY_SCHEMA
from mlgg_lab_common.testing import catalog_of_references
from total_war_lab.cli import app
from total_war_lab.schema import build_total_war_match_json_schema

CONFIGS = Path(__file__).resolve().parents[1] / "configs"
EXAMPLE = yaml.safe_load((CONFIGS / "match.example.yaml").read_text(encoding="utf-8"))
CATALOG = catalog_of_references(EXAMPLE)
VALIDATOR = Draft202012Validator(build_total_war_match_json_schema(CATALOG))
INLINE = EXAMPLE["allyFormations"][0]


def match(**overrides):
    return {"allyFormations": [INLINE], "enemyFormations": [{"library": "rival"}]} | overrides


def test_the_schema_is_valid_json_schema():
    Draft202012Validator.check_schema(build_total_war_match_json_schema(CATALOG))


def test_the_example_passes():
    assert VALIDATOR.is_valid(EXAMPLE), list(VALIDATOR.iter_errors(EXAMPLE))


def test_library_references_and_inline_formations_can_be_mixed():
    assert VALIDATOR.is_valid(match(allyFormations=[INLINE, {"library": "second"}]))
    assert not VALIDATOR.is_valid(match(enemyFormations=[{"library": "rival", "units": []}]))


def test_one_to_three_formations_per_side():
    assert VALIDATOR.is_valid(match(allyFormations=[INLINE] * 3))
    assert not VALIDATOR.is_valid(match(allyFormations=[INLINE] * 4))
    assert not VALIDATOR.is_valid(match(allyFormations=[]))


def test_the_turn_limit_cannot_be_written():
    assert not VALIDATOR.is_valid(match(turnLimit=15))


def test_a_memory_repeated_within_a_formation_is_rejected():
    memories = INLINE["memoryDefinitionIds"]
    repeated = INLINE | {"memoryDefinitionIds": [memories[0], memories[0]]}

    assert not VALIDATOR.is_valid(match(allyFormations=[repeated]))
    # 別の編成への再登場は可（R-TWR-01 #4）。
    assert VALIDATOR.is_valid(match(allyFormations=[INLINE, INLINE]))


def test_an_unknown_memory_is_rejected():
    formation = INLINE | {"memoryDefinitionIds": ["MEM_NOPE"]}

    assert not VALIDATOR.is_valid(match(allyFormations=[formation]))


@respx.mock
def test_the_schema_command_writes_the_common_and_the_total_war_schemas(tmp_path):
    respx.get(f"{DEFAULT_BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(200, json=CATALOG.model_dump(by_alias=True))
    )

    result = CliRunner().invoke(app, ["schema", "--out", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        [
            "total-war.evaluation.schema.json",
            FORMATION_LIBRARY_SCHEMA,
            "total-war.match.schema.json",
        ]
    )
    evaluation = json.loads(
        (tmp_path / "total-war.evaluation.schema.json").read_text(encoding="utf-8")
    )
    assert evaluation["properties"]["format"]["const"] == "TOTAL_WAR"
