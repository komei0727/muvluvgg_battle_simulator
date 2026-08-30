"""編成YAML→一括評価リクエストJSONの変換。

送信JSONは `docs/ddd/10_API設計.md`「FormationRequest」「TacticalExerciseEvaluationRequest」
の写しであり、キーの有無まで含めて一致させる（`additionalProperties: false` のため）。
"""

import pytest

from exercise_lab.models import (
    ConfigError,
    build_evaluation_request,
    load_formation_config,
)

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

    request = build_evaluation_request(config, runs_per_candidate=3, seed="abc123")

    ally = request["candidates"][0]["allyFormation"]
    assert [unit["unitDefinitionId"] for unit in ally["units"]] == ["UNIT_B", "UNIT_A"]
    assert ally["memoryDefinitionIds"] == ["MEMORY_Z", "MEMORY_A"]


def test_request_without_enhancement_omits_enhancement_keys(tmp_path):
    config = load_formation_config(write(tmp_path, MINIMAL_YAML))

    request = build_evaluation_request(config, runs_per_candidate=3, seed="abc123")

    assert request == {
        "enemyFormation": {
            "units": [
                {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "FRONT"}}
            ],
            "memoryDefinitionIds": [],
        },
        "candidates": [
            {
                "allyFormation": {
                    "units": [
                        {"unitDefinitionId": "UNIT_B", "position": {"column": 2, "row": "REAR"}},
                        {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
                    ],
                    "memoryDefinitionIds": ["MEMORY_Z", "MEMORY_A"],
                }
            }
        ],
        "runsPerCandidate": 3,
        "seed": "abc123",
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


def test_academy_levels_emit_all_nine_keys_defaulting_to_one(tmp_path):
    config = load_formation_config(write(tmp_path, ENHANCED_YAML))

    request = build_evaluation_request(config, runs_per_candidate=1, seed="s")

    assert request["candidates"][0]["allyFormation"]["enhancement"] == {
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

    units = build_evaluation_request(config, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]

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

    enemy = build_evaluation_request(config, runs_per_candidate=1, seed="s")["enemyFormation"]

    assert "enhancement" not in enemy
    assert "enhancement" not in enemy["units"][0]


def test_unknown_academy_level_key_is_rejected(tmp_path):
    yaml_text = ENHANCED_YAML.replace("PHYSICAL: 60", "PHYSICAL: 60, MAGIC: 3")

    with pytest.raises(ConfigError, match="MAGIC"):
        load_formation_config(write(tmp_path, yaml_text))


def test_unit_rank_is_sent_when_it_differs_from_the_default(tmp_path):
    config = load_formation_config(write(tmp_path, RANKED_YAML))

    units = build_evaluation_request(config, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]

    assert units[0]["enhancement"] == {"level": 200, "rank": 3, "gears": []}


def test_unit_rank_equal_to_the_default_is_omitted(tmp_path):
    config = load_formation_config(write(tmp_path, RANKED_YAML))

    units = build_evaluation_request(config, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]

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
