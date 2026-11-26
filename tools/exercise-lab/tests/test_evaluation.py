"""戦術演習の評価設定 → 試行計画 → 実行・再開。元ファイルを変えても計画の条件は変わらない。"""

import json
from pathlib import Path

import pytest

from exercise_lab.evaluation import plan_exercise_evaluation
from mlgg_lab_common.evaluation.runner import StopReason, run_evaluation
from mlgg_lab_common.models import ConfigError
from mlgg_lab_common.storage.layout import create_evaluation, open_evaluation
from mlgg_lab_common.testing import FakeEvaluationServer, draft_json

MATCH = """\
ally:
  units:
    - { unitDefinitionId: UNIT_B, position: { column: 2, row: REAR } }
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    - { unitDefinitionId: UNIT_A, position: { column: 1, row: FRONT } }
  memoryDefinitionIds: [MEM_Z, MEM_A]
enemy:
  unitDefinitionId: UNIT_TEX
  position: { column: 1, row: FRONT }
"""
# 編成ライブラリ（`tools/data/inputs/formations/`、import-draft の出力）の1件。
LIBRARY = """\
note: "ライブラリの味方編成"
units:
  - { unitDefinitionId: UNIT_C, position: { column: 0, row: FRONT } }
memoryDefinitionIds: [MEM_Y]
"""
LIBRARY_MATCH = """\
ally: { library: carry }
enemy:
  unitDefinitionId: UNIT_TEX
  position: { column: 1, row: FRONT }
"""
PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {"PHYSICAL": 80}, "attributes": {}},
    "units": {"UNIT_A": {"level": 300, "gears": [None] * 9}},
}
CONFIG = """\
format: TACTICAL_EXERCISE
seed: study-1
budget: { maxSubmittedRuns: 100 }
api: { maxRunsPerRequest: 2 }
inputs:
  formationsDir: ../inputs/formations
  playerData: ../inputs/player-data/player-data.json
cases:
  - { caseId: vs-tex, match: matches/vs-tex.yaml, runs: 3 }
  - { caseId: gaps, match: matches/vs-tex.yaml, runIndices: [0, 9] }
  - { caseId: from-ui, draft: ../inputs/drafts/exercise.json, runs: 1 }
  - { caseId: library, match: matches/library.yaml, runs: 1 }
"""


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    (tmp_path / "inputs" / "player-data").mkdir(parents=True)
    (tmp_path / "inputs" / "player-data" / "player-data.json").write_text(
        json.dumps(PLAYER_DATA), encoding="utf-8"
    )
    (tmp_path / "inputs" / "drafts").mkdir()
    (tmp_path / "inputs" / "drafts" / "exercise.json").write_text(
        json.dumps(draft_json()), encoding="utf-8"
    )
    (tmp_path / "configs" / "matches").mkdir(parents=True)
    (tmp_path / "configs" / "matches" / "vs-tex.yaml").write_text(MATCH, encoding="utf-8")
    (tmp_path / "configs" / "matches" / "library.yaml").write_text(LIBRARY_MATCH, encoding="utf-8")
    (tmp_path / "inputs" / "formations").mkdir()
    (tmp_path / "inputs" / "formations" / "carry.yaml").write_text(LIBRARY, encoding="utf-8")
    path = tmp_path / "configs" / "evaluation.yaml"
    path.write_text(CONFIG, encoding="utf-8")
    return path


