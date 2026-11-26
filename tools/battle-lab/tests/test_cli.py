"""`battle-lab` の評価コマンド。評価APIは偽物に差し替え、入力準備 → evaluate → 中断 →
status → resume → summarize → export を通す。status / summarize / export はAPIへ接続しない。"""

import csv
import dataclasses
import io
import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from battle_lab.cli import LAB
from mlgg_lab_common.cli import (
    EXIT_INCOMPLETE,
    EXIT_INPUT_ERROR,
    EXIT_OK,
    EXIT_RUN_FAILED,
    build_lab_app,
)
from mlgg_lab_common.testing import FakeEvaluationServer, draft_json

MATCH = """\
turnLimit: 7
allyFormation:
  units:
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    - { unitDefinitionId: UNIT_B, position: { column: 1, row: FRONT } }
enemyFormation:
  units:
    - { unitDefinitionId: UNIT_X, position: { column: 1, row: FRONT } }
"""
CONFIG = """\
format: BATTLE
seed: cli-1
budget: { maxSubmittedRuns: 100 }
api: { baseUrl: http://fake.invalid, maxRunsPerRequest: 3 }
output: { evaluationsDir: ../evaluations }
cases:
  - { caseId: yaml, match: ../inputs/match.yaml, runs: 4 }
  - { caseId: from-ui, draft: ../inputs/drafts/battle.json, runIndices: [0, 5] }
"""

runner = CliRunner()


class Offline:
    """評価APIに触れたら失敗させる。status / summarize / export が接続しないことの確認用。"""

    def post_json(self, path, payload):
        raise AssertionError("評価APIへ接続した")


def app_with(server):
    return build_lab_app(
        dataclasses.replace(
            LAB, transport_factory=lambda settings, key: server, sleep=lambda s: None
        ),
        help="test",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "inputs/drafts").mkdir(parents=True)
    (tmp_path / "inputs/match.yaml").write_text(MATCH, encoding="utf-8")
    (tmp_path / "inputs/drafts/battle.json").write_text(json.dumps(draft_json()), encoding="utf-8")
    (tmp_path / "configs").mkdir()
    (tmp_path / "configs/evaluation.yaml").write_text(CONFIG, encoding="utf-8")
    return tmp_path


def invoke(app, *args):
    return runner.invoke(app, [str(a) for a in args], catch_exceptions=False)


def test_evaluate_interrupt_resume_summarize_export(workspace, monkeypatch):
    # 設定内のパスは設定ファイル基準。別のディレクトリから実行しても同じファイルを指す。
    monkeypatch.chdir("/")
    server = FakeEvaluationServer(complete_limit=2)
    config = workspace / "configs/evaluation.yaml"
    first = invoke(
        app_with(server), "evaluate", config, "--evaluation-id", "e1", "--max-requests", "1"
    )

    assert first.exit_code == EXIT_INCOMPLETE, first.output
    assert "REQUEST_LIMIT_REACHED" in first.output
    assert "要求 #1: 新規完了 +2 | 完了 2/6 試行 | 送信 3 試行" in first.output
    evaluation = workspace / "evaluations/e1"
    assert (evaluation / "evaluation.sqlite3").is_file()
    assert (evaluation / "manifest.json").is_file()

    status = invoke(app_with(Offline()), "status", evaluation, "--json")
    assert status.exit_code == EXIT_OK
    counters = json.loads(status.output)["counters"]
    assert (counters["plannedRuns"], counters["submittedRuns"], counters["completedTrials"]) == (
        6,
        3,
        2,
    )
    assert json.loads(status.output)["lastSession"]["stopReason"] == "REQUEST_LIMIT_REACHED"

    partial = invoke(app_with(Offline()), "summarize", evaluation)
    assert partial.exit_code == EXIT_OK
    assert "未完了・失敗した試行は集計に含めない" in partial.output
    assert "== from-ui ==" in partial.output and "集計対象なし" in partial.output

    # 元の入力を書き換えても、再開は保存済みの計画（対戦条件・seed・試行番号）を送る。
    (workspace / "inputs/match.yaml").write_text(MATCH.replace("turnLimit: 7", "turnLimit: 2"))
    resumed_server = FakeEvaluationServer()
    resumed = invoke(app_with(resumed_server), "resume", evaluation)
    assert resumed.exit_code == EXIT_OK, resumed.output
    assert "停止理由: COMPLETED" in resumed.output
    yaml_cases = [c for r in resumed_server.requests for c in r["cases"] if c["caseId"] == "yaml"]
    assert {c["turnLimit"] for c in yaml_cases} == {7}
    assert {r["seed"] for r in resumed_server.requests} == {"cli-1"}

    summary = json.loads(invoke(app_with(Offline()), "summarize", evaluation, "--json").output)
    by_case = {c["caseId"]: c for c in summary["cases"]}
    assert (by_case["yaml"]["sampleSize"], by_case["from-ui"]["sampleSize"]) == (4, 2)
    outcomes = by_case["yaml"]["statistics"]["outcomes"]
    assert sum(e["count"] for e in outcomes.values()) == 4
    assert set(outcomes) == {"ALLY_WIN", "ALLY_LOSE"}
    assert by_case["yaml"]["statistics"]["completedTurn"]["summary"]["count"] == 4
    assert "規定 7 ターン" in by_case["yaml"]["match"]

    text = invoke(app_with(Offline()), "summarize", evaluation, "--case", "yaml").output
    assert "勝敗: ALLY_WIN" in text and "完了ターン: 平均" in text and "from-ui" not in text

    exported = invoke(app_with(Offline()), "export", evaluation)
    assert exported.exit_code == EXIT_OK
    out = evaluation / "exports"
    rows = list(csv.DictReader(io.StringIO((out / "trials.csv").read_text())))
    assert len(rows) == 6
    assert set(rows[0]) >= {"case_id", "run_index", "outcome", "completed_turn", "engine_revision"}
    assert len((out / "trials.jsonl").read_text().splitlines()) == 6


