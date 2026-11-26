"""総力戦の対戦入力: 出撃順・参加枠・再登場・1編成内の重複・ドラフト・解決済み入力の往復。"""

import json

import pytest

from mlgg_lab_common.inputs.catalog import Catalog
from mlgg_lab_common.inputs.draft import DraftError
from mlgg_lab_common.inputs.player_data import PlayerDataError
from mlgg_lab_common.inputs.resolution import InputValidationError
from mlgg_lab_common.models import ConfigError, SlotKey
from mlgg_lab_common.testing import draft_body, slot
from total_war_lab.inputs import (
    build_total_war_request,
    dump_resolved_total_war_input,
    load_resolved_total_war_input,
    load_total_war_draft,
    load_total_war_match_file,
    resolve_total_war_input,
    total_war_participant_slots,
)

MATCH_YAML = """\
allyFormations:
  - units:
      - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
      - { unitDefinitionId: UNIT_B, position: { column: 1, row: FRONT } }
    memoryDefinitionIds: [MEM_A, MEM_B]
  # 別の編成への同一ユニット・同一メモリーは再登場として許可される（R-TWR-01 #3／#4）。
  # 配置も編成ごとに判定するので、1編成目と同じ位置を使ってよい。
  - units:
      - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }
    memoryDefinitionIds: [MEM_A]
enemyFormations:
  - units:
      - { unitDefinitionId: UNIT_C, position: { column: 1, row: REAR } }
"""

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {}, "attributes": {}},
    "units": {"UNIT_A": {"level": 400, "gears": [None] * 9}},
}

CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "rev-2",
        "units": [
            {"unitDefinitionId": unit_id, "displayName": unit_id, "category": "PLAYABLE"}
            for unit_id in ("UNIT_A", "UNIT_B", "UNIT_C")
        ]
        + [{"unitDefinitionId": "UNIT_T", "displayName": "T", "category": "EXERCISE_ENEMY"}],
        "memories": [
            {"memoryDefinitionId": memory_id, "displayName": memory_id}
            for memory_id in ("MEM_A", "MEM_B")
        ],
    }
)


