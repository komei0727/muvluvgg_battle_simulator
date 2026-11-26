"""通常戦闘の探索空間: 固定した相手編成・規定ターン数に対する味方編成の探索。

共通基盤（`mlgg_lab_common.search`）の形式別アダプターを実装する。ここが持つのは
通常戦闘に固有の部分だけである。

- 固定条件 `fixed` = `{enemyFormation, turnLimit}`（相手編成は育成適用済み・探索中は不変）
- 候補（味方）+ 固定条件 → `ResolvedBattleInput`（評価計画へそのまま渡せる）
- 形式固有の受理条件は `ResolvedBattleInput.validate_match`（各陣営の配置重複・強化指定の
  組み合わせ）を通す。最終的な受理判定はAPIが行う。
- Catalog との事前検証: 味方の使用可能プール・相手編成とも `PLAYABLE`（R-TEX-11 #3）。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import Field, StrictInt, ValidationError

from mlgg_lab_common.inputs.catalog import (
    PLAYABLE,
    Catalog,
    formation_reference_errors,
    memory_errors,
    unit_errors,
)
from mlgg_lab_common.models import (
    ConfigError,
    FormationSpec,
    Spec,
    revalidated,
    validate_formation,
)
from mlgg_lab_common.search.candidate import Candidate, candidate_from_formation
from mlgg_lab_common.search.problem import (
    AllyTraining,
    GearPolicy,
    MethodBinding,
    SearchExecution,
    SearchProblem,
    SearchSpace,
)

from .inputs import (
    MAX_TURN_LIMIT,
    MIN_TURN_LIMIT,
    NORMAL_POOL_RULE,
    BattleMatch,
    ResolvedBattleInput,
)

FORMAT = "BATTLE"


class BattleFixedConditions(Spec):
    enemy_formation: FormationSpec = Field(alias="enemyFormation")
    turn_limit: StrictInt = Field(alias="turnLimit", ge=MIN_TURN_LIMIT, le=MAX_TURN_LIMIT)


def battle_fixed_conditions(resolved: ResolvedBattleInput) -> dict[str, Any]:
    """解決済みの対戦入力から固定条件（相手編成・規定ターン数）を写す。"""
    return BattleFixedConditions(
        enemyFormation=resolved.match.enemy_formation, turnLimit=resolved.match.turn_limit
    ).model_dump(mode="json", by_alias=True, exclude_none=True)


def _fixed(fixed: Mapping[str, Any]) -> BattleFixedConditions:
    try:
        return BattleFixedConditions.model_validate(fixed)
    except ValidationError as error:
        raise ConfigError(f"通常戦闘の固定条件として読めない: {error}") from error


class BattleSearchAdapter:
    format = FORMAT

    def fixed_problems(self, fixed: Mapping[str, Any]) -> list[str]:
        try:
            validate_formation(_fixed(fixed).enemy_formation, "enemyFormation")
        except ConfigError as error:
            return [str(error)]
        return []

    def build_input(self, problem: SearchProblem, ally: FormationSpec) -> ResolvedBattleInput:
        fixed = _fixed(problem.fixed)
        try:
            match = BattleMatch(
                allyFormation=ally,
                enemyFormation=fixed.enemy_formation,
                turnLimit=fixed.turn_limit,
            )
        except ValidationError as error:
            raise ConfigError(f"通常戦闘の対戦入力として成立しない: {error}") from error
        return revalidated(ResolvedBattleInput(match=match, provenance=problem.provenance))

    def catalog_problems(self, problem: SearchProblem, catalog: Catalog) -> list[str]:
        errors = [
            error
            for unit_id in problem.space.unit_pool
            for error in unit_errors(
                unit_id, "space.unitPool", PLAYABLE, catalog, rule=NORMAL_POOL_RULE
            )
        ]
        errors.extend(memory_errors(problem.space.memory_pool, "space.memoryPool", catalog))
        errors.extend(
            formation_reference_errors(
                _fixed(problem.fixed).enemy_formation,
                "fixed.enemyFormation",
                catalog,
                required_category=PLAYABLE,
                rule=NORMAL_POOL_RULE,
            )
        )
        return errors


BATTLE_SEARCH = BattleSearchAdapter()


def battle_search_problem(
    resolved: ResolvedBattleInput,
    *,
    space: SearchSpace,
    training: AllyTraining,
    execution: SearchExecution,
    method: MethodBinding,
    gear: GearPolicy | None = None,
    starts: Sequence[Candidate] | None = None,
) -> SearchProblem:
    """解決済みの対戦入力の相手側を固定し、味方側を探索する問題を作る。

    `starts` を省くと、対戦入力の味方編成（配置・ユニット順・メモリー順）を起点にする。
    起点の育成値は使わず、育成条件は `training` から引く（候補はユニットIDで育成条件を引く）。
    """
    return SearchProblem(
        format=FORMAT,
        fixed=battle_fixed_conditions(resolved),
        training=training,
        space=space,
        gear=gear or GearPolicy(),
        starts=list(starts)
        if starts is not None
        else [candidate_from_formation(resolved.match.ally_formation)],
        execution=execution,
        method=method,
        provenance=resolved.provenance,
    )
