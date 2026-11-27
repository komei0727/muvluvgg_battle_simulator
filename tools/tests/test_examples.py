"""各ラボのサンプルを個人ファイルなしで検証し、Catalogの実IDを確かめる。"""

import json
from pathlib import Path

import pytest

from battle_lab.evaluation import plan_battle_evaluation
from battle_lab.inputs import load_battle_match_file
from battle_lab.inputs import validate_against_catalog as validate_battle
from exercise_lab.evaluation import plan_exercise_evaluation
from exercise_lab.inputs.exercise import load_formation_config
from exercise_lab.inputs.exercise import validate_against_catalog as validate_exercise
from exercise_lab.search_config import plan_exercise_search
from mlgg_lab_common.inputs.catalog import Catalog
from mlgg_lab_common.inputs.library import FormationLibraryEntry, dump_formation_library_entry
from mlgg_lab_common.testing import scripted_method
from total_war_lab.evaluation import plan_total_war_evaluation
from total_war_lab.inputs import load_total_war_match_file
from total_war_lab.inputs import validate_against_catalog as validate_total_war

TOOLS = Path(__file__).resolve().parents[1]
CATALOG_DIR = TOOLS.parent / "apps/api/catalog"
EXERCISE_FIXTURES = TOOLS / "exercise-lab/tests/fixtures"


@pytest.fixture(scope="module")
def catalog():
    if not (CATALOG_DIR / "units.json").exists():
        pytest.skip("Catalogはリポジトリ全体のcheckoutにだけある")
    units = json.loads((CATALOG_DIR / "units.json").read_text(encoding="utf-8"))
    memories = json.loads((CATALOG_DIR / "memories.json").read_text(encoding="utf-8"))
    return Catalog.model_validate(
        {
            "catalogRevision": "committed",
            "units": [
                {
                    "unitDefinitionId": unit["unitDefinitionId"],
                    "displayName": unit["unitDefinitionId"],
                    # R-TEX-11 #1: 定義書で省略されたカテゴリは PLAYABLE。
                    "category": unit.get("category", "PLAYABLE"),
                }
                for unit in units
            ],
            "memories": [
                {"memoryDefinitionId": m["memoryDefinitionId"], "displayName": ""} for m in memories
            ],
        }
    )


def test_the_exercise_match_fixture_is_loadable_and_uses_current_ids(catalog):
    config = load_formation_config(EXERCISE_FIXTURES / "match.yaml")

    assert validate_exercise(config, catalog) == []


def test_the_battle_example_is_loadable_and_uses_current_ids(catalog):
    loaded = load_battle_match_file(TOOLS / "battle-lab/configs/match.example.yaml")

    assert validate_battle(loaded.match, catalog) == []


def test_the_total_war_example_is_loadable_and_uses_current_ids(catalog):
    loaded = load_total_war_match_file(TOOLS / "total-war-lab/configs/match.example.yaml")

    assert len(loaded.match.ally_formations) == 2
    assert validate_total_war(loaded.match, catalog) == []


def test_the_evaluation_examples_plan_without_personal_files(monkeypatch):
    # 設定内のパスは設定ファイル基準なので、実行ディレクトリに依らない。
    monkeypatch.chdir("/")
    battle = plan_battle_evaluation(TOOLS / "battle-lab/configs/evaluation.example.yaml")
    total_war = plan_total_war_evaluation(TOOLS / "total-war-lab/configs/evaluation.example.yaml")
    exercise = plan_exercise_evaluation(EXERCISE_FIXTURES / "batch-evaluation.yaml")

    assert battle.planned_runs == 103
    assert total_war.planned_runs == 50
    assert exercise.planned_runs == 200
    baseline, variant = exercise.cases
    assert baseline.match_fingerprint != variant.match_fingerprint
    assert baseline.run_indices == variant.run_indices


def test_the_initial_settings_example_resolves_multiple_library_entries(
    catalog, tmp_path, monkeypatch
):
    workspace = tmp_path / "tools"
    path = workspace / "exercise-lab/configs/evaluation.yaml"
    path.parent.mkdir(parents=True)
    path.write_bytes((TOOLS / "exercise-lab/configs/evaluation.example.yaml").read_bytes())
    library = workspace / "data/inputs/formations"
    library.mkdir(parents=True)
    for formation_id, fixture in (
        ("my-team", "match.yaml"),
        ("my-team-variant", "match-variant.yaml"),
    ):
        ally = load_formation_config(EXERCISE_FIXTURES / fixture).ally
        entry = FormationLibraryEntry(
            units=ally.units, memoryDefinitionIds=ally.memory_definition_ids
        )
        (library / f"{formation_id}.yaml").write_text(
            dump_formation_library_entry(entry), encoding="utf-8"
        )
    monkeypatch.chdir("/")
    plan = plan_exercise_search(path, method=scripted_method([], []).binding(), catalog=catalog)

    assert plan.searches_dir == workspace / "data/searches"
    baseline, variant = plan.problem.starts
    assert len(baseline.units) == 5
    assert baseline.candidate_id != variant.candidate_id
    assert plan.problem.fixed["enemy"]["unitDefinitionId"] == "UNIT_ANIS_SWEETDEVIL_TEX"
    assert plan.problem.method.settings["moves"]["replaceUnits"] is True
    assert plan.problem.method.settings["objective"]["bestOf"] == 5