def test_plan_only_then_status_and_summarize_without_results(workspace):
    config = workspace / "configs/evaluation.yaml"
    planned = invoke(app_with(Offline()), "evaluate", config, "--plan-only", "--evaluation-id", "p")

    assert planned.exit_code == EXIT_OK, planned.output
    evaluation = workspace / "evaluations/p"
    status = invoke(app_with(Offline()), "status", evaluation)
    assert "計画 6 / 完了 0 / 未完了 6" in status.output
    assert "まだ実行していない" in status.output
    summary = invoke(app_with(Offline()), "summarize", evaluation)
    assert summary.output.count("集計対象なし") == 2
    assert (
        invoke(app_with(Offline()), "export", evaluation, "--out", workspace / "x").exit_code == 0
    )
    assert (workspace / "x/trials.jsonl").read_text() == ""


def test_execution_errors_stop_with_their_own_exit_code_and_are_not_results(workspace):
    server = FakeEvaluationServer(script=[("status", 500, "INTERNAL_ERROR")])
    result = invoke(
        app_with(server), "evaluate", workspace / "configs/evaluation.yaml", "--evaluation-id", "f"
    )

    assert result.exit_code == EXIT_RUN_FAILED
    assert "EXECUTION_ERROR" in result.output
    status = json.loads(
        invoke(app_with(Offline()), "status", workspace / "evaluations/f", "--json").output
    )
    assert status["failuresByKind"] == {"EXECUTION_ERROR": 1}
    assert status["counters"]["completedTrials"] == 0
    summary = json.loads(
        invoke(app_with(Offline()), "summarize", workspace / "evaluations/f", "--json").output
    )
    assert [c["statistics"] for c in summary["cases"]] == [None, None]


def test_input_errors_exit_with_a_message_and_no_traceback(workspace, tmp_path):
    bad = workspace / "configs/bad.yaml"
    bad.write_text(CONFIG.replace("format: BATTLE", "format: TOTAL_WAR"), encoding="utf-8")
    missing_output = workspace / "configs/no-output.yaml"
    missing_output.write_text(
        CONFIG.replace("output: { evaluationsDir: ../evaluations }\n", ""), encoding="utf-8"
    )
    broken_match = workspace / "configs/broken.yaml"
    broken_match.write_text(CONFIG.replace("../inputs/match.yaml", "../inputs/none.yaml"))

    for args in (
        ("evaluate", bad),
        ("evaluate", missing_output),
        ("evaluate", broken_match),
        ("status", tmp_path / "no-such-evaluation"),
        ("summarize", tmp_path / "no-such-evaluation"),
    ):
        result = invoke(app_with(Offline()), *args)
        assert result.exit_code == EXIT_INPUT_ERROR, (args, result.output)
        assert "error" in result.output
    no_output = invoke(app_with(Offline()), "evaluate", missing_output)
    assert "output.evaluationsDir" in no_output.output


def test_unknown_case_and_reused_evaluation_id_are_input_errors(workspace):
    config = workspace / "configs/evaluation.yaml"
    invoke(app_with(Offline()), "evaluate", config, "--plan-only", "--evaluation-id", "dup")

    again = invoke(app_with(Offline()), "evaluate", config, "--plan-only", "--evaluation-id", "dup")
    assert again.exit_code == EXIT_INPUT_ERROR
    unknown = invoke(
        app_with(Offline()), "summarize", workspace / "evaluations/dup", "--case", "zzz"
    )
    assert unknown.exit_code == EXIT_INPUT_ERROR
    assert "zzz" in unknown.output


def test_evaluations_dir_option_overrides_the_config(workspace, tmp_path):
    other = tmp_path / "elsewhere"
    result = invoke(
        app_with(Offline()),
        "evaluate",
        workspace / "configs/evaluation.yaml",
        "--plan-only",
        "--evaluation-id",
        "o",
        "--evaluations-dir",
        other,
    )

    assert result.exit_code == EXIT_OK
    assert (other / "o/evaluation.sqlite3").is_file()
