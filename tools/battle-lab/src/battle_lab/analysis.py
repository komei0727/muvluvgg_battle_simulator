"""通常戦闘の記述統計。保存済みの観測値（`BattleRun`）だけから計算する。

- 勝敗（`ALLY_WIN` / `ALLY_LOSE`）の件数・比率。通常戦闘に引き分けは無い。
- 完了ターンの要約（平均・中央値・分位点・最小・最大）と、ターンごとの件数の分布。

勝率から候補の順位・採否を決めない（それは探索段階の目的関数の役割）。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from mlgg_lab_common.reporting import CsvColumn, FormatAnalyzer
from mlgg_lab_common.reporting.text import (
    describe_formation,
    format_frequency,
    format_numeric,
    format_ratios,
)
from mlgg_lab_common.statistics.summary import category_counts, frequency, numeric_summary

OUTCOMES = ("ALLY_WIN", "ALLY_LOSE")
COMPLETION_REASONS = (
    "ENEMY_DEFEATED",
    "ALLY_DEFEATED",
    "SIMULTANEOUS_DEFEAT",
    "TURN_LIMIT_REACHED",
)


def case_statistics(observations: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    turns = [int(o["completedTurn"]) for o in observations]
    return {
        "outcomes": category_counts([o["outcome"] for o in observations], OUTCOMES),
        "completedTurn": {
            "summary": numeric_summary(turns).to_dict(),
            "distribution": frequency(turns),
        },
    }


def describe_statistics(statistics: Mapping[str, Any]) -> list[str]:
    turn = statistics["completedTurn"]
    return [
        "勝敗: " + format_ratios(statistics["outcomes"]),
        "完了ターン: " + format_numeric(turn["summary"]),
        "完了ターンの分布: " + format_frequency(turn["distribution"]),
    ]


def describe_match(match: Mapping[str, Any]) -> str:
    return (
        f"味方 {describe_formation(match['allyFormation'])} vs "
        f"敵 {describe_formation(match['enemyFormation'])} / 規定 {match['turnLimit']} ターン"
    )


ANALYZER = FormatAnalyzer(
    format="BATTLE",
    statistics_version=1,
    completion_reasons=COMPLETION_REASONS,
    case_statistics=case_statistics,
    describe_statistics=describe_statistics,
    describe_match=describe_match,
    csv_columns=(CsvColumn("outcome", lambda o: o.get("outcome"), "勝敗（ALLY_WIN / ALLY_LOSE）"),),
    definitions={
        "outcomes": "勝敗ごとの件数と比率。分母は完了した固有試行数",
        "completedTurn.summary": "完了ターンの要約統計",
        "completedTurn.distribution": "完了ターンごとの件数と比率（ターンの昇順）",
    },
)
