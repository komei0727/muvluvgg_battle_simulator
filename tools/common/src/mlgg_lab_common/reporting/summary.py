"""ケース別の記述統計。

- ケースごとに出す。異なる相手・条件のケースを合算しない。
- 対象は完了した固有試行だけ（1試行1件）。未完了・通信失敗・実行エラーは標本に入れず、
  件数だけを別に示す。敗北・引き分け・スコア0へ読み替えない。
- 完了0件のケースは `statistics: null`（表示は「集計対象なし」）。平均・比率を0で埋めない。
- 標本数・対象ケース（対戦条件）・実行環境を必ず添える。
"""

from __future__ import annotations

from typing import Any

from ..statistics.summary import category_counts
from .analyzer import FormatAnalyzer
from .snapshot import EvaluationSnapshot
from .status import environment_json, evaluation_status

# `summarize_evaluation` が返す構造の版。キーの意味を変えたら上げる。
SUMMARY_FORMAT_VERSION = 1

COMMON_DEFINITIONS = {
    "sampleSize": "完了した固有試行の数。同じ試行の再送・重複応答は1件として数える",
    "pendingTrials": (
        "計画したが結果の無い試行の数（未送信・未完了・通信失敗・実行エラー）。統計に含めない"
    ),
    "completionReasons": "終了理由ごとの件数と比率。比率の分母は sampleSize",
    "quantiles": "分位点は線形補間（numpy.percentile の既定と同じ）。p05/p25/p75/p95",
    "stdev": "不偏標準偏差（n-1）。標本1件では null",
}


def summarize_evaluation(
    snapshot: EvaluationSnapshot,
    analyzer: FormatAnalyzer,
    *,
    case_ids: list[str] | None = None,
) -> dict[str, Any]:
    plan = snapshot.plan
    if analyzer.format != plan.contract.format:
        raise ValueError(
            f"{plan.evaluation_id} は {plan.contract.format} の評価実行で、"
            f"{analyzer.format} の集計では読めない"
        )
    status = evaluation_status(snapshot)
    cases = []
    for case in snapshot.select_cases(case_ids):
        observations = [result.observation for result in snapshot.results_of(case.case_id)]
        sample = len(observations)
        cases.append(
            {
                "caseId": case.case_id,
                "matchFingerprint": case.match_fingerprint,
                "match": analyzer.describe_match(case.match_request),
                "plannedTrials": len(case.run_indices),
                "sampleSize": sample,
                "pendingTrials": len(case.run_indices) - sample,
                "completionReasons": None
                if sample == 0
                else category_counts(
                    [o.get("completionReason") for o in observations],
                    analyzer.completion_reasons,
                ),
                "statistics": None if sample == 0 else analyzer.case_statistics(observations),
            }
        )
    return {
        "summaryFormatVersion": SUMMARY_FORMAT_VERSION,
        "statisticsVersion": analyzer.statistics_version,
        "evaluationId": plan.evaluation_id,
        "format": plan.contract.format,
        "contractId": plan.contract.contract_id,
        "seed": plan.seed,
        "environment": environment_json(snapshot),
        "counters": status["counters"],
        "lastSession": status["lastSession"],
        "cases": cases,
        "definitions": {**COMMON_DEFINITIONS, **analyzer.definitions},
    }
