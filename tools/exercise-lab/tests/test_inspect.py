"""`exercise-lab inspect`: 保存済みの試行を単発演習APIで詳細ログ付きに再生する。

評価実行のDBに残した seed・対戦条件・試行番号・実行環境から `replay` を組み立てて
`POST /api/v1/tactical-exercises` へ送り、保存値と照合してから詳細ログを保存する。
"""

import dataclasses
import json
from typing import Any

import typer
from typer.testing import CliRunner

from exercise_lab.cli import LAB
from exercise_lab.cli import app as real_app
from exercise_lab.inspect import REPLAY_PATH, register_inspect_command
from mlgg_lab_common.api.client import HttpExchange
from mlgg_lab_common.cli import (
    EXIT_INPUT_ERROR,
    EXIT_OK,
    EXIT_RUN_FAILED,
    register_evaluation_commands,
)
from mlgg_lab_common.testing import FakeEvaluationServer, draft_json

runner = CliRunner()

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {}, "attributes": {}},
    "units": {},
}
EVALUATIONS_PATH = "/api/v1/tactical-exercise-evaluations"


class FakeReplayServer:
    """評価APIの偽物に単発演習の再生を足す。再生の結果は同じ `(seed, 対戦条件, runIndex)` の
    評価結果と一致する（実APIと同じ性質）。`tamper` で応答を書き換えられる。"""

    def __init__(self, evaluation: FakeEvaluationServer) -> None:
        self.evaluation = evaluation
        self.replays: list[tuple[str, dict[str, Any]]] = []
        self.tamper: Any = None
        self.status: tuple[int, str, str] | None = None

    def post_json(self, path: str, payload: dict[str, Any]) -> HttpExchange:
        if path != REPLAY_PATH:
            return self.evaluation.post_json(path, payload)
        self.replays.append((path, payload))
        if self.status is not None:
            status, code, violation = self.status
            body = {
                "error": {
                    "code": code,
                    "message": "fake",
                    "violations": [{"path": violation, "message": "v"}],
                }
            }
            return HttpExchange(status, json.dumps(body), None, "t0", "t1")
        replay = payload["replay"]
        match = {k: v for k, v in payload.items() if k not in ("replay", "options")}
        run = self.evaluation._observe(
            EVALUATIONS_PATH, replay["seed"], {"caseId": "-"}, match, replay["runIndex"]
        )
        body: dict[str, Any] = {
            "schemaVersion": 1,
            "battleId": "B_REPLAY",
            "catalogRevision": self.evaluation.catalog_revision,
            "result": {
                "totalScore": run["totalScore"],
                "breakCount": run["breakCount"],
                "completionReason": run["completionReason"],
                "completedTurn": run["completedTurn"],
                "breaks": [],
            },
            "initialState": {"units": []},
            "stateTransitions": [{"delta": {}}],
            "unitSummaries": [],
            "events": [{"sequence": 1, "type": "BATTLE_STARTED"}],
        }
        if self.tamper is not None:
            self.tamper(body)
        return HttpExchange(200, json.dumps(body), None, "t0", "t1")


def app_with(server: FakeReplayServer) -> typer.Typer:
    app = typer.Typer()
    lab = dataclasses.replace(LAB, transport_factory=lambda s, k: server, sleep=lambda s: None)
    register_evaluation_commands(app, lab)
    register_inspect_command(app, lab)
    return app


def evaluated(tmp_path) -> tuple[Any, FakeReplayServer]:
    inputs = tmp_path / "data/inputs"
    (inputs / "drafts").mkdir(parents=True)
    (inputs / "player-data").mkdir()
    (inputs / "drafts/exercise.json").write_text(json.dumps(draft_json()), encoding="utf-8")
    (inputs / "player-data/player-data.json").write_text(json.dumps(PLAYER_DATA))
    config = tmp_path / "evaluation.yaml"
    config.write_text(
        "format: TACTICAL_EXERCISE\nseed: ex-1\nbudget: { maxSubmittedRuns: 100 }\n"
        "inputs:\n  playerData: data/inputs/player-data/player-data.json\n"
        "output: { evaluationsDir: data/evaluations }\n"
        "cases:\n"
        "  - { caseId: draft, draft: data/inputs/drafts/exercise.json, runIndices: [3, 8] }\n"
    )
    server = FakeReplayServer(FakeEvaluationServer())
    result = runner.invoke(
        app_with(server), ["evaluate", str(config), "--evaluation-id", "x"], catch_exceptions=False
    )
    assert result.exit_code == EXIT_OK, result.output
    return tmp_path / "data/evaluations/x", server


