"""リポジトリに置いた各ラボの公開サンプルは、個人ファイルなしで読め、コミット済みの
Catalog（`apps/api/catalog/`）にあるIDだけを使う。"""

import json
from pathlib import Path

import pytest

from battle_lab.evaluation import plan_battle_evaluation
from battle_lab.inputs import load_battle_match_file
from battle_lab.inputs import validate_against_catalog as validate_battle
from exercise_lab.inputs.exercise import load_formation_config
from exercise_lab.inputs.exercise import validate_against_catalog as validate_exercise
from mlgg_lab_common.inputs.catalog import Catalog
from total_war_lab.evaluation import plan_total_war_evaluation
from total_war_lab.inputs import load_total_war_match_file
from total_war_lab.inputs import validate_against_catalog as validate_total_war

TOOLS = Path(__file__).resolve().parents[1]
CATALOG_DIR = TOOLS.parent / "apps/api/catalog"


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


def test_the_exercise_example_is_loadable_and_uses_current_ids(catalog):
    config = load_formation_config(TOOLS / "exercise-lab/configs/formation.example.yaml")

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

    assert battle.planned_runs == 103
    assert total_war.planned_runs == 50
