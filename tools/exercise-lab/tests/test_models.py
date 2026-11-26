"""編成YAML→`FormationRequest` JSONの変換。

送信JSONは `docs/ddd/10_API設計.md`「FormationRequest」の写しであり、キーの有無まで
含めて一致させる（`additionalProperties: false` のため）。
"""

import pytest

from exercise_lab.inputs.exercise import build_enemy_formation, load_formation_config
from exercise_lab.inputs.models import ConfigError, build_ally_formation

MINIMAL_YAML = """
ally:
  units:
    - unitDefinitionId: UNIT_B
      position: { column: 2, row: REAR }
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
  memoryDefinitionIds:
    - MEMORY_Z
    - MEMORY_A
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""


def test_units_and_memories_keep_yaml_order(tmp_path):
    config = load_formation_config(write(tmp_path, MINIMAL_YAML))

    ally = build_ally_formation(config.ally)
    assert [unit["unitDefinitionId"] for unit in ally["units"]] == ["UNIT_B", "UNIT_A"]
    assert ally["memoryDefinitionIds"] == ["MEMORY_Z", "MEMORY_A"]


def test_request_without_enhancement_omits_enhancement_keys(tmp_path):
    config = load_formation_config(write(tmp_path, MINIMAL_YAML))

    assert build_enemy_formation(config.enemy) == {
        "units": [{"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "FRONT"}}],
        "memoryDefinitionIds": [],
    }
    assert build_ally_formation(config.ally) == {
        "units": [
            {"unitDefinitionId": "UNIT_B", "position": {"column": 2, "row": "REAR"}},
            {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
        ],
        "memoryDefinitionIds": ["MEMORY_Z", "MEMORY_A"],
    }


def test_duplicate_ally_position_is_rejected(tmp_path):
    yaml_text = """
ally:
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
    - unitDefinitionId: UNIT_B
      position: { column: 0, row: FRONT }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""

    with pytest.raises(ConfigError, match="column=0"):
        load_formation_config(write(tmp_path, yaml_text))


ENHANCED_YAML = """
ally:
  academyLevels:
    unitTypes: { PHYSICAL: 60 }
    attributes: { AGGRESSIVE: 40, CLEVER: 12 }
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
      level: 240
      gears:
        - { stat: ATTACK, tier: III, grade: S }
        - { stat: CRITICAL_RATE, tier: II, grade: B }
    - unitDefinitionId: UNIT_B
      position: { column: 1, row: REAR }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""

RANKED_YAML = """
ally:
  academyLevels:
    unitTypes: { PHYSICAL: 60 }
    attributes: { AGGRESSIVE: 40 }
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
      rank: 3
    - unitDefinitionId: UNIT_B
      position: { column: 1, row: REAR }
      rank: 5
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""

