"""評価APIのHTTP通信と、失敗の分類。

HTTPの失敗は例外にしない。要求1回ごとに状態・本文・時刻を `HttpExchange` として返し、
実行側が履歴へ残してから分類（`classify_exchange`）に従って再送・停止を決める。

分類の考え方:

- 応答を受け取れなかった（接続断・タイムアウト）: サーバーで実行済みかもしれない。同じ
  試行番号で再送すれば同じ結果が得られるので、回数を限って再送する。
- 混雑・一時的な不在（429、503 `CAPACITY_EXCEEDED`、502／504）: 回数を限って再送する。
- 入力・実行環境・実行保護・認証・提供可否の問題: 再送しても変わらないので止める。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from types import TracebackType
from typing import Any, Self

import httpx

DEFAULT_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True)
class HttpExchange:
    """要求1回の記録。`status` が `None` なら応答を受け取れなかった。"""

    status: int | None
    body: str | None
    transport_error: str | None
    started_at: str
    finished_at: str


class FailureKind(StrEnum):
    TRANSPORT = "TRANSPORT"
    RETRYABLE_STATUS = "RETRYABLE_STATUS"
    INVALID_INPUT = "INVALID_INPUT"
    ENVIRONMENT_MISMATCH = "ENVIRONMENT_MISMATCH"
    EXECUTION_ERROR = "EXECUTION_ERROR"
    UNAUTHORIZED = "UNAUTHORIZED"
    ENDPOINT_UNAVAILABLE = "ENDPOINT_UNAVAILABLE"


_RETRYABLE = frozenset({FailureKind.TRANSPORT, FailureKind.RETRYABLE_STATUS})
# 503のうち、混雑・内部キャンセルは時間をおけば通り得る。安全上限超過は同じ入力で再び超える。
_RETRYABLE_503_CODES = frozenset({"CAPACITY_EXCEEDED", "EXECUTION_CANCELLED"})
_REVISION_PATHS = frozenset({"expectedCatalogRevision", "expectedEngineRevision"})


@dataclass(frozen=True)
class Failure:
    kind: FailureKind
    code: str | None
    message: str

    @property
    def retryable(self) -> bool:
        return self.kind in _RETRYABLE


class EvaluationTransport:
    """評価APIへJSONを送る口。テストは同じ形の偽物を渡す。"""

    def post_json(self, path: str, payload: dict[str, Any]) -> HttpExchange:  # pragma: no cover
        raise NotImplementedError


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class EvaluationHttpClient(EvaluationTransport):
    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        access_key: str | None = None,
        clock: Callable[[], str] = _now,
    ) -> None:
        headers = {"Accept": "application/json"}
        if access_key:
            headers["Authorization"] = f"Bearer {access_key}"
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), timeout=timeout_seconds, headers=headers
        )
        self._clock = clock

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def post_json(self, path: str, payload: dict[str, Any]) -> HttpExchange:
        started = self._clock()
        try:
            response = self._client.post(path, json=payload)
        except httpx.HTTPError as error:
            return HttpExchange(
                status=None,
                body=None,
                transport_error=f"{type(error).__name__}: {error}",
                started_at=started,
                finished_at=self._clock(),
            )
        return HttpExchange(
            status=response.status_code,
            body=response.text,
            transport_error=None,
            started_at=started,
            finished_at=self._clock(),
        )


def classify_exchange(exchange: HttpExchange) -> Failure | None:
    """成功（200）なら `None`。応答本文の検証は別（`contracts.validate_response`）に行う。"""
    if exchange.status is None:
        return Failure(
            FailureKind.TRANSPORT,
            None,
            "応答を受け取れなかった（サーバーで実行済みの可能性がある）: "
            f"{exchange.transport_error}",
        )
    if exchange.status == 200:
        return None
    code, message, paths = _error_details(exchange.body)
    summary = f"{exchange.status} {code or '-'}: {message}"
    status = exchange.status
    if status == 429 or status in (502, 504):
        kind = FailureKind.RETRYABLE_STATUS
    elif status == 503:
        kind = (
            FailureKind.RETRYABLE_STATUS
            if code is None or code in _RETRYABLE_503_CODES
            else FailureKind.EXECUTION_ERROR
        )
    elif status == 422 and any(path.lstrip("/") in _REVISION_PATHS for path in paths):
        kind = FailureKind.ENVIRONMENT_MISMATCH
    elif status in (400, 413, 415, 422):
        kind = FailureKind.INVALID_INPUT
    elif status == 401:
        kind = FailureKind.UNAUTHORIZED
    elif status == 404:
        kind = FailureKind.ENDPOINT_UNAVAILABLE
    else:
        kind = FailureKind.EXECUTION_ERROR
    return Failure(kind, code, summary + "".join(f"\n  - {p}" for p in paths))


def _error_details(body: str | None) -> tuple[str | None, str, list[str]]:
    try:
        parsed = json.loads(body or "")
    except ValueError:
        return None, (body or "")[:200], []
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if not isinstance(error, dict):
        return None, (body or "")[:200], []
    violations = error.get("violations")
    paths = [
        str(v.get("path"))
        for v in (violations if isinstance(violations, list) else [])
        if isinstance(v, dict) and v.get("path") is not None
    ]
    code = error.get("code")
    return (code if isinstance(code, str) else None), str(error.get("message", "")), paths
