"""実APIでの評価実行。`MLGG_LAB_LIVE_API_URL` を設定したときだけ走る。

    cd apps/api && EVALUATION_ENDPOINT_ENABLED=true PORT=3917 mise exec -- pnpm exec tsx src/main.ts
    cd tools && MLGG_LAB_LIVE_API_URL=http://localhost:3917 \
      uv run pytest tests/test_live_evaluation_api.py

同じ計画を「要求を大きく」「要求を細かく・ケース順を逆に」「同じ条件でもう一度」で実行し、
対戦条件と試行番号で突き合わせた意味上の観測値が一致することを見る（原応答の時刻等は比べない）。
"""

import json
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from battle_lab.cli import app as battle_app
from battle_lab.evaluation import plan_battle_evaluation
from exercise_lab.cli import app as exercise_app
from exercise_lab.evaluation import plan_exercise_evaluation
from mlgg_lab_common.cli import EXIT_INCOMPLETE, EXIT_OK
from mlgg_lab_common.evaluation.runner import StopReason, run_evaluation
from mlgg_lab_common.storage.layout import create_evaluation
from total_war_lab.cli import app as total_war_app
from total_war_lab.evaluation import plan_total_war_evaluation

LIVE_URL = os.environ.get("MLGG_LAB_LIVE_API_URL")
pytestmark = pytest.mark.skipif(LIVE_URL is None, reason="MLGG_LAB_LIVE_API_URL が無い")

TOOLS = Path(__file__).resolve().parents[1]


# 演習の対戦入力は編成定義YAML（味方 + 敵1体）そのもの。
MATCH_FILES = {"exercise-lab": "tests/fixtures/match.yaml"}


def write_config(directory: Path, fmt: str, lab: str, *, cases: list[str], **api: int) -> Path:
    match = TOOLS / lab / MATCH_FILES.get(lab, "configs/match.example.yaml")
    api_lines = "".join(f"  {k}: {v}\n" for k, v in api.items())
    path = directory / f"{fmt}-{len(list(directory.iterdir()))}.yaml"
    path.write_text(
        f"format: {fmt}\nseed: live-1\nbudget: {{ maxSubmittedRuns: 200 }}\n"
        f"api:\n  baseUrl: {LIVE_URL}\n{api_lines}"
        "cases:\n" + "".join(cases).replace("MATCH", str(match)),
        encoding="utf-8",
    )
    return path


def observe(plan, directory: Path):
    _, repo = create_evaluation(directory, plan)
    with repo, plan.settings.http_client() as client:
        report = run_evaluation(repo, client)
        assert report.stop_reason is StopReason.COMPLETED, report.detail
        fingerprints = {c.case_id: c.match_fingerprint for c in plan.cases}
        environment = repo.environment()
        return (
            {(fingerprints[r.case_id], r.run_index): r.observation for r in repo.results()},
            environment,
            report,
        )


@pytest.mark.parametrize(
    ("fmt", "lab", "planner"),
    [
        ("BATTLE", "battle-lab", plan_battle_evaluation),
        ("TOTAL_WAR", "total-war-lab", plan_total_war_evaluation),
        ("TACTICAL_EXERCISE", "exercise-lab", plan_exercise_evaluation),
    ],
)
def test_split_order_and_rerun_do_not_change_semantic_results(tmp_path, fmt, lab, planner):
    configs = tmp_path / "configs"
    configs.mkdir()
    out = tmp_path / "evaluations"
    forward = [
        "  - { caseId: a, match: MATCH, runs: 4 }\n",
        "  - { caseId: b, match: MATCH, runIndices: [0, 7, 42] }\n",
    ]
    wide = planner(write_config(configs, fmt, lab, cases=forward))
    narrow = planner(
        write_config(
            configs,
            fmt,
            lab,
            cases=list(reversed(forward)),
            maxCasesPerRequest=1,
            maxRunsPerRequest=2,
        )
    )

    first, environment, report = observe(wide, out)
    again, _, _ = observe(planner(write_config(configs, fmt, lab, cases=forward)), out)
    split, _, split_report = observe(narrow, out)

    assert len(first) == 7 - 1  # a と b は同じ対戦条件なので runIndex 0 が重なる
    assert first == again == split
    assert report.counters.completed_trials == 7
    assert split_report.requests > report.requests
    assert environment is not None and environment.engine_revision
    if fmt == "TACTICAL_EXERCISE":
        sample = next(iter(first.values()))
        assert sample["completionReason"] in {"TURN_LIMIT_REACHED", "ALLY_DEFEATED"}
        assert {"totalScore", "breakCount"} <= sample.keys()
        assert len(sample["allyUnitBreaks"]) == 5
    if fmt == "TOTAL_WAR":
        sample = next(iter(first.values()))
        assert {"stages", "defeatedFormationCounts"} <= sample.keys()
        assert all(
            {"deployed", "reappearance", "formationNumber"} <= u.keys() for u in sample["units"]
        )


