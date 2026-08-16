"""探索アルゴリズムと、共通の予算・最終選抜。

3つの実装（反復局所探索・ランダムサーチ・Optuna）は同じ `Evaluator` と同じ予算を使い、
同じ最終選抜を通る。違うのは「次にどの候補を試すか」だけであり、比較が公平になる。

予算はシミュレーションの総試行数で数える。時間で切らないのは、同じ設定・同じseedなら
何度走らせても同じ結果が出るようにするためである。最終選抜のぶんは先に取り置く——
探索が予算を使い切ってから「上位5件を確かめる試行が無い」となると、結果を報告できない。
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from random import Random
from typing import Any, Protocol

from .candidate import Candidate
from .evaluator import EvaluationPhase, Evaluator
from .fitness import Objective
from .operators import Neighborhood, UnitHint, initial_population
from .racing import (
    FINAL_SURVIVAL_DIVISOR,
    SURVIVAL_RATIO,
    RacedCandidate,
    plan_stages,
    select_top_k,
    successive_halving,
)
from .search_config import ScheduleSpec, SearchConfig
from .state import SearchState, capture_state, read_state, restore_evaluator, write_state

# 世代あたりに残すエリート。交叉の親と、次世代の変異元になる。
ELITE_COUNT = 2

# 「何も進まない世代」がこれだけ続いたら打ち切る。1回で切らないのは、期限超過が
# たまたま重なった世代を「掘り尽くした」と取り違えないため。
BARREN_GENERATION_LIMIT = 3


@dataclass(frozen=True)
class SearchSettings:
    budget_runs: int
    patience: int


@dataclass(frozen=True)
class GenerationReport:
    generation: int
    consumed_runs: int
    best_fitness: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "generation": self.generation,
            "consumedRuns": self.consumed_runs,
            "bestFitness": self.best_fitness,
        }


@dataclass
class SearchContext:
    config: SearchConfig
    evaluator: Evaluator
    search_phase: EvaluationPhase
    final_phase: EvaluationPhase
    rng: Random
    settings: SearchSettings
    hints: tuple[UnitHint, ...] = ()
    state_path: Path | None = None
    on_generation: Callable[[GenerationReport], None] | None = None

    @property
    def policy(self) -> Objective:
        return self.config.objective

    @property
    def neighborhood(self) -> Neighborhood:
        return Neighborhood(
            constraints=self.config.constraints,
            weights=self.config.operator_weights.normalized(),
        )

    def exploration_budget(self) -> int:
        """探索へ回せる試行数。最終選抜のぶんを差し引く。"""
        return self.settings.budget_runs - final_selection_cost(self.config.schedule)

    def budget_left(self, projected: int = 0) -> bool:
        """これから `projected` 試行を使っても予算に収まるか。

        使い切ってから止めると、最後の1世代ぶんまるごと超過する。`--budget` は
        「だいたいこのくらい」ではなく上限として扱う。
        """
        return self.evaluator.consumed_runs + projected <= self.exploration_budget()


def exploration_pool(context: SearchContext) -> tuple[Candidate, ...]:
    """探索で評価した候補を、最終選抜へ送る順に並べる。

    深く評価された候補を先に置き、同じ試行数の中では適応度で並べる。試行数の違う候補を
    適応度の生値で横並びにしない——順序統計量ベースの推定量は標本数で偏りが変わり、
    浅くしか評価していない候補と公平に比べられない。レーシングを生き延びたことそのものが
    先に効く情報である。

    順位を評価器の履歴から作り直すのは、中断から再開したときにも探索前半の候補が
    プールへ残るようにするためでもある（履歴は状態ファイルへ保存される）。
    """
    policy = context.policy
    entries = [
        (record.sample_count, policy.fitness(record.scores), record.candidate)
        for record in context.evaluator.evaluated_records(context.search_phase)
        if record.scores
    ]
    entries.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return tuple(entry[2] for entry in entries)


@dataclass(frozen=True)
class ExplorationResult:
    """探索位相の産物。最終選抜へ送る候補（良い順）と、best-so-far の履歴。"""

    pool: tuple[Candidate, ...]
    history: tuple[GenerationReport, ...]
    stopped_because: str


@dataclass(frozen=True)
class OptimizationResult:
    algorithm: str
    top: tuple[RacedCandidate, ...]
    history: tuple[GenerationReport, ...]
    consumed_runs: int
    stopped_because: str


class SearchAlgorithm(Protocol):
    name: str

    def explore(self, context: SearchContext, state: SearchState | None) -> ExplorationResult: ...


def _ladder_cost(
    candidate_count: int, stage_runs: Sequence[int], shrink: Callable[[int], int]
) -> int:
    """段を登り切るのに要る試行数。生き残りだけが次の段へ進むぶんを織り込む。"""
    survivors = candidate_count
    consumed = 0
    previous = 0
    for index, runs in enumerate(stage_runs):
        consumed += survivors * (runs - previous)
        previous = runs
        if index < len(stage_runs) - 1:
            survivors = shrink(survivors)
    return consumed


def final_selection_cost(schedule: ScheduleSpec) -> int:
    """最終選抜が使う試行数。予算から先に取り置く量であり、実際の消費と一致する。"""
    return _ladder_cost(
        schedule.final_pool_size,
        schedule.final_stage_runs,
        lambda survivors: max(schedule.top_k, math.ceil(survivors / FINAL_SURVIVAL_DIVISOR)),
    )


def racing_cost(candidate_count: int, stage_runs: Sequence[int]) -> int:
    """1世代のレーシングに要る試行数の上限。

    評価済みの候補（エリートなど）は使い回すので実際の消費はこれより小さい。予算を
    超えないことを保証するために、多めに見た値で世代を始めるかどうかを決める。
    """
    return _ladder_cost(
        candidate_count, stage_runs, lambda survivors: max(1, math.ceil(survivors * SURVIVAL_RATIO))
    )


def minimum_budget(schedule: ScheduleSpec) -> int:
    """レポートを1つ出すのに最低限要る試行数。探索1世代 + 最終選抜。"""
    return final_selection_cost(schedule) + racing_cost(
        schedule.population_size, schedule.stage_runs
    )


def optimize(
    algorithm: SearchAlgorithm, context: SearchContext, *, resume: bool = False
) -> OptimizationResult:
    """探索から最終選抜までを通す。3アルゴリズムで共通の入口。"""
    schedule = context.config.schedule
    minimum = minimum_budget(schedule)
    if context.settings.budget_runs < minimum:
        generation = racing_cost(schedule.population_size, schedule.stage_runs)
        raise ValueError(
            f"予算 {context.settings.budget_runs} 試行では最終選抜"
            f"（{final_selection_cost(schedule)} 試行）と探索1世代（{generation} 試行）に届かない。"
            f"--budget を {minimum} 以上にするか、populationSize / stageRuns /"
            " finalPoolSize / finalStageRuns を下げる"
        )

    state = _restore(context, resume)
    exploration = algorithm.explore(context, state)
    top = select_top_k(
        exploration.pool[: context.config.schedule.final_pool_size],
        context.evaluator,
        policy=context.policy,
        stages=plan_stages(context.config.schedule.final_stage_runs, context.policy),
        phase=context.final_phase,
        k=context.config.schedule.top_k,
    )
    return OptimizationResult(
        algorithm=algorithm.name,
        top=tuple(top),
        history=exploration.history,
        consumed_runs=context.evaluator.consumed_runs,
        stopped_because=exploration.stopped_because,
    )


def _restore(context: SearchContext, resume: bool) -> SearchState | None:
    if not resume or context.state_path is None or not context.state_path.exists():
        return None
    state = read_state(context.state_path)
    restore_evaluator(context.evaluator, state, (context.search_phase, context.final_phase))
    context.rng.setstate(state.rng_state)
    return state


@dataclass
class _Progress:
    """世代をまたぐ best-so-far の記録。曲線が下がらないことをここで保証する。"""

    history: list[GenerationReport] = field(default_factory=list)
    best_fitness: float = float("-inf")
    stale_generations: int = 0

    def observe(self, generation: int, consumed_runs: int, fitness: float) -> None:
        if fitness > self.best_fitness:
            self.best_fitness = fitness
            self.stale_generations = 0
        else:
            self.stale_generations += 1
        self.history.append(
            GenerationReport(
                generation=generation, consumed_runs=consumed_runs, best_fitness=self.best_fitness
            )
        )

    def load(self, history: Sequence[dict[str, Any]], stale_generations: int) -> None:
        self.history = [
            GenerationReport(
                generation=entry["generation"],
                consumed_runs=entry["consumedRuns"],
                best_fitness=entry["bestFitness"],
            )
            for entry in history
        ]
        self.stale_generations = stale_generations
        if self.history:
            self.best_fitness = self.history[-1].best_fitness


class _GenerationalSearch:
    """世代を回す骨組み。候補の作り方だけを派生が決める。

    レーシング・予算・patience・状態保存はここに集約する。アルゴリズムごとに
    書き分けると、比較したいはずの「候補の作り方」以外の条件までずれる。
    """

    name = ""

    def explore(self, context: SearchContext, state: SearchState | None) -> ExplorationResult:
        progress = _Progress()
        if state is None:
            generation = 0
            population = self.initial(context)
        else:
            # 再開時は初期母集団を作らない。作ると乱数を余分に消費し、復元した
            # 乱数の位置がずれて、中断なしの実行と違う軌跡になる。
            generation = state.generation
            population = list(state.population)
            progress.load(state.history, state.stale_generations)

        stopped = "budget"
        stages = plan_stages(context.config.schedule.stage_runs, context.policy)
        barren_generations = 0

        stage_runs = context.config.schedule.stage_runs
        while context.budget_left(racing_cost(len(population), stage_runs)):
            generation += 1
            spent_before = context.evaluator.consumed_runs
            ranked = successive_halving(
                population,
                context.evaluator,
                policy=context.policy,
                stages=stages,
                phase=context.search_phase,
            )
            if ranked:
                progress.observe(generation, context.evaluator.consumed_runs, ranked[0].fitness)
                if context.on_generation is not None:
                    context.on_generation(progress.history[-1])

            # 1件も順位が付かない（サーバーが期限で何も返せない）世代と、新しい試行を
            # 1つも消費しない（探索空間を掘り尽くした）世代が続いたら打ち切る。
            # どちらも回し続けても状況が変わらず、予算だけが減らないまま止まらなくなる。
            made_progress = bool(ranked) and context.evaluator.consumed_runs > spent_before
            barren_generations = 0 if made_progress else barren_generations + 1
            if barren_generations >= BARREN_GENERATION_LIMIT:
                stopped = "exhausted"
                self._save(context, generation, progress, population)
                break

            if progress.stale_generations >= context.settings.patience:
                stopped = "patience"
                self._save(context, generation, progress, population)
                break
            # 保存するのは「次に評価する母集団」。評価前の母集団を保存すると、再開時に
            # 同じ世代をもう一度回すことになり、履歴が中断なしの実行と食い違う。
            population = self.next_population(context, ranked)
            self._save(context, generation, progress, population)

        return ExplorationResult(
            pool=exploration_pool(context),
            history=tuple(progress.history),
            stopped_because=stopped,
        )

    def initial(self, context: SearchContext) -> list[Candidate]:
        raise NotImplementedError

    def next_population(
        self, context: SearchContext, ranked: Sequence[RacedCandidate]
    ) -> list[Candidate]:
        raise NotImplementedError

    def _save(
        self,
        context: SearchContext,
        generation: int,
        progress: _Progress,
        population: Sequence[Candidate],
    ) -> None:
        if context.state_path is None:
            return
        write_state(
            context.state_path,
            capture_state(
                algorithm=self.name,
                generation=generation,
                stale_generations=progress.stale_generations,
                population=tuple(population),
                history=tuple(report.to_dict() for report in progress.history),
                rng=context.rng,
                evaluator=context.evaluator,
                phases=(context.search_phase, context.final_phase),
            ),
        )


class IteratedLocalSearch(_GenerationalSearch):
    """既知の良編成を種にした反復局所探索。

    エリートの近傍を重点的に掘りつつ、毎世代いくらかランダム候補を混ぜて、
    種から遠い領域への道も残す。
    """

    name = "local-search"

    def initial(self, context: SearchContext) -> list[Candidate]:
        return initial_population(
            context.neighborhood,
            context.rng,
            size=context.config.schedule.population_size,
            seeds=context.config.seed_candidates(),
            hints=context.hints,
            max_seed_count=context.config.max_seed_count(),
        )

    def next_population(
        self, context: SearchContext, ranked: Sequence[RacedCandidate]
    ) -> list[Candidate]:
        space = context.neighborhood
        size = context.config.schedule.population_size
        elites = [entry.candidate for entry in ranked[:ELITE_COUNT]]
        population: list[Candidate] = list(elites)
        keys = {candidate.canonical_key() for candidate in population}

        def add(candidate: Candidate) -> None:
            key = candidate.canonical_key()
            if key not in keys and len(population) < size:
                keys.add(key)
                population.append(candidate)

        if len(elites) >= 2:
            add(space.crossover(elites[0], elites[1], context.rng))
            add(space.crossover(elites[1], elites[0], context.rng))

        # 生き残り全体の近傍を掘る。エリートだけを掘ると1つの谷から出られない。
        # 順位が1件も付かなかった世代（期限超過で何も返らない）は親がいないので、
        # 変異を飛ばしてランダムで埋め直す。
        parents = [entry.candidate for entry in ranked]
        guard = 0
        while parents and len(population) < size and guard < size * 20:
            guard += 1
            add(space.mutate(context.rng.choice(parents), context.rng))
        return _fill_with_random(population, add, space, context.rng, size)


class RandomSearch(_GenerationalSearch):
    """下限のベースライン。毎世代を独立なランダム候補で埋める。"""

    name = "random"

    def initial(self, context: SearchContext) -> list[Candidate]:
        return self._draw(context)

    def next_population(
        self, context: SearchContext, ranked: Sequence[RacedCandidate]
    ) -> list[Candidate]:
        del ranked
        return self._draw(context)

    def _draw(self, context: SearchContext) -> list[Candidate]:
        space = context.neighborhood
        size = context.config.schedule.population_size
        population: list[Candidate] = []
        keys: set[str] = set()

        def add(candidate: Candidate) -> None:
            key = candidate.canonical_key()
            if key not in keys and len(population) < size:
                keys.add(key)
                population.append(candidate)

        return _fill_with_random(population, add, space, context.rng, size)


def _fill_with_random(
    population: list[Candidate],
    add: Callable[[Candidate], None],
    space: Neighborhood,
    rng: Random,
    size: int,
) -> list[Candidate]:
    """残り枠をランダム候補で埋める。

    試行回数に上限を置く。候補プールが小さいと空間を掘り尽くして新しい候補が出なくなり、
    上限が無いと母集団を満たせないまま回り続ける。埋まらなければ小さいまま返し、
    「何も進まない世代」として探索側が打ち切る。
    """
    for _ in range(size * 50):
        if len(population) >= size:
            break
        add(space.random_candidate(rng))
    return population


def _optuna_search() -> SearchAlgorithm:
    # Optunaは使うときだけ読み込む。未導入の環境でも自作の2実装は動かせるようにする。
    from .optuna_search import OptunaSearch

    return OptunaSearch()


ALGORITHMS: dict[str, Callable[[], SearchAlgorithm]] = {
    IteratedLocalSearch.name: IteratedLocalSearch,
    RandomSearch.name: RandomSearch,
    "optuna": _optuna_search,
}


def build_algorithm(name: str) -> SearchAlgorithm:
    factory = ALGORITHMS.get(name)
    if factory is None:
        raise ValueError(f"未知のアルゴリズム {name}（{', '.join(sorted(ALGORITHMS))} のいずれか）")
    return factory()
