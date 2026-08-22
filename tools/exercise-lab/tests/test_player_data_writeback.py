"""理論値配分の書き戻し。`mlgg:player-data` の形へ、入力へ重ねる形で出す。"""

import json

from exercise_lab.models import Gear
from exercise_lab.player_data import (
    load_player_data,
    overlaid_player_data,
    read_player_data_document,
)

DOCUMENT = {
    "schemaVersion": 1,
    "academyLevels": {
        "unitTypes": {"PHYSICAL": 60},
        "attributes": {"AGGRESSIVE": 40},
    },
    "levelLink": {"enabled": True, "level": 250},
    "units": {
        "UNIT_A": {
            "level": 240,
            "linkExcluded": True,
            "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}, *([None] * 8)],
        },
        "UNIT_BENCH": {
            "level": 120,
            "gears": [{"stat": "DEFENSE", "tier": "II", "grade": "C"}, *([None] * 8)],
        },
    },
}

THEORETICAL = [
    ("UNIT_A", [Gear(stat="CRITICAL_RATE", tier="III", grade="A")]),
    ("UNIT_NEW", [Gear(stat="ATTACK", tier="II", grade="D")]),
]


def overlay(document=None, allocations=None):
    document = json.loads(json.dumps(document or DOCUMENT))
    data = load_player_data_from(document)
    return overlaid_player_data(document, data, allocations or THEORETICAL)


def load_player_data_from(document):
    from exercise_lab.player_data import PlayerData

    return PlayerData.model_validate(document)


def test_the_written_document_can_be_read_back(tmp_path):
    written, _ = overlay()
    path = tmp_path / "player-data.json"
    path.write_text(json.dumps(written), encoding="utf-8")

    data = load_player_data(path)

    assert [gear.stat for gear in data.units["UNIT_A"].gears if gear] == ["CRITICAL_RATE"]
    assert [gear.stat for gear in data.units["UNIT_NEW"].gears if gear] == ["ATTACK"]


def test_a_unit_outside_the_formation_keeps_its_record():
    written, _ = overlay()

    assert written["units"]["UNIT_BENCH"] == DOCUMENT["units"]["UNIT_BENCH"]


def test_the_level_the_academy_levels_and_the_level_link_survive():
    written, _ = overlay()

    assert written["academyLevels"] == DOCUMENT["academyLevels"]
    assert written["levelLink"] == DOCUMENT["levelLink"]
    assert written["units"]["UNIT_A"]["level"] == 240
    assert written["units"]["UNIT_A"]["linkExcluded"] is True


def test_no_key_the_stored_format_does_not_know_is_added():
    written, _ = overlay()

    assert set(written) == set(DOCUMENT)
    assert set(written["units"]["UNIT_A"]) == set(DOCUMENT["units"]["UNIT_A"])
    assert set(written["units"]["UNIT_NEW"]) == {"level", "gears"}


def test_a_unit_without_a_record_is_written_at_the_level_it_was_evaluated_with():
    written, warnings = overlay()

    # レベルリンクON・除外なしなので、評価に使われたのはリンクレベルである。
    assert written["units"]["UNIT_NEW"]["level"] == 250
    assert any("UNIT_NEW" in warning for warning in warnings)


def test_the_gear_slots_are_padded_to_nine():
    written, _ = overlay()

    assert len(written["units"]["UNIT_A"]["gears"]) == 9
    assert written["units"]["UNIT_A"]["gears"][1:] == [None] * 8


def test_the_input_document_is_left_alone():
    document = json.loads(json.dumps(DOCUMENT))

    overlay(document=document)

    assert document == DOCUMENT


def test_the_same_unit_in_two_slots_is_written_once_with_a_warning():
    allocations = [
        ("UNIT_A", [Gear(stat="ATTACK", tier="III", grade="S")]),
        ("UNIT_A", [Gear(stat="CRITICAL_RATE", tier="III", grade="S")]),
    ]

    written, warnings = overlay(allocations=allocations)

    assert [gear["stat"] for gear in written["units"]["UNIT_A"]["gears"] if gear] == ["ATTACK"]
    assert any("UNIT_A" in warning for warning in warnings)


def test_reading_the_document_validates_it(tmp_path):
    path = tmp_path / "player-data.json"
    path.write_text(json.dumps(DOCUMENT), encoding="utf-8")

    assert read_player_data_document(path) == DOCUMENT
