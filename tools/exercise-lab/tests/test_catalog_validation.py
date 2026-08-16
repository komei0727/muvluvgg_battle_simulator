"""実行前のカタログ突き合わせ。

未知IDと編成プール違反（`R-TEX-11` #1）は、1000試行を投げてから422で返るのではなく
1回のカタログ取得で先に検出する。
"""

from exercise_lab.api import Catalog, validate_against_catalog
from exercise_lab.models import load_formation_config

CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "2026-06-28.1",
        "units": [
            {"unitDefinitionId": "UNIT_A", "displayName": "A", "category": "PLAYABLE"},
            {"unitDefinitionId": "UNIT_B", "displayName": "B", "category": "PLAYABLE"},
            {
                "unitDefinitionId": "UNIT_ENEMY",
                "displayName": "E",
                "category": "EXERCISE_ENEMY",
                "exerciseActive": True,
            },
        ],
        "memories": [{"memoryDefinitionId": "MEMORY_A", "displayName": "M"}],
    }
)

VALID_YAML = """
ally:
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
  memoryDefinitionIds: [MEMORY_A]
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""


def test_valid_config_reports_no_error(tmp_path):
    config = load_formation_config(write(tmp_path, VALID_YAML))

    assert validate_against_catalog(config, CATALOG) == []


def test_unknown_ally_unit_is_reported(tmp_path):
    config = load_formation_config(write(tmp_path, VALID_YAML.replace("UNIT_A", "UNIT_NOPE")))

    errors = validate_against_catalog(config, CATALOG)

    assert any("UNIT_NOPE" in error for error in errors)


def test_exercise_enemy_in_the_ally_side_is_reported(tmp_path):
    config = load_formation_config(write(tmp_path, VALID_YAML.replace("UNIT_A", "UNIT_ENEMY")))

    errors = validate_against_catalog(config, CATALOG)

    assert any("R-TEX-11" in error and "PLAYABLE" in error for error in errors)


def test_playable_unit_as_the_enemy_is_reported(tmp_path):
    yaml_text = VALID_YAML.replace("unitDefinitionId: UNIT_ENEMY", "unitDefinitionId: UNIT_B")
    config = load_formation_config(write(tmp_path, yaml_text))

    errors = validate_against_catalog(config, CATALOG)

    assert any("R-TEX-11" in error and "EXERCISE_ENEMY" in error for error in errors)


def test_unknown_memory_is_reported(tmp_path):
    config = load_formation_config(write(tmp_path, VALID_YAML.replace("MEMORY_A", "MEMORY_NOPE")))

    errors = validate_against_catalog(config, CATALOG)

    assert any("MEMORY_NOPE" in error for error in errors)


def write(tmp_path, text: str):
    path = tmp_path / "formation.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_unknown_id_errors_point_at_the_search_command(tmp_path):
    # IDを手で書き写す前提の道具なので、打ち間違いの次の一手を出口に置く。
    config = load_formation_config(write(tmp_path, VALID_YAML.replace("UNIT_A", "UNIT_KOTOHA")))

    errors = validate_against_catalog(config, CATALOG)

    assert any("lab units --grep" in error for error in errors)


def test_unknown_memory_errors_point_at_the_search_command(tmp_path):
    config = load_formation_config(write(tmp_path, VALID_YAML.replace("MEMORY_A", "MEM_TYPO")))

    errors = validate_against_catalog(config, CATALOG)

    assert any("lab memories --grep" in error for error in errors)