def test_the_real_app_has_inspect():
    assert "inspect" in typer.main.get_command(real_app).commands


def test_inspect_replays_the_saved_run_through_the_single_exercise_api_and_saves_the_log(tmp_path):
    directory, server = evaluated(tmp_path)

    result = runner.invoke(
        app_with(server),
        ["inspect", str(directory), "--case", "draft", "--run", "8"],
        catch_exceptions=False,
    )

    assert result.exit_code == EXIT_OK, result.output
    [(path, body)] = server.replays
    assert path == REPLAY_PATH
    evaluation_request = server.evaluation.requests[0]["cases"][0]
    assert {k: v for k, v in body.items() if k != "replay"} == {
        k: v for k, v in evaluation_request.items() if k not in ("caseId", "runIndices")
    }
    assert body["replay"] == {
        "seed": "ex-1",
        "runIndex": 8,
        "expectedCatalogRevision": "cat-1",
        "expectedEngineRevision": "eng-1",
        "expectedSeedDerivationVersion": "MULBERRY32_FNV1A_SPLITMIX32_V1",
    }
    trace = directory / "traces/draft-8.json"
    saved = json.loads(trace.read_text())
    assert (
        saved["events"]
        and saved["result"]["totalScore"]
        == (
            server.evaluation._observe(
                EVALUATIONS_PATH,
                "ex-1",
                {"caseId": "-"},
                {k: v for k, v in body.items() if k != "replay"},
                8,
            )["totalScore"]
        )
    )
    assert str(trace) in result.output and "一致" in result.output


def test_inspect_json_reports_the_saved_and_replayed_values(tmp_path):
    directory, server = evaluated(tmp_path)

    result = runner.invoke(
        app_with(server), ["inspect", str(directory), "--case", "draft", "--run", "3", "--json"]
    )

    assert result.exit_code == EXIT_OK, result.output
    document = json.loads(result.output)
    assert document["caseId"] == "draft" and document["runIndex"] == 3
    assert document["replayed"] == document["saved"]
    assert set(document["saved"]) == {
        "totalScore",
        "breakCount",
        "completionReason",
        "completedTurn",
    }
    assert document["eventCount"] == 1
    assert document["tracePath"].endswith("traces/draft-3.json")


def test_inspect_refuses_a_replay_that_differs_from_the_saved_run_and_keeps_no_log(tmp_path):
    directory, server = evaluated(tmp_path)
    server.tamper = lambda body: body["result"].update(totalScore=body["result"]["totalScore"] + 1)

    result = runner.invoke(
        app_with(server), ["inspect", str(directory), "--case", "draft", "--run", "3"]
    )

    assert result.exit_code == EXIT_RUN_FAILED
    assert "totalScore" in result.output
    assert not (directory / "traces/draft-3.json").exists()


def test_inspect_refuses_a_response_without_the_detailed_log(tmp_path):
    directory, server = evaluated(tmp_path)
    server.tamper = lambda body: body.update(events=[])

    result = runner.invoke(
        app_with(server), ["inspect", str(directory), "--case", "draft", "--run", "3"]
    )

    assert result.exit_code == EXIT_RUN_FAILED
    assert "詳細イベント" in result.output
    assert not (directory / "traces").exists() or not any((directory / "traces").iterdir())


def test_inspect_reports_an_api_rejection_such_as_a_changed_engine(tmp_path):
    directory, server = evaluated(tmp_path)
    server.status = (422, "INVALID_COMMAND", "/replay/expectedEngineRevision")

    result = runner.invoke(
        app_with(server), ["inspect", str(directory), "--case", "draft", "--run", "3"]
    )

    assert result.exit_code == EXIT_RUN_FAILED
    assert "/replay/expectedEngineRevision" in result.output
    assert "ENVIRONMENT_MISMATCH" in result.output


def test_inspect_needs_a_completed_run_of_a_planned_case(tmp_path):
    directory, server = evaluated(tmp_path)

    for args in (["--case", "nope", "--run", "3"], ["--case", "draft", "--run", "4"]):
        result = runner.invoke(app_with(server), ["inspect", str(directory), *args])
        assert result.exit_code == EXIT_INPUT_ERROR, result.output
    assert server.replays == []
