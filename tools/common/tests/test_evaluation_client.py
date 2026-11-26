"""評価APIのHTTP通信と失敗の分類。HTTPの失敗は例外にせず、履歴へ残せる形で返す。"""

import httpx
import pytest
import respx

from mlgg_lab_common.api.client import (
    EvaluationHttpClient,
    FailureKind,
    classify_exchange,
)

BASE = "http://lab.test"
PATH = "/api/v1/battle-evaluations"


def error_body(code: str, *paths: str) -> dict:
    return {
        "error": {
            "code": code,
            "message": "m",
            "violations": [{"path": p, "message": "v"} for p in paths],
        }
    }


@respx.mock
def test_successful_exchange_keeps_the_raw_body_and_timestamps():
    route = respx.post(f"{BASE}{PATH}").respond(200, json={"ok": True})
    with EvaluationHttpClient(BASE, timeout_seconds=5, access_key="k") as client:
        exchange = client.post_json(PATH, {"seed": "s"})

    assert exchange.status == 200
    assert exchange.body == '{"ok":true}'
    assert exchange.started_at <= exchange.finished_at
    assert classify_exchange(exchange) is None
    assert route.calls.last.request.headers["authorization"] == "Bearer k"


@respx.mock
def test_transport_errors_are_returned_as_lost_responses():
    respx.post(f"{BASE}{PATH}").mock(side_effect=httpx.ReadTimeout("slow"))
    with EvaluationHttpClient(BASE, timeout_seconds=5) as client:
        exchange = client.post_json(PATH, {})

    failure = classify_exchange(exchange)
    assert exchange.status is None
    assert failure is not None
    assert failure.kind is FailureKind.TRANSPORT
    # 応答を失っただけで、サーバーは実行したかもしれない。
    assert failure.retryable


@pytest.mark.parametrize(
    ("status", "body", "kind", "retryable"),
    [
        (429, error_body("RATE_LIMIT_EXCEEDED"), FailureKind.RETRYABLE_STATUS, True),
        (503, error_body("CAPACITY_EXCEEDED"), FailureKind.RETRYABLE_STATUS, True),
        (502, None, FailureKind.RETRYABLE_STATUS, True),
        (504, error_body("EXECUTION_TIMEOUT"), FailureKind.RETRYABLE_STATUS, True),
        (503, error_body("EXECUTION_LIMIT_EXCEEDED"), FailureKind.EXECUTION_ERROR, False),
        (500, error_body("INTERNAL_INVARIANT_VIOLATION"), FailureKind.EXECUTION_ERROR, False),
        (400, error_body("MALFORMED_REQUEST"), FailureKind.INVALID_INPUT, False),
        (413, error_body("REQUEST_TOO_LARGE"), FailureKind.INVALID_INPUT, False),
        (
            422,
            error_body("INVALID_COMMAND", "/cases/0/allyFormation/units/0"),
            FailureKind.INVALID_INPUT,
            False,
        ),
        (
            422,
            error_body("INVALID_COMMAND", "/expectedEngineRevision"),
            FailureKind.ENVIRONMENT_MISMATCH,
            False,
        ),
        (
            422,
            error_body("INVALID_COMMAND", "expectedCatalogRevision"),
            FailureKind.ENVIRONMENT_MISMATCH,
            False,
        ),
        (401, error_body("UNAUTHORIZED"), FailureKind.UNAUTHORIZED, False),
        (404, error_body("ENDPOINT_DISABLED"), FailureKind.ENDPOINT_UNAVAILABLE, False),
    ],
)
@respx.mock
def test_http_failures_are_classified_by_status_and_code(status, body, kind, retryable):
    route = respx.post(f"{BASE}{PATH}")
    if body:
        route.respond(status, json=body)
    else:
        route.respond(status, text="bad gateway")
    with EvaluationHttpClient(BASE, timeout_seconds=5) as client:
        failure = classify_exchange(client.post_json(PATH, {}))

    assert failure is not None
    assert failure.kind is kind
    assert failure.retryable is retryable
    if body:
        assert failure.code == body["error"]["code"]