def test_plan_snapshots_the_resolved_exercise_from_any_cwd(config_path, monkeypatch):
    monkeypatch.chdir("/")
    plan = plan_exercise_evaluation(config_path)

    case = plan.cases[0]
    # 規定ターン数は演習で固定なので送らない。敵は1体・メモリーなし・強化なし。
    assert set(case.match_request) == {"allyFormation", "enemyFormation"}
    ally = case.match_request["allyFormation"]
    assert [u["unitDefinitionId"] for u in ally["units"]] == ["UNIT_B", "UNIT_A", "UNIT_A"]
    assert ally["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert ally["units"][1]["enhancement"]["level"] == 300
    assert case.match_request["enemyFormation"] == {
        "units": [{"unitDefinitionId": "UNIT_TEX", "position": {"column": 1, "row": "FRONT"}}],
        "memoryDefinitionIds": [],
    }
    # 同じユニットを置いた2枠は枠番号で区別する。
    assert [(s.side, s.unit_index, s.unit_definition_id) for s in case.expected_slots] == [
        ("ALLY", 0, "UNIT_B"),
        ("ALLY", 1, "UNIT_A"),
        ("ALLY", 2, "UNIT_A"),
        ("ENEMY", 0, "UNIT_TEX"),
    ]
    assert case.input_snapshot["format"] == "TACTICAL_EXERCISE"
    assert plan.cases[1].run_indices == (0, 9)
    # UIの演習ドラフトもそのまま使える。
    assert plan.cases[2].match_request["enemyFormation"]["units"][0]["unitDefinitionId"] == (
        "UNIT_ENEMY"
    )
    # 味方は編成ライブラリの参照でも書ける（中身を展開して計画へ焼く）。
    library = plan.cases[3]
    assert [u["unitDefinitionId"] for u in library.match_request["allyFormation"]["units"]] == [
        "UNIT_C"
    ]
    assert library.match_request["allyFormation"]["memoryDefinitionIds"] == ["MEM_Y"]
    roles = {s["role"] for s in library.input_snapshot["provenance"]["sources"]}
    assert roles == {"MATCH_FILE", "FORMATION_LIBRARY", "PLAYER_DATA"}


def test_resume_uses_the_saved_plan_even_after_the_source_files_change(config_path, tmp_path):
    plan = plan_exercise_evaluation(config_path, evaluation_id="ev")
    directory, repo = create_evaluation(tmp_path / "evaluations", plan)
    first = FakeEvaluationServer(complete_limit=1)
    with repo:
        report = run_evaluation(repo, first, sleep=lambda _: None, max_requests=1)
    assert report.stop_reason is StopReason.REQUEST_LIMIT_REACHED
    # 元の対戦入力と手持ちデータを書き換える。
    (tmp_path / "configs" / "matches" / "vs-tex.yaml").write_text(
        MATCH.replace("UNIT_TEX", "UNIT_OTHER_TEX"), encoding="utf-8"
    )
    (tmp_path / "inputs" / "player-data" / "player-data.json").write_text("{}", encoding="utf-8")
    (tmp_path / "inputs" / "formations" / "carry.yaml").unlink()

    resumed = FakeEvaluationServer()
    with open_evaluation(directory) as reopened:
        report = run_evaluation(reopened, resumed, sleep=lambda _: None)
        results = reopened.results()

    assert report.stop_reason is StopReason.COMPLETED
    assert report.counters.completed_trials == 7
    assert len(results) == 7
    assert all("totalScore" in r.observation for r in results)
    sent = [c for r in first.requests + resumed.requests for c in r["cases"]]
    assert {c["enemyFormation"]["units"][0]["unitDefinitionId"] for c in sent} >= {"UNIT_TEX"}
    assert "UNIT_OTHER_TEX" not in json.dumps(sent)
    # 部分応答で未完了だった番号も、同じ試行番号のまま送り直して埋める。
    assert sorted((r.case_id, r.run_index) for r in results) == sorted(
        (c.case_id, i) for c in plan.cases for i in c.run_indices
    )
    assert {i for c in sent for i in c["runIndices"]} <= {0, 1, 2, 9}


def test_an_unknown_key_in_the_match_file_is_refused(config_path, tmp_path):
    (tmp_path / "configs" / "matches" / "vs-tex.yaml").write_text(
        MATCH + "turnLimit: 5\n", encoding="utf-8"
    )

    with pytest.raises(ConfigError, match="turnLimit"):
        plan_exercise_evaluation(config_path)


def test_player_data_cannot_be_applied_to_the_exercise_enemy(config_path):
    config_path.write_text(
        CONFIG.replace("  playerData:", "  playerDataSides: [ALLY, ENEMY]\n  playerData:"),
        encoding="utf-8",
    )

    with pytest.raises(ConfigError, match="敵"):
        plan_exercise_evaluation(config_path)


def test_a_battle_config_is_not_planned_as_an_exercise(config_path):
    config_path.write_text(
        CONFIG.replace("format: TACTICAL_EXERCISE", "format: BATTLE"), encoding="utf-8"
    )

    with pytest.raises(ConfigError, match="TACTICAL_EXERCISE"):
        plan_exercise_evaluation(config_path)
