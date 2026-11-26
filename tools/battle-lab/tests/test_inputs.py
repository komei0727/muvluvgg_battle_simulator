"""通常戦闘の対戦入力: 読み込み・形式固有の検証・手持ちデータの適用・解決済み入力の往復。"""

import json

import pytest

from battle_lab.inputs import (
    battle_participant_slots,
    build_battle_request,
    dump_resolved_battle_input,
    load_battle_draft,
    load_battle_match_file,
    load_resolved_battle_input,
    resolve_battle_input,
)
from mlgg_lab_common.inputs.catalog import Catalog
from mlgg_lab_common.inputs.draft import DraftError
from mlgg_lab_common.inputs.resolution import InputValidationError
from mlgg_lab_common.models import ConfigError, SlotKey
from mlgg_lab_common.testing import draft_json, slot

MATCH_YAML = """\
turnLimit: 15
allyFormation:
  units:
    - { unitDefinitionId: UNIT_B, position: { column: 2, row: REAR } }
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
  memoryDefinitionIds: [MEM_Z, MEM_A]
enemyFormation:
  # 演習と違い、敵は複数体・メモリーあり・同じ定義の複数枠でよい。
  units:
    - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    - { unitDefinitionId: UNIT_A, position: { column: 1, row: FRONT } }
    - { unitDefinitionId: UNIT_C, position: { column: 1, row: REAR } }
  memoryDefinitionIds: [MEM_A]
"""

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {"PHYSICAL": 80}, "attributes": {}},
    "units": {"UNIT_A": {"level": 300, "gears": [None] * 9}},
}

CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "rev-1",
        "units": [
            {"unitDefinitionId": unit_id, "displayName": unit_id, "category": "PLAYABLE"}
            for unit_id in ("UNIT_A", "UNIT_B", "UNIT_C")
        ]
        + [{"unitDefinitionId": "UNIT_T", "displayName": "T", "category": "EXERCISE_ENEMY"}],
        "memories": [
            {"memoryDefinitionId": memory_id, "displayName": memory_id}
            for memory_id in ("MEM_A", "MEM_Z")
        ],
    }
)


