"""総力戦の評価設定 → 試行計画 → 実行。出撃順・再登場枠・引き分けを欠落させず保存する。"""

from pathlib import Path

from mlgg_lab_common.evaluation.runner import StopReason, run_evaluation
from mlgg_lab_common.storage.layout import create_evaluation
from mlgg_lab_common.testing import FakeEvaluationServer
from total_war_lab.evaluation import plan_total_war_evaluation

MATCH = """\
allyFormations:
  - units:
      - { unitDefinitionId: UNIT_B, position: { column: 0, row: FRONT } }
  - units:
      # 1編成目と同じユニットの再登場（別編成なので可）。
      - { unitDefinitionId: UNIT_B, position: { column: 0, row: FRONT } }
      - { unitDefinitionId: UNIT_A, position: { column: 1, row: REAR } }
enemyFormations:
  - units:
      - { unitDefinitionId: UNIT_C, position: { column: 1, row: FRONT } }
"""
CONFIG = """\
format: TOTAL_WAR
seed: tw
budget: { maxSubmittedRuns: 20 }
cases:
  - { caseId: reappear, match: match.yaml, runs: 6 }
"""


def test_total_war_trials_keep_deployment_order_and_every_slot(tmp_path: Path):
    (tmp_path / "match.yaml").write_text(MATCH, encoding="utf-8")
    config = tmp_path / "evaluation.yaml"
    config.write_text(CONFIG, encoding="utf-8")

    plan = plan_total_war_evaluation(config, evaluation_id="tw")
    case = plan.cases[0]
    assert [
        [u["unitDefinitionId"] for u in f["units"]] for f in case.match_request["allyFormations"]
    ] == [["UNIT_B"], ["UNIT_B", "UNIT_A"]]
    assert plan.settings.max_cases_per_request == 32

    _, repo = create_evaluation(tmp_path / "evaluations", plan)
    with repo:
        report = run_evaluation(repo, FakeEvaluationServer(), sleep=lambda _: None)

        assert report.stop_reason is StopReason.COMPLETED
        results = repo.results()
    assert len(results) == 6
    slots = [
        (u["side"], u["formationNumber"], u["unitIndex"], u["unitDefinitionId"])
        for u in results[0].observation["units"]
    ]
    assert slots == [
        ("ALLY", 1, 0, "UNIT_B"),
        ("ALLY", 2, 0, "UNIT_B"),
        ("ALLY", 2, 1, "UNIT_A"),
        ("ENEMY", 1, 0, "UNIT_C"),
    ]
    # 偽物は勝ち・負け・引き分けを混ぜて返す。引き分けも1試行として保存する。
    assert "DRAW" in {r.observation["outcome"] for r in results}
