"""単発の演習実行（`POST /api/v1/tactical-exercises`）の応答読み取り。"""

import httpx
import pytest
import respx

from exercise_lab.api import (
    DETAILED_LOG_LEVEL,
    EXERCISE_PATH,
    LabApiClient,
    LabApiError,
    build_exercise_request,
)

BASE_URL = "http://localhost:3000"

RESPONSE = {
    "schemaVersion": 1,
    "battleId": "battle-1",
    "catalogRevision": "2026-08-01.1",
    "result": {
        "completionReason": "TURN_LIMIT_REACHED",
        "completedTurn": 5,
        "totalScore": 123456,
        "breakCount": 2,
        "breaks": [],
    },
    "initialState": {
        "units": [
            {
                "battleUnitId": "BU_1",
                "unitDefinitionId": "UNIT_A",
                "side": "ALLY",
                "formationPosition": {"column": 0, "row": "FRONT"},
            },
            {
                "battleUnitId": "BU_2",
                "unitDefinitionId": "UNIT_ENEMY",
                "side": "ENEMY",
                "formationPosition": {"column": 1, "row": "REAR"},
            },
        ]
    },
    "events": [
        {
            "sequence": 1,
            "type": "ACTION_QUEUE_CREATED",
            "category": "FACT",
            "targetUnitIds": [],
            "details": {
                "cycleNumber": 1,
                "reservations": [
                    {"battleUnitId": "BU_1", "reservedActionKind": "AS", "actionSpeed": 900},
                ],
            },
        }
    ],
    "unitSummaries": [
        {"battleUnitId": "BU_1", "side": "ALLY", "damageDealt": 1000, "damageTaken": 0}
    ],
}


def test_the_request_asks_for_the_detailed_log():
    body = build_exercise_request(
        ally_formation={"units": [], "memoryDefinitionIds": []},
        enemy_formation={"units": [], "memoryDefinitionIds": []},
    )

    assert body["options"] == {"logLevel": DETAILED_LOG_LEVEL}
    assert set(body) == {"allyFormation", "enemyFormation", "options"}


@respx.mock
def test_the_response_exposes_the_roster_and_the_events():
    respx.post(f"{BASE_URL}{EXERCISE_PATH}").mock(return_value=httpx.Response(200, json=RESPONSE))

    with LabApiClient(BASE_URL) as client:
        response = client.simulate_exercise({"allyFormation": {}, "enemyFormation": {}})

    assert response.catalog_revision == "2026-08-01.1"
    assert response.total_score == 123456
    assert response.roster()["BU_1"].unit_definition_id == "UNIT_A"
    assert response.roster()["BU_2"].side == "ENEMY"
    assert response.events[0].type == "ACTION_QUEUE_CREATED"
    assert response.events[0].details["reservations"][0]["battleUnitId"] == "BU_1"


@respx.mock
def test_an_error_response_is_reported_without_a_traceback():
    respx.post(f"{BASE_URL}{EXERCISE_PATH}").mock(
        return_value=httpx.Response(
            422, json={"error": {"code": "INVALID_COMMAND", "message": "だめ"}}
        )
    )

    with LabApiClient(BASE_URL) as client, pytest.raises(LabApiError) as error:
        client.simulate_exercise({"allyFormation": {}, "enemyFormation": {}})

    assert "INVALID_COMMAND" in str(error.value)