def write(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def test_the_request_keeps_order_and_carries_the_turn_limit(tmp_path):
    loaded = load_battle_match_file(write(tmp_path, "match.yaml", MATCH_YAML))

    request = build_battle_request(loaded.match)

    assert request["turnLimit"] == 15
    assert [u["unitDefinitionId"] for u in request["allyFormation"]["units"]] == [
        "UNIT_B",
        "UNIT_A",
    ]
    assert request["allyFormation"]["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert request["enemyFormation"]["memoryDefinitionIds"] == ["MEM_A"]
    assert "enhancement" not in request["enemyFormation"]


def test_the_exercise_constraints_do_not_apply(tmp_path):
    loaded = load_battle_match_file(write(tmp_path, "match.yaml", MATCH_YAML))

    resolved = resolve_battle_input(loaded, catalog=CATALOG)

    assert len(resolved.match.enemy_formation.units) == 3


def test_slots_tell_apart_the_same_definition_on_the_enemy_side(tmp_path):
    loaded = load_battle_match_file(write(tmp_path, "match.yaml", MATCH_YAML))

    enemy_a = [
        s.key
        for s in battle_participant_slots(loaded.match)
        if s.key.side == "ENEMY" and s.unit_definition_id == "UNIT_A"
    ]

    assert enemy_a == [
        SlotKey(side="ENEMY", formation_number=None, unit_index=0),
        SlotKey(side="ENEMY", formation_number=None, unit_index=1),
    ]


@pytest.mark.parametrize("turn_limit", [0, 100, "15", True, 7.5])
def test_a_turn_limit_out_of_range_or_not_an_integer_is_rejected(tmp_path, turn_limit):
    text = MATCH_YAML.replace("turnLimit: 15", f"turnLimit: {json.dumps(turn_limit)}")

    with pytest.raises(ConfigError, match="turnLimit"):
        load_battle_match_file(write(tmp_path, "match.yaml", text))


@pytest.mark.parametrize("turn_limit", [1, 99])
def test_the_turn_limit_bounds_are_accepted(tmp_path, turn_limit):
    text = MATCH_YAML.replace("turnLimit: 15", f"turnLimit: {turn_limit}")

    assert load_battle_match_file(write(tmp_path, "m.yaml", text)).match.turn_limit == turn_limit


def test_a_missing_turn_limit_is_rejected(tmp_path):
    with pytest.raises(ConfigError, match="turnLimit"):
        load_battle_match_file(write(tmp_path, "m.yaml", MATCH_YAML.replace("turnLimit: 15\n", "")))


def test_unknown_keys_are_rejected(tmp_path):
    with pytest.raises(ConfigError, match="logLevel"):
        load_battle_match_file(write(tmp_path, "m.yaml", MATCH_YAML + "logLevel: SUMMARY\n"))


def test_duplicate_positions_are_rejected_per_side(tmp_path):
    text = MATCH_YAML.replace(
        "{ column: 1, row: FRONT } }\n    - { unitDefinitionId: UNIT_C",
        "{ column: 0, row: FRONT } }\n    - { unitDefinitionId: UNIT_C",
    )

    with pytest.raises(ConfigError, match="enemyFormation: 配置が重複"):
        load_battle_match_file(write(tmp_path, "m.yaml", text))


def test_the_pool_is_playable_on_both_sides(tmp_path):
    text = MATCH_YAML.replace("UNIT_C", "UNIT_T")
    loaded = load_battle_match_file(write(tmp_path, "m.yaml", text))

    with pytest.raises(InputValidationError) as caught:
        resolve_battle_input(loaded, catalog=CATALOG)

    assert caught.value.errors == [
        "enemyFormation.units[2]: UNIT_T は category=EXERCISE_ENEMY であり PLAYABLE ではない"
        "（R-TEX-11 #3）"
    ]


def test_formations_can_come_from_the_library(tmp_path):
    library = tmp_path / "formations"
    library.mkdir()
    write(
        library,
        "rival.yaml",
        "units:\n  - { unitDefinitionId: UNIT_C, position: { column: 1, row: FRONT } }\n",
    )
    text = MATCH_YAML.split("enemyFormation:")[0] + "enemyFormation: { library: rival }\n"

    loaded = load_battle_match_file(write(tmp_path, "m.yaml", text), formations_dir=library)

    assert [u.unit_definition_id for u in loaded.match.enemy_formation.units] == ["UNIT_C"]
    assert [(s.role, s.applies_to) for s in loaded.sources] == [
        ("MATCH_FILE", None),
        ("FORMATION_LIBRARY", "enemyFormation"),
    ]


def test_player_data_goes_to_the_ally_only_by_default(tmp_path):
    loaded = load_battle_match_file(write(tmp_path, "m.yaml", MATCH_YAML))
    player_data = write(tmp_path, "pd.json", json.dumps(PLAYER_DATA))

    resolved = resolve_battle_input(loaded, player_data_path=player_data)

    request = resolved.to_request()
    assert request["allyFormation"]["units"][1]["enhancement"]["level"] == 300
    assert "enhancement" not in request["enemyFormation"]
    assert resolved.provenance.warnings == [
        "allyFormation: UNIT_B は手持ちデータに無い（レベル200・ギアなしとして評価する）"
    ]


def test_player_data_can_be_applied_to_both_sides(tmp_path):
    loaded = load_battle_match_file(write(tmp_path, "m.yaml", MATCH_YAML))
    player_data = write(tmp_path, "pd.json", json.dumps(PLAYER_DATA))

    resolved = resolve_battle_input(
        loaded, player_data_path=player_data, player_data_sides=("ALLY", "ENEMY")
    )

    enemy_units = resolved.to_request()["enemyFormation"]["units"]
    assert [u.get("enhancement", {}).get("level") for u in enemy_units] == [300, 300, None]
    assert [s.applies_to for s in resolved.provenance.sources if s.role == "PLAYER_DATA"] == [
        "allyFormation",
        "enemyFormation",
    ]


def test_the_resolved_input_round_trips_without_the_source_files(tmp_path):
    match_file = write(tmp_path, "m.yaml", MATCH_YAML)
    player_data = write(tmp_path, "pd.json", json.dumps(PLAYER_DATA))
    resolved = resolve_battle_input(
        load_battle_match_file(match_file), player_data_path=player_data, catalog=CATALOG
    )
    saved = write(tmp_path, "resolved.json", dump_resolved_battle_input(resolved))
    match_file.unlink()
    player_data.unlink()

    reloaded = load_resolved_battle_input(saved)

    assert reloaded == resolved
    assert reloaded.to_request() == resolved.to_request()
    assert reloaded.provenance.catalog_revision == "rev-1"
    assert json.loads(saved.read_text(encoding="utf-8"))["format"] == "BATTLE"


def test_a_resolved_input_of_another_format_is_rejected(tmp_path):
    resolved = resolve_battle_input(load_battle_match_file(write(tmp_path, "m.yaml", MATCH_YAML)))
    payload = json.loads(dump_resolved_battle_input(resolved))
    payload["format"] = "TOTAL_WAR"

    with pytest.raises(ConfigError, match="format"):
        load_resolved_battle_input(write(tmp_path, "r.json", json.dumps(payload)))


def test_the_normal_battle_draft_is_imported_with_both_sides_and_the_turn_limit(tmp_path):
    stored = draft_json(
        enemySlots=[slot("enemy", "REAR", 0, "UNIT_Y"), slot("enemy", "FRONT", 2, "UNIT_X")],
        enemyMemoryDefinitionIds=[None, "MEM_E", None, None, None, None],
        turnLimit=30,
    )

    loaded = load_battle_draft(write(tmp_path, "draft.json", json.dumps(stored)))

    request = build_battle_request(loaded.match)
    assert request["turnLimit"] == 30
    assert [u["unitDefinitionId"] for u in request["enemyFormation"]["units"]] == [
        "UNIT_X",
        "UNIT_Y",
    ]
    assert request["enemyFormation"]["memoryDefinitionIds"] == ["MEM_E"]
    # ドラフトの強化入力は読まない（育成状態の正本は手持ちデータ）。
    assert "enhancement" not in request["allyFormation"]


def test_a_draft_without_a_turn_limit_needs_one_given(tmp_path):
    path = write(tmp_path, "draft.json", json.dumps(draft_json(turnLimit="")))

    with pytest.raises(DraftError, match="規定ターン数"):
        load_battle_draft(path)
    assert load_battle_draft(path, turn_limit=12).match.turn_limit == 12


def test_a_draft_without_enemies_is_rejected(tmp_path):
    path = write(tmp_path, "draft.json", json.dumps(draft_json(enemySlots=[])))

    with pytest.raises(DraftError, match="両陣営"):
        load_battle_draft(path)
