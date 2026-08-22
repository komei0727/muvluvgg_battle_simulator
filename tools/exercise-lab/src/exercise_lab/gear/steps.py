"""到達手順。現状から理論値までを、途中で止めても損をしない単位へ切る。

理論値は到達不能な目標である。手に入るギアは1枚ずつなので、実用上の成果物は配分そのもの
ではなく**現状からそこへ向かう順序**になる。

並べ方は現状からの限界効用（1手だけ適用したときのΔ期待日次ベスト）である。ただし
**1手ずつの効果は加法ではない** ——順位で当て先が決まる効果は閾値を跨ぐまで何も起きず、
跨いだ瞬間にまとめて動く。したがって経路上には「単独では現状より下がる手」が現れる。

そこを**谷**として明示する。単独のΔが負の手、あるいは適用して止めると累積が現状を
下回る手は、累積が正へ転じるところまでの手と1グループにする。**片方だけ適用して止めると
現状より弱くなる**ため、グループを書かない手順表は危険である。

グループの切れ目は「そこで止めてよい点」であり、グループ内の順序には意味が無い——
同じ集合を適用した先の配分は順序に依らないので、グループの末端は入れ替えても変わらない。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..optimize.evaluator import EvaluationPhase
from ..optimize.fitness import Objective
from .allocation import MAX_PIECES_PER_UNIT, Allocation, GearPiece, UnitAllocation
from .neighborhood import Move
from .search import BudgetedSampleSource, ClimbSettings, phases_for_climb, unpaid_runs

NON_MONOTONE_WARNING = (
    "手順の最後まで進めた点が経路上の最良ではない。理論値は最終選抜の乱数範囲で選び、"
    "手順表は確定段の乱数範囲で測っているため、両者の順位は食い違うことがある"
    "（累積Δが最大の行で止める判断もありうる）"
)

NO_BUDGET_WARNING = (
    "予算の残りが足りず、到達手順を組めなかった（--budget を増やすか --confirm-runs を下げる）"
)


@dataclass(frozen=True)
class GearStep:
    """手順表の1行。`group` が同じ行はセットで適用する。"""

    index: int
    group: int
    slot_index: int
    unit_definition_id: str
    move: Move
    allocation: Allocation
    # 現状へこの1手だけを適用したときのΔ期待日次ベスト。測れなかったら `None`。
    solo_delta: float | None
    # 現状からこの行までを適用したときのΔ期待日次ベスト。
    cumulative_delta: float | None

    @property
    def removed(self) -> GearPiece | None:
        return self.move.removed

    @property
    def added(self) -> GearPiece | None:
        return self.move.added


@dataclass(frozen=True)
class StepPlan:
    start: Allocation
    target: Allocation
    phase: EvaluationPhase
    steps: tuple[GearStep, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.steps

    def group_ends(self) -> tuple[str, ...]:
        """各グループの末端の配分（正準キー）。**そこで止めてよい点**である。

        グループ内の順序を入れ替えても、適用した集合が同じなら末端は変わらない。
        """
        if not self.steps:
            return ()
        ends: list[str] = []
        for step, following in zip(self.steps, [*self.steps[1:], None], strict=True):
            if following is None or following.group != step.group:
                ends.append(step.allocation.canonical_key())
        return tuple(ends)


def max_step_count(unit_count: int) -> int:
    """実行前に見積もれる手数の上限。全枠が9枚とも入れ替わった場合である。

    1手は「1枚外して1枚挿す」なので、1ユニットの手数は外す枚数と挿す枚数の多い方
    （最大9）に収まる。
    """
    return unit_count * MAX_PIECES_PER_UNIT


def step_plan_cost(climb: ClimbSettings, *, step_count: int) -> int:
    """手順表を組むのに払いうる最大試行数。

    現状1件と、単独のΔを測る手ごとの1件、累積を測る行ごとの1件。累積の1行目は単独と
    同じ配分になるので実際はこれより小さいが、**多めに見積もる**ぶんには予算を食い破らない。
    """
    if step_count < 1:
        return 0
    return (1 + 2 * step_count) * climb.confirm_runs


def diff_moves(start: Allocation, target: Allocation) -> tuple[Move, ...]:
    """現状から理論値までの差分を、1手ずつへ切り出す。

    外す駒と挿す駒を組にして「1枚入れ替える」1手にする。組にしないと、挿す手だけが先に
    並んだ途中経過が同一ステータス4枚・合計10枚といった実在しない構成になる。

    組にする相手は**同じステータスを先に**選ぶ。ランクだけの違い（Ⅲ-S → Ⅲ-C）を別の
    ステータスの手と組ませると、手順表に「攻撃力を外して会心率を挿し、別の行で会心率を
    外して攻撃力を挿す」という往復が出る。
    """
    return tuple(
        move
        for slot_index, (before, after) in enumerate(zip(start.units, target.units, strict=True))
        for move in _unit_moves(slot_index, before, after)
    )


def _unit_moves(slot_index: int, before: UnitAllocation, after: UnitAllocation) -> list[Move]:
    removed = _surplus(before, after)
    added = _surplus(after, before)
    paired = _pair_same_stat(removed, added)
    while removed and added:
        paired.append((removed.pop(0), added.pop(0)))
    moves = [
        _move(slot_index, before.unit_definition_id, out_piece, in_piece)
        for out_piece, in_piece in paired
    ]
    moves.extend(
        _move(slot_index, before.unit_definition_id, out_piece, None) for out_piece in removed
    )
    moves.extend(_move(slot_index, before.unit_definition_id, None, in_piece) for in_piece in added)
    return moves


def _surplus(left: UnitAllocation, right: UnitAllocation) -> list[GearPiece]:
    """`left` にあって `right` に無い駒。枚数の差ぶんだけ並べる。"""
    remaining = list(right.pieces)
    surplus: list[GearPiece] = []
    for piece in left.pieces:
        if piece in remaining:
            remaining.remove(piece)
            continue
        surplus.append(piece)
    return surplus


def _pair_same_stat(
    removed: list[GearPiece], added: list[GearPiece]
) -> list[tuple[GearPiece | None, GearPiece | None]]:
    """同じステータスどうしを先に組にする。残りは呼び出し側が順に組む。"""
    paired: list[tuple[GearPiece | None, GearPiece | None]] = []
    for out_piece in list(removed):
        in_piece = next((entry for entry in added if entry.stat == out_piece.stat), None)
        if in_piece is None:
            continue
        removed.remove(out_piece)
        added.remove(in_piece)
        paired.append((out_piece, in_piece))
    return paired


def _move(
    slot_index: int,
    unit_definition_id: str,
    removed: GearPiece | None,
    added: GearPiece | None,
) -> Move:
    if removed is None:
        kind = "add"
    elif added is None:
        kind = "remove"
    elif added.stat == removed.stat:
        kind = "rank"
    else:
        kind = "move"
    return Move(
        kind=kind,
        slot_index=slot_index,
        unit_definition_id=unit_definition_id,
        removed=removed,
        added=added,
    )


def apply_all(start: Allocation, moves: Sequence[Move]) -> Allocation | None:
    """手を順に重ねた配分。1つでも適用できなければ `None`。"""
    allocation = start
    for move in moves:
        applied = move.apply(allocation)
        if applied is None:
            return None
        allocation = applied
    return allocation


def group_numbers(
    solo: Sequence[float | None], cumulative: Sequence[float | None]
) -> tuple[int, ...]:
    """行ごとのグループ番号。**そこで止めてよい行**でグループを閉じる。

    閉じる条件は2つとも要る——その手が単独で損をしないこと（`solo >= 0`）と、そこまでの
    累積が現状を上回ること（`cumulative > 0`）である。片方でも欠ければ、その行で止めた
    利用者は現状より弱い編成を持つことになる。測れなかった行（`None`）は「止めてよい」と
    言えないので閉じない。

    最後の行は必ず閉じる。理論値まで進めば止まるほかない。
    """
    numbers: list[int] = []
    group = 1
    for solo_delta, cumulative_delta in zip(solo, cumulative, strict=True):
        numbers.append(group)
        if (
            solo_delta is not None
            and cumulative_delta is not None
            and solo_delta >= 0.0
            and cumulative_delta > 0.0
        ):
            group += 1
    return tuple(numbers)


def build_step_plan(
    start: Allocation,
    target: Allocation,
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    objective: Objective,
    budget_runs: int,
) -> StepPlan:
    """現状から理論値までの手順表を組む。差分が無ければ空で返す。

    測るのは確定段の位相である。理論値そのものは探索の確定段で測り終えているので、
    末端の1件はキャッシュから読める。
    """
    _, phase = phases_for_climb(climb)
    moves = diff_moves(start, target)
    if not moves:
        return StepPlan(start=start, target=target, phase=phase)

    solo = [(move, applied) for move in moves if (applied := move.apply(start)) is not None]
    if not solo or not _affordable(
        start, [allocation for _, allocation in solo], evaluator, climb=climb, budget=budget_runs
    ):
        return StepPlan(start=start, target=target, phase=phase, warnings=(NO_BUDGET_WARNING,))

    deltas = _expected_best_deltas(
        start,
        [allocation for _, allocation in solo],
        evaluator,
        climb=climb,
        objective=objective,
        phase=phase,
    )
    ordered = sorted(
        solo,
        key=lambda entry: (
            -_sortable(deltas.get(entry[1].canonical_key())),
            entry[0].canonical_key(),
        ),
    )

    warnings: list[str] = []
    prefixes = _prefixes(start, [move for move, _ in ordered])
    kept = _within_budget(
        start, prefixes, evaluator, climb=climb, budget=budget_runs, warnings=warnings
    )
    cumulative = _expected_best_deltas(
        start, kept, evaluator, climb=climb, objective=objective, phase=phase
    )

    solo_deltas = [deltas.get(allocation.canonical_key()) for _, allocation in ordered]
    cumulative_deltas = [cumulative.get(allocation.canonical_key()) for allocation in prefixes]
    groups = group_numbers(solo_deltas, cumulative_deltas)
    steps = tuple(
        GearStep(
            index=index + 1,
            group=groups[index],
            slot_index=move.slot_index,
            unit_definition_id=move.unit_definition_id,
            move=move,
            allocation=prefixes[index],
            solo_delta=solo_deltas[index],
            cumulative_delta=cumulative_deltas[index],
        )
        for index, (move, _) in enumerate(ordered)
    )
    measured_cumulative = [
        step.cumulative_delta for step in steps if step.cumulative_delta is not None
    ]
    if measured_cumulative and steps[-1].cumulative_delta != max(measured_cumulative):
        warnings.append(NON_MONOTONE_WARNING)
    return StepPlan(
        start=start,
        target=target,
        phase=phase,
        steps=steps,
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _sortable(delta: float | None) -> float:
    """測れなかった手は最後尾へ。順位を推測で埋めない。"""
    return float("-inf") if delta is None else delta


def _prefixes(start: Allocation, moves: Sequence[Move]) -> list[Allocation]:
    allocations: list[Allocation] = []
    current = start
    for move in moves:
        applied = move.apply(current)
        # 差分から切り出した手はどの順で重ねても制約を満たす（枚数は現状と理論値の
        # あいだに収まる）。それでも `None` を潰さないのは、上流の変更で崩れたときに
        # 手順表が黙って途中で切れるのを避けるためである。
        assert applied is not None, move.canonical_key()
        current = applied
        allocations.append(current)
    return allocations


def _affordable(
    start: Allocation,
    allocations: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    budget: int,
) -> bool:
    return evaluator.consumed_runs + _cost(start, allocations, evaluator, climb=climb) <= budget


def _within_budget(
    start: Allocation,
    allocations: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    budget: int,
    warnings: list[str],
) -> list[Allocation]:
    """予算に収まる行まで削る。**黙って切らない**——落とした件数を警告に残す。"""
    kept = list(allocations)
    while kept and not _affordable(start, kept, evaluator, climb=climb, budget=budget):
        kept.pop()
    dropped = len(allocations) - len(kept)
    if dropped:
        warnings.append(
            f"予算の残りが足りず、到達手順の累積 {dropped} 行を測れなかった"
            "（その行はグループを閉じない）"
        )
    return kept


def _cost(
    start: Allocation,
    allocations: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
) -> int:
    _, phase = phases_for_climb(climb)
    keys = {start.canonical_key(): start}
    for allocation in allocations:
        keys.setdefault(allocation.canonical_key(), allocation)
    return sum(
        unpaid_runs(evaluator, allocation, phase, climb.confirm_runs)
        for allocation in keys.values()
    )


def _expected_best_deltas(
    start: Allocation,
    allocations: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    climb: ClimbSettings,
    objective: Objective,
    phase: EvaluationPhase,
) -> dict[str, float]:
    """現状に対するΔ期待日次ベスト。試行数は現状と揃えて比べる。"""
    if not allocations:
        return {}
    records = evaluator.ensure([start, *allocations], climb.confirm_runs, phase=phase)
    by_key = {record.candidate.canonical_key(): record for record in records}
    base = by_key[start.canonical_key()]
    deltas: dict[str, float] = {}
    for allocation in allocations:
        record = by_key[allocation.canonical_key()]
        count = min(climb.confirm_runs, base.sample_count, record.sample_count)
        if count < 1:
            continue
        deltas[allocation.canonical_key()] = objective.expected_best(
            record.scores_at(count)
        ) - objective.expected_best(base.scores_at(count))
    return deltas
