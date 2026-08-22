"""ギア感度分析のレポート。

数値は分析と同じ `Objective` で出す。レポート側で別の計算をすると、上位に並んだ理由と
報告された値が食い違う。

**基点編成を変えたら本レポートの結論は無効になる。** ギアの限界効用は順位で決まる効果
（`HIGHEST_ATTACK` / `LOWEST_ATTACK`・単発消費デバフ）の当て先に依存し、その当て先は
メモリーやユニットの入れ替えで変わるためである。その旨をレポート自身に残す。
"""

from __future__ import annotations

import csv
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..api import Catalog
from ..models import FormationConfig
from ..optimize.fitness import Objective
from .allocation import SEARCHED_STATS, Allocation
from .neighborhood import Move
from .plan import PlanResult, PlanSettings, RestartAttempt
from .rank_tuning import RankTuningResult, RankWalk
from .search import ClimbResult
from .sensitivity import (
    CombinedResult,
    MoveEntry,
    PairedDiff,
    SensitivityResult,
    SensitivitySettings,
)

# コンソール表の見出し。ID そのままでは5列が端末幅に収まらない。
STAT_LABELS: Mapping[str, str] = {
    "ATTACK": "攻撃力",
    "ACTION_SPEED": "行動速度",
    "CRITICAL_RATE": "会心率",
    "CRITICAL_DAMAGE_BONUS": "会心DMG",
    "AFFINITY_BONUS": "属性相性",
}

BASE_FORMATION_CAVEAT = (
    "この結果は基点編成に固有である。ユニット・配置・メモリー・レベル・学園レベルの"
    "いずれかを変えると、順位で当て先が決まる効果の受け先が変わり、限界効用も変わる"
)

MOVE_CSV_COLUMNS = (
    "slot_index",
    "unit_definition_id",
    "kind",
    "removed",
    "added",
    "gained_stat",
    "deepest_stage",
    "screen_runs",
    "screen_mean_diff",
    "screen_mean_ci_low",
    "screen_mean_ci_high",
    "screen_defeat_rate",
    "confirm_runs",
    "confirm_expected_best_diff",
    "confirm_expected_best_ci_low",
    "confirm_expected_best_ci_high",
    "confirm_guard_diff",
    "confirm_fitness_diff",
    "confirm_defeat_rate",
    "verify_runs",
    "verify_expected_best_diff",
    "verify_expected_best_ci_low",
    "verify_expected_best_ci_high",
    "verify_guard_diff",
    "verify_fitness_diff",
    "verify_defeat_rate",
)


def build_sensitivity_summary(
    result: SensitivityResult,
    *,
    config: FormationConfig,
    catalog: Catalog,
    settings: SensitivitySettings,
    objective: Objective,
    seed: str,
    catalog_revision: str,
    planned_runs: Mapping[str, int],
    consumed_runs: int,
) -> dict[str, Any]:
    return {
        "seed": seed,
        "catalogRevision": catalog_revision,
        "caveat": BASE_FORMATION_CAVEAT,
        "baseFormation": _base_formation(result.base_allocation, config, catalog),
        "settings": {
            "screenRuns": settings.screen_runs,
            "confirmRuns": settings.confirm_runs,
            "verifyRuns": settings.verify_runs,
            "survivors": settings.survivors,
            "topMoves": settings.top_moves,
            "includeRank": settings.include_rank,
            "addRank": settings.add_rank.label,
        },
        "objective": {
            "bestOf": objective.best_of,
            "lambda": objective.expected_weight,
            "guardQuantile": objective.guard_quantile,
        },
        "plannedRuns": dict(planned_runs),
        "consumedRuns": consumed_runs,
        "basePhases": {
            name: {
                "runs": record.sample_count,
                "mean": objective.mean(record.scores),
                "expectedBest": objective.expected_best(record.scores),
                "guard": objective.guard(record.scores),
                "defeatRate": record.defeat_rate(),
            }
            for name, record in result.base_records.items()
            if record.sample_count > 0
        },
        "utilityMap": [
            {
                "slotIndex": cell.slot_index,
                "unitDefinitionId": cell.unit_definition_id,
                "displayName": _display_name(catalog, cell.unit_definition_id),
                "stat": cell.stat,
                "expectedBestDiff": None
                if cell.entry is None
                else cell.entry.deepest.expected_best_diff,
                "significant": None
                if cell.entry is None
                else cell.entry.deepest.expected_best_significant,
                "stage": None if cell.entry is None else cell.entry.deepest_stage,
                "move": None if cell.entry is None else cell.entry.move.label,
                "unavailableBecause": cell.unavailable_because,
            }
            for cell in result.utility_map()
        ],
        "moves": [_move_summary(entry, catalog) for entry in result.moves],
        "topMoves": [_move_summary(entry, catalog) for entry in result.top_moves],
        "combined": _combined_summary(result.combined, catalog),
        "warnings": list(result.warnings),
    }


