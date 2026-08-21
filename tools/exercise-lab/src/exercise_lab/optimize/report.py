"""最適化レポート。上位編成の統計と、UIへそのまま入力できる編成表。

数値は探索と同じ `Objective` で出す。レポート側で別の計算をすると、探索が選んだ理由と
報告された順位が食い違う。

期待日次ベストは重みが上位の標本へ集中するため実効サンプル数が少なく、報告に耐える水準
（`fitness.MIN_RELIABLE_EFFECTIVE_SAMPLES`）を割った場合は警告を添える。数字だけを黙って
出すと、読み手はそれが確かな値かどうかを判断できない。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt

from ..api import Catalog
from ..stats import NORMAL_QUANTILE_95, summarize_scores
from .candidate import Candidate
from .fitness import MIN_RELIABLE_EFFECTIVE_SAMPLES
from .racing import RacedCandidate
from .search_config import SearchConfig

if TYPE_CHECKING:  # pragma: no cover - 型検査のためだけの読み込み
    from .algorithms import GenerationReport


def build_optimization_summary(
    top: Sequence[RacedCandidate[Candidate]],
    *,
    config: SearchConfig,
    catalog: Catalog,
    algorithm: str,
    seed: str,
    budget_runs: int,
    consumed_runs: int,
    stopped_because: str,
    history: Sequence[GenerationReport],
    catalog_revision: str,
) -> dict[str, Any]:
    objective = config.objective
    formations = [
        _formation_summary(entry, rank=rank, config=config, catalog=catalog)
        for rank, entry in enumerate(top, start=1)
    ]
    return {
        "algorithm": algorithm,
        "seed": seed,
        "catalogRevision": catalog_revision,
        "budgetRuns": budget_runs,
        "consumedRuns": consumed_runs,
        "stoppedBecause": stopped_because,
        "objective": {
            "bestOf": objective.best_of,
            # YAMLのキー名に合わせる。レポートから設定へ戻れるようにする。
            "lambda": objective.expected_weight,
            "guardQuantile": objective.guard_quantile,
            "effectiveSamples": objective.effective_samples(top[0].sample_count) if top else 0.0,
        },
        "schedule": {
            "stageRuns": list(config.schedule.stage_runs),
            "finalStageRuns": list(config.schedule.final_stage_runs),
            "populationSize": config.schedule.population_size,
            "finalPoolSize": config.schedule.final_pool_size,
            "topK": config.schedule.top_k,
        },
        "topFormations": formations,
        "bestSoFar": [
            {
                "generation": point.generation,
                "consumedRuns": point.consumed_runs,
                "bestFitness": point.best_fitness,
            }
            for point in history
        ],
        "warnings": _warnings(top, config),
    }


def _formation_summary(
    entry: RacedCandidate[Candidate], *, rank: int, config: SearchConfig, catalog: Catalog
) -> dict[str, Any]:
    scores = entry.record.scores_at(entry.sample_count)
    stats = summarize_scores(scores)
    half_width = (
        None
        if stats.stdev is None
        else NORMAL_QUANTILE_95 * stats.stdev / (entry.sample_count**0.5)
    )
    objective = config.objective
    return {
        "rank": rank,
        "canonicalKey": entry.candidate.canonical_key(),
        "sampleCount": entry.sample_count,
        "fitness": entry.fitness,
        "expectedBest": entry.expected_best,
        "medianBest": objective.median_best(scores),
        "guaranteedBest": entry.guard,
        "mean": entry.mean,
        "median": stats.median,
        "stdev": stats.stdev,
        "minimum": stats.minimum,
        "maximum": stats.maximum,
        "ci95Low": None if half_width is None else entry.mean - half_width,
        "ci95High": None if half_width is None else entry.mean + half_width,
        "defeatRate": entry.defeat_rate,
        "formation": formation_rows(entry, config=config, catalog=catalog),
    }


def formation_rows(
    entry: RacedCandidate[Candidate], *, config: SearchConfig, catalog: Catalog
) -> dict[str, Any]:
    """UIへ入力するための編成表。IDだけでは画面上で探せないため表示名を添える。

    強化値も併記する。同じ編成でも育成状態が違えば別のスコアになるので、
    どの育成状態で出た結果かをレポート単体で確かめられるようにする。
    """
    formation = config.formation_config(entry.candidate)
    units = [
        {
            "unitDefinitionId": unit.unit_definition_id,
            "displayName": _unit_name(catalog, unit.unit_definition_id),
            "column": unit.position.column,
            "row": unit.position.row,
            "level": unit.level,
            "gears": [f"{gear.stat} {gear.tier} {gear.grade}" for gear in unit.gears or []],
        }
        for unit in formation.ally.units
    ]
    memories = [
        {
            "order": order,
            "memoryDefinitionId": memory_id,
            "displayName": _memory_name(catalog, memory_id),
        }
        for order, memory_id in enumerate(entry.candidate.memory_definition_ids, start=1)
    ]
    return {
        "units": units,
        "memories": memories,
        "enemy": {
            "unitDefinitionId": config.enemy.unit_definition_id,
            "displayName": _unit_name(catalog, config.enemy.unit_definition_id),
            "column": config.enemy.position.column,
            "row": config.enemy.position.row,
        },
    }


def _warnings(top: Sequence[RacedCandidate[Candidate]], config: SearchConfig) -> list[str]:
    warnings: list[str] = []
    objective = config.objective
    thin = [entry for entry in top if not objective.is_reliable(entry.sample_count)]
    if thin:
        shallowest = min(entry.sample_count for entry in thin)
        warnings.append(
            f"期待日次ベストの実効サンプル数が "
            f"{objective.effective_samples(shallowest):.1f} しかない"
            f"（試行数 {shallowest}、報告に要る目安は {MIN_RELIABLE_EFFECTIVE_SAMPLES}）。"
            "順位付けには使えるが、値そのものは上位数標本に引きずられやすい"
        )
    return warnings


def _unit_name(catalog: Catalog, unit_definition_id: str) -> str:
    unit = catalog.unit(unit_definition_id)
    # Catalogから消えたIDでも表を出せるようにする。探索の結果を捨てるほどの問題ではない。
    return unit.display_name if unit is not None else unit_definition_id


def _memory_name(catalog: Catalog, memory_definition_id: str) -> str:
    for memory in catalog.memories:
        if memory.memory_definition_id == memory_definition_id:
            return memory.display_name
    return memory_definition_id


def write_best_so_far_chart(history: Sequence[GenerationReport], path: Path, *, title: str) -> None:
    """消費試行数に対する best-so-far 曲線。同一予算でのアルゴリズム比較に使う。"""
    write_comparison_chart({"best so far": history}, path, title=title)


# 曲線の色。アルゴリズムの並び順で割り当てる。
_CURVE_COLORS = ("#4c78a8", "#f58518", "#54a24b", "#e45756", "#b279a2")


def write_comparison_chart(
    histories: Mapping[str, Sequence[GenerationReport]], path: Path, *, title: str
) -> None:
    """複数アルゴリズムの best-so-far 曲線を重ねる。

    横軸を世代ではなく消費試行数にするのは、アルゴリズムによって1世代の重さが違うため
    である。世代で並べると、1世代に多く払う実装が不当に速く見える。
    """
    figure, axes = plt.subplots(figsize=(8, 4.5))
    try:
        for index, (label, history) in enumerate(histories.items()):
            axes.step(
                [point.consumed_runs for point in history],
                [point.best_fitness for point in history],
                where="post",
                label=label,
                color=_CURVE_COLORS[index % len(_CURVE_COLORS)],
            )
        axes.set_title(title)
        axes.set_xlabel("consumed simulation runs")
        axes.set_ylabel("best fitness")
        if len(histories) > 1:
            axes.legend()
        figure.tight_layout()
        figure.savefig(path, dpi=120)
    finally:
        plt.close(figure)
