"""近傍生成。変異・交叉・初期母集団。"""

import random

import pytest

from exercise_lab.optimize.candidate import (
    Candidate,
    Cell,
    Constraints,
    Placement,
    constraint_violations,
)
from exercise_lab.optimize.operators import (
    Neighborhood,
    UnitHint,
    heuristic_candidates,
    initial_population,
)
from exercise_lab.optimize.search_config import OperatorWeightsSpec
from helpers import MEMORY_POOL, UNIT_POOL


def make_constraints(**overrides) -> Constraints:
    defaults = {"unit_pool": UNIT_POOL, "memory_pool": MEMORY_POOL}
    return Constraints(**{**defaults, **overrides})


def only(operator: str) -> dict[str, float]:
    weights = dict.fromkeys(OperatorWeightsSpec().as_dict(), 0.0)
    weights[operator] = 1.0
    return weights


def neighborhood(weights=None, constraints=None) -> Neighborhood:
    return Neighborhood(
        constraints=constraints or make_constraints(),
        weights=weights or OperatorWeightsSpec().normalized(),
    )


SQUAD = Candidate(
    placements=(
        Placement("UNIT_A", Cell(column=0, row="FRONT")),
        Placement("UNIT_B", Cell(column=1, row="FRONT")),
        Placement("UNIT_C", Cell(column=0, row="REAR")),
    ),
    memory_definition_ids=("MEM_1", "MEM_2", "MEM_3"),
)


def test_random_candidates_always_satisfy_the_constraints():
    rules = make_constraints(
        fixed_placements=(Placement("UNIT_H", Cell(column=2, row="REAR")),),
        required_units=("UNIT_G",),
        required_memories=("MEM_8",),
    )
    space = neighborhood(constraints=rules)
    rng = random.Random(1)

    for _ in range(300):
        assert constraint_violations(space.random_candidate(rng), rules) == []


def test_mutations_always_satisfy_the_constraints():
    rules = make_constraints(
        fixed_placements=(Placement("UNIT_H", Cell(column=2, row="REAR")),),
        required_units=("UNIT_G",),
        required_memories=("MEM_8",),
    )
    space = neighborhood(constraints=rules)
    rng = random.Random(2)
    current = space.random_candidate(rng)

    for _ in range(500):
        current = space.mutate(current, rng)
        assert constraint_violations(current, rules) == []


def test_crossovers_always_satisfy_the_constraints():
    rules = make_constraints(required_units=("UNIT_G",), required_memories=("MEM_8",))
    space = neighborhood(constraints=rules)
    rng = random.Random(3)

    for _ in range(300):
        child = space.crossover(space.random_candidate(rng), space.random_candidate(rng), rng)
        assert constraint_violations(child, rules) == []


def test_a_mutation_changes_the_candidate():
    space = neighborhood()
    rng = random.Random(4)

    assert space.mutate(SQUAD, rng).canonical_key() != SQUAD.canonical_key()


def test_unit_swap_exchanges_a_member_without_touching_the_cells():
    space = neighborhood(weights=only("unit_swap"))
    rng = random.Random(5)

    mutated = space.mutate(SQUAD, rng)

    assert {p.cell for p in mutated.placements} == {p.cell for p in SQUAD.placements}
    assert set(mutated.unit_definition_ids) != set(SQUAD.unit_definition_ids)
    assert len(mutated.placements) == len(SQUAD.placements)


@pytest.mark.parametrize("operator", ["placement_move", "placement_swap", "row_flip"])
def test_placement_operators_keep_the_squad_and_the_memories(operator):
    space = neighborhood(weights=only(operator))
    rng = random.Random(6)

    mutated = space.mutate(SQUAD, rng)

    assert set(mutated.unit_definition_ids) == set(SQUAD.unit_definition_ids)
    assert mutated.memory_definition_ids == SQUAD.memory_definition_ids
    assert mutated.canonical_key() != SQUAD.canonical_key()


