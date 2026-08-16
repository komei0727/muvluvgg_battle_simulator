"""UIの演習ドラフト（localStorage `mlgg:last-draft:exercise`）の取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `toStoredDraft` /
`BattleDraft`。空枠の除去と並び順は `request-mapper.ts` の `buildFormation` に合わせる。
"""

import json

import pytest

from exercise_lab.draft import DraftError, load_exercise_draft
from exercise_lab.models import build_evaluation_request


def slot(side, row, column, unit_definition_id=None, enhancement=None):
    # JSON.stringify はオブジェクトの `undefined` をキーごと落とすため、
    # 空枠には `unitDefinitionId` が現れない。
    built = {"slotKey": f"{side}:{row}:{column}", "side": side, "row": row, "column": column}
    if unit_definition_id is not None:
        built["unitDefinitionId"] = unit_definition_id
    if enhancement is not None:
        built["enhancement"] = enhancement
    return built


ENHANCEMENT = {
    "level": 298,
    "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}] + [None] * 8,
}


def draft_json(**overrides):
    draft = {
        "allySlots": [
            slot("ally", "FRONT", 0, "UNIT_A", ENHANCEMENT),
            slot("ally", "FRONT", 1),
            slot("ally", "FRONT", 2, "UNIT_C"),
            slot("ally", "REAR", 0),
            slot("ally", "REAR", 1, "UNIT_D"),
            slot("ally", "REAR", 2),
        ],
        "enemySlots": [
            slot("enemy", "FRONT", 0),
            slot("enemy", "FRONT", 1, "UNIT_ENEMY"),
            slot("enemy", "FRONT", 2),
            slot("enemy", "REAR", 0),
            slot("enemy", "REAR", 1),
            slot("enemy", "REAR", 2),
        ],
        # 空枠は配列上 `null` として並ぶ。
        "allyMemoryDefinitionIds": [None, "MEM_Z", None, "MEM_A", None, None],
        "enemyMemoryDefinitionIds": [None] * 6,
        "turnLimit": 5,
        "logLevel": "SUMMARY",
        "allyEnhancement": {
            "enabled": True,
            "academyLevels": {
                "unitTypes": {"PHYSICAL": 99, "ENERGY": 100, "AGILE": 101},
                "attributes": {
                    "AGGRESSIVE": 102,
                    "SHY": 103,
                    "CUTE": 101,
                    "SMART": 102,
                    "COMICAL": 26,
                    "CLEVER": 27,
                },
            },
        },
        "enemyEnhancement": {
            "enabled": False,
            "academyLevels": {"unitTypes": {}, "attributes": {}},
        },
    }
    draft.update(overrides)
    return {"schemaVersion": 1, "catalogRevision": "2026-08-16.3", "draft": draft}


def test_filled_slots_are_kept_in_front_then_rear_column_order(tmp_path):
    config = load_exercise_draft(write(tmp_path, draft_json()))

    units = config.ally.units
    assert [unit.unit_definition_id for unit in units] == ["UNIT_A", "UNIT_C", "UNIT_D"]
    assert [(unit.position.row, unit.position.column) for unit in units] == [
        ("FRONT", 0),
        ("FRONT", 2),
        ("REAR", 1),
    ]


def test_memory_slots_are_compressed_keeping_order(tmp_path):
    config = load_exercise_draft(write(tmp_path, draft_json()))

    assert list(config.ally.memory_definition_ids) == ["MEM_Z", "MEM_A"]


def test_enemy_slot_becomes_the_single_enemy(tmp_path):
    config = load_exercise_draft(write(tmp_path, draft_json()))

    assert config.enemy.unit_definition_id == "UNIT_ENEMY"
    assert (config.enemy.position.row, config.enemy.position.column) == ("FRONT", 1)


def test_enhancement_is_not_carried_over(tmp_path):
    # 育成状態の正本は `--player-data` に一本化する。ドラフト側の強化入力は読まない。
    config = load_exercise_draft(write(tmp_path, draft_json()))

    assert config.ally.academy_levels is None
    assert all(unit.level is None and unit.gears is None for unit in config.ally.units)
    request = build_evaluation_request(config, runs_per_candidate=1, seed="s")
    ally = request["candidates"][0]["allyFormation"]
    assert "enhancement" not in ally
    assert all("enhancement" not in unit for unit in ally["units"])


def test_draft_without_an_enemy_is_rejected(tmp_path):
    empty = [slot("enemy", row, column) for row in ("FRONT", "REAR") for column in (0, 1, 2)]

    with pytest.raises(DraftError, match="敵"):
        load_exercise_draft(write(tmp_path, draft_json(enemySlots=empty)))


def test_draft_with_two_enemies_is_rejected(tmp_path):
    two = [
        slot("enemy", "FRONT", 0, "UNIT_E1"),
        slot("enemy", "FRONT", 1, "UNIT_E2"),
        slot("enemy", "FRONT", 2),
        slot("enemy", "REAR", 0),
        slot("enemy", "REAR", 1),
        slot("enemy", "REAR", 2),
    ]

    with pytest.raises(DraftError, match="ちょうど1体"):
        load_exercise_draft(write(tmp_path, draft_json(enemySlots=two)))


def test_draft_without_allies_is_rejected(tmp_path):
    empty = [slot("ally", row, column) for row in ("FRONT", "REAR") for column in (0, 1, 2)]

    with pytest.raises(DraftError, match="味方"):
        load_exercise_draft(write(tmp_path, draft_json(allySlots=empty)))


def test_unknown_schema_version_is_rejected(tmp_path):
    stored = draft_json()
    stored["schemaVersion"] = 2

    with pytest.raises(DraftError, match="schemaVersion"):
        load_exercise_draft(write(tmp_path, stored))


def test_normal_battle_draft_is_rejected(tmp_path):
    # `mlgg:last-draft`（通常戦闘）は敵が最大5体でメモリーも持つ。演習用キーとの
    # 取り違えを、敵の体数で検出できる。
    stored = draft_json(
        enemySlots=[
            slot("enemy", "FRONT", 0, "UNIT_E1"),
            slot("enemy", "FRONT", 1, "UNIT_E2"),
            slot("enemy", "FRONT", 2, "UNIT_E3"),
            slot("enemy", "REAR", 0),
            slot("enemy", "REAR", 1),
            slot("enemy", "REAR", 2),
        ]
    )

    with pytest.raises(DraftError, match="mlgg:last-draft:exercise"):
        load_exercise_draft(write(tmp_path, stored))


def write(tmp_path, value):
    path = tmp_path / "last-draft-exercise.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return path
