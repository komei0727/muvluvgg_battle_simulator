"""ギア配分の型・制約・正準キー。送信前にR-ENH-04違反を落とす。"""

import pytest

from exercise_lab.gear.allocation import (
    MAX_PIECES_PER_STAT,
    SEARCHED_STATS,
    Allocation,
    GearAllocationError,
    GearPiece,
    UnitAllocation,
    rank_from_label,
)


def piece(stat: str, tier: str = "III", grade: str = "S") -> GearPiece:
    return GearPiece(stat=stat, tier=tier, grade=grade)


def unit(*pieces: GearPiece, unit_definition_id: str = "UNIT_A") -> UnitAllocation:
    return UnitAllocation(unit_definition_id=unit_definition_id, pieces=tuple(pieces))


def test_slot_order_does_not_change_the_canonical_key():
    first = unit(piece("ATTACK"), piece("CRITICAL_RATE"), piece("ATTACK", grade="A"))
    second = unit(piece("CRITICAL_RATE"), piece("ATTACK", grade="A"), piece("ATTACK"))

    assert first.canonical_key() == second.canonical_key()
    assert Allocation((first,)).canonical_key() == Allocation((second,)).canonical_key()


def test_the_canonical_key_separates_units_that_hold_the_same_pieces():
    left = unit(piece("ATTACK"), unit_definition_id="UNIT_A")
    right = unit(piece("ATTACK"), unit_definition_id="UNIT_B")

    assert Allocation((left, right)).canonical_key() != Allocation((right, left)).canonical_key()


def test_four_pieces_of_the_same_stat_are_rejected():
    over = unit(*(piece("ATTACK", grade=grade) for grade in ("S", "A", "B", "C")))

    violations = Allocation((over,)).violations()

    assert any("ATTACK" in violation and "R-ENH-04" in violation for violation in violations)


def test_ten_pieces_are_rejected_even_when_each_stat_stays_within_three():
    stats = [*SEARCHED_STATS[:2], "MAXIMUM_HP"]
    crowded = unit(
        *(piece(stat, grade=grade) for stat in stats for grade in ("S", "A", "B")),
        piece("CRITICAL_RATE"),
    )

    violations = Allocation((crowded,)).violations()

    assert len(crowded.pieces) == 10
    assert any("9" in violation for violation in violations)


def test_a_valid_allocation_has_no_violations():
    filled = unit(*(piece(stat) for stat in SEARCHED_STATS[:3] for _ in range(MAX_PIECES_PER_STAT)))

    assert len(filled.pieces) == 9
    assert Allocation((filled,)).violations() == []


def test_counts_are_reported_per_stat():
    mixed = unit(piece("ATTACK"), piece("ATTACK", grade="A"), piece("ACTION_SPEED"))

    assert mixed.count("ATTACK") == 2
    assert mixed.count("CRITICAL_RATE") == 0
    assert mixed.total == 3


def test_pieces_convert_to_the_request_gear_objects_in_canonical_order():
    mixed = unit(piece("CRITICAL_RATE"), piece("ATTACK", tier="II", grade="D"))

    gears = mixed.to_gears()

    assert [gear.model_dump() for gear in gears] == [
        {"stat": "ATTACK", "tier": "II", "grade": "D"},
        {"stat": "CRITICAL_RATE", "tier": "III", "grade": "S"},
    ]


def test_an_unknown_rank_label_is_rejected_with_the_accepted_forms():
    with pytest.raises(GearAllocationError) as error:
        rank_from_label("IV-S")

    assert "III-S" in str(error.value)


def test_a_rank_label_round_trips():
    assert rank_from_label("II-C").with_stat("ATTACK") == piece("ATTACK", tier="II", grade="C")
