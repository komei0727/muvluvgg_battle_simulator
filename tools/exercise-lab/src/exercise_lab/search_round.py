"""チャットが指定した変更と試行を、既存の探索基盤へ接続する。"""

from __future__ import annotations

from collections.abc import Iterator
from itertools import combinations, permutations, product
from typing import Annotated, Literal, get_args

from pydantic import Field, StrictInt, model_validator

from mlgg_lab_common.api.contracts import MAX_RUN_INDEX
from mlgg_lab_common.experiments.search_store import SqliteSearchStore
from mlgg_lab_common.models import ConfigError, Gear, Position, Spec
from mlgg_lab_common.models.formation import GearGrade, GearStat, GearTier
from mlgg_lab_common.search import operations as ops
from mlgg_lab_common.search.candidate import Candidate, Origin, dump_candidate, effective_gears
from mlgg_lab_common.search.constraints import check_candidate
from mlgg_lab_common.search.method import Allocation, Proposal, SearchMethod, TrialRequest
from mlgg_lab_common.search.problem import ComponentDescriptor, SearchProblem
from mlgg_lab_common.search.view import CandidateEntry, SearchView

from .search_config import SearchMoves, SearchObjective, SearchTrials
from .search_space import EXERCISE_SEARCH
from .statistics.daily_best import expected_best

Phase = Literal["screening", "confirmation"]
CandidateKind = Literal["memory", "placement", "gear", "unit"]
Index = Annotated[StrictInt, Field(ge=0)]


class ReplaceMemory(Spec):
    kind: Literal["replaceMemory"] = "replaceMemory"
    index: Index
    memory_id: str = Field(alias="memoryId", min_length=1)


class SwapMemories(Spec):
    kind: Literal["swapMemories"] = "swapMemories"
    first: Index
    second: Index


class MoveMemory(Spec):
    kind: Literal["moveMemory"] = "moveMemory"
    index: Index
    destination: Index


class ReplaceUnit(Spec):
    kind: Literal["replaceUnit"] = "replaceUnit"
    index: Index
    unit_id: str = Field(alias="unitId", min_length=1)


class MoveUnit(Spec):
    kind: Literal["moveUnit"] = "moveUnit"
    index: Index
    position: Position


class SwapPositions(Spec):
    kind: Literal["swapPositions"] = "swapPositions"
    first: Index
    second: Index


class SetPositions(Spec):
    kind: Literal["setPositions"] = "setPositions"
    positions: tuple[Position, ...]


class SetGears(Spec):
    kind: Literal["setGears"] = "setGears"
    index: Index
    gears: tuple[Gear, ...] | None


class ReplaceGear(Spec):
    kind: Literal["replaceGear"] = "replaceGear"
    index: Index
    gear_index: Index = Field(alias="gearIndex")
    gear: Gear | None


Operation = Annotated[
    ReplaceMemory
    | SwapMemories
    | MoveMemory
    | ReplaceUnit
    | MoveUnit
    | SwapPositions
    | SetPositions
    | SetGears
    | ReplaceGear,
    Field(discriminator="kind"),
]


class ProposedChange(Spec):
    parent_id: str = Field(alias="parentId", min_length=1)
    operations: list[Operation] = Field(min_length=1)


class RoundInput(Spec):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    phase: Phase = "screening"
    candidate_ids: list[str] = Field(default_factory=list, alias="candidateIds")
    proposals: list[ProposedChange] = Field(default_factory=list)
    runs: Annotated[StrictInt, Field(gt=0)] | None = None
    run_indices: list[Annotated[StrictInt, Field(ge=0, le=MAX_RUN_INDEX)]] | None = Field(
        default=None, alias="runIndices", min_length=1
    )

    @model_validator(mode="after")
    def validate_round(self) -> RoundInput:
        if not self.candidate_ids and not self.proposals:
            raise ValueError("candidateIds または proposals が要る")
        if self.runs is not None and self.run_indices is not None:
            raise ValueError("runs と runIndices は同時に指定できない")
        if self.run_indices is not None and len(set(self.run_indices)) != len(self.run_indices):
            raise ValueError("runIndices が重複している")
        return self


def phase_seed(problem: SearchProblem, phase: Phase) -> str:
    if phase == "screening":
        return problem.execution.battle_seed
    trials = problem.method.settings.get("trials")
    if trials is None:
        raise ConfigError("この探索には確認試行の seed が設定されていない")
    return SearchTrials.model_validate(trials).confirmation_seed


def saved_candidates(store: SqliteSearchStore) -> dict[str, Candidate]:
    return {p.candidate_id: p.candidate for p in store.proposals() if p.accepted}


