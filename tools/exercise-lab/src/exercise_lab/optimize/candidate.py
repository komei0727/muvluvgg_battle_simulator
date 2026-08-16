"""探索の遺伝子型と、制約を満たす形への矯正。

遺伝子型は「6マスへのユニット割当」と「メモリーの部分集合」の2つを持つ。

**どちらも並べる順は結果を変えない。** ユニットは同速時の行動順が
「味方・敵・前列・絶対左列」で決まり、対象順も距離と配置で決まるため、配置が同じなら
列挙順が違っても同じ編成である。メモリーは並びが発動解決順（`R-MEM-02`）を決めるものの、
現行のメモリー効果はどの順で解決してもスコアが動かない。正準キーはこの2つに依っており、
並べ替えただけの候補へ二重に予算を払わずに済む。

メモリーの並びがスコアへ効くようになったら、順序を探索変数へ戻す必要がある——
`canonical_key` の畳み込みと、並びを正規化している `repair` の両方が前提を持つ。

このモジュールはAPIにもカタログにも依存しない。純粋な組合せだけを扱い、
編成リクエストへの変換は `config.py` が持つ。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

Row = Literal["FRONT", "REAR"]

# `R-TEX-01` #2: 味方は1〜5体、メモリーは最大6件。
MAX_UNITS = 5
MAX_MEMORIES = 6
COLUMNS = (0, 1, 2)
ROWS: tuple[Row, ...] = ("FRONT", "REAR")


@dataclass(frozen=True, order=True)
class Cell:
    """6マスの1つ。`column` は俯瞰時の絶対左から 0・1・2、`row` は敵へ近い側が FRONT。

    比較順（`order=True`）は row → column になるが、正準化では `ALL_CELLS` の並び
    （前列優先）を使う。両者を混ぜないよう、並べ替えの基準は常に `ALL_CELLS` の索引にする。
    """

    column: int
    row: Row

    def __post_init__(self) -> None:
        if self.column not in COLUMNS:
            raise ValueError(f"column は 0・1・2 のいずれか（{self.column}）")
        if self.row not in ROWS:
            raise ValueError(f"row は FRONT・REAR のいずれか（{self.row}）")


# 前列を先に並べる。空きマスを埋める順・正準キーの並びの両方がこの索引に従う。
ALL_CELLS: tuple[Cell, ...] = tuple(
    Cell(column=column, row=row) for row in ROWS for column in COLUMNS
)
_CELL_ORDER = {cell: index for index, cell in enumerate(ALL_CELLS)}


@dataclass(frozen=True)
class Placement:
    unit_definition_id: str
    cell: Cell


@dataclass(frozen=True)
class Candidate:
    placements: tuple[Placement, ...]
    memory_definition_ids: tuple[str, ...]

    @property
    def unit_definition_ids(self) -> tuple[str, ...]:
        return tuple(placement.unit_definition_id for placement in self.placements)

    def canonical_key(self) -> str:
        """等価な編成を同一視する鍵。評価キャッシュと最終プールの重複排除で使う。

        配置はマス順、メモリーはID順へ揃える。どちらの並びもスコアを変えないので、
        並べ替えただけの候補を別物として数えると同じ編成に何度も予算を使うことになる。
        """
        squad = "|".join(
            f"{placement.cell.row}{placement.cell.column}={placement.unit_definition_id}"
            for placement in sorted(self.placements, key=_cell_index)
        )
        return f"{squad}#{'>'.join(sorted(self.memory_definition_ids))}"


@dataclass(frozen=True)
class Constraints:
    """探索設定が与える制約。すべての候補生成はこれを通した結果だけを返す。"""

    unit_pool: tuple[str, ...]
    memory_pool: tuple[str, ...]
    # エンジン仕様上は同一ユニットを複数入れられるため、既定で禁じつつ明示で開ける。
    allow_duplicate_units: bool = False
    # マスまで固定するもの。`required_units` と違い、配置も探索対象から外れる。
    fixed_placements: tuple[Placement, ...] = ()
    # 必ず編成へ入れるが、配置は探索させるもの。
    required_units: tuple[str, ...] = ()
    # 必ず編成へ入れるメモリー。
    required_memories: tuple[str, ...] = ()
    max_units: int = MAX_UNITS
    max_memories: int = MAX_MEMORIES

    def __post_init__(self) -> None:
        """満たしようのない制約をここで落とす。

        矯正（`repair`）は「制約を必ず満たす候補を返す」ことを約束するので、そもそも
        解が存在しない設定を受け取ると約束を破るしかない。設定の誤りは探索を1回も
        走らせる前に分かるべきものなので、候補ではなく制約の側で失敗させる。
        """
        pinned = self.fixed_unit_ids | set(self.required_units)
        if len(pinned) > self.max_units:
            raise ValueError(
                f"固定・必須ユニットが{len(pinned)}体あり、上限{self.max_units}体に収まらない"
            )
        if len(self.fixed_cells) != len(self.fixed_placements):
            raise ValueError("固定スロットが同じマスを2度指している")
        if len(self.fixed_unit_ids) != len(self.fixed_placements):
            raise ValueError("同じユニットへ2つの固定スロットが指定されている")
        if len(set(self.required_memories)) > self.max_memories:
            raise ValueError(
                f"必須メモリーが{len(set(self.required_memories))}件あり、"
                f"上限{self.max_memories}件に収まらない"
            )
        _reject_outside_pool(pinned, self.unit_pool, "固定・必須ユニット")
        _reject_outside_pool(set(self.required_memories), self.memory_pool, "必須メモリー")

    @property
    def fixed_cells(self) -> frozenset[Cell]:
        return frozenset(placement.cell for placement in self.fixed_placements)

    @property
    def fixed_unit_ids(self) -> frozenset[str]:
        return frozenset(placement.unit_definition_id for placement in self.fixed_placements)


def encode_candidate(candidate: Candidate) -> dict[str, Any]:
    """状態ファイル（JSON）へ書ける形にする。APIのキー名へ寄せ、目で追えるようにする。"""
    return {
        "placements": [
            {
                "unitDefinitionId": placement.unit_definition_id,
                "column": placement.cell.column,
                "row": placement.cell.row,
            }
            for placement in candidate.placements
        ],
        "memoryDefinitionIds": list(candidate.memory_definition_ids),
    }


def decode_candidate(payload: dict[str, Any]) -> Candidate:
    return Candidate(
        placements=tuple(
            Placement(
                unit_definition_id=entry["unitDefinitionId"],
                cell=Cell(column=entry["column"], row=entry["row"]),
            )
            for entry in payload["placements"]
        ),
        memory_definition_ids=tuple(payload["memoryDefinitionIds"]),
    )


def repair(candidate: Candidate, constraints: Constraints) -> Candidate:
    """制約を満たす最も近い候補へ矯正する。決定的で、冪等。

    変異・交叉は制約を気にせず候補を壊してよく、正しさはここが一手に引き受ける。
    乱数を使わないのは、同じ入力からは常に同じ候補が出るようにするためである
    （状態保存からの再開で探索軌跡が変わらない条件の1つ）。
    """
    placements = _repair_placements(candidate.placements, constraints)
    memories = _repair_memories(candidate.memory_definition_ids, constraints)
    return Candidate(placements=placements, memory_definition_ids=memories)


def _repair_placements(
    placements: Sequence[Placement], constraints: Constraints
) -> tuple[Placement, ...]:
    kept = _select_units(placements, constraints)
    return _assign_cells(kept, constraints)


def _select_units(placements: Sequence[Placement], constraints: Constraints) -> list[Placement]:
    """プール外・重複を落とし、必須ユニットを入れ、5体へ収める。"""
    pool = set(constraints.unit_pool)
    seen: set[str] = set()
    kept: list[Placement] = []
    for placement in placements:
        unit = placement.unit_definition_id
        if unit not in pool:
            continue
        if not constraints.allow_duplicate_units and unit in seen:
            continue
        seen.add(unit)
        kept.append(placement)

    required = [*constraints.fixed_placements]
    required.extend(
        Placement(unit_definition_id=unit, cell=ALL_CELLS[0])
        for unit in constraints.required_units
        if unit not in constraints.fixed_unit_ids
    )
    # 固定・必須は必ず残す枠なので、先に確保してから残りを埋める。逆にすると
    # 5体を超えた時点で必須が押し出される。
    pinned_ids = {placement.unit_definition_id for placement in required}
    free = [placement for placement in kept if placement.unit_definition_id not in pinned_ids]
    room = max(0, constraints.max_units - len(required))
    kept = [*required, *free[:room]]

    if not kept:
        raise ValueError(
            "候補プール内のユニットが1体も無く、味方1体以上（R-TEX-01 #2）を満たせない"
        )
    return kept


def _assign_cells(
    placements: Sequence[Placement], constraints: Constraints
) -> tuple[Placement, ...]:
    """マスの重複を解く。固定マスは動かさず、衝突した側を空きマスへ送る。"""
    fixed_units = constraints.fixed_unit_ids
    fixed_by_unit = {
        placement.unit_definition_id: placement.cell for placement in constraints.fixed_placements
    }
    taken = set(constraints.fixed_cells)
    assigned: list[Placement] = []
    unresolved: list[Placement] = []

    for placement in placements:
        unit = placement.unit_definition_id
        if unit in fixed_units:
            assigned.append(Placement(unit_definition_id=unit, cell=fixed_by_unit[unit]))
            continue
        if placement.cell in taken:
            unresolved.append(placement)
            continue
        taken.add(placement.cell)
        assigned.append(placement)

    free = [cell for cell in ALL_CELLS if cell not in taken]
    for placement, cell in zip(unresolved, free, strict=False):
        assigned.append(Placement(unit_definition_id=placement.unit_definition_id, cell=cell))

    # 入力の並びに関わらず同じ編成が同じ並びで出るよう、マス順へ揃える。
    # 送信順は結果に影響しないため、ここで並べ替えても評価は変わらない。
    return tuple(sorted(assigned, key=_cell_index))


def _repair_memories(memories: Sequence[str], constraints: Constraints) -> tuple[str, ...]:
    pool = set(constraints.memory_pool)
    deduped: list[str] = []
    for memory in memories:
        if memory in pool and memory not in deduped:
            deduped.append(memory)

    required = set(constraints.required_memories)
    missing = [memory for memory in constraints.required_memories if memory not in deduped]
    # 枠から溢れさせてよいのは必須でないものだけ。件数で切り詰めると、必須が
    # 7件目に居るときに落ちる（入っているのに要件を満たさない候補が出る）。
    optional = [memory for memory in deduped if memory not in required]
    room = max(0, constraints.max_memories - len(required))
    kept = required.union(optional[:room])
    # 並びはID順へ揃える。順序はスコアを変えないので、同じ編成から常に同じ送信JSONが
    # 出るようにしておく（実行ごとに並びが揺れると評価ログと突き合わせにくい）。
    return tuple(sorted([*(memory for memory in deduped if memory in kept), *missing]))


def constraint_violations(candidate: Candidate, constraints: Constraints) -> list[str]:
    """破っている制約をすべて挙げる。`repair` の後は空になる。"""
    violations: list[str] = []
    violations.extend(_unit_violations(candidate, constraints))
    violations.extend(_cell_violations(candidate, constraints))
    violations.extend(_memory_violations(candidate, constraints))
    return violations


def _unit_violations(candidate: Candidate, constraints: Constraints) -> Iterable[str]:
    units = candidate.unit_definition_ids
    if not units:
        yield "味方が0体（R-TEX-01 #2 は1体以上）"
    if len(units) > constraints.max_units:
        yield f"味方が{len(units)}体で上限{constraints.max_units}体を超える"
    unknown = sorted(set(units) - set(constraints.unit_pool))
    if unknown:
        yield f"候補プール外のユニット: {', '.join(unknown)}"
    if not constraints.allow_duplicate_units and len(set(units)) != len(units):
        yield "同じユニットが複数入っている"
    missing = sorted(set(constraints.required_units) - set(units))
    if missing:
        yield f"必須ユニットが入っていない: {', '.join(missing)}"


def _cell_violations(candidate: Candidate, constraints: Constraints) -> Iterable[str]:
    cells = [placement.cell for placement in candidate.placements]
    if len(set(cells)) != len(cells):
        yield "同じマスに複数のユニットが乗っている"
    for fixed in constraints.fixed_placements:
        if fixed not in candidate.placements:
            yield (
                f"固定スロットが守られていない: {fixed.unit_definition_id} は "
                f"column={fixed.cell.column}, row={fixed.cell.row}"
            )


def _memory_violations(candidate: Candidate, constraints: Constraints) -> Iterable[str]:
    memories = candidate.memory_definition_ids
    if len(memories) > constraints.max_memories:
        yield f"メモリーが{len(memories)}件で上限{constraints.max_memories}件を超える"
    unknown = sorted(set(memories) - set(constraints.memory_pool))
    if unknown:
        yield f"候補プール外のメモリー: {', '.join(unknown)}"
    if len(set(memories)) != len(memories):
        yield "同じメモリーが複数入っている"
    missing = sorted(set(constraints.required_memories) - set(memories))
    if missing:
        yield f"必須メモリーが入っていない: {', '.join(missing)}"


def cell_index(cell: Cell) -> int:
    """`ALL_CELLS` 上の位置。並べ替えの基準をこれ1つに揃える。"""
    return _CELL_ORDER[cell]


def _cell_index(placement: Placement) -> int:
    return cell_index(placement.cell)


def _reject_outside_pool(values: set[str], pool: Sequence[str], label: str) -> None:
    unknown = sorted(values - set(pool))
    if unknown:
        raise ValueError(f"{label}が候補プールに無い: {', '.join(unknown)}")
