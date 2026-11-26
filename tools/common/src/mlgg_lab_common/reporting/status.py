"""評価実行の進捗。計画・送信・完了・未完了を分けて数え、停止理由を添える。"""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..evaluation.budget import remaining_runs
from .snapshot import EvaluationSnapshot

# 停止理由がまだ無い実行の状態。停止理由の無さだけで中断と決めず、実行のロックで見分ける。
# RUNNING: 別の実行がいま実行している。resume すると拒否される（二重に実行しない）。
# INTERRUPTED: 実行していたプロセスが居ない（落ちた・強制終了した）。resume で続けられる。
# UNKNOWN: ロックを確かめられなかった。
RUNNING = "RUNNING"
INTERRUPTED = "INTERRUPTED"
UNKNOWN = "UNKNOWN"


def _unfinished_state(running: bool | None) -> str:
    if running is None:
        return UNKNOWN
    return RUNNING if running else INTERRUPTED


def evaluation_status(snapshot: EvaluationSnapshot) -> dict[str, Any]:
    plan = snapshot.plan
    counters = snapshot.counters
    last = snapshot.sessions[-1] if snapshot.sessions else None
    return {
        "evaluationId": plan.evaluation_id,
        "format": plan.contract.format,
        "contractId": plan.contract.contract_id,
        "seed": plan.seed,
        "createdAt": plan.created_at,
        "environment": environment_json(snapshot),
        "counters": {
            "plannedRuns": counters.planned_runs,
            # 再送・部分応答で未完了だった分を含む。完了数とは別に数える。
            "submittedRuns": counters.submitted_runs,
            "completedTrials": counters.completed_trials,
            "pendingTrials": counters.planned_runs - counters.completed_trials,
            "attempts": counters.attempts,
        },
        "budget": {
            "maxSubmittedRuns": plan.budget.max_submitted_runs,
            "remainingRuns": remaining_runs(plan.budget.max_submitted_runs, counters),
        },
        "attemptsByStatus": dict(sorted(Counter(a.status for a in snapshot.attempts).items())),
        # 通信失敗・実行エラー等。観測結果（敗北・引き分け）とは別に数える。
        "failuresByKind": dict(
            sorted(Counter(a.failure_kind for a in snapshot.attempts if a.failure_kind).items())
        ),
        "running": snapshot.running,
        "sessions": len(snapshot.sessions),
        "lastSession": None
        if last is None
        else {
            "sessionId": last.session_id,
            "startedAt": last.started_at,
            "finishedAt": last.finished_at,
            "stopReason": last.stop_reason or _unfinished_state(snapshot.running),
            "detail": last.detail,
        },
        "cases": [
            {
                "caseId": case.case_id,
                "plannedTrials": len(case.run_indices),
                "completedTrials": len(snapshot.results_of(case.case_id)),
                "pendingTrials": len(snapshot.pending_run_indices(case)),
            }
            for case in plan.cases
        ],
    }


def environment_json(snapshot: EvaluationSnapshot) -> dict[str, str] | None:
    environment = snapshot.environment
    if environment is None:
        return None
    return {
        "catalogRevision": environment.catalog_revision,
        "engineRevision": environment.engine_revision,
        "seedDerivationVersion": environment.seed_derivation_version,
        "contractId": environment.contract_id,
    }
