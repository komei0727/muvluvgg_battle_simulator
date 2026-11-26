"""評価設定の読み込み。設定内のパスは設定ファイルの位置を基準に解決し、実行ディレクトリに依らない。"""

import json
from pathlib import Path

import pytest

from mlgg_lab_common.evaluation.config import (
    CaseSource,
    InputOptions,
    load_evaluation_config,
    plan_from_config,
)
from mlgg_lab_common.models import ConfigError
from mlgg_lab_common.storage.layout import (
    DB_FILE,
    MANIFEST_FILE,
    create_evaluation,
    open_evaluation,
    write_manifest,
)
from mlgg_lab_common.testing import FakeBattleInput

CONFIG = """\
format: BATTLE
seed: study-1
budget: {{ maxSubmittedRuns: 50 }}
api: {{ baseUrl: "http://api.test", maxRunsPerRequest: 10 }}
inputs:
  formationsDir: {formations}
  playerData: {player_data}
  playerDataSides: [ALLY, ENEMY]
output:
  evaluationsDir: ../evaluations
cases:
  - caseId: from-match
    match: matches/a.yaml
    runs: 3
  - caseId: from-draft
    draft: {draft}
    runIndices: [0, 7, 42]
"""


def write_config(directory: Path, **paths: str) -> Path:
    values = {
        "formations": "../inputs/formations",
        "player_data": "../inputs/pd.json",
        "draft": "drafts/d.json",
    }
    values.update(paths)
    path = directory / "configs" / "evaluation.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(CONFIG.format(**values), encoding="utf-8")
    return path


def test_paths_are_resolved_from_the_config_file_not_the_cwd(tmp_path, monkeypatch):
    config_path = write_config(tmp_path, draft=str(tmp_path / "abs" / "d.json"))
    monkeypatch.chdir(tmp_path / "configs")
    first = load_evaluation_config(Path("evaluation.yaml"))
    monkeypatch.chdir("/")

    config = load_evaluation_config(config_path)

    assert config == first
    root = (tmp_path / "configs").resolve()
    assert config.formations_dir == (root / "../inputs/formations").resolve()
    assert config.player_data == (root / "../inputs/pd.json").resolve()
    assert config.evaluations_dir == (root / "../evaluations").resolve()
    assert config.cases[0].source == CaseSource("MATCH_FILE", root / "matches" / "a.yaml")
    # 絶対パスはそのまま使う。
    assert config.cases[1].source == CaseSource("DRAFT", (tmp_path / "abs" / "d.json").resolve())
    assert config.cases[0].run_indices == (0, 1, 2)
    assert config.cases[1].run_indices == (0, 7, 42)
    assert config.player_data_sides == ("ALLY", "ENEMY")
    assert config.settings.base_url == "http://api.test"


def test_plan_from_config_passes_resolved_paths_to_the_format_resolver(tmp_path):
    config = load_evaluation_config(write_config(tmp_path))
    seen: list[tuple[CaseSource, InputOptions]] = []

    def resolve(source: CaseSource, options: InputOptions):
        seen.append((source, options))
        return FakeBattleInput.of(["UNIT_A"], ["UNIT_B"])

    plan = plan_from_config(config, resolve, evaluation_id="ev")

    assert [c.case_id for c in plan.cases] == ["from-match", "from-draft"]
    assert plan.settings.max_runs_per_request == 10
    assert plan.budget.max_submitted_runs == 50
    assert seen[0][1].formations_dir == config.formations_dir
    assert seen[0][1].player_data_path == config.player_data


@pytest.mark.parametrize(
    ("replace", "message"),
    [
        (("runs: 3", "runs: 3\n    runIndices: [1]"), "どちらか一方"),
        (("    runs: 3\n", ""), "どちらか一方"),
        (("match: matches/a.yaml", "match: a.yaml\n    draft: b.json"), "どちらか一方"),
        (("seed: study-1", "seed: study-1\nextra: 1"), "extra"),
        (("format: BATTLE", "format: CHESS"), "format"),
    ],
)
def test_invalid_configs_are_rejected(tmp_path, replace, message):
    path = write_config(tmp_path)
    path.write_text(path.read_text(encoding="utf-8").replace(*replace), encoding="utf-8")

    with pytest.raises(ConfigError, match=message):
        load_evaluation_config(path)


def test_format_must_match_what_the_lab_expects(tmp_path):
    with pytest.raises(ConfigError, match="TOTAL_WAR"):
        load_evaluation_config(write_config(tmp_path), expected_format="TOTAL_WAR")


def test_an_unknown_format_is_refused(tmp_path):
    path = write_config(tmp_path)
    path.write_text(
        path.read_text(encoding="utf-8").replace("format: BATTLE", "format: PVP"),
        encoding="utf-8",
    )

    with pytest.raises(ConfigError, match="format"):
        load_evaluation_config(path)


def test_evaluation_directory_holds_the_database_and_a_summary_manifest(tmp_path):
    config = load_evaluation_config(write_config(tmp_path))
    plan = plan_from_config(
        config, lambda s, o: FakeBattleInput.of(["UNIT_A"], ["UNIT_B"]), evaluation_id="ev-1"
    )

    directory, repository = create_evaluation(tmp_path / "evaluations", plan)
    repository.close()

    assert directory == tmp_path / "evaluations" / "ev-1"
    assert (directory / DB_FILE).is_file()
    manifest = json.loads((directory / MANIFEST_FILE).read_text(encoding="utf-8"))
    assert manifest["evaluationId"] == "ev-1"
    assert manifest["format"] == "BATTLE"
    assert manifest["counters"] == {"plannedRuns": 6, "submittedRuns": 0, "completedTrials": 0}
    with pytest.raises(FileExistsError):
        create_evaluation(tmp_path / "evaluations", plan)
    # manifestを消しても再開できる（正本はDB）。
    (directory / MANIFEST_FILE).unlink()
    with open_evaluation(directory) as reopened:
        assert reopened.load_plan() == plan
        write_manifest(directory, reopened)
    assert (directory / MANIFEST_FILE).is_file()