def apply_operations(
    problem: SearchProblem, parent: Candidate, operations: list[Operation]
) -> Candidate:
    moves = SearchMoves.model_validate(problem.method.settings["moves"])
    candidate = parent
    for change in operations:
        match change:
            case ReplaceMemory(index=index, memory_id=memory):
                _allow(moves.replace_memories, change.kind)
                candidate = ops.replace_memory(candidate, index, memory)
            case SwapMemories(first=first, second=second):
                _allow(moves.reorder_memories, change.kind)
                candidate = ops.swap_memories(candidate, first, second)
            case MoveMemory(index=index, destination=destination):
                _allow(moves.reorder_memories, change.kind)
                candidate = ops.move_memory(candidate, index, destination)
            case ReplaceUnit(index=index, unit_id=unit):
                _allow(moves.replace_units, change.kind)
                candidate = ops.replace_unit(candidate, index, unit)
            case MoveUnit(index=index, position=position):
                _allow(moves.move_units, change.kind)
                candidate = ops.move_unit(candidate, index, position)
            case SwapPositions(first=first, second=second):
                _allow(moves.move_units, change.kind)
                candidate = ops.swap_positions(candidate, first, second)
            case SetPositions(positions=positions):
                _allow(moves.move_units, change.kind)
                if len(positions) != len(candidate.units):
                    raise ConfigError("positions は候補のユニット数と同数で指定する")
                units = tuple(
                    unit.model_copy(update={"position": position})
                    for unit, position in zip(candidate.units, positions, strict=True)
                )
                candidate = candidate.model_copy(update={"units": units})
            case SetGears(index=index, gears=gears):
                _allow(problem.gear.mode == "ADJUSTABLE", change.kind)
                candidate = ops.set_gears(candidate, index, gears)
            case ReplaceGear(index=index, gear_index=slot, gear=gear):
                _allow(problem.gear.mode == "ADJUSTABLE", change.kind)
                if index >= len(candidate.units):
                    raise ConfigError(f"ユニット枠 {index} が範囲外")
                items = effective_gears(problem, candidate.units[index])
                if slot > len(items) or (slot == len(items) and gear is None):
                    raise ConfigError(f"ギア枠 {slot} が範囲外")
                items[slot : slot + 1] = [] if gear is None else [gear]
                candidate = ops.set_gears(candidate, index, items)
    return candidate


def _allow(enabled: bool, kind: str) -> None:
    if not enabled:
        raise ConfigError(f"{kind} は初期設定で無効")


def _operations(
    problem: SearchProblem, parent: Candidate, kind: CandidateKind
) -> Iterator[Operation]:
    moves = SearchMoves.model_validate(problem.method.settings["moves"])
    memory_ids = parent.memory_definition_ids
    unit_ids = parent.unit_ids()
    if kind == "memory":
        if moves.replace_memories:
            for i, memory in product(range(len(memory_ids)), problem.space.memory_pool):
                if memory_ids[i] != memory:
                    yield ReplaceMemory(index=i, memoryId=memory)
        if moves.reorder_memories:
            for a, b in combinations(range(len(memory_ids)), 2):
                yield SwapMemories(first=a, second=b)
            for a, b in permutations(range(len(memory_ids)), 2):
                yield MoveMemory(index=a, destination=b)
    elif kind == "unit" and moves.replace_units:
        for i, unit in product(range(len(unit_ids)), problem.space.unit_pool):
            if unit_ids[i] != unit:
                yield ReplaceUnit(index=i, unitId=unit)
    elif kind == "placement" and moves.move_units:
        choices = problem.space.allowed_positions or ops.ALL_POSITIONS
        for positions in permutations(choices, len(unit_ids)):
            yield SetPositions(positions=positions)
    elif kind == "gear" and problem.gear.mode == "ADJUSTABLE":
        policy = problem.gear
        options = [
            Gear(stat=stat, tier=tier, grade=grade)
            for stat, tier, grade in product(
                get_args(GearStat) if policy.allowed_stats is None else policy.allowed_stats,
                get_args(GearTier) if policy.allowed_tiers is None else policy.allowed_tiers,
                get_args(GearGrade) if policy.allowed_grades is None else policy.allowed_grades,
            )
        ]
        for i, unit in enumerate(parent.units):
            if (
                policy.adjustable_unit_ids is not None
                and unit.unit_definition_id not in policy.adjustable_unit_ids
            ):
                continue
            gears = effective_gears(problem, unit)
            for j, current in enumerate(gears):
                if current in gears[:j]:
                    continue
                yield ReplaceGear(index=i, gearIndex=j, gear=None)
                for gear in options:
                    if gear != current:
                        yield ReplaceGear(index=i, gearIndex=j, gear=gear)
            if len(gears) < policy.max_gears_per_unit:
                for gear in options:
                    yield ReplaceGear(index=i, gearIndex=len(gears), gear=gear)


