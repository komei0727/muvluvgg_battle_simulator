"""`total-war-lab` の評価コマンド。勝ち抜き戦全体を1試行として集計し、引き分けを
独立した結果として示す。評価APIは偽物に差し替える。"""

import csv
import dataclasses
import io
import json
from pathlib import Path

from typer.testing import CliRunner

from mlgg_lab_common.cli import EXIT_OK, build_lab_app
from mlgg_lab_common.testing import FakeEvaluationServer
from total_war_lab.cli import LAB

MATCH = Path(__file__).resolve().parents[1] / "configs/match.example.yaml"
runner = CliRunner()


def app_with(server):
    return build_lab_app(
        dataclasses.replace(LAB, transport_factory=lambda s, k: server, sleep=lambda s: None),
        help="test",
    )


def test_total_war_summary_keeps_draws_and_counts_whole_runs(tmp_path):
    config = tmp_path / "evaluation.yaml"
    config.write_text(
        "format: TOTAL_WAR\nseed: tw-1\nbudget: { maxSubmittedRuns: 100 }\n"
        "output: { evaluationsDir: out }\n"
        f"cases:\n  - {{ caseId: tw, match: {MATCH}, runs: 30 }}\n",
        encoding="utf-8",
    )
    result = runner.invoke(
        app_with(FakeEvaluationServer()),
        ["evaluate", str(config), "--evaluation-id", "t"],
        catch_exceptions=False,
    )
    assert result.exit_code == EXIT_OK, result.output

    evaluation = tmp_path / "out/t"
    summary = json.loads(
        runner.invoke(app_with(None), ["summarize", str(evaluation), "--json"]).output
    )
    (case,) = summary["cases"]
    stats = case["statistics"]
    assert case["sampleSize"] == 30
    assert list(stats["outcomes"]) == ["ALLY_WIN", "ALLY_LOSE", "DRAW"]
    assert sum(e["count"] for e in stats["outcomes"].values()) == 30
    assert stats["outcomes"]["DRAW"]["count"] > 0
    # 編成対戦を独立試行として水増ししない（比率の分母は勝ち抜き戦の数）。
    assert all(p["trials"] <= 30 and p["ratio"] == p["trials"] / 30 for p in stats["pairings"])
    assert sum(e["count"] for e in stats["defeatedFormations"]["enemy"]) == 30
    assert {d["side"] for d in stats["deployment"]} == {"ALLY", "ENEMY"}
    assert all(d["formationNumber"] >= 1 for d in stats["deployment"])

    text = runner.invoke(app_with(None), ["summarize", str(evaluation)]).output
    assert "勝敗・引き分け: ALLY_WIN" in text and "DRAW" in text and "出撃状況" in text

    assert runner.invoke(app_with(None), ["export", str(evaluation)]).exit_code == EXIT_OK
    rows = list(csv.DictReader(io.StringIO((evaluation / "exports/trials.csv").read_text())))
    assert len(rows) == 30
    assert {r["outcome"] for r in rows} <= {"ALLY_WIN", "ALLY_LOSE", "DRAW"}
    assert all(r["stage_count"] and r["enemy_defeated_formations"] for r in rows)
    jsonl = (evaluation / "exports/trials.jsonl").read_text().splitlines()
    assert all("stages" in json.loads(line)["observation"] for line in jsonl)


def test_a_battle_evaluation_is_not_opened_by_the_total_war_lab(tmp_path):
    battle_config = tmp_path / "b.yaml"
    battle_config.write_text(
        "format: BATTLE\nseed: x\nbudget: { maxSubmittedRuns: 1 }\n"
        f"cases:\n  - {{ caseId: c, match: {MATCH}, runs: 1 }}\n"
    )
    result = runner.invoke(app_with(None), ["evaluate", str(battle_config)])

    assert result.exit_code == 1
    assert "TOTAL_WAR" in result.output
