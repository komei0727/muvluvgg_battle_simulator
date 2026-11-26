"""探索問題と候補の制約検証。

- `candidate_problems`: 形式に依らない制約（使用可能プール・人数・配置・重複・固定指定・
  ギアの許可範囲と資源制約）。
- `check_candidate`: 上に加え、育成条件を当てた編成を形式別アダプターで対戦入力へ組み立て、
  形式固有の受理条件（配置重複・強化指定の組み合わせ等）を通す。評価計画へ載せる前に呼ぶ。
- `problem_problems`: 探索問題そのものの整合性（範囲の矛盾・起点編成の合法性等）。

ここは事前検証であり、最終的な受理判定はAPIが行う。問題は最初の1件で止めずにすべて返す。
"""

from __future__ import annotations

from collections import Counter

from ..models.formation import ConfigError, Position
from .adapter import FormatSearchAdapter
from .candidate import Candidate, effective_gears, materialize
from .problem import SearchProblem


def _key(position: Position) -> tuple[int, str]:
    return (position.column, position.row)


def candidate_problems(problem: SearchProblem, candidate: Candidate) -> list[str]:
    space = problem.space
    problems: list[str] = []
    unit_ids = candidate.unit_ids()
    pool = set(space.unit_pool)

    problems.extend(
        f"units[{i}]: {uid} は使用可能プールに無い"
        for i, uid in enumerate(unit_ids)
        if uid not in pool
    )
    if not space.min_units <= len(unit_ids) <= space.max_units:
        problems.append(f"ユニット数 {len(unit_ids)} が {space.min_units}～{space.max_units} の外")
    if not space.allow_duplicate_units:
        problems.extend(
            f"ユニット {uid} が {n} 枠にある（重複を許していない）"
            for uid, n in Counter(unit_ids).items()
            if n > 1
        )

    positions = Counter(_key(unit.position) for unit in candidate.units)
    problems.extend(
        f"配置 column={c}, row={r} が重複している" for (c, r), n in positions.items() if n > 1
    )
    if space.allowed_positions is not None:
        allowed = {_key(p) for p in space.allowed_positions}
        problems.extend(
            f"units[{i}]: 配置 column={u.position.column}, row={u.position.row} は許可されていない"
            for i, u in enumerate(candidate.units)
            if _key(u.position) not in allowed
        )

    for fixed in space.fixed_units:
        placed = [u for u in candidate.units if u.unit_definition_id == fixed.unit_definition_id]
        if not placed:
            problems.append(f"固定ユニット {fixed.unit_definition_id} が無い")
        elif fixed.position is not None and all(
            _key(u.position) != _key(fixed.position) for u in placed
        ):
            problems.append(
                f"固定ユニット {fixed.unit_definition_id} が固定した配置"
                f"（column={fixed.position.column}, row={fixed.position.row}）に無い"
            )

    problems.extend(_memory_problems(problem, candidate))
    problems.extend(_gear_problems(problem, candidate))
    return problems


def _memory_problems(problem: SearchProblem, candidate: Candidate) -> list[str]:
    space = problem.space
    memories = list(candidate.memory_definition_ids)
    problems: list[str] = []
    pool = set(space.memory_pool)
    problems.extend(
        f"memoryDefinitionIds[{i}]: {mid} は使用可能プールに無い"
        for i, mid in enumerate(memories)
        if mid not in pool
    )
    if not space.min_memories <= len(memories) <= space.max_memories:
        problems.append(
            f"メモリー数 {len(memories)} が {space.min_memories}～{space.max_memories} の外"
        )
    if not space.allow_duplicate_memories:
        problems.extend(
            f"メモリー {mid} が {n} 件ある（重複を許していない）"
            for mid, n in Counter(memories).items()
            if n > 1
        )
    for fixed in space.fixed_memories:
        if fixed.memory_definition_id not in memories:
            problems.append(f"固定メモリー {fixed.memory_definition_id} が無い")
        elif fixed.index is not None and (
            fixed.index >= len(memories) or memories[fixed.index] != fixed.memory_definition_id
        ):
            problems.append(
                f"固定メモリー {fixed.memory_definition_id} が固定した位置 {fixed.index} に無い"
            )
    return problems


