"""戦術演習の探索空間: 固定した演習対象（敵1体と配置）に対する味方編成の探索。

共通基盤（`mlgg_lab_common.search`）の形式別アダプターを実装する。ここが持つのは
演習に固有の部分だけである。

- 固定条件 `fixed` = `{enemy}`（敵ちょうど1体・メモリーなし・強化なし、R-TEX-01 #3）。
  規定ターン数は5で固定（R-TEX-01 #4）なので持たない。
- 候補（味方）+ 固定条件 → `ResolvedExerciseInput`（評価計画へそのまま渡せる）
- Catalog との事前検証: 味方の使用可能プールは `PLAYABLE`、敵は `EXERCISE_ENEMY`（R-TEX-11 #1）。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import ValidationError

from mlgg_lab_common.inputs.catalog import (
    EXERCISE_ENEMY,
    PLAYABLE,
    Catalog,
    memory_errors,
    unit_errors,
)
from mlgg_lab_common.models import ConfigError, FormationSpec, Spec, revalidated
from mlgg_lab_common.search.candidate import Candidate, candidate_from_formation
from mlgg_lab_common.search.problem import (
    AllyTraining,
    GearPolicy,
    MethodBinding,
    SearchExecution,
    SearchProblem,
    SearchSpace,
)

from .inputs.exercise import (
    EXERCISE_POOL_RULE,
    EnemySpec,
    FormationConfig,
    ResolvedExerciseInput,
)

FORMAT = "TACTICAL_EXERCISE"


class ExerciseFixedConditions(Spec):
    enemy: EnemySpec


def exercise_fixed_conditions(resolved: ResolvedExerciseInput) -> dict[str, Any]:
    """解決済みの演習入力から固定条件（演習対象）を写す。"""
    return ExerciseFixedConditions(enemy=resolved.match.enemy).model_dump(
        mode="json", by_alias=True, exclude_none=True
    )


def _fixed(fixed: Mapping[str, Any]) -> ExerciseFixedConditions:
    try:
        return ExerciseFixedConditions.model_validate(fixed)
    except ValidationError as error:
        raise ConfigError(f"戦術演習の固定条件として読めない: {error}") from error


class ExerciseSearchAdapter:
    format = FORMAT

    def fixed_problems(self, fixed: Mapping[str, Any]) -> list[str]:
        try:
            _fixed(fixed)
        except ConfigError as error:
            return [str(error)]
        return []

    def build_input(self, problem: SearchProblem, ally: FormationSpec) -> ResolvedExerciseInput:
        fixed = _fixed(problem.fixed)
        try:
            match = FormationConfig(ally=ally, enemy=fixed.enemy)
        except ValidationError as error:
            raise ConfigError(f"戦術演習の対戦入力として成立しない: {error}") from error
        return revalidated(ResolvedExerciseInput(match=match, provenance=problem.provenance))

    def catalog_problems(self, problem: SearchProblem, catalog: Catalog) -> list[str]:
        errors = [
            error
            for unit_id in problem.space.unit_pool
            for error in unit_errors(
                unit_id, "space.unitPool", PLAYABLE, catalog, rule=EXERCISE_POOL_RULE
            )
        ]
        errors.extend(memory_errors(problem.space.memory_pool, "space.memoryPool", catalog))
        errors.extend(
            unit_errors(
                _fixed(problem.fixed).enemy.unit_definition_id,
                "fixed.enemy",
                EXERCISE_ENEMY,
                catalog,
                rule=EXERCISE_POOL_RULE,
            )
        )
        return errors


EXERCISE_SEARCH = ExerciseSearchAdapter()


def exercise_search_problem(
    resolved: ResolvedExerciseInput,
    *,
    space: SearchSpace,
    training: AllyTraining,
    execution: SearchExecution,
    method: MethodBinding,
    gear: GearPolicy | None = None,
    starts: Sequence[Candidate] | None = None,
) -> SearchProblem:
    """解決済みの演習入力の演習対象を固定し、味方側を探索する問題を作る。

    `starts` を省くと、演習入力の味方編成（配置・ユニット順・メモリー順）を起点にする。
    起点の育成値は使わず、育成条件は `training` から引く。
    """
    return SearchProblem(
        format=FORMAT,
        fixed=exercise_fixed_conditions(resolved),
        training=training,
        space=space,
        gear=gear or GearPolicy(),
        starts=list(starts)
        if starts is not None
        else [candidate_from_formation(resolved.match.ally)],
        execution=execution,
        method=method,
        provenance=resolved.provenance,
    )
