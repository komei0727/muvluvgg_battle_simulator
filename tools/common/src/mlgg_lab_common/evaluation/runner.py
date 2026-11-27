"""評価の実行と再開。

    保存済み計画 → 結果の無い試行を抽出 → 上限・予算に合わせて次の要求を作る
      → 予算を確保して要求を保存 → 送信 → 応答を検証・保存 → 繰り返す

再開は同じ関数をもう一度呼ぶだけでよい。状態の正本はDBにあり、元の編成YAML・育成JSONは
読み直さない。前回の実行が送信中のまま終わった要求は放棄扱いにし（送信数には残す）、
結果の無い試行だけを同じseed・試行番号で送り直す。

どこで止まっても、止まった理由（`StopReason`）を返してDBの実行履歴にも残す。

- 再送できる失敗（通信断・混雑）は `max_retries` 回まで続けて再送する（間隔は倍々）。
- 入力不正・実行ガード・応答不整合・実行環境の不一致・結果の衝突は記録して止まる。
- 1件も完了しない応答が `max_consecutive_no_progress` 回続いたら止まる。
- 送信予算が尽きたら止まる。どの経路も有限回で終わる。

通信失敗・未完了・実行エラーは結果として保存しない（敗北・引き分け・スコア0へ変換しない）。
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

from ..api.client import EvaluationTransport, FailureKind, classify_exchange
from ..api.contracts import EvaluationRequest, RequestCase, ResponseContractError, validate_response
from ..storage.repository import (
    EnvironmentMismatchError,
    EvaluationBusyError,
    EvaluationRepository,
    ResultConflictError,
)
from .batching import split_pending
from .budget import BudgetExhaustedError, Counters, remaining_runs
from .models import EvaluationPlan


class StopReason(StrEnum):
    COMPLETED = "COMPLETED"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    REQUEST_LIMIT_REACHED = "REQUEST_LIMIT_REACHED"
    RETRY_LIMIT_REACHED = "RETRY_LIMIT_REACHED"
    NO_PROGRESS_LIMIT_REACHED = "NO_PROGRESS_LIMIT_REACHED"
    INVALID_INPUT = "INVALID_INPUT"
    EXECUTION_ERROR = "EXECUTION_ERROR"
    RESPONSE_INVALID = "RESPONSE_INVALID"
    ENVIRONMENT_MISMATCH = "ENVIRONMENT_MISMATCH"
    RESULT_CONFLICT = "RESULT_CONFLICT"
    UNAUTHORIZED = "UNAUTHORIZED"
    ENDPOINT_UNAVAILABLE = "ENDPOINT_UNAVAILABLE"


_STOP_ON_FAILURE = {
    FailureKind.INVALID_INPUT: StopReason.INVALID_INPUT,
    FailureKind.ENVIRONMENT_MISMATCH: StopReason.ENVIRONMENT_MISMATCH,
    FailureKind.EXECUTION_ERROR: StopReason.EXECUTION_ERROR,
    FailureKind.UNAUTHORIZED: StopReason.UNAUTHORIZED,
    FailureKind.ENDPOINT_UNAVAILABLE: StopReason.ENDPOINT_UNAVAILABLE,
}


@dataclass(frozen=True)
class RequestProgress:
    """要求1回を終えた時点の状況。実行中の表示に使う（保存はしない）。"""

    # この実行で送った要求の数。
    requests: int
    counters: Counters
    # この要求で新たに保存した結果の数。失敗した要求では0。
    new_results: int
    # 失敗した要求なら分類（`FailureKind` か `RESPONSE_INVALID` 等）と内容。
    failure: str | None = None


ProgressCallback = Callable[[RequestProgress], None]


@dataclass(frozen=True)
class RunReport:
    stop_reason: StopReason
    detail: str | None
    counters: Counters
    # この実行で送った要求の数。
    requests: int


__all__ = ["EvaluationBusyError", "RequestProgress", "RunReport", "StopReason", "run_evaluation"]


def run_evaluation(
    repository: EvaluationRepository,
    transport: EvaluationTransport,
    *,
    sleep: Callable[[float], None] = time.sleep,
    max_requests: int | None = None,
    on_progress: ProgressCallback | None = None,
    max_runs_per_request: int | None = None,
    shrink_on_partial: bool = False,
) -> RunReport:
    """実行する。同じ評価実行を別の実行が実行中なら `EvaluationBusyError`（何も送らない）。

    排他は送信中の要求を放棄扱いにする前に取る。後から来た実行が、動いている実行の
    要求を放棄にして同じ試行を二重に送らないようにするため。
    """
    if max_runs_per_request is not None and max_runs_per_request < 1:
        raise ValueError("要求あたりの試行数は1以上")
    with repository.exclusive_run():
        return _run(
            repository,
            transport,
            sleep,
            max_requests,
            on_progress,
            max_runs_per_request,
            shrink_on_partial,
        )


def _run(
    repository: EvaluationRepository,
    transport: EvaluationTransport,
    sleep: Callable[[float], None],
    max_requests: int | None,
    on_progress: ProgressCallback | None,
    max_runs_per_request: int | None,
    shrink_on_partial: bool,
) -> RunReport:
    plan = repository.load_plan()
    settings = plan.settings
    if shrink_on_partial:
        partial_sizes = (
            _next_partial_cap(attempt.completed_runs, attempt.run_count)
            for attempt in repository.attempts()
            if attempt.completed_runs is not None and attempt.completed_runs < attempt.run_count
        )
        initial_cap = max_runs_per_request or plan.contract.default_max_runs_per_request
        max_runs_per_request = min(initial_cap, min(partial_sizes, default=initial_cap))
    repository.abandon_in_flight()
    session = repository.start_session()
    requests = 0
    retries = 0
    no_progress = 0

    def stop(reason: StopReason, detail: str | None = None) -> RunReport:
        repository.finish_session(session, reason.value, detail)
        return RunReport(reason, detail, repository.counters(), requests)

    def notify(new_results: int, failure: str | None = None) -> None:
        if on_progress is not None:
            on_progress(RequestProgress(requests, repository.counters(), new_results, failure))

    while True:
        pending = repository.pending_trials()
        if not pending:
            return stop(StopReason.COMPLETED)
        if max_requests is not None and requests >= max_requests:
            return stop(StopReason.REQUEST_LIMIT_REACHED, f"この実行の要求数上限 {max_requests}")
        remaining = remaining_runs(plan.budget.max_submitted_runs, repository.counters())
        if remaining == 0:
            return stop(
                StopReason.BUDGET_EXHAUSTED,
                f"送信予算 {plan.budget.max_submitted_runs} 試行を使い切った"
                f"（未完了 {len(pending)} 試行）",
            )
        cap = remaining if max_runs_per_request is None else min(remaining, max_runs_per_request)
        request = _next_request(plan, repository, pending, cap)
        try:
            attempt = repository.reserve_attempt(session, request)
        except BudgetExhaustedError as error:  # pragma: no cover - 直前に残りを見ている
            return stop(StopReason.BUDGET_EXHAUSTED, str(error))
        requests += 1
        exchange = transport.post_json(plan.contract.path, request.body())

        failure = classify_exchange(exchange)
        if failure is not None:
            repository.record_failure(
                attempt, exchange, failure.kind.value, failure.code, failure.message
            )
            notify(0, f"{failure.kind.value}: {failure.message}")
            if not failure.retryable:
                return stop(_STOP_ON_FAILURE[failure.kind], failure.message)
            retries += 1
            if retries > settings.max_retries:
                return stop(
                    StopReason.RETRY_LIMIT_REACHED,
                    f"再送できる失敗が {retries} 回続いた: {failure.message}",
                )
            sleep(settings.retry_backoff_seconds * 2 ** (retries - 1))
            continue
        retries = 0

        try:
            validated = validate_response(request, json.loads(exchange.body or ""))
        except (ValueError, ResponseContractError) as error:
            repository.record_failure(attempt, exchange, "RESPONSE_INVALID", None, str(error))
            notify(0, f"RESPONSE_INVALID: {error}")
            return stop(StopReason.RESPONSE_INVALID, str(error))
        try:
            outcome = repository.record_success(attempt, exchange, validated)
        except EnvironmentMismatchError as error:
            notify(0, f"ENVIRONMENT_MISMATCH: {error}")
            return stop(StopReason.ENVIRONMENT_MISMATCH, str(error))
        except ResultConflictError as error:
            notify(0, f"RESULT_CONFLICT: {error}")
            return stop(StopReason.RESULT_CONFLICT, str(error))
        notify(outcome.new_results)
        if shrink_on_partial and validated.incomplete:
            previous = len(validated.completed) + len(validated.incomplete)
            max_runs_per_request = _next_partial_cap(len(validated.completed), previous)

        if outcome.new_results == 0:
            no_progress += 1
            if no_progress >= settings.max_consecutive_no_progress:
                return stop(
                    StopReason.NO_PROGRESS_LIMIT_REACHED,
                    f"1件も完了しない応答が {no_progress} 回続いた"
                    "（要求あたりの試行数を減らすか、サーバーの期限を延ばす）",
                )
        else:
            no_progress = 0


def _next_partial_cap(completed: int, submitted: int) -> int:
    return max(1, completed or submitted // 2)


def _next_request(
    plan: EvaluationPlan,
    repository: EvaluationRepository,
    pending: list[tuple[str, int]],
    remaining: int,
) -> EvaluationRequest:
    settings = plan.settings
    max_cases = settings.max_cases_per_request or plan.contract.default_max_cases_per_request
    max_runs = settings.max_runs_per_request or plan.contract.default_max_runs_per_request
    batch = split_pending(pending, max_cases=max_cases, max_runs=min(max_runs, remaining))[0]
    cases = {case.case_id: case for case in plan.cases}
    environment = repository.environment()
    return EvaluationRequest(
        contract=plan.contract,
        seed=plan.seed,
        cases=tuple(
            RequestCase(
                case_id=case_id,
                match_request=cases[case_id].match_request,
                run_indices=run_indices,
                expected_slots=cases[case_id].expected_slots,
            )
            for case_id, run_indices in batch
        ),
        # 環境が確定した後は、その環境以外では1試行も実行させない。
        expected_catalog_revision=(
            environment.catalog_revision if environment else settings.expected_catalog_revision
        ),
        expected_engine_revision=(
            environment.engine_revision if environment else settings.expected_engine_revision
        ),
    )
