"""リポジトリに置いた公開サンプルは、個人ファイル（`configs/formations/` 等）なしで読める。"""

from pathlib import Path

from exercise_lab.inputs.exercise import load_formation_config
from exercise_lab.inputs.models import build_ally_formation

CONFIGS = Path(__file__).resolve().parents[1] / "configs"


def test_the_bundled_formation_example_is_loadable():
    config = load_formation_config(CONFIGS / "formation.example.yaml")

    ally = build_ally_formation(config.ally)
    assert len(ally["units"]) == 5
    assert len(ally["memoryDefinitionIds"]) == 6
    assert config.enemy.unit_definition_id.endswith("_TEX")


def test_only_the_formation_example_is_bundled():
    assert sorted(path.name for path in CONFIGS.glob("*.example.yaml")) == [
        "formation.example.yaml"
    ]
