"""Optunaベースライン。TPE + WilcoxonPruner + 既知編成のウォームスタート。

自作の反復局所探索を採用するかどうかを決めるための比較対象である。同じ `Evaluator`・
同じ予算・同じ最終選抜を通し、違うのは「次にどの候補を試すか」と「浅い評価で打ち切るか」
だけにしてある。

`WilcoxonPruner` はノイズ付きヒューリスティックの評価用に作られたプルーナーで、
試行ごとの値を**同じ試行番号どうしで**現ベストと対比較（Wilcoxon符号順位検定）し、
劣ると分かった時点で打ち切る。サーバーが乱数列を `runIndex` だけで決めるため、
同じ試行番号は候補間で同じ乱数列になり、対応のある検定の前提がそのまま満たされる。

ひとつ注意がある。プルーナーへ渡すのは試行ごとの素のスコアなので、打ち切りの判断は
**平均**についてのものになる。一方この探索が最大化するのは期待日次ベスト（上振れが
資産になる指標）である。平均は並でも天井が高い候補が早めに切られることがあり、
自作実装よりやや保守的に働く。比較結果を読むときはこの差を織り込む。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .algorithms import (
    ExplorationResult,
    GenerationReport,
    SearchContext,
    exploration_pool,
)
from .candidate import ALL_CELLS, Candidate, Placement, repair
from .state import SearchState

if TYPE_CHECKING:  # pragma: no cover - 型検査のためだけの読み込み
    import optuna

# 「このマス／枠は空」を表すカテゴリ値。編成の人数とメモリー枚数そのものを
# 探索変数にするため、専用のカテゴリを置く。
EMPTY = "-"


class OptunaSearch:
    name = "optuna"

    def explore(self, context: SearchContext, state: SearchState | None) -> ExplorationResult:
        import optuna

        if state is not None:
            raise ValueError(
                "Optunaベースラインは中断からの再開に対応しない"
                "（study の内部状態を状態ファイルへ持たないため）"
            )
        optuna.logging.set_verbosity(optuna.logging.WARNING)

        study = optuna.create_study(
            direction="maximize",
            sampler=optuna.samplers.TPESampler(
                # カテゴリカル変数どうしの相関（このユニットならこの配置、など）を
                # 拾わせる。既定の単変量TPEは編成を1マスずつ独立に決めてしまう。
                multivariate=True,
                group=True,
                seed=context.rng.randrange(2**32),
            ),
            pruner=optuna.pruners.WilcoxonPruner(),
        )
        for seed_candidate in context.config.seed_candidates()[: context.config.max_seed_count()]:
            study.enqueue_trial(_parameters_of(seed_candidate, context))

        history: list[GenerationReport] = []
        best = float("-inf")
        stale = 0

        def objective(trial: optuna.Trial) -> float:
            nonlocal best, stale
            candidate = _candidate_of(trial, context)
            fitness, _ = _evaluate(trial, candidate, context)
            if fitness > best:
                best = fitness
                stale = 0
            else:
                stale += 1
            history.append(
                GenerationReport(
                    generation=len(history) + 1,
                    consumed_runs=context.evaluator.consumed_runs,
                    best_fitness=best,
                )
            )
            return fitness

        stopped = "budget"

        def stop_when_spent(study: optuna.Study, trial: optuna.trial.FrozenTrial) -> None:
            nonlocal stopped
            del trial
            if stale >= context.settings.patience:
                stopped = "patience"
                study.stop()
            # 次の試行は最も深い段まで積み得る。使い切ってから止めると超過するので、
            # 1試行ぶんの余地が無くなった時点で畳む。
            elif not context.budget_left(context.config.schedule.stage_runs[-1]):
                study.stop()

        study.optimize(objective, callbacks=[stop_when_spent])

        return ExplorationResult(
            pool=exploration_pool(context),
            history=tuple(history),
            stopped_because=stopped,
        )


def _evaluate(
    trial: optuna.Trial, candidate: Candidate, context: SearchContext
) -> tuple[float, int]:
    """段ごとに試行を積み、そのつど打ち切りを問う。

    報告は試行ごと（`trial.report(score, run_index)`）に行う。プルーナーは同じ
    `run_index` の値どうしを突き合わせるため、番号を候補間で揃えることが前提になる。
    """
    reported = 0
    scores: list[int] = []
    for target in context.config.schedule.stage_runs:
        (record,) = context.evaluator.ensure([candidate], target, phase=context.search_phase)
        scores = record.scores
        for index in range(reported, len(scores)):
            trial.report(scores[index], index)
        reported = len(scores)
        if not scores:
            break
        if trial.should_prune():
            # 打ち切っても `TrialPruned` は投げない。推定値を返しておくと
            # サンプラーがその候補の情報を捨てずに次の提案へ使える。
            break
    if not scores:
        return float("-inf"), 0
    return context.policy.fitness(scores), len(scores)


def _parameters_of(candidate: Candidate, context: SearchContext) -> dict[str, Any]:
    """候補をOptunaのパラメータ空間へ写す。ウォームスタート（`enqueue_trial`）で使う。"""
    del context
    by_cell = {placement.cell: placement.unit_definition_id for placement in candidate.placements}
    parameters: dict[str, Any] = {
        _cell_key(index): by_cell.get(cell, EMPTY) for index, cell in enumerate(ALL_CELLS)
    }
    memories = candidate.memory_definition_ids
    for slot in range(6):
        parameters[_memory_key(slot)] = memories[slot] if slot < len(memories) else EMPTY
    return parameters


def _candidate_of(trial: optuna.Trial, context: SearchContext) -> Candidate:
    """6マス×ユニット、6枠×メモリーのカテゴリカル変数から候補を組む。

    重複も人数超過もここでは弾かない。制約は `repair` が引き受ける規約に揃えてある。
    """
    constraints = context.config.constraints
    units = [EMPTY, *constraints.unit_pool]
    memories = [EMPTY, *constraints.memory_pool]

    placements = []
    for index, cell in enumerate(ALL_CELLS):
        chosen = trial.suggest_categorical(_cell_key(index), units)
        if chosen != EMPTY:
            placements.append(Placement(unit_definition_id=chosen, cell=cell))

    chosen_memories = []
    for slot in range(constraints.max_memories):
        chosen = trial.suggest_categorical(_memory_key(slot), memories)
        if chosen != EMPTY:
            chosen_memories.append(chosen)

    return repair(
        Candidate(placements=tuple(placements), memory_definition_ids=tuple(chosen_memories)),
        constraints,
    )


def _cell_key(index: int) -> str:
    return f"cell{index}"


def _memory_key(slot: int) -> str:
    return f"memory{slot}"
