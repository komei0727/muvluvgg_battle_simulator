"""チャットがCLIだけで候補・中断・対応比較・詳細再生を扱える。"""

import json
from pathlib import Path

import httpx
import respx
from typer.testing import CliRunner

from exercise_lab.cli import app
from mlgg_lab_common.inputs.catalog import CATALOG_PATH
from mlgg_lab_common.testing import FakeEvaluationServer

URL = "http://localhost:3000"
EVALUATION_PATH = "/api/v1/tactical-exercise-evaluations"


def invoke(*args, payload=None, code=0):
    result = CliRunner().invoke(
        app, list(map(str, args)), input=None if payload is None else json.dumps(payload)
    )
    assert result.exit_code == code, (result.output, result.exception)
    return json.loads(result.stdout)


@respx.mock
def test_search_cli_resumes_and_replays_paired_trials(tmp_path):
    config = tmp_path / "evaluation.yaml"
    config.write_text(
        """enemy: {unitDefinitionId: UNIT_E, position: {column: 0, row: FRONT}}
starts: [first, second]
inputs: {formationsDir: formations}
moves: {replaceMemories: true, replaceUnits: true}
space: {memoryPool: [MEM_A, MEM_B], unitPool: [UNIT_A, UNIT_B]}
objective: {metric: EXPECTED_DAILY_BEST, bestOf: 2}
trials: {screeningRuns: 2, finalists: 1, confirmationRuns: 2, confirmationSeed: holdout}
execution:
  candidateSeed: choices
  battleSeed: pilot
  budget: {maxSubmittedRuns: 24}
output: {searchesDir: searches}
""",
        encoding="utf-8",
    )
    formations = tmp_path / "formations"
    formations.mkdir()
    for name, column in (("first", 0), ("second", 1)):
        (formations / f"{name}.yaml").write_text(
            f"""units: [{{unitDefinitionId: UNIT_A, position: {{column: {column}, row: REAR}}}}]
memoryDefinitionIds: [MEM_A]
""",
            encoding="utf-8",
        )
    respx.get(URL + CATALOG_PATH, headers={"Authorization": "Bearer secret"}).respond(
        200,
        json={
            "catalogRevision": "cat-1",
            "units": [
                {"unitDefinitionId": uid, "displayName": uid, "category": category}
                for uid, category in (
                    ("UNIT_A", "PLAYABLE"),
                    ("UNIT_B", "PLAYABLE"),
                    ("UNIT_E", "EXERCISE_ENEMY"),
                )
            ],
            "memories": [
                {"memoryDefinitionId": mid, "displayName": mid} for mid in ("MEM_A", "MEM_B")
            ],
        },
    )
    server = FakeEvaluationServer(complete_limit=1)

    def evaluate(request):
        exchange = server.post_json(EVALUATION_PATH, json.loads(request.content))
        return httpx.Response(200, content=exchange.body)

    respx.post(URL + EVALUATION_PATH).mock(side_effect=evaluate)
    start = invoke("search", "init", config, "--access-key", "secret")
    directory = start["searchDir"]
    baseline, other = (row["candidateId"] for row in start["initialCandidates"])
    assert baseline != other
    assert start["budget"]["reservedForConfirmation"] == 6
    chosen = invoke("search", "candidates", directory, "--parent", baseline, "--kind", "memory")
    [change] = chosen["candidates"]
    [unit_change] = invoke(
        "search", "candidates", directory, "--parent", baseline, "--kind", "unit"
    )["candidates"]
    assert unit_change["candidate"]["units"][0]["unitDefinitionId"] == "UNIT_B"
    candidate = change["candidateId"]
    command = {"id": "pilot", "candidateIds": [baseline], "proposals": [change["proposal"]]}
    paused = invoke("search", "round", directory, "-", "--max-requests", 1, payload=command, code=2)
    assert paused["openRound"]["completedRuns"] == 1
    assert paused["budget"]["submitted"] == 4
    assert paused["openRound"]["requests"][1]["candidateId"] == candidate
    done = invoke("search", "resume", directory, "--max-runs-per-request", 2)
    assert done["openRound"] is None
    assert [
        sum(len(case["runIndices"]) for case in request["cases"]) for request in server.requests
    ] == [4, 1, 1, 1]
    assert done["budget"]["submitted"] == 7
    status = invoke("search", "status", directory, "--trials")
    assert status["rounds"][0]["requests"][0]["completedRunIndices"] == [0, 1]
    assert invoke("search", "round", directory, "-", payload=command)["budget"] == done["budget"]
    rejected = invoke("search", "round", directory, "-", payload=command | {"runs": 3}, code=1)
    assert rejected["execution"]["stopReason"] == "INVALID_REQUEST"

    server.complete_limit = None
    confirm = {"id": "holdout", "phase": "confirmation", "candidateIds": [baseline, candidate]}
    done = invoke("search", "round", directory, "-", payload=confirm)
    assert done["budget"]["submitted"] == 11
    assert done["budget"]["reservedForConfirmation"] == 2
    assert [case["runIndices"] for case in server.requests[-1]["cases"]] == [[0, 1], [0, 1]]
    report = invoke(
        "compare", directory, "--baseline", baseline, "--phase", "confirmation", "--json"
    )
    first, unmatched = report["comparisons"]
    assert first["candidateId"] == candidate
    assert first["pairedRuns"] == 2 and unmatched["pairedRuns"] == 0
    assert first["expectedBest"]["confidenceInterval95"] is not None
    assert first["changes"]["memories"] == {"before": ["MEM_A"], "after": ["MEM_B"]}
    trial = first["representativeTrials"]["largestGain"]["candidate"]

    def replay(request):
        payload = json.loads(request.content)
        assert set(payload) == {"allyFormation", "enemyFormation", "replay"}
        replay_spec = payload["replay"]
        assert replay_spec == {
            "seed": "holdout",
            "runIndex": trial["runIndex"],
            "expectedCatalogRevision": server.catalog_revision,
            "expectedEngineRevision": server.engine_revision,
            "expectedSeedDerivationVersion": server.seed_derivation_version,
        }
        formations = {key: payload[key] for key in ("allyFormation", "enemyFormation")}
        result = server.post_json(
            EVALUATION_PATH,
            {
                "seed": replay_spec["seed"],
                "cases": [
                    formations | {"caseId": "replay", "runIndices": [replay_spec["runIndex"]]}
                ],
            },
        )
        saved = json.loads(result.body)["cases"][0]["runs"][0]
        score = saved["totalScore"]
        return httpx.Response(
            200,
            json={
                "result": {
                    key: saved[key]
                    for key in ("totalScore", "breakCount", "completedTurn", "completionReason")
                },
                "catalogRevision": server.catalog_revision,
                "initialState": {"units": []},
                "stateTransitions": [],
                "events": [
                    {
                        "sequence": 1,
                        "turnNumber": 1,
                        "type": "EXERCISE_SCORE_ACCUMULATED",
                        "details": {"totalScore": score},
                    }
                ],
            },
        )

    respx.post(URL + "/api/v1/tactical-exercises").mock(side_effect=replay)
    inspected = invoke(
        "inspect",
        directory,
        "--phase",
        "confirmation",
        "--candidate",
        candidate,
        "--baseline",
        baseline,
        "--run-index",
        trial["runIndex"],
        "--evaluation-id",
        trial["evaluationId"],
    )
    [pair] = inspected["trials"]
    assert pair["delta"]["totalScore"] == pair["delta"]["scoreByTurn"]["1"]
    assert Path(pair["candidate"]["tracePath"]).is_file()