def _base_formation(
    allocation: Allocation, config: FormationConfig, catalog: Catalog
) -> dict[str, Any]:
    """基点編成の写し。ギアは配分側から出す（どちらを評価したのかを1つに決める）。"""
    return {
        "units": [
            {
                "slotIndex": index,
                "unitDefinitionId": unit.unit_definition_id,
                "displayName": _display_name(catalog, unit.unit_definition_id),
                "row": spec.position.row,
                "column": spec.position.column,
                "level": spec.level,
                "gears": [piece.label for piece in unit.pieces],
            }
            for index, (unit, spec) in enumerate(
                zip(allocation.units, config.ally.units, strict=True)
            )
        ],
        "memoryDefinitionIds": list(config.ally.memory_definition_ids),
        "enemyUnitDefinitionId": config.enemy.unit_definition_id,
    }


def _move_summary(entry: MoveEntry, catalog: Catalog) -> dict[str, Any]:
    return {
        "slotIndex": entry.move.slot_index,
        "unitDefinitionId": entry.move.unit_definition_id,
        "displayName": _display_name(catalog, entry.move.unit_definition_id),
        "kind": entry.move.kind,
        "label": entry.move.label,
        "gainedStat": entry.move.gained_stat(),
        "deepestStage": entry.deepest_stage,
        "screen": _difference(entry.screen),
        "confirm": _difference(entry.confirm),
        "verify": _difference(entry.verify),
    }


def _combined_summary(combined: CombinedResult | None, catalog: Catalog) -> dict[str, Any] | None:
    if combined is None:
        return None
    return {
        "applied": [
            {
                "slotIndex": move.slot_index,
                "unitDefinitionId": move.unit_definition_id,
                "displayName": _display_name(catalog, move.unit_definition_id),
                "label": move.label,
            }
            for move in combined.applied
        ],
        # 重ねられなかった手。「k手を適用した」という報告が実際と食い違わないよう残す。
        "skipped": [
            {"unitDefinitionId": move.unit_definition_id, "label": move.label}
            for move in combined.skipped
        ],
        "allocation": [
            {
                "slotIndex": index,
                "unitDefinitionId": unit.unit_definition_id,
                "gears": [piece.label for piece in unit.pieces],
            }
            for index, unit in enumerate(combined.allocation.units)
        ],
        "verify": _difference(combined.difference),
    }


def _difference(diff: PairedDiff | None) -> dict[str, Any] | None:
    if diff is None:
        return None
    return {
        "runs": diff.count,
        "meanDiff": diff.mean_diff,
        "meanCiLow": diff.mean_ci_low,
        "meanCiHigh": diff.mean_ci_high,
        "meanSignificant": diff.mean_significant,
        "expectedBestDiff": diff.expected_best_diff,
        "expectedBestCiLow": diff.expected_best_ci_low,
        "expectedBestCiHigh": diff.expected_best_ci_high,
        "expectedBestSignificant": diff.expected_best_significant,
        "guardDiff": diff.guard_diff,
        "fitnessDiff": diff.fitness_diff,
        "baseMean": diff.base_mean,
        "defeatRate": diff.defeat_rate,
        "baseDefeatRate": diff.base_defeat_rate,
    }


