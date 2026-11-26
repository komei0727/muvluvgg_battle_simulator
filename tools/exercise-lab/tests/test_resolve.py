"""演習入力の解決: Catalogでの事前検証と由来情報。"""

import json

import pytest

from exercise_lab.inputs.exercise import (
    exercise_participant_slots,
    load_exercise_draft,
    resolve_exercise_config,
    resolve_exercise_input,
)
from mlgg_lab_common.inputs.catalog import Catalog
from mlgg_lab_common.inputs.player_data import PlayerDataError
from mlgg_lab_common.inputs.resolution import InputValidationError
from mlgg_lab_common.models import ConfigError, InputSource, SlotKey
from mlgg_lab_common.testing import draft_json

CONFIG_YAML = """
ally:
  units:
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    - { unitDefinitionId: UNIT_A, position: { column: 1, row: FRONT } }
  memoryDefinitionIds: [MEM_A]
enemy: { unitDefinitionId: UNIT_ENEMY_TEX, position: { column: 1, row: FRONT } }
"""

CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "rev-3",
        "units": [
            {"unitDefinitionId": "UNIT_A", "displayName": "A", "category": "PLAYABLE"},
            {
                "unitDefinitionId": "UNIT_ENEMY_TEX",
                "displayName": "E",
                "category": "EXERCISE_ENEMY",
            },
        ],
        "memories": [{"memoryDefinitionId": "MEM_A", "displayName": "a"}],
    }
)


def write(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def test_a_valid_input_records_its_sources_and_the_catalog_revision(tmp_path):
    config = write(tmp_path, "formation.yaml", CONFIG_YAML)
    player_data = write(
        tmp_path,
        "pd.json",
        json.dumps(
            {"schemaVersion": 1, "academyLevels": {"unitTypes": {}, "attributes": {}}, "units": {}}
        ),
    )

    resolved = resolve_exercise_input(config, player_data_path=player_data, catalog=CATALOG)

    assert resolved.provenance.catalog_revision == "rev-3"
    assert [(s.role, s.path, s.applies_to) for s in resolved.provenance.sources] == [
        ("MATCH_FILE", str(config), None),
        ("PLAYER_DATA", str(player_data), "ally"),
    ]
    assert len(resolved.provenance.warnings) == 2


def test_every_catalog_problem_is_reported_at_once(tmp_path):
    config = write(
        tmp_path,
        "formation.yaml",
        CONFIG_YAML.replace("UNIT_ENEMY_TEX", "UNIT_A").replace("MEM_A]", "MEM_NOPE]"),
    )

    with pytest.raises(InputValidationError) as caught:
        resolve_exercise_input(config, catalog=CATALOG)

    assert len(caught.value.errors) == 2
    assert "R-TEX-11 #1" in caught.value.errors[0]


def test_a_draft_can_be_resolved_with_the_draft_as_its_origin(tmp_path):
    draft = write(tmp_path, "draft.json", json.dumps(draft_json()))

    resolved = resolve_exercise_config(
        load_exercise_draft(draft), origin=InputSource(role="DRAFT", path=str(draft))
    )

    assert resolved.provenance.sources[0].role == "DRAFT"
    assert resolved.to_request()["enemyFormation"]["units"][0]["unitDefinitionId"] == "UNIT_ENEMY"


def test_the_enemy_is_the_single_unnumbered_enemy_slot(tmp_path):
    resolved = resolve_exercise_input(write(tmp_path, "formation.yaml", CONFIG_YAML))

    keys = [s.key for s in exercise_participant_slots(resolved.match)]

    assert keys[-1] == SlotKey(side="ENEMY", formation_number=None, unit_index=0)
    assert keys[:2] == [
        SlotKey(side="ALLY", formation_number=None, unit_index=0),
        SlotKey(side="ALLY", formation_number=None, unit_index=1),
    ]


def test_player_data_that_breaks_the_model_is_rejected_at_resolution(tmp_path):
    """解決できた入力は、保存して編集せずに読み戻せなければならない。"""
    config = write(tmp_path, "formation.yaml", CONFIG_YAML)
    player_data = write(
        tmp_path,
        "pd.json",
        json.dumps(
            {
                "schemaVersion": 1,
                "academyLevels": {"unitTypes": {}, "attributes": {}},
                "units": {"UNIT_A": {"level": 0, "gears": [None] * 9}},
            }
        ),
    )

    with pytest.raises(PlayerDataError, match=r"UNIT_A.*level"):
        resolve_exercise_input(config, player_data_path=player_data)


def test_a_resolved_input_that_would_fail_to_reload_is_rejected_at_resolution(tmp_path):
    """読み戻し時の独自検証（学園レベルのキー等）も解決時に通す。"""
    config = write(tmp_path, "formation.yaml", CONFIG_YAML)
    player_data = write(
        tmp_path,
        "pd.json",
        json.dumps(
            {
                "schemaVersion": 1,
                "academyLevels": {"unitTypes": {"PHYSICA": 80}, "attributes": {}},
                "units": {},
            }
        ),
    )

    with pytest.raises(ConfigError, match="PHYSICA"):
        resolve_exercise_input(config, player_data_path=player_data)
