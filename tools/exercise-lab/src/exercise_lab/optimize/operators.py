"""近傍生成——変異・交叉・初期母集団。

演算子は制約を気にせず候補を壊してよい。正しさは `repair` が一手に引き受けるので、
ここは「どこをどう動かすか」だけを持つ。演算子の選択は重み付きで、既定は配置と
メモリーを主、ユニット入替を低頻度にしてある（`search_config.OperatorWeightsSpec`）。

乱数は呼び出し側の `random.Random` を受け取り、モジュール内では作らない。
状態保存からの再開で探索軌跡が変わらない条件として、乱数源を1つに保つ。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from random import Random

from .candidate import (
    ALL_CELLS,
    Candidate,
    Cell,
    Constraints,
    Placement,
    cell_index,
    repair,
)

# 変異が入力と同じ候補になったときに引き直す回数。適用できない演算子（空のメモリー列へ
# の削除など）を引いても、1回の呼び出しで近傍を返せるようにする。
MUTATION_ATTEMPTS = 8

# カタログの適性は `FRONT`/`BACK`、編成入力の後衛は `REAR`。名前の違いをここへ閉じ込める
# （`apps/ui/src/lib/aptitude.ts` と同じ対応）。
_APTITUDE_OF_ROW = {"FRONT": "FRONT", "REAR": "BACK"}

# 攻撃役とみなすロール。高攻撃力構成の種を組むときの優先度にだけ使う。
_ATTACKER_ROLES = ("PHYSICAL_ATTACKER", "ENERGY_ATTACKER")


@dataclass(frozen=True)
class UnitHint:
    """カタログが持つユニットの属性。ヒューリスティック種を組むためだけに使う。

    探索そのものはこれを見ない。適性やロールから性能を推し量るのは当てずっぽうであり、
    正しさの判定は評価APIの結果だけに委ねる。
    """

    unit_definition_id: str
    position_aptitudes: tuple[str, ...]
    attribute: str
    unit_type: str
    role: str

    def fits(self, row: str) -> bool:
        return _APTITUDE_OF_ROW[row] in self.position_aptitudes


@dataclass(frozen=True)
class Neighborhood:
    constraints: Constraints
    weights: Mapping[str, float]

    def random_candidate(self, rng: Random) -> Candidate:
        size = rng.randint(1, self.constraints.max_units)
        units = rng.sample(self.constraints.unit_pool, min(size, len(self.constraints.unit_pool)))
        cells = rng.sample(ALL_CELLS, len(units))
        memory_count = rng.randint(0, min(self.constraints.max_memories, len(self._memory_pool)))
        return repair(
            Candidate(
                placements=tuple(
                    Placement(unit_definition_id=unit, cell=cell)
                    for unit, cell in zip(units, cells, strict=True)
                ),
                memory_definition_ids=tuple(rng.sample(self._memory_pool, memory_count)),
            ),
            self.constraints,
        )

    def mutate(self, candidate: Candidate, rng: Random) -> Candidate:
        """近傍を1つ返す。適用できない演算子を引いたら引き直す。

        引き直しても変わらない場合（1体しかいない編成への配置交換など）は入力を返す。
        呼び出し側は「必ず別の候補が返る」ことを当てにしない。
        """
        names = list(self.weights)
        weights = [self.weights[name] for name in names]
        for _ in range(MUTATION_ATTEMPTS):
            (operator,) = rng.choices(names, weights=weights, k=1)
            mutated = repair(_OPERATORS[operator](self, candidate, rng), self.constraints)
            if mutated.canonical_key() != candidate.canonical_key():
                return mutated
        return repair(candidate, self.constraints)

    def crossover(self, first: Candidate, second: Candidate, rng: Random) -> Candidate:
        """片方のユニット構成と、もう片方のメモリー構成を組み合わせる。

        配置とメモリーは別々の部分問題として動くので、良い配置と良いメモリーの組が
        別のエリートに分かれて出たときに、それを1つへまとめる手を用意する。
        """
        del rng
        return repair(
            Candidate(
                placements=first.placements,
                memory_definition_ids=second.memory_definition_ids,
            ),
            self.constraints,
        )

    @property
    def _memory_pool(self) -> tuple[str, ...]:
        return self.constraints.memory_pool

    def _unused_units(self, candidate: Candidate) -> list[str]:
        used = set(candidate.unit_definition_ids)
        return [unit for unit in self.constraints.unit_pool if unit not in used]

    def _unused_memories(self, candidate: Candidate) -> list[str]:
        used = set(candidate.memory_definition_ids)
        return [memory for memory in self._memory_pool if memory not in used]

    def _movable(self, candidate: Candidate) -> list[Placement]:
        """固定スロットに乗っていないユニット。配置系の演算子が動かせる対象。"""
        fixed = self.constraints.fixed_unit_ids
        return [
            placement
            for placement in candidate.placements
            if placement.unit_definition_id not in fixed
        ]


def _unit_swap(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """編成中の1体を、プール内の未使用ユニットと入れ替える。マスは動かさない。"""
    swappable = [
        placement
        for placement in space._movable(candidate)
        if placement.unit_definition_id not in space.constraints.required_units
    ]
    unused = space._unused_units(candidate)
    if not swappable or not unused:
        return candidate
    target = rng.choice(swappable)
    replacement = rng.choice(unused)
    return _replace(
        candidate,
        target,
        Placement(unit_definition_id=replacement, cell=target.cell),
    )


def _unit_add(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """未使用のユニットを空きマスへ足す。

    入替だけでは編成人数が初期値から動かず、探索空間から人数の次元が丸ごと落ちる。
    3体で始まった候補が5体へ育てない、という形で最適解へ届かなくなる。
    """
    occupied = {placement.cell for placement in candidate.placements}
    free = [cell for cell in ALL_CELLS if cell not in occupied]
    unused = space._unused_units(candidate)
    if not free or not unused or len(candidate.placements) >= space.constraints.max_units:
        return candidate
    return Candidate(
        (
            *candidate.placements,
            Placement(unit_definition_id=rng.choice(unused), cell=rng.choice(free)),
        ),
        candidate.memory_definition_ids,
    )


def _unit_remove(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """1体を外す。空いたマスを他の配置へ使う手を残すために持つ。"""
    removable = [
        placement
        for placement in space._movable(candidate)
        if placement.unit_definition_id not in space.constraints.required_units
    ]
    if not removable or len(candidate.placements) <= 1:
        return candidate
    target = rng.choice(removable)
    return Candidate(
        tuple(placement for placement in candidate.placements if placement != target),
        candidate.memory_definition_ids,
    )


def _placement_move(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """1体を空きマスへ移す。"""
    movable = space._movable(candidate)
    occupied = {placement.cell for placement in candidate.placements}
    free = [cell for cell in ALL_CELLS if cell not in occupied]
    if not movable or not free:
        return candidate
    target = rng.choice(movable)
    return _replace(
        candidate,
        target,
        Placement(unit_definition_id=target.unit_definition_id, cell=rng.choice(free)),
    )


def _placement_swap(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """2体のマスを入れ替える。"""
    movable = space._movable(candidate)
    if len(movable) < 2:
        return candidate
    first, second = rng.sample(movable, 2)
    placements = [
        placement for placement in candidate.placements if placement not in (first, second)
    ]
    placements.append(Placement(first.unit_definition_id, second.cell))
    placements.append(Placement(second.unit_definition_id, first.cell))
    return Candidate(tuple(placements), candidate.memory_definition_ids)


def _row_flip(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """1体を同じ列の反対の行へ移す。前後の入れ替えは行動順と対象順の両方に効く。"""
    movable = space._movable(candidate)
    occupied = {placement.cell for placement in candidate.placements}
    flippable = [
        placement
        for placement in movable
        if Cell(column=placement.cell.column, row=_opposite(placement.cell.row)) not in occupied
    ]
    if not flippable:
        return candidate
    target = rng.choice(flippable)
    return _replace(
        candidate,
        target,
        Placement(
            unit_definition_id=target.unit_definition_id,
            cell=Cell(column=target.cell.column, row=_opposite(target.cell.row)),
        ),
    )


def _memory_swap(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    """1枠を未使用のメモリーへ差し替える。"""
    slots = _free_memory_slots(space, candidate)
    unused = space._unused_memories(candidate)
    if not slots or not unused:
        return candidate
    memories = list(candidate.memory_definition_ids)
    memories[rng.choice(slots)] = rng.choice(unused)
    return Candidate(candidate.placements, tuple(memories))


def _memory_add(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    unused = space._unused_memories(candidate)
    if not unused or len(candidate.memory_definition_ids) >= space.constraints.max_memories:
        return candidate
    # 差し込む位置は選ばない。並びはスコアを変えず、`repair` がID順へ揃える。
    return Candidate(candidate.placements, (*candidate.memory_definition_ids, rng.choice(unused)))


def _memory_remove(space: Neighborhood, candidate: Candidate, rng: Random) -> Candidate:
    slots = _free_memory_slots(space, candidate)
    if not slots:
        return candidate
    memories = list(candidate.memory_definition_ids)
    del memories[rng.choice(slots)]
    return Candidate(candidate.placements, tuple(memories))


_OPERATORS = {
    "unit_swap": _unit_swap,
    "unit_add": _unit_add,
    "unit_remove": _unit_remove,
    "placement_move": _placement_move,
    "placement_swap": _placement_swap,
    "row_flip": _row_flip,
    "memory_swap": _memory_swap,
    "memory_add": _memory_add,
    "memory_remove": _memory_remove,
}


def initial_population(
    space: Neighborhood,
    rng: Random,
    *,
    size: int,
    seeds: Sequence[Candidate],
    hints: Sequence[UnitHint] = (),
    max_seed_count: int | None = None,
) -> list[Candidate]:
    """初期母集団を組む。

    並びは「既知の良編成 → その変異体 → ヒューリスティック種 → ランダム」。既知解由来を
    上限まで先に入れるのは、良い出発点を確実に含めるためである。一方でそれ以上増やすと
    集団が似通い、未知の組み合わせへ届かなくなるので `max_seed_count` で頭打ちにする。
    """
    limit = size // 4 if max_seed_count is None else max_seed_count
    population: list[Candidate] = []
    keys: set[str] = set()

    def add(candidate: Candidate) -> bool:
        key = candidate.canonical_key()
        if key in keys or len(population) >= size:
            return False
        keys.add(key)
        population.append(candidate)
        return True

    seeded = [repair(seed, space.constraints) for seed in seeds[:limit]]
    for seed in seeded:
        add(seed)
    # 残った種枠は既知編成の軽い変異体で埋める。良い編成の「すぐ隣」は当たりが多い。
    while seeded and len(population) < min(limit, size):
        before = len(population)
        for seed in seeded:
            if len(population) >= min(limit, size):
                break
            add(space.mutate(seed, rng))
        if len(population) == before:
            break

    for candidate in heuristic_candidates(space.constraints, hints):
        add(candidate)

    guard = 0
    while len(population) < size and guard < size * 50:
        guard += 1
        add(space.random_candidate(rng))
    return population


def heuristic_candidates(
    constraints: Constraints, hints: Sequence[UnitHint]
) -> tuple[Candidate, ...]:
    """当たりの付いた出発点。カタログ情報が無ければ何も返さない。

    どちらも「勝てる編成」の主張ではなく、ランダムより筋の良い出発点にすぎない。
    優劣は評価APIの結果だけが決める。
    """
    if not hints:
        return ()
    by_id = {
        hint.unit_definition_id: hint
        for hint in hints
        if hint.unit_definition_id in constraints.unit_pool
    }
    if not by_id:
        return ()

    candidates: list[Candidate] = []
    attackers = sorted(
        by_id.values(),
        key=lambda hint: (hint.role not in _ATTACKER_ROLES, hint.unit_definition_id),
    )
    aptitude_seed = _seat_by_aptitude(attackers, constraints)
    if aptitude_seed is not None:
        candidates.append(aptitude_seed)

    grouped = _largest_attribute_group(by_id.values())
    attribute_seed = _seat_by_aptitude(grouped, constraints)
    if attribute_seed is not None:
        candidates.append(attribute_seed)

    seen: set[str] = set()
    unique: list[Candidate] = []
    for candidate in candidates:
        key = candidate.canonical_key()
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return tuple(unique)


def _largest_attribute_group(hints: Sequence[UnitHint]) -> list[UnitHint]:
    """同じ属性で固めた最大の組。属性を揃えると編成ボーナスが伸びる。"""
    groups: dict[str, list[UnitHint]] = {}
    for hint in hints:
        groups.setdefault(hint.attribute, []).append(hint)
    if not groups:
        return []
    # 同数の属性が並んだときは属性名の辞書順で選ぶ。プールの並び順に任せると、
    # YAMLの行を入れ替えただけで種が変わる。
    _, group = min(groups.items(), key=lambda item: (-len(item[1]), item[0]))
    return group


def _seat_by_aptitude(hints: Sequence[UnitHint], constraints: Constraints) -> Candidate | None:
    """適性に合う行へ順に着席させる。座れなかったユニットは編成に入れない。"""
    occupied = set(constraints.fixed_cells)
    placements = list(constraints.fixed_placements)
    for hint in hints:
        if len(placements) >= constraints.max_units:
            break
        if hint.unit_definition_id in constraints.fixed_unit_ids:
            continue
        cell = next(
            (cell for cell in ALL_CELLS if cell not in occupied and hint.fits(cell.row)),
            None,
        )
        if cell is None:
            continue
        occupied.add(cell)
        placements.append(Placement(unit_definition_id=hint.unit_definition_id, cell=cell))
    if not placements:
        return None
    return repair(
        Candidate(
            placements=tuple(sorted(placements, key=lambda p: cell_index(p.cell))),
            memory_definition_ids=tuple(constraints.memory_pool[: constraints.max_memories]),
        ),
        constraints,
    )


def _free_memory_slots(space: Neighborhood, candidate: Candidate) -> list[int]:
    """必須メモリー以外の枠。必須を消したり差し替えたりしても矯正で戻るため除く。"""
    required = set(space.constraints.required_memories)
    return [
        index
        for index, memory in enumerate(candidate.memory_definition_ids)
        if memory not in required
    ]


def _replace(candidate: Candidate, target: Placement, replacement: Placement) -> Candidate:
    placements = [
        replacement if placement == target else placement for placement in candidate.placements
    ]
    return Candidate(tuple(placements), candidate.memory_definition_ids)


def _opposite(row: str) -> str:
    return "REAR" if row == "FRONT" else "FRONT"