def write_moves_csv(result: SensitivityResult, path: Path) -> None:
    """手ごとの生値。後から pandas で横断分析するための正本。

    列は固定である。篩いまでしか進まなかった手は確定・確認走の列が空になり、深さの
    違いが表から読める。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(MOVE_CSV_COLUMNS), lineterminator="\n")
        writer.writeheader()
        writer.writerows(_move_row(entry) for entry in result.moves)


def _move_row(entry: MoveEntry) -> dict[str, Any]:
    row: dict[str, Any] = {
        "slot_index": entry.move.slot_index,
        "unit_definition_id": entry.move.unit_definition_id,
        "kind": entry.move.kind,
        "removed": "" if entry.move.removed is None else entry.move.removed.label,
        "added": "" if entry.move.added is None else entry.move.added.label,
        "gained_stat": entry.move.gained_stat() or "",
        "deepest_stage": entry.deepest_stage,
    }
    row.update(_screen_columns(entry.screen))
    for stage, diff in (("confirm", entry.confirm), ("verify", entry.verify)):
        row.update(_deep_columns(stage, diff))
    return row


def _screen_columns(diff: PairedDiff) -> dict[str, Any]:
    return {
        "screen_runs": diff.count,
        "screen_mean_diff": diff.mean_diff,
        "screen_mean_ci_low": diff.mean_ci_low,
        "screen_mean_ci_high": diff.mean_ci_high,
        "screen_defeat_rate": diff.defeat_rate,
    }


def _deep_columns(stage: str, diff: PairedDiff | None) -> dict[str, Any]:
    if diff is None:
        return {
            f"{stage}_{name}": ""
            for name in (
                "runs",
                "expected_best_diff",
                "expected_best_ci_low",
                "expected_best_ci_high",
                "guard_diff",
                "fitness_diff",
                "defeat_rate",
            )
        }
    return {
        f"{stage}_runs": diff.count,
        f"{stage}_expected_best_diff": diff.expected_best_diff,
        f"{stage}_expected_best_ci_low": diff.expected_best_ci_low,
        f"{stage}_expected_best_ci_high": diff.expected_best_ci_high,
        f"{stage}_guard_diff": diff.guard_diff,
        f"{stage}_fitness_diff": diff.fitness_diff,
        f"{stage}_defeat_rate": diff.defeat_rate,
    }


def _display_name(catalog: Catalog, unit_definition_id: str) -> str:
    unit = catalog.unit(unit_definition_id)
    return unit.display_name if unit is not None else unit_definition_id


def move_text(move: Move) -> str:
    """コンソール用の手の表記。ステータスIDは長すぎて表の列に収まらない。

    JSON・CSVの `label` はIDのまま残す（機械可読の側は表示都合で変えない）。
    """
    if move.kind == "move":
        return (
            f"{STAT_LABELS[move.removed.stat]} {move.removed.rank.label}"
            f" → {STAT_LABELS[move.added.stat]}"
        )
    if move.kind == "add":
        return f"{STAT_LABELS[move.added.stat]} {move.added.rank.label} を追加"
    if move.kind == "remove":
        return f"{STAT_LABELS[move.removed.stat]} {move.removed.rank.label} を外す"
    return f"{STAT_LABELS[move.removed.stat]} {move.removed.rank.label} → {move.added.rank.label}"


def utility_rows(result: SensitivityResult, catalog: Catalog) -> list[tuple[str, list[str]]]:
    """限界効用マップをコンソール表の行へ直す。値の表記規則をここへ集約する。

    - `(+120)` — 信頼区間が0を跨いだ手。「効果ゼロ」ではなく「この試行数では見えない」。
    - `上限3枚` — そのステータスが既に上限で、積む手が存在しない。
    - `-` — 上限ではないが積む手が無い（9枠が埋まっていて動かせる駒が無い等）。
    """
    cells = result.utility_map()
    rows: list[tuple[str, list[str]]] = []
    for slot_index, unit in enumerate(result.base_allocation.units):
        values: list[str] = []
        for stat in SEARCHED_STATS:
            cell = next(
                entry for entry in cells if entry.slot_index == slot_index and entry.stat == stat
            )
            values.append(_cell_text(cell))
        rows.append((f"{slot_index}: {_display_name(catalog, unit.unit_definition_id)}", values))
    return rows


def _cell_text(cell: Any) -> str:
    if cell.entry is None:
        return cell.unavailable_because or "-"
    value = cell.entry.deepest.expected_best_diff
    text = f"{value:+,.0f}"
    return text if cell.entry.deepest.expected_best_significant else f"({text})"


# --- 理論値探索（`lab gear-plan`）のレポート ---------------------------------

PLAN_CAVEAT = (
    "この配分は基点編成に固有である。ユニット・配置・メモリー・レベル・学園レベルの"
    "いずれかを変えるとレジームが変わり、最適なギア配分も変わる"
)

RANGE_CAVEAT = (
    "枝の順位は探索が使ったのと同じ乱数範囲で付けている。別の乱数範囲での確定"
    "（最終選抜）はこのコマンドの担当ではない"
)

PRICE_CAVEAT = (
    "単価はランク微調整で測った枠のぶんだけである（境界に関わらない枠は測っていない）。"
    "1段のΔは測った時点の配分に依存し、段どうしを足し合わせられない"
)


def build_plan_summary(
    result: PlanResult,
    *,
    config: FormationConfig,
    catalog: Catalog,
    settings: PlanSettings,
    objective: Objective,
    seed: str,
    catalog_revision: str,
    budget: Mapping[str, int],
    budget_runs: int,
    observations: int,
) -> dict[str, Any]:
    return {
        "seed": seed,
        "catalogRevision": catalog_revision,
        "caveat": PLAN_CAVEAT,
        "rankingCaveat": RANGE_CAVEAT,
        "baseFormation": _base_formation(result.start, config, catalog),
        "settings": {
            "screenRuns": settings.climb.screen_runs,
            "confirmRuns": settings.climb.confirm_runs,
            "survivors": settings.climb.survivors,
            "maxIterations": settings.climb.max_iterations,
            "includeRank": settings.climb.include_rank,
            "restarts": settings.restarts,
            "pushSteps": settings.push_steps,
            "rankSteps": settings.rank.steps,
        },
        "objective": {
            "bestOf": objective.best_of,
            "lambda": objective.expected_weight,
            "guardQuantile": objective.guard_quantile,
        },
        "budgetRuns": budget_runs,
        "plannedRuns": dict(budget),
        "consumedRuns": result.consumed_runs,
        "observationRuns": observations,
        "baseSignature": result.base_signature.to_dict(),
        "signatures": [
            {
                "origin": entry.origin,
                "digest": entry.signature.digest(),
                "allocation": _allocation_summary(entry.allocation, catalog),
                **entry.signature.to_dict(),
            }
            for entry in result.signatures
        ],
        "baseClimb": _climb_summary(result.base_climb, catalog),
        "restarts": [_restart_summary(attempt, catalog) for attempt in result.restarts],
        "rankTuning": _rank_tuning_summary(result.rank_tuning, catalog),
        "priceCaveat": PRICE_CAVEAT,
        "best": _allocation_summary(result.best, catalog),
        "ranking": [
            {"allocation": _allocation_summary(allocation, catalog), "fitness": fitness}
            for allocation, fitness in result.ranking
        ],
        "warnings": list(result.warnings),
    }


def _rank_tuning_summary(
    tuning: RankTuningResult | None, catalog: Catalog
) -> dict[str, Any] | None:
    """Phase D の結果。回さなかった実行では `null`（`--rank-steps 0`・効果表なし）。"""
    if tuning is None:
        return None
    return {
        "stoppedBecause": tuning.stopped_because,
        "start": _allocation_summary(tuning.start, catalog),
        "best": _allocation_summary(tuning.best, catalog),
        "bestGain": tuning.best_gain,
        "targets": [
            {
                "slotIndex": target.slot_index,
                "unitDefinitionId": tuning.start.units[target.slot_index].unit_definition_id,
                "displayName": _display_name(
                    catalog, tuning.start.units[target.slot_index].unit_definition_id
                ),
                "stat": target.stat,
                # そう判断した根拠。観測のあいだに当て先が動いた成分の名前である。
                "components": list(target.components),
            }
            for target in tuning.targets
        ],
        "walks": [_walk_summary(walk, catalog) for walk in tuning.walks],
        "prices": [
            {
                "stepIndex": price.step_index,
                "slotIndex": price.slot_index,
                "unitDefinitionId": price.unit_definition_id,
                "displayName": _display_name(catalog, price.unit_definition_id),
                "stat": price.stat,
                "step": price.rank_step.label,
                "pointsDelta": price.rank_step.points_delta,
                "expectedBestDelta": price.expected_best_delta,
                "fitnessDelta": price.fitness_delta,
                "runs": price.runs,
            }
            for price in tuning.prices
        ],
        "signatures": [
            {
                "digest": entry.digest,
                "fitness": entry.fitness,
                "move": None if entry.move is None else entry.move.label,
                "allocation": _allocation_summary(entry.allocation, catalog),
                **entry.signature.to_dict(),
            }
            for entry in tuning.signatures
        ],
        "warnings": list(tuning.warnings),
    }


def _walk_summary(walk: RankWalk, catalog: Catalog) -> dict[str, Any]:
    return {
        "slotIndex": walk.target.slot_index,
        "stat": walk.target.stat,
        "stoppedBecause": walk.stopped_because,
        "stops": [
            {
                "step": stop.step,
                "unitDefinitionId": stop.move.unit_definition_id,
                "displayName": _display_name(catalog, stop.move.unit_definition_id),
                "move": stop.move.label,
                "digest": stop.signature.digest(),
                "changed": stop.changed,
                "fitnessGain": stop.fitness_gain,
                "expectedBestGain": stop.expected_best_gain,
            }
            for stop in walk.stops
        ],
    }


def _climb_summary(climb: ClimbResult, catalog: Catalog) -> dict[str, Any]:
    return {
        "start": _allocation_summary(climb.start, catalog),
        "best": _allocation_summary(climb.best, catalog),
        "stoppedBecause": climb.stopped_because,
        "steps": [
            {
                "iteration": step.iteration,
                "unitDefinitionId": step.move.unit_definition_id,
                "displayName": _display_name(catalog, step.move.unit_definition_id),
                "slotIndex": step.move.slot_index,
                "move": step.move.label,
                "fitnessGain": step.fitness_gain,
                "damageGain": step.damage_gain,
                "scoreGain": step.score_gain,
            }
            for step in climb.steps
        ],
        # 自ユニット与ダメが伸びていないのに総スコアが伸びた手。レジーム変更の疑い。
        "regimeCandidates": [
            {
                "iteration": candidate.iteration,
                "unitDefinitionId": candidate.move.unit_definition_id,
                "slotIndex": candidate.move.slot_index,
                "move": candidate.move.label,
                "damageGain": candidate.damage_gain,
                "scoreGain": candidate.score_gain,
            }
            for candidate in climb.regime_candidates
        ],
    }


def _restart_summary(attempt: RestartAttempt, catalog: Catalog) -> dict[str, Any]:
    return {
        "index": attempt.index,
        "component": attempt.component,
        "direction": attempt.direction,
        "slotIndex": attempt.slot_index,
        "pushedMoves": [move.label for move in attempt.moves],
        "changed": attempt.changed,
        "stoppedBecause": attempt.stopped_because,
        "signature": None if attempt.signature is None else attempt.signature.to_dict(),
        "climb": None if attempt.climb is None else _climb_summary(attempt.climb, catalog),
    }


def _allocation_summary(allocation: Allocation, catalog: Catalog) -> list[dict[str, Any]]:
    return [
        {
            "slotIndex": index,
            "unitDefinitionId": unit.unit_definition_id,
            "displayName": _display_name(catalog, unit.unit_definition_id),
            "gears": [piece.label for piece in unit.pieces],
            "counts": {stat: unit.count(stat) for stat in SEARCHED_STATS},
        }
        for index, unit in enumerate(allocation.units)
    ]


def rank_price_rows(tuning: RankTuningResult, catalog: Catalog) -> list[list[str]]:
    """単価表をコンソール表の行へ直す。**上げる向き**で読む。"""
    return [
        [
            f"{price.slot_index}: {_display_name(catalog, price.unit_definition_id)}",
            STAT_LABELS.get(price.stat, price.stat),
            price.rank_step.label,
            f"{price.rank_step.points_delta:+.2f}pt",
            f"{price.expected_best_delta:+,.0f}",
            str(price.step_index),
        ]
        for price in tuning.prices
    ]


def allocation_rows(
    allocation: Allocation, start: Allocation, catalog: Catalog
) -> list[tuple[str, list[str]]]:
    """配分をコンソール表の行へ直す。基点からの増減を添える。"""
    rows: list[tuple[str, list[str]]] = []
    for index, unit in enumerate(allocation.units):
        before = start.units[index]
        values = []
        for stat in SEARCHED_STATS:
            count = unit.count(stat)
            delta = count - before.count(stat)
            values.append(f"{count}" if delta == 0 else f"{count} ({delta:+d})")
        rows.append((f"{index}: {_display_name(catalog, unit.unit_definition_id)}", values))
    return rows
