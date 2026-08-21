"""ギア1手の近傍。上限に達した手を生成せず、枠の区別で重複した手も出さない。"""

from exercise_lab.gear.allocation import (
    DEFAULT_ADD_RANK,
    MAX_PIECES_PER_STAT,
    Allocation,
    GearPiece,
    GearRank,
    UnitAllocation,
)
from exercise_lab.gear.neighborhood import neighborhood


def piece(stat: str, tier: str = "III", grade: str = "S") -> GearPiece:
    return GearPiece(stat=stat, tier=tier, grade=grade)


def allocation(*pieces: GearPiece) -> Allocation:
    return Allocation((UnitAllocation(unit_definition_id="UNIT_A", pieces=tuple(pieces)),))


def kinds(moves) -> set[str]:
    return {move.kind for move in moves}


def test_a_stat_already_at_the_limit_receives_no_move():
    base = allocation(
        *(piece("ATTACK", grade=grade) for grade in ("S", "A", "B")), piece("ACTION_SPEED")
    )

    moves = neighborhood(base)

    assert all(move.added is None or move.added.stat != "ATTACK" for move in moves)
    assert any(move.added is not None and move.added.stat == "CRITICAL_RATE" for move in moves)


def test_remove_is_part_of_the_neighborhood():
    base = allocation(piece("ATTACK"), piece("ACTION_SPEED"))

    moves = neighborhood(base)

    removals = [move for move in moves if move.kind == "remove"]
    assert {move.removed.stat for move in removals} == {"ATTACK", "ACTION_SPEED"}
    assert all(move.added is None for move in removals)


def test_identical_pieces_in_different_gear_slots_produce_one_move():
    base = allocation(piece("ATTACK"), piece("ATTACK"), piece("ACTION_SPEED"))

    moves = neighborhood(base)

    assert len({move.canonical_key() for move in moves}) == len(moves)
    assert sum(1 for move in moves if move.kind == "remove") == 2


def test_add_is_dropped_once_the_unit_holds_nine_pieces():
    stats = ("ATTACK", "ACTION_SPEED", "CRITICAL_RATE")
    base = allocation(*(piece(stat, grade=grade) for stat in stats for grade in ("S", "A", "B")))

    moves = neighborhood(base)

    assert "add" not in kinds(moves)
    assert {"move", "remove"} <= kinds(moves)


def test_add_uses_the_requested_rank():
    base = allocation(piece("ATTACK"))

    moves = neighborhood(base, add_rank=GearRank(tier="II", grade="C"))

    added = [move.added for move in moves if move.kind == "add"]
    assert added and all(entry.rank == GearRank(tier="II", grade="C") for entry in added)


def test_rank_moves_are_excluded_unless_requested():
    base = allocation(piece("ATTACK", grade="B"))

    assert "rank" not in kinds(neighborhood(base))
    assert "rank" in kinds(neighborhood(base, include_rank=True))


def test_a_rank_move_never_reproduces_the_current_rank():
    base = allocation(piece("ATTACK", grade="B"))

    moves = [move for move in neighborhood(base, include_rank=True) if move.kind == "rank"]

    assert moves
    assert all(move.added != move.removed for move in moves)
    assert all(move.added.stat == "ATTACK" for move in moves)


def test_excluded_stats_are_never_touched():
    base = allocation(piece("MAXIMUM_HP"), piece("DEFENSE"), piece("ATTACK"))

    moves = neighborhood(base, include_rank=True)

    touched = {piece.stat for move in moves for piece in (move.added, move.removed) if piece}
    assert touched.isdisjoint({"MAXIMUM_HP", "DEFENSE"})


def test_every_move_produces_a_constraint_satisfying_allocation():
    base = allocation(piece("ATTACK"), piece("ATTACK"), piece("ACTION_SPEED"))

    for move in neighborhood(base, include_rank=True):
        applied = move.apply(base)
        assert applied is not None
        assert applied.violations() == []
        assert applied.canonical_key() != base.canonical_key()


def test_a_move_that_no_longer_fits_the_allocation_is_reported_as_inapplicable():
    base = allocation(piece("ATTACK"))
    removal = next(move for move in neighborhood(base) if move.kind == "remove")

    assert removal.apply(removal.apply(base)) is None


def test_moves_carry_the_unit_slot_they_belong_to():
    base = Allocation(
        (
            UnitAllocation(unit_definition_id="UNIT_A", pieces=(piece("ATTACK"),)),
            UnitAllocation(unit_definition_id="UNIT_B", pieces=(piece("ACTION_SPEED"),)),
        )
    )

    moves = neighborhood(base)

    assert {(move.slot_index, move.unit_definition_id) for move in moves} == {
        (0, "UNIT_A"),
        (1, "UNIT_B"),
    }


def test_a_move_from_one_stat_to_another_keeps_the_rank_and_the_total():
    base = allocation(piece("ATTACK", tier="II", grade="D"))

    moves = [move for move in neighborhood(base) if move.kind == "move"]

    assert moves
    for move in moves:
        assert move.removed == piece("ATTACK", tier="II", grade="D")
        assert move.added.rank == GearRank(tier="II", grade="D")
        assert move.apply(base).total() == base.total()


def test_the_neighborhood_is_deterministic():
    base = allocation(piece("ATTACK"), piece("CRITICAL_RATE"))

    first = [move.canonical_key() for move in neighborhood(base, include_rank=True)]
    second = [move.canonical_key() for move in neighborhood(base, include_rank=True)]

    assert first == second


def test_the_default_add_rank_is_the_top_of_the_table():
    assert GearRank(tier="III", grade="S") == DEFAULT_ADD_RANK
    assert MAX_PIECES_PER_STAT == 3
