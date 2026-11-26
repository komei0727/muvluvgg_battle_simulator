"""`exercise-lab` の評価コマンド。UIドラフト → import-draft（編成ライブラリ） → 評価設定 →
evaluate → summarize / export を通す。入力補助コマンドと同じ `exercise-lab` に載る。"""

import csv
import dataclasses
import io
import json

import typer
from typer.testing import CliRunner

from exercise_lab.cli import LAB
from exercise_lab.cli import app as real_app
from mlgg_lab_common.cli import EXIT_OK, register_evaluation_commands
from mlgg_lab_common.testing import FakeEvaluationServer, draft_json

runner = CliRunner()

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {}, "attributes": {}},
    "units": {},
}


def app_with(server):
    app = typer.Typer()
    register_evaluation_commands(
        app,
        dataclasses.replace(LAB, transport_factory=lambda s, k: server, sleep=lambda s: None),
    )
    return app


def test_the_real_app_keeps_input_helpers_and_adds_evaluation_commands():
    names = set(typer.main.get_command(real_app).commands)

    assert {"import-draft", "units", "memories", "formations", "schema"} <= names
    assert {"evaluate", "resume", "status", "summarize", "export"} <= names


def test_ui_draft_to_library_to_evaluation_summary_and_export(tmp_path):
    inputs = tmp_path / "data/inputs"
    (inputs / "drafts").mkdir(parents=True)
    (inputs / "player-data").mkdir()
    (inputs / "drafts/exercise.json").write_text(json.dumps(draft_json()), encoding="utf-8")
    (inputs / "player-data/player-data.json").write_text(json.dumps(PLAYER_DATA))
    imported = runner.invoke(
        real_app,
        [
            "import-draft",
            str(inputs / "drafts/exercise.json"),
            "--library",
            "-o",
            str(inputs / "formations/mine.yaml"),
        ],
    )
    assert imported.exit_code == 0, imported.output

    configs = tmp_path / "configs"
    configs.mkdir()
    (configs / "vs-tex.yaml").write_text(
        "ally: { library: mine }\n"
        "enemy:\n  unitDefinitionId: UNIT_TEX\n  position: { column: 1, row: FRONT }\n"
    )
    (configs / "evaluation.yaml").write_text(
        "format: TACTICAL_EXERCISE\nseed: ex-1\nbudget: { maxSubmittedRuns: 100 }\n"
        "inputs:\n  formationsDir: ../data/inputs/formations\n"
        "  playerData: ../data/inputs/player-data/player-data.json\n"
        "output: { evaluationsDir: ../data/evaluations }\n"
        "cases:\n  - { caseId: library, match: vs-tex.yaml, runs: 5 }\n"
        "  - { caseId: draft, draft: ../data/inputs/drafts/exercise.json, runIndices: [3, 8] }\n"
    )
    result = runner.invoke(
        app_with(FakeEvaluationServer()),
        ["evaluate", str(configs / "evaluation.yaml"), "--evaluation-id", "x"],
        catch_exceptions=False,
    )
    assert result.exit_code == EXIT_OK, result.output

    evaluation = tmp_path / "data/evaluations/x"
    summary = json.loads(
        runner.invoke(app_with(None), ["summarize", str(evaluation), "--json"]).output
    )
    by_case = {c["caseId"]: c for c in summary["cases"]}
    score = by_case["library"]["statistics"]["totalScore"]
    assert score["count"] == 5 and score["min"] <= score["p25"] <= score["median"] <= score["max"]
    assert set(by_case["draft"]["completionReasons"]) == {"TURN_LIMIT_REACHED", "ALLY_DEFEATED"}
    assert "演習対象" in by_case["library"]["match"]

    text = runner.invoke(app_with(None), ["summarize", str(evaluation)]).output
    assert "スコア: 平均" in text and "ブレイク回数の分布" in text

    assert runner.invoke(app_with(None), ["export", str(evaluation)]).exit_code == EXIT_OK
    rows = list(csv.DictReader(io.StringIO((evaluation / "exports/trials.csv").read_text())))
    assert [(r["case_id"], r["run_index"]) for r in rows][-2:] == [("draft", "3"), ("draft", "8")]
    assert all(r["total_score"] and r["break_count"] for r in rows)
