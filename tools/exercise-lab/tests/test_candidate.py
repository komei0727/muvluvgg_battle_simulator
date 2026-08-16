"""遺伝子型・正準キー・制約充足化。"""

import random

import pytest

from exercise_lab.optimize.candidate import (
    ALL_CELLS,
    Candidate,
    Cell,
    Constraints,
    Placement,
    constraint_violations,
    decode_candidate,
    encode_candidate,
    repair,
)

POOL = ("UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E", "UNIT_F", "UNIT_G")
MEMORIES = ("MEM_1", "MEM_2", "MEM_3", "MEM_4", "MEM_5", "MEM_6", "MEM_7", "MEM_8")


def constraints(**overrides) -> Constraints:
    defaults = {"unit_pool": POOL, "memory_pool": MEMORIES}
    return Constraints(**{**defaults, **overrides})


def candidate(units: list[tuple[str, int, str]], memories: tuple[str, ...] = ()) -> Candidate:
    return Candidate(
        placements=tuple(
            Placement(unit_definition_id=unit, cell=Cell(column=column, row=row))
            for unit, column, row in units
        ),
        memory_definition_ids=memories,
    )


def test_all_cells_covers_the_six_squares_front_first():
    assert len(ALL_CELLS) == 6
    assert ALL_CELLS[0] == Cell(column=0, row="FRONT")
    assert ALL_CELLS[3] == Cell(column=0, row="REAR")


def test_encode_decode_round_trips():
    original = candidate(
        [("UNIT_A", 0, "FRONT"), ("UNIT_B", 2, "REAR")], memories=("MEM_2", "MEM_1")
    )

    assert decode_candidate(encode_candidate(original)) == original


def test_encode_produces_json_safe_primitives():
    payload = encode_candidate(candidate([("UNIT_A", 1, "REAR")], memories=("MEM_1",)))

    assert payload == {
        "placements": [{"unitDefinitionId": "UNIT_A", "column": 1, "row": "REAR"}],
        "memoryDefinitionIds": ["MEM_1"],
    }


def test_canonical_key_ignores_the_order_units_are_listed_in():
    """送信順は結果に影響しない。

    同速時の行動順は「味方・敵・前列・絶対左列」で決まり（`06_戦闘状態遷移.md` キュー生成）、
    対象順も距離と配置で決まる。配置が同じなら書いた順が違っても同じ編成である。
    """
    listed_one_way = candidate([("UNIT_A", 0, "FRONT"), ("UNIT_B", 2, "REAR")])
    listed_the_other_way = candidate([("UNIT_B", 2, "REAR"), ("UNIT_A", 0, "FRONT")])

    assert listed_one_way.canonical_key() == listed_the_other_way.canonical_key()


def test_canonical_key_separates_different_placements_of_the_same_units():
    assert (
        candidate([("UNIT_A", 0, "FRONT")]).canonical_key()
        != candidate([("UNIT_A", 1, "FRONT")]).canonical_key()
    )


def test_canonical_key_separates_different_memory_orders():
    """メモリーの並び順は発動解決順（R-MEM-02）に効くため、別の候補として扱う。"""
    assert (
        candidate([("UNIT_A", 0, "FRONT")], memories=("MEM_1", "MEM_2")).canonical_key()
        != candidate([("UNIT_A", 0, "FRONT")], memories=("MEM_2", "MEM_1")).canonical_key()
    )


def test_repair_removes_duplicate_units_keeping_the_first():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT"), ("UNIT_A", 1, "FRONT"), ("UNIT_B", 2, "FRONT")]),
        constraints(),
    )

    assert [placement.unit_definition_id for placement in repaired.placements] == [
        "UNIT_A",
        "UNIT_B",
    ]


def test_repair_keeps_duplicate_units_when_they_are_allowed():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT"), ("UNIT_A", 1, "FRONT")]),
        constraints(allow_duplicate_units=True),
    )

    assert len(repaired.placements) == 2


def test_repair_moves_a_unit_off_an_occupied_cell():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT"), ("UNIT_B", 0, "FRONT")]),
        constraints(),
    )

    cells = [placement.cell for placement in repaired.placements]
    assert len(set(cells)) == 2
    assert cells[0] == Cell(column=0, row="FRONT")


def test_repair_drops_units_outside_the_pool():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT"), ("UNIT_UNKNOWN", 1, "FRONT")]),
        constraints(),
    )

    assert [placement.unit_definition_id for placement in repaired.placements] == ["UNIT_A"]


def test_repair_caps_the_squad_at_five_units():
    repaired = repair(
        candidate([(unit, index % 3, "FRONT") for index, unit in enumerate(POOL)]),
        constraints(),
    )

    assert len(repaired.placements) == 5


def test_repair_forces_a_fixed_placement_evicting_the_occupant():
    fixed = Placement(unit_definition_id="UNIT_G", cell=Cell(column=1, row="REAR"))
    repaired = repair(
        candidate([("UNIT_A", 1, "REAR"), ("UNIT_B", 0, "FRONT")]),
        constraints(fixed_placements=(fixed,)),
    )

    assert fixed in repaired.placements
    # 追い出された側は消えず、空いているマスへ移る（探索対象の情報を捨てない）
    assert "UNIT_A" in {placement.unit_definition_id for placement in repaired.placements}