def test_an_unexpected_engine_revision_stops_before_any_run(tmp_path):
    configs = tmp_path / "configs"
    configs.mkdir()
    path = write_config(
        configs, "BATTLE", "battle-lab", cases=["  - { caseId: a, match: MATCH, runs: 2 }\n"]
    )
    path.write_text(
        path.read_text(encoding="utf-8").replace(
            "api:\n", "api:\n  expectedEngineRevision: not-this-engine\n"
        ),
        encoding="utf-8",
    )
    plan = plan_battle_evaluation(path)
    _, repo = create_evaluation(tmp_path / "evaluations", plan)
    with repo, plan.settings.http_client() as client:
        report = run_evaluation(repo, client)

        assert report.stop_reason is StopReason.ENVIRONMENT_MISMATCH
        assert repo.results() == []
        assert repo.attempts()[0].http_status == 422


@pytest.mark.parametrize(
    ("fmt", "lab", "app"),
    [
        ("BATTLE", "battle-lab", battle_app),
        ("TOTAL_WAR", "total-war-lab", total_war_app),
        ("TACTICAL_EXERCISE", "exercise-lab", exercise_app),
    ],
)
def test_cli_evaluate_interrupt_resume_summarize_export(tmp_path, fmt, lab, app):
    """利用者の操作どおりに、要求1回で止めて → status → resume → summarize → export を通す。"""
    configs = tmp_path / "configs"
    configs.mkdir()
    config = write_config(
        configs,
        fmt,
        lab,
        cases=[
            "  - { caseId: a, match: MATCH, runs: 3 }\n",
            "  - { caseId: b, match: MATCH, runIndices: [5, 9] }\n",
        ],
        maxCasesPerRequest=1,
        maxRunsPerRequest=2,
    )
    runner = CliRunner()
    evaluation = tmp_path / "evaluations/live"

    def run(*args: object):
        return runner.invoke(app, [str(a) for a in args], catch_exceptions=False)

    first = run(
        "evaluate",
        config,
        "--evaluations-dir",
        evaluation.parent,
        "--evaluation-id",
        "live",
        "--max-requests",
        "1",
    )
    assert first.exit_code == EXIT_INCOMPLETE, first.output
    status = json.loads(run("status", evaluation, "--json").output)
    assert status["counters"]["completedTrials"] == 2
    assert status["lastSession"]["stopReason"] == "REQUEST_LIMIT_REACHED"

    resumed = run("resume", evaluation)
    assert resumed.exit_code == EXIT_OK, resumed.output
    summary = json.loads(run("summarize", evaluation, "--json").output)
    assert [c["sampleSize"] for c in summary["cases"]] == [3, 2]
    assert all(c["statistics"] is not None for c in summary["cases"])
    assert summary["environment"]["engineRevision"]

    assert run("export", evaluation).exit_code == EXIT_OK
    lines = (evaluation / "exports/trials.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 5