def _gear_problems(problem: SearchProblem, candidate: Candidate) -> list[str]:
    policy = problem.gear
    problems: list[str] = []
    if policy.mode == "FIXED":
        problems.extend(
            f"units[{i}]: ギア固定の探索でギアを変更している（{u.unit_definition_id}）"
            for i, u in enumerate(candidate.units)
            if u.gears is not None
        )

    adjustable = None if policy.adjustable_unit_ids is None else set(policy.adjustable_unit_ids)
    for i, unit in enumerate(candidate.units):
        if policy.mode == "FIXED" or unit.gears is None:
            continue
        where = f"units[{i}]（{unit.unit_definition_id}）"
        if adjustable is not None and unit.unit_definition_id not in adjustable:
            problems.append(f"{where}: ギアを調整してよいユニットではない")
        if len(unit.gears) > policy.max_gears_per_unit:
            problems.append(
                f"{where}: ギア {len(unit.gears)} 個が上限 {policy.max_gears_per_unit} を超える"
            )
        for j, gear in enumerate(unit.gears):
            for label, value, allowed in (
                ("能力", gear.stat, policy.allowed_stats),
                ("段階", gear.tier, policy.allowed_tiers),
                ("等級", gear.grade, policy.allowed_grades),
            ):
                if allowed is not None and value not in allowed:
                    problems.append(f"{where}.gears[{j}]: {label} {value} は許可されていない")

    # 資源上限はギア固定でも効く。ギアを変えなくても、ユニット選抜で編成全体の使用量は変わる。
    sent = [gear for unit in candidate.units for gear in effective_gears(problem, unit)]
    for limit in policy.resource_limits:
        used = sum(1 for gear in sent if limit.matches(gear))
        if used > limit.max_count:
            label = "・".join(
                str(v) for v in (limit.stat, limit.tier, limit.grade) if v is not None
            )
            problems.append(
                f"ギア資源の上限を超える（{label or '全ギア'}: {used} 個 > {limit.max_count} 個）"
            )
    return problems


def check_candidate(
    problem: SearchProblem, adapter: FormatSearchAdapter, candidate: Candidate
) -> list[str]:
    """評価へ送れる候補かを確かめる。共通の制約を満たしたときだけ対戦入力を組み立てる。"""
    problems = candidate_problems(problem, candidate)
    if problems:
        return problems
    try:
        adapter.build_input(problem, materialize(problem, candidate))
    except ConfigError as error:
        return [f"対戦入力として成立しない: {error}"]
    return []


def problem_problems(problem: SearchProblem, adapter: FormatSearchAdapter) -> list[str]:
    space, policy, training = problem.space, problem.gear, problem.training
    problems: list[str] = []
    if adapter.format != problem.format:
        problems.append(
            f"アダプターの形式 {adapter.format} は探索問題の形式 {problem.format} と違う"
        )
        return problems
    problems.extend(f"fixed: {p}" for p in adapter.fixed_problems(problem.fixed))

    if space.min_units > space.max_units:
        problems.append(f"minUnits {space.min_units} が maxUnits {space.max_units} より大きい")
    if space.min_memories > space.max_memories:
        problems.append(
            f"minMemories {space.min_memories} が maxMemories {space.max_memories} より大きい"
        )
    for label, values in (("unitPool", space.unit_pool), ("memoryPool", space.memory_pool)):
        problems.extend(f"{label}: {v} が重複している" for v, n in Counter(values).items() if n > 1)
    unit_pool, memory_pool = set(space.unit_pool), set(space.memory_pool)
    problems.extend(
        f"fixedUnits: {f.unit_definition_id} が使用可能プールに無い"
        for f in space.fixed_units
        if f.unit_definition_id not in unit_pool
    )
    problems.extend(
        f"fixedMemories: {f.memory_definition_id} が使用可能プールに無い"
        for f in space.fixed_memories
        if f.memory_definition_id not in memory_pool
    )
    if len(space.fixed_units) > space.max_units:
        problems.append("固定ユニットが maxUnits より多い")
    if len(space.fixed_memories) > space.max_memories:
        problems.append("固定メモリーが maxMemories より多い")
    if space.allowed_positions is not None:
        allowed = {_key(p) for p in space.allowed_positions}
        if len(allowed) < space.min_units:
            problems.append("許可した配置の数が minUnits より少ない")
        problems.extend(
            f"fixedUnits: {f.unit_definition_id} の固定配置が許可されていない"
            for f in space.fixed_units
            if f.position is not None and _key(f.position) not in allowed
        )

    if training.academy_levels is None:
        problems.extend(
            f"training.units.{uid}: academyLevels が無い育成条件へ level / rank / gears / module は"
            " 指定できない"
            for uid, unit in training.units.items()
            if unit.is_specified
        )
        if policy.mode == "ADJUSTABLE":
            problems.append(
                "ギア調整ありの探索には training.academyLevels が要る（強化計算を使う）"
            )
    if policy.adjustable_unit_ids is not None:
        problems.extend(
            f"gear.adjustableUnitIds: {uid} が使用可能プールに無い"
            for uid in policy.adjustable_unit_ids
            if uid not in unit_pool
        )

    if problems:
        # 範囲そのものが矛盾していると、起点編成の検証結果は読み違えやすいので出さない。
        return problems
    for index, start in enumerate(problem.starts):
        problems.extend(f"starts[{index}]: {p}" for p in check_candidate(problem, adapter, start))
    return problems
