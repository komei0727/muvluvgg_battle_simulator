"""参加枠の識別、対戦入力内の編成1件（インライン／ライブラリ参照）、ドラフト本体、参照検証。"""

import pytest

from mlgg_lab_common.inputs.catalog import PLAYABLE, Catalog, formation_reference_errors
from mlgg_lab_common.inputs.draft import parse_draft_body
from mlgg_lab_common.inputs.sources import load_formation_entry
from mlgg_lab_common.models import ConfigError, FormationSpec, SlotKey, participant_slots
from mlgg_lab_common.testing import draft_body, slot

FIRST = {"units": [{"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}}]}
SECOND = {
    "units": [
        {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
        {"unitDefinitionId": "UNIT_A", "position": {"column": 1, "row": "FRONT"}},
    ]
}

LIBRARY_ENTRY = """\
note: 記録用
units:
  - unitDefinitionId: UNIT_B
    position: { column: 2, row: REAR }
  - unitDefinitionId: UNIT_A
    position: { column: 0, row: FRONT }
memoryDefinitionIds: [MEM_Z, MEM_A]
"""


def test_slots_are_keyed_by_position_in_the_request_not_by_definition():
    slots = participant_slots("ALLY", [FormationSpec.model_validate(SECOND)], numbered=False)

    assert [s.key for s in slots] == [
        SlotKey(side="ALLY", formation_number=None, unit_index=0),
        SlotKey(side="ALLY", formation_number=None, unit_index=1),
    ]
    assert {s.unit_definition_id for s in slots} == {"UNIT_A"}


def test_numbered_slots_carry_the_one_based_formation_number():
    formations = [FormationSpec.model_validate(FIRST), FormationSpec.model_validate(SECOND)]

    keys = [s.key for s in participant_slots("ENEMY", formations, numbered=True)]

    assert keys == [
        SlotKey(side="ENEMY", formation_number=1, unit_index=0),
        SlotKey(side="ENEMY", formation_number=2, unit_index=0),
        SlotKey(side="ENEMY", formation_number=2, unit_index=1),
    ]


def test_unnumbered_slots_need_exactly_one_formation():
    formations = [FormationSpec.model_validate(FIRST)] * 2

    with pytest.raises(ValueError):
        participant_slots("ALLY", formations, numbered=False)


def test_an_inline_entry_is_validated(tmp_path):
    duplicated = {"units": [FIRST["units"][0], FIRST["units"][0]]}

    with pytest.raises(ConfigError, match="配置が重複"):
        load_formation_entry(duplicated, "allyFormation", formations_dir=tmp_path)


def test_a_library_reference_is_expanded_with_its_source_recorded(tmp_path):
    (tmp_path / "olga.yaml").write_text(LIBRARY_ENTRY, encoding="utf-8")

    loaded = load_formation_entry({"library": "olga"}, "enemyFormation", formations_dir=tmp_path)

    assert [u.unit_definition_id for u in loaded.formation.units] == ["UNIT_B", "UNIT_A"]
    assert loaded.formation.memory_definition_ids == ["MEM_Z", "MEM_A"]
    assert loaded.formation.academy_levels is None
    assert loaded.source is not None
    assert loaded.source.role == "FORMATION_LIBRARY"
    assert loaded.source.path == str(tmp_path / "olga.yaml")
    assert loaded.source.applies_to == "enemyFormation"


def test_a_library_reference_cannot_be_mixed_with_inline_fields(tmp_path):
    with pytest.raises(ConfigError, match="academyLevels"):
        load_formation_entry(
            {"library": "olga", "academyLevels": {}}, "allyFormation", formations_dir=tmp_path
        )


def test_a_library_reference_needs_a_directory():
    with pytest.raises(ConfigError, match="ディレクトリが指定されていない"):
        load_formation_entry({"library": "olga"}, "allyFormation", formations_dir=None)


def test_a_draft_body_keeps_both_sides_in_row_then_column_order_and_memory_slot_order():
    body = draft_body(
        enemySlots=[slot("enemy", "REAR", 2, "UNIT_Y"), slot("enemy", "FRONT", 1, "UNIT_X")],
        enemyMemoryDefinitionIds=["MEM_Q", None, "MEM_P", None, None, None],
    )

    draft = parse_draft_body(body, where="draft")

    assert [s.unit_definition_id for s in draft.ally_slots] == ["UNIT_A", "UNIT_C", "UNIT_D"]
    assert [s.unit_definition_id for s in draft.enemy_slots] == ["UNIT_X", "UNIT_Y"]
    assert draft.ally_memory_definition_ids == ("MEM_Z", "MEM_A")
    assert draft.enemy_memory_definition_ids == ("MEM_Q", "MEM_P")
    assert draft.turn_limit == 5


@pytest.mark.parametrize("value", ["", True, None, "10"])
def test_an_unset_or_malformed_turn_limit_is_read_as_absent(value):
    assert parse_draft_body(draft_body(turnLimit=value), where="draft").turn_limit is None


CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "rev",
        "units": [
            {"unitDefinitionId": "UNIT_A", "displayName": "A", "category": PLAYABLE},
            {"unitDefinitionId": "UNIT_T", "displayName": "T", "category": "EXERCISE_ENEMY"},
        ],
        "memories": [{"memoryDefinitionId": "MEM_A", "displayName": "a"}],
    }
)


def test_reference_errors_point_at_each_slot_and_carry_the_given_rule():
    spec = FormationSpec.model_validate(
        {
            "units": [
                {"unitDefinitionId": "UNIT_T", "position": {"column": 0, "row": "FRONT"}},
                {"unitDefinitionId": "UNIT_NOPE", "position": {"column": 1, "row": "FRONT"}},
            ],
            "memoryDefinitionIds": ["MEM_A", "MEM_NOPE"],
        }
    )

    errors = formation_reference_errors(
        spec, "allyFormations[1]", CATALOG, required_category=PLAYABLE, rule="R-X #9"
    )

    assert len(errors) == 3
    assert errors[0].startswith("allyFormations[1].units[0]: UNIT_T")
    assert "（R-X #9）" in errors[0]
    assert errors[1].startswith("allyFormations[1].units[1]: 未知のユニット UNIT_NOPE")
    assert errors[2].startswith("allyFormations[1].memoryDefinitionIds: 未知のメモリー MEM_NOPE")