# R-ENH-08: モジュール補正のリクエスト上書き。
MODULE_YAML = """
ally:
  academyLevels:
    unitTypes: { PHYSICAL: 60 }
    attributes: { AGGRESSIVE: 40 }
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
      module:
        hp: { fixed: 5000, ratio: 0.1 }
        attack: { fixed: 3000 }
    - unitDefinitionId: UNIT_B
      position: { column: 1, row: REAR }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""


def test_academy_levels_emit_all_nine_keys_defaulting_to_one(tmp_path):
    config = load_formation_config(write(tmp_path, ENHANCED_YAML))

    assert build_ally_formation(config.ally)["enhancement"] == {
        "academyLevels": {
            "unitTypes": {"PHYSICAL": 60, "ENERGY": 1, "AGILE": 1},
            "attributes": {
                "AGGRESSIVE": 40,
                "SHY": 1,
                "CUTE": 1,
                "SMART": 1,
                "COMICAL": 1,
                "CLEVER": 12,
            },
        }
    }


def test_unit_enhancement_keeps_gear_order_and_omits_default_units(tmp_path):
    config = load_formation_config(write(tmp_path, ENHANCED_YAML))

    units = build_ally_formation(config.ally)["units"]

    assert units[0]["enhancement"] == {
        "level": 240,
        "gears": [
            {"stat": "ATTACK", "tier": "III", "grade": "S"},
            {"stat": "CRITICAL_RATE", "tier": "II", "grade": "B"},
        ],
    }
    # レベル200・ギア0件は省略時の既定と同値なので `enhancement` 自体を出さない。
    assert "enhancement" not in units[1]


def test_enemy_never_carries_enhancement(tmp_path):
    config = load_formation_config(write(tmp_path, ENHANCED_YAML))

    enemy = build_enemy_formation(config.enemy)

    assert "enhancement" not in enemy
    assert "enhancement" not in enemy["units"][0]


def test_unknown_academy_level_key_is_rejected(tmp_path):
    yaml_text = ENHANCED_YAML.replace("PHYSICAL: 60", "PHYSICAL: 60, MAGIC: 3")

    with pytest.raises(ConfigError, match="MAGIC"):
        load_formation_config(write(tmp_path, yaml_text))


def test_unit_rank_is_sent_when_it_differs_from_the_default(tmp_path):
    config = load_formation_config(write(tmp_path, RANKED_YAML))

    units = build_ally_formation(config.ally)["units"]

    assert units[0]["enhancement"] == {"level": 200, "rank": 3, "gears": []}


def test_unit_rank_equal_to_the_default_is_omitted(tmp_path):
    config = load_formation_config(write(tmp_path, RANKED_YAML))

    units = build_ally_formation(config.ally)["units"]

    # rank 5（LR+5）はlevel 200・ギア0件と同じく省略時の既定と同値なので、
    # `enhancement` 自体を出さない。
    assert "enhancement" not in units[1]


def test_unit_rank_without_academy_levels_is_rejected(tmp_path):
    yaml_text = MINIMAL_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      rank: 3",
    )

    with pytest.raises(ConfigError, match="academyLevels"):
        load_formation_config(write(tmp_path, yaml_text))


def test_unit_module_is_sent_when_present_and_only_the_written_fields_appear(tmp_path):
    config = load_formation_config(write(tmp_path, MODULE_YAML))

    units = build_ally_formation(config.ally)["units"]

    assert units[0]["enhancement"]["module"] == {
        "hp": {"fixed": 5000, "ratio": 0.1},
        "attack": {"fixed": 3000},
    }
    # モジュール上書きが無いユニットはlevel・rank・gearsが既定のままなので`enhancement`が無い。
    assert "enhancement" not in units[1]


def test_unit_module_alone_still_emits_enhancement_even_at_default_level_rank_gears(tmp_path):
    """R-ENH-08: モジュール上書きが1件でもあれば、他が既定のままでも`enhancement`を出す。"""
    yaml_text = """
ally:
  academyLevels:
    unitTypes: { PHYSICAL: 60 }
    attributes: { AGGRESSIVE: 40 }
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
      module:
        defense: { ratio: -0.05 }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""
    config = load_formation_config(write(tmp_path, yaml_text))

    units = build_ally_formation(config.ally)["units"]

    assert units[0]["enhancement"] == {
        "level": 200,
        "gears": [],
        "module": {"defense": {"ratio": -0.05}},
    }


@pytest.mark.parametrize(
    "literal",
    [
        pytest.param(".inf", id="inf"),
        pytest.param("-.inf", id="neg-inf"),
        pytest.param(".nan", id="nan"),
    ],
)
def test_unit_module_with_a_non_finite_value_is_rejected(tmp_path, literal):
    # R-ENH-08は有限の実数だけを許可する。YAMLの`.inf`/`-.inf`/`.nan`はPyYAMLが
    # 素直にfloat('inf')等へ読むため、pydantic側で明示的に弾く必要がある。
    yaml_text = f"""
ally:
  academyLevels:
    unitTypes: {{ PHYSICAL: 60 }}
    attributes: {{ AGGRESSIVE: 40 }}
  units:
    - unitDefinitionId: UNIT_A
      position: {{ column: 0, row: FRONT }}
      module:
        hp: {{ fixed: {literal} }}
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: {{ column: 1, row: FRONT }}
"""

    with pytest.raises(ConfigError, match="finite"):
        load_formation_config(write(tmp_path, yaml_text))


def test_unit_module_without_academy_levels_is_rejected(tmp_path):
    yaml_text = MINIMAL_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      module: { hp: { fixed: 5000 } }",
    )

    with pytest.raises(ConfigError, match="academyLevels"):
        load_formation_config(write(tmp_path, yaml_text))


def test_unit_level_without_academy_levels_is_rejected(tmp_path):
    yaml_text = MINIMAL_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      level: 240",
    )

    with pytest.raises(ConfigError, match="academyLevels"):
        load_formation_config(write(tmp_path, yaml_text))


def write(tmp_path, text: str):
    path = tmp_path / "formation.yaml"
    path.write_text(text, encoding="utf-8")
    return path
