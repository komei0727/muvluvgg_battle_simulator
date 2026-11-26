"""評価実行の保存・検索のインターフェース。

実行制御（`evaluation.runner`）はこの口だけを使い、SQLの詳細を知らない。整合性に関わる
判定（予算の確保・実行環境の照合・同一試行の結果の一致）は保存と同じトランザクションの
中で行うため、実装側の責務にしてある。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ..api.client import HttpExchange
from ..api.contracts import EvaluationRequest, ExecutionEnvironment, ValidatedResponse
from ..evaluation.budget import Counters
from ..evaluation.models import EvaluationPlan


class EnvironmentMismatchError(Exception):
    """保存済みの結果と違う実行環境の応答。同じ評価実行へ混ぜない。"""


class ResultConflictError(Exception):
    """同じ試行から意味の違う観測値が返った。既存の結果は書き換えない。"""


@dataclass(frozen=True)
class SaveOutcome:
    new_results: int
    # 既に同じ観測値が保存されていた試行の数（応答喪失後の再送などで起こる）。
    duplicate_results: int


@dataclass(frozen=True)
class StoredResult:
    case_id: str
    run_index: int
    observation: dict[str, Any]
    attempt_id: int


@dataclass(frozen=True)
class AttemptRecord:
    attempt_id: int
    session_id: int
    status: str
    run_count: int
    http_status: int | None
    transport_error: str | None
    failure_kind: str | None
    failure_code: str | None
    failure_message: str | None
    completed_runs: int | None
    new_results: int | None
    duplicate_results: int | None


@dataclass(frozen=True)
class SessionRecord:
    session_id: int
    started_at: str
    finished_at: str | None
    stop_reason: str | None
    detail: str | None


class EvaluationRepository(Protocol):
    def load_plan(self) -> EvaluationPlan: ...

    def environment(self) -> ExecutionEnvironment | None: ...

    def pending_trials(self) -> list[tuple[str, int]]:
        """結果の無い試行。計画のケース順、ケース内は試行番号の昇順。"""
        ...

    def counters(self) -> Counters: ...

    def start_session(self) -> int: ...

    def finish_session(self, session_id: int, stop_reason: str, detail: str | None) -> None: ...

    def abandon_in_flight(self) -> int:
        """前回の実行が送信中のまま終わった要求を放棄扱いにする。送信数には残す。"""
        ...

    def reserve_attempt(self, session_id: int, request: EvaluationRequest) -> int:
        """予算を確保して要求を履歴へ残す。足りなければ `BudgetExhaustedError`。"""
        ...

    def record_failure(
        self,
        attempt_id: int,
        exchange: HttpExchange | None,
        kind: str,
        code: str | None,
        message: str,
    ) -> None: ...

    def record_success(
        self, attempt_id: int, exchange: HttpExchange, response: ValidatedResponse
    ) -> SaveOutcome:
        """原応答と結果を1トランザクションで保存する。

        実行環境の不一致は `EnvironmentMismatchError`、観測値の不一致は
        `ResultConflictError` を送出し、どちらも結果を1件も保存せずに履歴へ失敗として残す。
        """
        ...

    def results(self) -> list[StoredResult]: ...

    def attempts(self) -> list[AttemptRecord]: ...

    def sessions(self) -> list[SessionRecord]: ...
