"""`lab` が提供するコマンドの範囲と、Catalog取得の失敗の伝え方。"""

import httpx
import pytest
import respx
from typer.testing import CliRunner

from exercise_lab.cli import app
from mlgg_lab_common.inputs.catalog import CATALOG_PATH, CatalogClient, LabApiError

BASE_URL = "http://localhost:3000"
INPUT_COMMANDS = ("import-draft", "units", "memories", "formations", "schema")

runner = CliRunner()


def test_help_lists_exactly_the_input_commands():
    result = runner.invoke(app, ["--help"])

    assert result.exit_code == 0, result.output
    for command in INPUT_COMMANDS:
        assert command in result.output


@pytest.mark.parametrize(
    "command", ["stats", "optimize", "compare", "gear-sensitivity", "gear-plan"]
)
def test_the_removed_analysis_commands_are_gone(command):
    result = runner.invoke(app, [command, "--help"])

    assert result.exit_code != 0


@pytest.mark.parametrize("command", INPUT_COMMANDS)
def test_each_input_command_has_help(command):
    result = runner.invoke(app, [command, "--help"])

    assert result.exit_code == 0, result.output


@respx.mock
def test_the_catalog_is_fetched_from_the_base_url():
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(
            200,
            json={
                "catalogRevision": "rev",
                "units": [
                    {
                        "unitDefinitionId": "UNIT_A",
                        "displayName": "A",
                        "category": "PLAYABLE",
                        "attribute": "CUTE",
                        "unitType": "ENERGY",
                        "positionAptitudes": ["FRONT"],
                        # 応答に将来増えた項目では壊れない。
                        "futureField": 1,
                    }
                ],
                "memories": [],
                "gearEffects": [
                    {
                        "stat": "ATTACK",
                        "values": [{"tier": "III", "grade": "S", "percentagePoints": 6.0}],
                    }
                ],
            },
        )
    )

    with CatalogClient(BASE_URL + "/") as client:
        catalog = client.fetch_catalog()

    unit = catalog.unit("UNIT_A")
    assert catalog.catalog_revision == "rev"
    assert unit is not None
    assert (unit.attribute, unit.unit_type, unit.position_aptitudes) == (
        "CUTE",
        "ENERGY",
        ["FRONT"],
    )
    assert catalog.gear_effects[0].values[0].percentage_points == 6.0


@respx.mock
def test_an_error_response_carries_the_code_and_the_violations():
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(
            503,
            json={
                "error": {
                    "code": "CATALOG_UNAVAILABLE",
                    "message": "not ready",
                    "violations": [{"path": "catalog", "ruleId": "R-X", "message": "missing"}],
                }
            },
        )
    )

    with CatalogClient(BASE_URL) as client, pytest.raises(LabApiError) as caught:
        client.fetch_catalog()

    message = str(caught.value)
    assert "503 CATALOG_UNAVAILABLE: not ready" in message
    assert "catalog R-X missing" in message


@respx.mock
def test_a_response_outside_the_contract_is_an_explained_error():
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(200, json={"units": []})
    )

    with CatalogClient(BASE_URL) as client, pytest.raises(LabApiError, match="契約と合わない"):
        client.fetch_catalog()


@respx.mock
def test_an_unreachable_server_is_reported_without_a_traceback():
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(side_effect=httpx.ConnectError("refused"))

    result = runner.invoke(app, ["units"])

    assert result.exit_code == 1
    assert "APIへ到達できない" in result.output
