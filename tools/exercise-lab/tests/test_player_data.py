"""ブラウザ localStorage `mlgg:player-data` エクスポートの取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `StoredPlayerData`。
"""

import json

import pytest

from exercise_lab.models import build_evaluation_request, load_formation_config
from exercise_lab.player_data import PlayerDataError, apply_player_data, load_player_data

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {
        "unitTypes": {"PHYSICAL": 60, "ENERGY": 55, "AGILE": 50},
        "attributes": {
            "AGGRESSIVE": 40,
            "SHY": 39,
            "CUTE": 38,
            "SMART": 37,
            "COMICAL": 36,
            "CLEVER": 35,
        },
    },
    "units": {
        "UNIT_A": {
            "level": 240,
            "gears": [
                {"stat": "ATTACK", "tier": "III", "grade": "S"},
                None,
                None,
                {"stat": "DEFENSE", "tier": "II", "grade": "C"},
                None,
                None,
                None,
                None,
                None,
            ],
        }
    },
}

CONFIG_YAML = """
ally:
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
    - unitDefinitionId: UNIT_MISSING
      position: { column: 1, row: FRONT }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""


def test_stored_level_and_gears_are_applied_to_the_matching_unit(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert units[0]["enhancement"] == {
        "level": 240,
        "gears": [
            {"stat": "ATTACK", "tier": "III", "grade": "S"},
            {"stat": "DEFENSE", "tier": "II", "grade": "C"},
        ],
    }


def test_stored_academy_levels_enable_side_enhancement(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    formation = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]
    assert formation["enhancement"]["academyLevels"]["unitTypes"]["ENERGY"] == 55
    assert formation["enhancement"]["academyLevels"]["attributes"]["CLEVER"] == 35


def test_unit_absent_from_player_data_is_warned_and_left_at_defaults(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, warnings = apply_player_data(config, data)

    assert any("UNIT_MISSING" in warning for warning in warnings)
    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert "enhancement" not in units[1]


def test_yaml_values_win_over_stored_values(tmp_path):
    yaml_text = CONFIG_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      level: 1\n      gears: []",
        1,
    ).replace(
        "ally:\n",
        "ally:\n  academyLevels:\n    unitTypes: { PHYSICAL: 3 }\n",
        1,
    )
    config = load_formation_config(write(tmp_path, "formation.yaml", yaml_text))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    formation = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]
    assert formation["units"][0]["enhancement"] == {"level": 1, "gears": []}
    assert formation["enhancement"]["academyLevels"]["unitTypes"] == {
        "PHYSICAL": 3,
        "ENERGY": 1,
        "AGILE": 1,
    }


def test_unknown_schema_version_is_rejected(tmp_path):
    path = write_json(tmp_path, {**PLAYER_DATA, "schemaVersion": 2})

    with pytest.raises(PlayerDataError, match="schemaVersion"):
        load_player_data(path)


def write(tmp_path, name: str, text: str):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def write_json(tmp_path, value):
    return write(tmp_path, "player-data.json", json.dumps(value))
