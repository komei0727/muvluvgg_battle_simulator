"""送信試行数の予算。

計画した試行数・送信した試行数（再送を含む）・完了した固有の試行数を分けて数える。
応答を失った要求はサーバーで何回実行されたか分からないが、送信した分は必ず送信数へ
入れ、完了数とは混同しない。予算は送信前に確保する（確保した要求を保存してから送る）ので、
送信直後に中断しても上限を超えない。
"""

from __future__ import annotations

from dataclasses import dataclass


class BudgetExhaustedError(Exception):
    """送信予算の残りが要求の試行数に足りない。"""


@dataclass(frozen=True)
class Counters:
    planned_runs: int
    # 送信した（送信を確保した）試行数の合計。同じ試行の再送も1回ずつ数える。
    submitted_runs: int
    # 結果を保存した固有の試行数。
    completed_trials: int
    attempts: int


def remaining_runs(max_submitted_runs: int, counters: Counters) -> int:
    return max(0, max_submitted_runs - counters.submitted_runs)