def enumerate_candidates(
    problem: SearchProblem, parent: Candidate, kind: CandidateKind
) -> Iterator[dict]:
    seen = {parent.candidate_id}
    for change in _operations(problem, parent, kind):
        candidate = apply_operations(problem, parent, [change])
        cid = candidate.candidate_id
        if cid in seen or check_candidate(problem, EXERCISE_SEARCH, candidate):
            continue
        seen.add(cid)
        proposal = ProposedChange(parentId=parent.candidate_id, operations=[change])
        yield {
            "candidateId": cid,
            "candidate": dump_candidate(candidate),
            "proposal": proposal.model_dump(mode="json", by_alias=True),
        }


def confirmation_reserve(problem: SearchProblem, start_count: int, used: int) -> int:
    settings = problem.method.settings.get("trials")
    if settings is None:
        return 0
    trials = SearchTrials.model_validate(settings)
    return max(0, trials.confirmation_runs * (trials.finalists + start_count) - used)


class _Interactive:
    descriptor = ComponentDescriptor(componentId="exercise-lab.interactive", version="1")
    state_version = 1

    def __init__(
        self,
        command: RoundInput | None = None,
        proposals: tuple[Proposal, ...] = (),
        objective: SearchObjective | None = None,
    ) -> None:
        self.command = command
        self.proposals = proposals
        self.objective = objective

    def dump_state(self) -> None:
        return None

    def load_state(self, state: None) -> None:
        if state is not None:
            raise ConfigError("対話型探索のチェックポイントが不正")

    def observe(self, _feedback) -> None:
        pass

    def propose(self, _view, _rng) -> tuple[Proposal, ...]:
        return self.proposals

    def allocate(self, view: SearchView, _rng) -> Allocation:
        assert self.command is not None
        command = self.command
        trials = SearchTrials.model_validate(view.problem.method.settings["trials"])
        seed = phase_seed(view.problem, command.phase)
        reserved = 0
        if command.phase == "screening":
            used = sum(
                round_.submitted_runs or 0
                for round_ in view.rounds
                if round_.seed == trials.confirmation_seed
            )
            reserved = confirmation_reserve(view.problem, len(view.start_candidate_ids), used)
        candidate_ids = dict.fromkeys(
            [*command.candidate_ids, *(p.candidate.candidate_id for p in self.proposals)]
        )
        default = (
            trials.screening_runs if command.phase == "screening" else trials.confirmation_runs
        )
        return Allocation(
            requests=tuple(
                TrialRequest(
                    cid,
                    runs=(command.runs or default) if command.run_indices is None else None,
                    run_indices=None if command.run_indices is None else tuple(command.run_indices),
                )
                for cid in candidate_ids
            ),
            seed=seed,
            reserve_runs=reserved,
        )

    def estimate(self, entry: CandidateEntry) -> dict:
        assert self.objective is not None
        objective = self.objective
        by_seed: dict[str | None, list[int]] = {}
        for observation in entry.observations:
            by_seed.setdefault(observation.seed, []).append(observation.observation["totalScore"])
        return {
            seed: {
                "sampleCount": len(scores),
                "meanScore": sum(scores) / len(scores),
                "expectedBest": expected_best(scores, best_of=objective.best_of)
                if len(scores) >= objective.best_of
                else None,
            }
            for seed, scores in by_seed.items()
        }


def interactive_method(
    store: SqliteSearchStore | None = None, command: RoundInput | None = None
) -> SearchMethod:
    component = _Interactive()
    if store is not None:
        problem = store.load_problem()
        proposals = []
        parents = saved_candidates(store)
        if command is not None:
            for change in command.proposals:
                if change.parent_id not in parents:
                    raise ConfigError(f"起点候補 {change.parent_id} が見つからない")
                try:
                    candidate = apply_operations(
                        problem, parents[change.parent_id], change.operations
                    )
                except IndexError as error:
                    raise ConfigError(f"{change.parent_id}: 変更する枠が範囲外") from error
                proposals.append(
                    Proposal(
                        candidate,
                        Origin(
                            kind="PROPOSED",
                            parents=(change.parent_id,),
                            operations=tuple(op.kind for op in change.operations),
                            note={
                                "changes": change.model_dump(mode="json", by_alias=True)[
                                    "operations"
                                ]
                            },
                        ),
                    )
                )
        objective = problem.method.settings.get("objective")
        if objective is None:
            raise ConfigError("search init で作成した対話型探索が必要")
        component = _Interactive(
            command, tuple(proposals), SearchObjective.model_validate(objective)
        )
    return SearchMethod(component, component, component)
