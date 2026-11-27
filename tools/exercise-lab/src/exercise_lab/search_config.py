"""戦術演習の探索設定を読み、既存の探索基盤へ渡す入力を確定する。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, PositiveInt, StrictBool, ValidationError, model_validator

from mlgg_lab_common.inputs.catalog import Catalog
from mlgg_lab_common.inputs.resolution import load_player_data_input
from mlgg_lab_common.inputs.sources import load_formation_entry
from mlgg_lab_common.inputs.yaml_io import load_yaml_mapping
from mlgg_lab_common.models import ConfigError, FormationSpec, InputSource, Spec
from mlgg_lab_common.search.candidate import candidate_from_formation
from mlgg_lab_common.search.constraints import problem_problems
from mlgg_lab_common.search.problem import (
    AllyTraining,
    GearPolicy,
    MethodBinding,
    SearchExecution,
    SearchProblem,
    SearchProblemError,
    SearchSpace,
)
from mlgg_lab_common.search.training import training_from_player_data

from .inputs.exercise import EnemySpec, FormationConfig, resolve_exercise_config
from .search_space import EXERCISE_SEARCH, exercise_search_problem
from .statistics.daily_best import DEFAULT_BEST_OF

FormationId = Annotated[str, Field(min_length=1, pattern=r"^[^/\\]+$")]


class SearchInputs(Spec):
    formations_dir: str = Field(
        default="../../data/inputs/formations", alias="formationsDir", min_length=1
    )
    player_data: str | None = Field(default=None, alias="playerData", min_length=1)


class SearchMoves(Spec):
    replace_units: StrictBool = Field(default=False, alias="replaceUnits")
    move_units: StrictBool = Field(default=False, alias="moveUnits")
    replace_memories: StrictBool = Field(default=False, alias="replaceMemories")
    reorder_memories: StrictBool = Field(default=False, alias="reorderMemories")


class ConfiguredSpace(SearchSpace):
    # 入れ替えない場合は、省略したプールに起点の ID を使う。
    unit_pool: list[str] = Field(default_factory=list, alias="unitPool", min_length=1)


class SearchObjective(Spec):
    metric: Literal["MEAN_SCORE", "EXPECTED_DAILY_BEST"]
    best_of: PositiveInt = Field(default=DEFAULT_BEST_OF, alias="bestOf")


class SearchTrials(Spec):
    screening_runs: PositiveInt = Field(alias="screeningRuns")
    finalists: PositiveInt
    confirmation_runs: PositiveInt = Field(alias="confirmationRuns")
    confirmation_seed: str = Field(alias="confirmationSeed", min_length=1)


class SearchOutput(Spec):
    searches_dir: str = Field(alias="searchesDir", min_length=1)


class ExerciseSearchConfig(Spec):
    enemy: EnemySpec
    starts: list[FormationId] = Field(min_length=1)
    inputs: SearchInputs = Field(default_factory=SearchInputs)
    space: ConfiguredSpace = Field(default_factory=ConfiguredSpace)
    moves: SearchMoves = Field(default_factory=SearchMoves)
    gear: GearPolicy = Field(default_factory=GearPolicy)
    objective: SearchObjective
    execution: SearchExecution
    trials: SearchTrials
    output: SearchOutput

    @model_validator(mode="after")
    def check_settings(self) -> ExerciseSearchConfig:
        if self.moves.replace_units and not self.space.unit_pool:
            raise ValueError("moves.replaceUnits を有効にするには space.unitPool が要る")
        if self.moves.replace_memories and not self.space.memory_pool:
            raise ValueError("moves.replaceMemories を有効にするには space.memoryPool が要る")
        if self.trials.confirmation_seed == self.execution.battle_seed:
            raise ValueError("trials.confirmationSeed は execution.battleSeed と別の seed にする")
        return self


@dataclass(frozen=True)
class ExerciseSearchPlan:
    problem: SearchProblem
    searches_dir: Path


def load_exercise_search_config(path: Path) -> ExerciseSearchConfig:
    try:
        return ExerciseSearchConfig.model_validate(load_yaml_mapping(path))
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error


def plan_exercise_search(
    path: Path, *, method: MethodBinding, catalog: Catalog | None = None
) -> ExerciseSearchPlan:
    """起点・探索範囲・育成を解決する。探索DBの作成や試行の送信は行わない。"""
    path = path.resolve()
    config = load_exercise_search_config(path)
    base = path.parent
    library_dir = _path(base, config.inputs.formations_dir)
    formations: list[FormationSpec] = []
    sources: list[InputSource] = []
    for index, formation_id in enumerate(config.starts):
        start = load_formation_entry(
            {"library": formation_id}, f"{path}: starts[{index}]", formations_dir=library_dir
        )
        assert start.source is not None
        formations.append(start.formation)
        sources.append(start.source)

    space_values = config.space.model_dump(by_alias=True, exclude_unset=True)
    space_values.setdefault(
        "unitPool",
        list(dict.fromkeys(unit.unit_definition_id for ally in formations for unit in ally.units)),
    )
    space_values.setdefault(
        "memoryPool",
        list(dict.fromkeys(memory for ally in formations for memory in ally.memory_definition_ids)),
    )
    space = SearchSpace.model_validate(space_values)

    training = AllyTraining()
    warnings: list[str] = []
    if config.inputs.player_data is not None:
        loaded = load_player_data_input(_path(base, config.inputs.player_data))
        training, warnings = training_from_player_data(space.unit_pool, loaded.data)
        sources.append(loaded.source.model_copy(update={"applies_to": "ally"}))
    resolved = resolve_exercise_config(
        FormationConfig(ally=formations[0], enemy=config.enemy), origin=sources, catalog=catalog
    )
    resolved.provenance.warnings.extend(warnings)

    settings = config.model_dump(
        mode="json", by_alias=True, include={"starts", "moves", "objective", "trials"}
    )
    execution = config.execution
    if catalog is not None:
        api = execution.api
        if (
            api.expected_catalog_revision is not None
            and api.expected_catalog_revision != catalog.catalog_revision
        ):
            raise ConfigError("expectedCatalogRevision が取得した Catalog と一致しない")
        execution = execution.model_copy(
            update={
                "api": api.model_copy(
                    update={"expected_catalog_revision": catalog.catalog_revision}
                )
            }
        )
    problem = exercise_search_problem(
        resolved,
        space=space,
        training=training,
        gear=config.gear,
        starts=[candidate_from_formation(ally) for ally in formations],
        execution=execution,
        method=method.model_copy(update={"settings": method.settings | settings}),
    )
    problems = problem_problems(problem, EXERCISE_SEARCH)
    if catalog is not None and not problems:
        problems = EXERCISE_SEARCH.catalog_problems(problem, catalog)
    if problems:
        raise SearchProblemError(problems)
    return ExerciseSearchPlan(problem, _path(base, config.output.searches_dir))


def _path(base: Path, value: str) -> Path:
    return (base / Path(value).expanduser()).resolve()
