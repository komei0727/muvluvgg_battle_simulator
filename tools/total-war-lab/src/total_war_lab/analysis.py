"""総力戦の記述統計。保存済みの観測値（`TotalWarRun`）だけから計算する。

総力戦は勝ち抜き戦全体を1試行とする。編成どうしの対戦（`stages`）を独立した試行として
数えない——比率の分母はいつも完了した試行（勝ち抜き戦）の数である。

- 勝敗・引き分け（`ALLY_WIN` / `ALLY_LOSE` / `DRAW`）の件数・比率。引き分けを勝敗へ換算しない。
- 撃破した／された編成数の分布（`defeatedFormationCounts`）。
- 編成対戦の数の分布と、各対戦（味方編成番号×敵編成番号）が現れた試行数。
- 参加枠ごとの出撃した試行数（`deployed`）と再登場枠かどうか（`reappearance`）。
- 完了ターンの要約と分布。
"""

from __future__ import annotations

from collections import Counter
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

OUTCOMES = ("ALLY_WIN", "ALLY_LOSE", "DRAW")
COMPLETION_REASONS = (
    "ENEMY_DEFEATED",
    "ALLY_DEFEATED",
    "SIMULTANEOUS_DEFEAT",
    "TURN_LIMIT_REACHED",
)


def case_statistics(observations: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    trials = len(observations)
    turns = [int(o["completedTurn"]) for o in observations]
    pairings: Counter[tuple[int, int]] = Counter()
    for o in observations:
        # 1試行の中で同じ組み合わせが2度現れても1と数える（試行あたりの出現）。
        pairings.update(
            {(s["allyFormationNumber"], s["enemyFormationNumber"]) for s in o["stages"]}
        )
    slots: dict[tuple[str, int, int], dict[str, Any]] = {}
    for o in observations:
        for unit in o["units"]:
            key = (unit["side"], unit["formationNumber"], unit["unitIndex"])
            entry = slots.setdefault(
                key,
                {
                    "side": unit["side"],
                    "formationNumber": unit["formationNumber"],
                    "unitIndex": unit["unitIndex"],
                    "unitDefinitionId": unit["unitDefinitionId"],
                    "reappearance": unit["reappearance"],
                    "deployedTrials": 0,
                },
            )
            entry["deployedTrials"] += 1 if unit["deployed"] else 0
    side_order = {"ALLY": 0, "ENEMY": 1}
    deployment = [
        {**entry, "deployedRatio": entry["deployedTrials"] / trials}
        for _, entry in sorted(slots.items(), key=lambda kv: (side_order[kv[0][0]], *kv[0][1:]))
    ]
    return {
        "outcomes": category_counts([o["outcome"] for o in observations], OUTCOMES),
        "defeatedFormations": {
            "enemy": frequency([o["defeatedFormationCounts"]["enemy"] for o in observations]),
            "ally": frequency([o["defeatedFormationCounts"]["ally"] for o in observations]),
        },
        "stageCount": frequency([len(o["stages"]) for o in observations]),
        "pairings": [
            {
                "allyFormationNumber": ally,
                "enemyFormationNumber": enemy,
                "trials": count,
                "ratio": count / trials,
            }
            for (ally, enemy), count in sorted(pairings.items())
        ],
        "deployment": deployment,
        "completedTurn": {
            "summary": numeric_summary(turns).to_dict(),
            "distribution": frequency(turns),
        },
    }


def describe_statistics(statistics: Mapping[str, Any]) -> list[str]:
    turn = statistics["completedTurn"]
    defeated = statistics["defeatedFormations"]
    lines = [
        "勝敗・引き分け: " + format_ratios(statistics["outcomes"]),
        "撃破した敵編成数: " + format_frequency(defeated["enemy"]),
        "撃破された味方編成数: " + format_frequency(defeated["ally"]),
        "編成対戦の数: " + format_frequency(statistics["stageCount"]),
        "編成対戦（味方-敵、現れた試行数）: "
        + ", ".join(
            f"{p['allyFormationNumber']}-{p['enemyFormationNumber']}"
            f" {p['trials']} ({p['ratio']:.1%})"
            for p in statistics["pairings"]
        ),
        "完了ターン: " + format_numeric(turn["summary"]),
        "出撃状況（出撃した試行数）:",
    ]
    lines += [
        f"  {d['side']} 編成{d['formationNumber']} 枠{d['unitIndex']} {d['unitDefinitionId']}"
        f"{'（再登場）' if d['reappearance'] else ''}:"
        f" {d['deployedTrials']} ({d['deployedRatio']:.1%})"
        for d in statistics["deployment"]
    ]
    return lines


def describe_match(match: Mapping[str, Any]) -> str:
    ally = " → ".join(describe_formation(f) for f in match["allyFormations"])
    enemy = " → ".join(describe_formation(f) for f in match["enemyFormations"])
    return f"味方 {ally} vs 敵 {enemy}"


ANALYZER = FormatAnalyzer(
    format="TOTAL_WAR",
    statistics_version=1,
    completion_reasons=COMPLETION_REASONS,
    case_statistics=case_statistics,
    describe_statistics=describe_statistics,
    describe_match=describe_match,
    csv_columns=(
        CsvColumn(
            "outcome", lambda o: o.get("outcome"), "勝敗・引き分け（ALLY_WIN / ALLY_LOSE / DRAW）"
        ),
        CsvColumn(
            "enemy_defeated_formations",
            lambda o: (o.get("defeatedFormationCounts") or {}).get("enemy"),
            "撃破した敵編成数",
        ),
        CsvColumn(
            "ally_defeated_formations",
            lambda o: (o.get("defeatedFormationCounts") or {}).get("ally"),
            "撃破された味方編成数",
        ),
        CsvColumn(
            "stage_count",
            lambda o: None if o.get("stages") is None else len(o["stages"]),
            "編成対戦の数（stages の件数）",
        ),
    ),
    definitions={
        "outcomes": "勝敗・引き分けごとの件数と比率。引き分けは独立した結果で、勝敗へ換算しない",
        "defeatedFormations": "撃破した敵編成数（enemy）／撃破された味方編成数（ally）ごとの試行数",
        "stageCount": "1試行（勝ち抜き戦全体）に含まれる編成対戦の数の分布",
        "pairings": "味方編成番号×敵編成番号の対戦が現れた試行数。分母は試行数（対戦数ではない）",
        "deployment": "参加枠ごとの出撃した試行数と比率。reappearance は再登場枠かどうか",
        "completedTurn.summary": "完了ターン（勝ち抜き戦全体の通しターン）の要約統計",
    },
)
