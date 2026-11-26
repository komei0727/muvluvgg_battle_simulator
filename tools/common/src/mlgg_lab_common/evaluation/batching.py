"""要求の分割。

結果の無い試行を、計画のケース順・試行番号の昇順のまま、要求あたりのケース数・総試行数の
上限に収まるよう詰める。1つのケースの試行番号は複数の要求に分かれてよいが、1つの要求の中で
同じケースを2回並べない（`caseId` は要求内で一意でなければならない）。

分割は送る束を決めるだけで、seed・試行番号は変えない。乱数列は `(seed, runIndex)` だけで
決まるので、分け方を変えても同じ試行は同じ結果になる。
"""

from __future__ import annotations

from collections.abc import Sequence

Batch = list[tuple[str, tuple[int, ...]]]


def split_pending(
    pending: Sequence[tuple[str, int]], *, max_cases: int, max_runs: int
) -> list[Batch]:
    if max_cases < 1 or max_runs < 1:
        raise ValueError("要求あたりの上限は1以上")
    grouped: list[tuple[str, list[int]]] = []
    for case_id, run_index in pending:
        if grouped and grouped[-1][0] == case_id:
            grouped[-1][1].append(run_index)
        else:
            grouped.append((case_id, [run_index]))

    batches: list[Batch] = []
    current: Batch = []
    runs = 0
    for case_id, indices in grouped:
        while indices:
            if len(current) == max_cases or runs == max_runs:
                batches.append(current)
                current, runs = [], 0
            taken = indices[: max_runs - runs]
            indices = indices[len(taken) :]
            current.append((case_id, tuple(taken)))
            runs += len(taken)
    if current:
        batches.append(current)
    return batches