def write(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def load(tmp_path, text=MATCH_YAML, **kwargs):
    return load_total_war_match_file(write(tmp_path, "match.yaml", text), **kwargs)


def test_formations_are_sent_in_deployment_order_and_sides_may_differ_in_count(tmp_path):
    request = build_total_war_request(load(tmp_path).match)

    assert [len(f["units"]) for f in request["allyFormations"]] == [2, 1]
    assert [f["memoryDefinitionIds"] for f in request["allyFormations"]] == [
        ["MEM_A", "MEM_B"],
        ["MEM_A"],
    ]
    assert len(request["enemyFormations"]) == 1
    assert "turnLimit" not in request


def test_a_reappearing_unit_is_accepted_and_told_apart_by_formation_number(tmp_path):
    loaded = load(tmp_path)

    resolve_total_war_input(loaded, catalog=CATALOG)
    keys = [
        s.key for s in total_war_participant_slots(loaded.match) if s.unit_definition_id == "UNIT_A"
    ]

    assert keys == [
        SlotKey(side="ALLY", formation_number=1, unit_index=0),
        SlotKey(side="ALLY", formation_number=2, unit_index=0),
    ]


def test_duplicates_within_one_formation_are_all_reported_with_their_paths(tmp_path):
    text = MATCH_YAML.replace(
        "UNIT_B, position: { column: 1, row: FRONT } }\n    memoryDefinitionIds: [MEM_A, MEM_B]",
        "UNIT_A, position: { column: 1, row: FRONT } }\n    memoryDefinitionIds: [MEM_A, MEM_A]",
    )

    with pytest.raises(InputValidationError) as caught:
        load(tmp_path, text)

    assert [error.split(": ", 1)[1].split(":")[0] for error in caught.value.errors] == [
        "allyFormations[0].units[1].unitDefinitionId",
        "allyFormations[0].memoryDefinitionIds[1]",
    ]


@pytest.mark.parametrize("count", [0, 4])
def test_the_formation_count_must_be_one_to_three(tmp_path, count):
    entry = "  - units: [{ unitDefinitionId: UNIT_C, position: { column: 0, row: FRONT } }]\n"
    text = MATCH_YAML.split("enemyFormations:")[0] + "enemyFormations:\n" + entry * count
    if count == 0:
        text = text.replace("enemyFormations:\n", "enemyFormations: []\n")

    with pytest.raises(ConfigError, match="enemyFormations"):
        load(tmp_path, text)


def test_a_turn_limit_cannot_be_given(tmp_path):
    with pytest.raises(ConfigError, match="turnLimit"):
        load(tmp_path, MATCH_YAML + "turnLimit: 15\n")


def test_duplicate_positions_are_checked_per_formation(tmp_path):
    text = MATCH_YAML.replace(
        "UNIT_B, position: { column: 1, row: FRONT }", "UNIT_B, position: { column: 0, row: FRONT }"
    )

    with pytest.raises(ConfigError, match=r"allyFormations\[0\]: 配置が重複"):
        load(tmp_path, text)


def test_the_pool_is_playable_on_both_sides(tmp_path):
    loaded = load(tmp_path, MATCH_YAML.replace("UNIT_C", "UNIT_T"))

    with pytest.raises(InputValidationError) as caught:
        resolve_total_war_input(loaded, catalog=CATALOG)

    assert caught.value.errors[0].startswith("enemyFormations[0].units[0]: UNIT_T")


def test_library_references_expand_in_place_and_keep_the_order(tmp_path):
    library = tmp_path / "formations"
    library.mkdir()
    write(
        library,
        "anchor.yaml",
        "units:\n  - { unitDefinitionId: UNIT_B, position: { column: 2, row: REAR } }\n",
    )
    text = MATCH_YAML.replace("enemyFormations:\n", "enemyFormations:\n  - library: anchor\n")

    loaded = load(tmp_path, text, formations_dir=library)

    assert [f.units[0].unit_definition_id for f in loaded.match.enemy_formations] == [
        "UNIT_B",
        "UNIT_C",
    ]
    assert loaded.sources[1].applies_to == "enemyFormations[0]"


def test_player_data_is_applied_to_every_formation_of_the_side(tmp_path):
    player_data = write(tmp_path, "pd.json", json.dumps(PLAYER_DATA))

    resolved = resolve_total_war_input(load(tmp_path), player_data_path=player_data)

    levels = [
        [u.get("enhancement", {}).get("level") for u in f["units"]]
        for f in resolved.to_request()["allyFormations"]
    ]
    assert levels == [[400, None], [400]]
    assert resolved.provenance.warnings == [
        "allyFormations[0]: UNIT_B は手持ちデータに無い（レベル200・ギアなしとして評価する）"
    ]
    assert "enhancement" not in resolved.to_request()["enemyFormations"][0]


def test_the_resolved_input_round_trips_without_the_source_files(tmp_path):
    match_file = write(tmp_path, "match.yaml", MATCH_YAML)
    player_data = write(tmp_path, "pd.json", json.dumps(PLAYER_DATA))
    resolved = resolve_total_war_input(
        load_total_war_match_file(match_file),
        player_data_path=player_data,
        player_data_sides=("ALLY", "ENEMY"),
        catalog=CATALOG,
    )
    saved = write(tmp_path, "resolved.json", dump_resolved_total_war_input(resolved))
    match_file.unlink()
    player_data.unlink()

    reloaded = load_resolved_total_war_input(saved)

    assert reloaded == resolved
    assert reloaded.to_request() == resolved.to_request()
    assert reloaded.participant_slots() == resolved.participant_slots()


def test_a_saved_input_edited_into_an_invalid_one_is_rejected_on_load(tmp_path):
    resolved = resolve_total_war_input(load(tmp_path))
    payload = json.loads(dump_resolved_total_war_input(resolved))
    payload["match"]["allyFormations"][0]["memoryDefinitionIds"] = ["MEM_A", "MEM_A"]

    with pytest.raises(InputValidationError, match="R-TWR-01 #4"):
        load_resolved_total_war_input(write(tmp_path, "r.json", json.dumps(payload)))


def stored_total_war_draft(ally_count, enemy_count, bodies=None):
    return {
        "schemaVersion": 1,
        "formations": bodies
        or [
            draft_body(),
            draft_body(
                allySlots=[slot("ally", "REAR", 2, "UNIT_A")],
                enemySlots=[slot("enemy", "FRONT", 0, "UNIT_E2")],
                allyMemoryDefinitionIds=["MEM_A"] + [None] * 5,
            ),
            draft_body(allySlots=[], enemySlots=[]),
        ],
        "formationCounts": {"ally": ally_count, "enemy": enemy_count},
        "logLevel": "SUMMARY",
    }


def test_the_draft_uses_the_leading_sets_for_each_side(tmp_path):
    path = write(tmp_path, "draft.json", json.dumps(stored_total_war_draft(2, 1)))

    match = load_total_war_draft(path).match

    assert [[u.unit_definition_id for u in f.units] for f in match.ally_formations] == [
        ["UNIT_A", "UNIT_C", "UNIT_D"],
        ["UNIT_A"],
    ]
    assert [[u.unit_definition_id for u in f.units] for f in match.enemy_formations] == [
        ["UNIT_ENEMY"]
    ]
    # 各組の強化入力・規定ターン数は読まない。
    assert build_total_war_request(match)["allyFormations"][0].get("enhancement") is None


def test_a_draft_using_an_empty_set_is_rejected(tmp_path):
    path = write(tmp_path, "draft.json", json.dumps(stored_total_war_draft(3, 1)))

    with pytest.raises(DraftError, match=r"allyFormations\[2\]"):
        load_total_war_draft(path)


@pytest.mark.parametrize("count", [0, 4, True, "2"])
def test_a_draft_with_a_bad_formation_count_is_rejected(tmp_path, count):
    path = write(tmp_path, "draft.json", json.dumps(stored_total_war_draft(count, 1)))

    with pytest.raises(DraftError, match="編成数"):
        load_total_war_draft(path)


def test_a_normal_battle_draft_is_not_read_as_a_total_war_draft(tmp_path):
    path = write(tmp_path, "draft.json", json.dumps({"schemaVersion": 1, "draft": draft_body()}))

    with pytest.raises(DraftError, match="mlgg:last-draft:total-war"):
        load_total_war_draft(path)


def test_player_data_that_breaks_the_model_is_rejected_at_resolution(tmp_path):
    """解決できた入力は、保存して編集せずに読み戻せなければならない。"""
    broken = {**PLAYER_DATA, "units": {"UNIT_A": {"level": 0, "gears": [None] * 9}}}
    player_data = write(tmp_path, "pd.json", json.dumps(broken))

    with pytest.raises(PlayerDataError, match=r"UNIT_A.*level"):
        resolve_total_war_input(load(tmp_path), player_data_path=player_data)