def test_row_flip_keeps_the_column():
    space = neighborhood(weights=only("row_flip"))
    rng = random.Random(7)

    mutated = space.mutate(SQUAD, rng)

    moved = {p.unit_definition_id: p.cell for p in mutated.placements}
    original = {p.unit_definition_id: p.cell for p in SQUAD.placements}
    changed = [unit for unit in original if moved[unit] != original[unit]]
    assert changed
    assert all(moved[unit].column == original[unit].column for unit in changed)


@pytest.mark.parametrize("operator", ["memory_swap", "memory_add", "memory_remove"])
def test_memory_operators_keep_the_placements(operator):
    space = neighborhood(weights=only(operator))
    rng = random.Random(8)

    mutated = space.mutate(SQUAD, rng)

    assert mutated.placements == SQUAD.placements
    assert set(mutated.memory_definition_ids) != set(SQUAD.memory_definition_ids)


def test_no_operator_only_reshuffles_the_memories():
    """並べ替えだけの手を持たない。順序はスコアを変えないので探索する意味がない。

    仮に持たせても `repair` がID順へ戻すため、変異が「何も変わらなかった」扱いになり、
    近傍生成の試行を空振りさせるだけになる。
    """
    space = neighborhood()
    rng = random.Random(9)

    for _ in range(200):
        mutated = space.mutate(SQUAD, rng)
        if mutated.placements == SQUAD.placements:
            assert set(mutated.memory_definition_ids) != set(SQUAD.memory_definition_ids)


def test_memory_add_is_skipped_when_every_slot_is_full():
    """適用できない演算子を選んだときも、候補を返し、制約は破らない。"""
    full = Candidate(SQUAD.placements, MEMORY_POOL[:6])
    space = neighborhood(weights=only("memory_add"))
    rng = random.Random(10)

    mutated = space.mutate(full, rng)

    assert constraint_violations(mutated, make_constraints()) == []
    assert len(mutated.memory_definition_ids) == 6


def test_unit_add_grows_the_squad():
    """人数は探索変数である。入替だけだと初期人数から動かせない。"""
    space = neighborhood(weights=only("unit_add"))

    grown = space.mutate(SQUAD, random.Random(17))

    assert len(grown.placements) == len(SQUAD.placements) + 1
    assert set(SQUAD.unit_definition_ids).issubset(grown.unit_definition_ids)


def test_unit_remove_shrinks_the_squad():
    space = neighborhood(weights=only("unit_remove"))

    shrunk = space.mutate(SQUAD, random.Random(18))

    assert len(shrunk.placements) == len(SQUAD.placements) - 1


def test_unit_add_is_skipped_when_the_squad_is_full():
    full = Candidate(
        tuple(
            Placement(unit, Cell(column=index % 3, row="FRONT" if index < 3 else "REAR"))
            for index, unit in enumerate(UNIT_POOL[:5])
        ),
        (),
    )
    space = neighborhood(weights=only("unit_add"))

    assert len(space.mutate(full, random.Random(19)).placements) == 5


def test_unit_remove_never_empties_the_squad():
    single = Candidate((Placement("UNIT_A", Cell(column=0, row="FRONT")),), ())
    space = neighborhood(weights=only("unit_remove"))

    assert len(space.mutate(single, random.Random(20)).placements) == 1


def test_repeated_mutation_can_reach_a_full_squad_from_a_small_one():
    """人数を動かす手があることの効き目。3体で始めても5体へ育てる。"""
    space = neighborhood()
    rng = random.Random(21)
    current = SQUAD

    sizes = set()
    for _ in range(300):
        current = space.mutate(current, rng)
        sizes.add(len(current.placements))

    assert max(sizes) == 5


def test_crossover_takes_the_squad_from_one_parent_and_the_memories_from_the_other():
    space = neighborhood()
    other = Candidate(
        placements=(
            Placement("UNIT_D", Cell(column=2, row="FRONT")),
            Placement("UNIT_E", Cell(column=1, row="REAR")),
        ),
        memory_definition_ids=("MEM_5", "MEM_6"),
    )

    child = space.crossover(SQUAD, other, random.Random(11))

    assert child.placements == SQUAD.placements
    assert child.memory_definition_ids == other.memory_definition_ids


