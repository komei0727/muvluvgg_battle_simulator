"""通常戦闘の評価設定 → 試行計画 → 実行・再開。元ファイルを変えても計画の条件は変わらない。"""

import json
from pathlib import Path

import pytest

from battle_lab.evaluation import plan_battle_evaluation
from mlgg_lab_common.evaluation.runner import StopReason, run_evaluation
from mlgg_lab_common.models import ConfigError
from mlgg_lab_common.storage.layout import create_evaluation, open_evaluation
from mlgg_lab_common.testing import FakeEvaluationServer

MATCH = """\
turnLimit: 7
allyFormation: { library: pair }
enemyFormation:
  units:
    - { unitDefinitionId: UNIT_C, position: { column: 1, row: REAR } }
  memoryDefinitionIds: [MEM_A]
"""
LIBRARY = """\
units:
  - { unitDefinitionId: UNIT_B, position: { column: 2, row: REAR } }
  - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
memoryDefinitionIds: [MEM_Z, MEM_A]
"""
PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {"PHYSICAL": 80}, "attributes": {}},
    "units": {"UNIT_A": {"level": 300, "gears": [None] * 9}},
}
CONFIG = """\
format: BATTLE
seed: study-1
budget: { maxSubmittedRuns: 100 }
api: { maxRunsPerRequest: 2 }
inputs:
  formationsDir: ../inputs/formations
  playerData: ../inputs/player-data/player-data.json
cases:
  - { caseId: vs-c, match: matches/vs-c.yaml, runs: 3 }
  - { caseId: gaps, match: matches/vs-c.yaml, runIndices: [0, 9] }
"""


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    (tmp_path / "inputs" / "formations").mkdir(parents=True)
    (tmp_path / "inputs" / "formations" / "pair.yaml").write_text(LIBRARY, encoding="utf-8")
    (tmp_path / "inputs" / "player-data").mkdir()
    (tmp_path / "inputs" / "player-data" / "player-data.json").write_text(
        json.dumps(PLAYER_DATA), encoding="utf-8"
    )
    (tmp_path / "configs" / "matches").mkdir(parents=True)
    (tmp_path / "configs" / "matches" / "vs-c.yaml").write_text(MATCH, encoding="utf-8")
    path = tmp_path / "configs" / "evaluation.yaml"
    path.write_text(CONFIG, encoding="utf-8")
    return path


def test_plan_snapshots_the_resolved_match_from_any_cwd(config_path, monkeypatch):
    monkeypatch.chdir("/")
    plan = plan_battle_evaluation(config_path)

    case = plan.cases[0]
    # 編成ライブラリの中身・メモリー順・手持ちデータの育成値が送信内容に入っている。
    assert case.match_request["turnLimit"] == 7
    ally = case.match_request["allyFormation"]
    assert [u["unitDefinitionId"] for u in ally["units"]] == ["UNIT_B", "UNIT_A"]
    assert ally["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert ally["units"][1]["enhancement"]["level"] == 300
    assert case.input_snapshot["format"] == "BATTLE"
    roles = {s["role"] for s in case.input_snapshot["provenance"]["sources"]}
    assert roles == {"MATCH_FILE", "FORMATION_LIBRARY", "PLAYER_DATA"}
    assert plan.cases[1].run_indices == (0, 9)


def test_resume_uses_the_saved_plan_even_after_the_source_files_change(config_path, tmp_path):
    plan = plan_battle_evaluation(config_path, evaluation_id="ev")
    directory, repo = create_evaluation(tmp_path / "evaluations", plan)
    first = FakeEvaluationServer()
    with repo:
        assert run_evaluation(repo, first, sleep=lambda _: None, max_requests=1).stop_reason is (
            StopReason.REQUEST_LIMIT_REACHED
        )
    # 元の対戦入力・ライブラリ・手持ちデータを書き換える。
    (tmp_path / "configs" / "matches" / "vs-c.yaml").write_text(
        MATCH.replace("turnLimit: 7", "turnLimit: 99"), encoding="utf-8"
    )
    (tmp_path / "inputs" / "formations" / "pair.yaml").unlink()
    (tmp_path / "inputs" / "player-data" / "player-data.json").write_text("{}", encoding="utf-8")

    resumed = FakeEvaluationServer()
    with open_evaluation(directory) as reopened:
        report = run_evaluation(reopened, resumed, sleep=lambda _: None)

    assert report.stop_reason is StopReason.COMPLETED
    assert report.counters.completed_trials == 5
    sent = [c for r in first.requests + resumed.requests for c in r["cases"]]
    assert {c["turnLimit"] for c in sent} == {7}
    assert all(c["allyFormation"] == plan.cases[0].match_request["allyFormation"] for c in sent)


def test_a_total_war_config_is_not_planned_as_a_battle(config_path):
    config_path.write_text(CONFIG.replace("format: BATTLE", "format: TOTAL_WAR"), encoding="utf-8")

    with pytest.raises(ConfigError, match="BATTLE"):
        plan_battle_evaluation(config_path)
