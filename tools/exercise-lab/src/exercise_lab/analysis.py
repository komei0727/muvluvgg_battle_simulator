"""戦術演習の記述統計。保存済みの観測値（`ExerciseRun`）だけから計算する。

- スコア（`totalScore`）の要約（平均・中央値・分位点・最小・最大）。
- ブレイク回数の要約と、回数ごとの件数の分布。
- 終了理由（規定ターン到達／味方全滅）は共通の内訳で示す。勝敗へは読み替えない。

UIの統計表示（日次ベスト等の `exercise_lab.statistics`）とは別物で、指定挑戦回数での
最高値の期待値のような目的関数はここに組み込まない。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from mlgg_lab_common.reporting import CsvColumn, FormatAnalyzer
from mlgg_lab_common.reporting.text import describe_formation, format_frequency, format_numeric
from mlgg_lab_common.statistics.summary import frequency, numeric_summary

COMPLETION_REASONS = ("TURN_LIMIT_REACHED", "ALLY_DEFEATED")


def case_statistics(observations: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    breaks = [int(o["breakCount"]) for o in observations]
    return {
        "totalScore": numeric_summary([int(o["totalScore"]) for o in observations]).to_dict(),
        "breakCount": {
            "summary": numeric_summary(breaks).to_dict(),
            "distribution": frequency(breaks),
        },
    }


def describe_statistics(statistics: Mapping[str, Any]) -> list[str]:
    return [
        "スコア: " + format_numeric(statistics["totalScore"], digits=0),
        "ブレイク回数: " + format_numeric(statistics["breakCount"]["summary"]),
        "ブレイク回数の分布: " + format_frequency(statistics["breakCount"]["distribution"]),
    ]


def describe_match(match: Mapping[str, Any]) -> str:
    return (
        f"味方 {describe_formation(match['allyFormation'])} vs "
        f"演習対象 {describe_formation(match['enemyFormation'])}"
    )


ANALYZER = FormatAnalyzer(
    format="TACTICAL_EXERCISE",
    statistics_version=1,
    completion_reasons=COMPLETION_REASONS,
    case_statistics=case_statistics,
    describe_statistics=describe_statistics,
    describe_match=describe_match,
    csv_columns=(
        CsvColumn("total_score", lambda o: o.get("totalScore"), "スコア（totalScore）"),
        CsvColumn("break_count", lambda o: o.get("breakCount"), "ブレイク回数（breakCount）"),
    ),
    definitions={
        "totalScore": "スコアの要約統計",
        "breakCount.summary": "ブレイク回数の要約統計",
        "breakCount.distribution": "ブレイク回数ごとの件数と比率（回数の昇順）",
    },
)