def test_the_initial_population_has_the_requested_size():
    space = neighborhood()

    population = initial_population(space, random.Random(12), size=40, seeds=())

    assert len(population) == 40


def test_the_initial_population_contains_every_known_formation():
    space = neighborhood()
    seeds = (SQUAD, Candidate(SQUAD.placements, ("MEM_4",)))

    population = initial_population(space, random.Random(13), size=40, seeds=seeds)

    keys = {candidate.canonical_key() for candidate in population}
    assert all(seed.canonical_key() in keys for seed in seeds)


def test_known_formations_never_take_more_than_a_quarter_of_the_population():
    """種で埋め尽くすと多様性を失い、最終解がかえって悪くなる。"""
    space = neighborhood()
    seeds = tuple(
        Candidate(SQUAD.placements, (memory,)) for memory in MEMORY_POOL
    )  # 8件（40の25%=10件より少ないが、変異体を足しても超えさせない）

    population = initial_population(space, random.Random(14), size=20, seeds=seeds)

    seeded = [
        candidate
        for candidate in population
        if candidate.unit_definition_ids == SQUAD.unit_definition_ids
    ]
    assert len(seeded) <= 5


def test_the_initial_population_is_deterministic_for_a_seed():
    space = neighborhood()

    first = initial_population(space, random.Random(15), size=20, seeds=(SQUAD,))
    second = initial_population(space, random.Random(15), size=20, seeds=(SQUAD,))

    assert [c.canonical_key() for c in first] == [c.canonical_key() for c in second]


def test_the_initial_population_holds_no_duplicates():
    space = neighborhood()

    population = initial_population(space, random.Random(16), size=30, seeds=(SQUAD,))

    keys = [candidate.canonical_key() for candidate in population]
    assert len(set(keys)) == len(keys)


HINTS = (
    UnitHint("UNIT_A", ("FRONT",), attribute="SHY", unit_type="PHYSICAL", role="PHYSICAL_ATTACKER"),
    UnitHint("UNIT_B", ("FRONT",), attribute="SHY", unit_type="PHYSICAL", role="PHYSICAL_ATTACKER"),
    UnitHint("UNIT_C", ("BACK",), attribute="SHY", unit_type="ENERGY", role="ENERGY_ATTACKER"),
    UnitHint("UNIT_D", ("BACK",), attribute="SHY", unit_type="ENERGY", role="SUPPORT"),
    UnitHint("UNIT_E", ("FRONT", "BACK"), attribute="CUTE", unit_type="AGILE", role="SUPPORT"),
    UnitHint("UNIT_F", ("BACK",), attribute="CUTE", unit_type="AGILE", role="HEALER"),
)


def test_heuristic_seeds_place_units_on_a_row_their_aptitude_matches():
    """カタログの `FRONT`/`BACK` は編成入力の `FRONT`/`REAR` と名前が違う。"""
    aptitudes = {hint.unit_definition_id: hint.position_aptitudes for hint in HINTS}

    for candidate in heuristic_candidates(make_constraints(), HINTS):
        for placement in candidate.placements:
            wanted = "FRONT" if placement.cell.row == "FRONT" else "BACK"
            assert wanted in aptitudes[placement.unit_definition_id]


def test_a_heuristic_seed_gathers_units_that_share_an_attribute():
    """属性を揃えると編成ボーナスが伸びる。その狙いの構成を1つ種に入れる。"""
    attributes = {hint.unit_definition_id: hint.attribute for hint in HINTS}

    candidates = heuristic_candidates(make_constraints(), HINTS)

    assert any(
        len({attributes[unit] for unit in candidate.unit_definition_ids}) == 1
        for candidate in candidates
    )


def test_heuristic_seeds_satisfy_the_constraints():
    rules = make_constraints(required_units=("UNIT_G",))

    for candidate in heuristic_candidates(rules, HINTS):
        assert constraint_violations(candidate, rules) == []


def test_no_heuristic_seeds_without_catalog_hints():
    assert heuristic_candidates(make_constraints(), ()) == ()