def test_repair_moves_a_fixed_unit_that_sits_on_the_wrong_cell():
    fixed = Placement(unit_definition_id="UNIT_A", cell=Cell(column=2, row="REAR"))
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT"), ("UNIT_B", 2, "REAR")]),
        constraints(fixed_placements=(fixed,)),
    )

    assert fixed in repaired.placements
    assert len([p for p in repaired.placements if p.unit_definition_id == "UNIT_A"]) == 1


def test_repair_adds_a_required_unit_that_is_missing():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT")]),
        constraints(required_units=("UNIT_C",)),
    )

    assert "UNIT_C" in {placement.unit_definition_id for placement in repaired.placements}


def test_repair_keeps_required_units_when_the_squad_is_full():
    repaired = repair(
        candidate([(unit, index % 3, "FRONT") for index, unit in enumerate(POOL[:5])]),
        constraints(required_units=("UNIT_G",)),
    )

    assert len(repaired.placements) == 5
    assert "UNIT_G" in {placement.unit_definition_id for placement in repaired.placements}


def test_repair_removes_unknown_and_duplicated_memories():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT")], memories=("MEM_1", "MEM_UNKNOWN", "MEM_1", "MEM_2")),
        constraints(),
    )

    assert repaired.memory_definition_ids == ("MEM_1", "MEM_2")


def test_repair_caps_memories_at_six():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT")], memories=MEMORIES),
        constraints(),
    )

    assert len(repaired.memory_definition_ids) == 6


def test_repair_keeps_required_memories_even_when_the_slots_are_full():
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT")], memories=MEMORIES[:6]),
        constraints(required_memories=("MEM_8",)),
    )

    assert len(repaired.memory_definition_ids) == 6
    assert "MEM_8" in repaired.memory_definition_ids


def test_repair_does_not_pin_a_required_memory_to_a_slot():
    """必須メモリーは「入っていること」だけを強制する。

    並び順は発動解決順に効く探索変数なので、ここで位置まで固定すると探索空間から
    順序が落ちる。すでに入っているなら位置は動かさない。
    """
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT")], memories=("MEM_1", "MEM_8", "MEM_2")),
        constraints(required_memories=("MEM_8",)),
    )

    assert repaired.memory_definition_ids == ("MEM_1", "MEM_8", "MEM_2")


def test_repair_rejects_a_candidate_that_cannot_hold_one_unit():
    with pytest.raises(ValueError, match="1体"):
        repair(candidate([("UNIT_UNKNOWN", 0, "FRONT")]), constraints())


def test_repair_is_idempotent():
    once = repair(
        candidate(
            [("UNIT_A", 0, "FRONT"), ("UNIT_A", 0, "FRONT"), ("UNIT_B", 1, "FRONT")],
            memories=("MEM_1", "MEM_1"),
        ),
        constraints(),
    )

    assert repair(once, constraints()) == once


def test_repair_always_produces_a_candidate_that_satisfies_the_constraints():
    """乱雑な入力を多数流しても、出力が制約を破らないこと。"""
    rules = constraints(
        fixed_placements=(Placement("UNIT_G", Cell(column=1, row="REAR")),),
        required_units=("UNIT_F",),
        required_memories=("MEM_7",),
    )
    rng = random.Random(20260817)

    for _ in range(500):
        broken = candidate(
            [
                (
                    rng.choice([*POOL, "UNIT_UNKNOWN"]),
                    rng.randrange(3),
                    rng.choice(["FRONT", "REAR"]),
                )
                for _ in range(rng.randrange(1, 9))
            ],
            memories=tuple(
                rng.choice([*MEMORIES, "MEM_UNKNOWN"]) for _ in range(rng.randrange(0, 10))
            ),
        )

        assert constraint_violations(repair(broken, rules), rules) == []


def test_constraint_violations_reports_every_broken_rule():
    """最初の1件で止めない。設定の直し漏れで往復させないため、破った規則をすべて出す。"""
    rules = constraints(required_units=("UNIT_F",))
    broken = candidate(
        [("UNIT_A", 0, "FRONT"), ("UNIT_A", 0, "FRONT")], memories=("MEM_1", "MEM_1")
    )

    violations = constraint_violations(broken, rules)

    assert violations == [
        "同じユニットが複数入っている",
        "必須ユニットが入っていない: UNIT_F",
        "同じマスに複数のユニットが乗っている",
        "同じメモリーが複数入っている",
    ]


def test_constraints_reject_more_pinned_units_than_the_squad_holds():
    with pytest.raises(ValueError, match="上限5体"):
        constraints(required_units=POOL[:6])


def test_constraints_reject_two_fixed_slots_on_the_same_cell():
    with pytest.raises(ValueError, match="同じマス"):
        constraints(
            fixed_placements=(
                Placement("UNIT_A", Cell(column=0, row="FRONT")),
                Placement("UNIT_B", Cell(column=0, row="FRONT")),
            )
        )


def test_constraints_reject_a_required_unit_outside_the_pool():
    with pytest.raises(ValueError, match="候補プールに無い"):
        constraints(required_units=("UNIT_UNKNOWN",))


def test_repair_keeps_a_required_memory_that_sits_past_the_sixth_slot():
    """必須メモリーが7件目にあっても落とさない。件数で切ると「入っているのに欠ける」。"""
    repaired = repair(
        candidate([("UNIT_A", 0, "FRONT")], memories=(*MEMORIES[:6], "MEM_7")),
        constraints(required_memories=("MEM_7",)),
    )

    assert len(repaired.memory_definition_ids) == 6
    assert "MEM_7" in repaired.memory_definition_ids
