"""分割実行・部分応答・再開・予算・障害処理。実DBと評価APIの偽物で確かめる。"""

import json

import pytest

from mlgg_lab_common.api.client import HttpExchange
from mlgg_lab_common.api.contracts import EvaluationRequest, RequestCase, validate_response
from mlgg_lab_common.evaluation.batching import split_pending
from mlgg_lab_common.evaluation.identity import match_fingerprint
from mlgg_lab_common.evaluation.models import Budget, ExecutionSettings
from mlgg_lab_common.evaluation.plan import CaseSpec, create_plan
from mlgg_lab_common.evaluation.runner import StopReason, run_evaluation
from mlgg_lab_common.storage.repository import ResultConflictError
from mlgg_lab_common.storage.sqlite import SqliteEvaluationRepository
from mlgg_lab_common.testing import FakeBattleInput, FakeEvaluationServer, FakeTotalWarInput

A = FakeBattleInput.of(["UNIT_A", "UNIT_A"], ["UNIT_B"])
B = FakeBattleInput.of(["UNIT_C"], ["UNIT_B"], turn_limit=9)
C = FakeBattleInput.of(["UNIT_D"], ["UNIT_E"], turn_limit=3)


def make_repo(tmp_path, cases=None, *, name="e", budget=1000, **settings):
    cases = cases or [
        CaseSpec("a", A, [0, 1, 2, 3]),
        CaseSpec("b", B, [5, 9]),
        CaseSpec("c", C, [0]),
    ]
    plan = create_plan(
        "BATTLE",
        cases,
        seed="s",
        budget=Budget(max_submitted_runs=budget),
        settings=ExecutionSettings(retryBackoffSeconds=0.5, **settings),
    )
    return SqliteEvaluationRepository.create(tmp_path / f"{name}.sqlite3", plan)


def by_trial(repo):
    """意味上の観測値を (対戦条件, 試行番号) で引く。ケースIDや分割に依らない比較用。"""
    plan = repo.load_plan()
    fingerprints = {c.case_id: c.match_fingerprint for c in plan.cases}
    return {(fingerprints[r.case_id], r.run_index): r.observation for r in repo.results()}


def requested_runs(server):
    return [
        (c["caseId"], i)
        for request in server.requests
        for c in request["cases"]
        for i in c["runIndices"]
    ]


def no_sleep(_seconds):
    pass


def test_requests_respect_case_and_run_limits_and_complete_the_plan(tmp_path):
    server = FakeEvaluationServer()
    with make_repo(tmp_path, maxCasesPerRequest=2, maxRunsPerRequest=3) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.COMPLETED
        assert report.counters.completed_trials == 7
        assert report.counters.submitted_runs == 7
    for request in server.requests:
        assert len(request["cases"]) <= 2
        assert sum(len(c["runIndices"]) for c in request["cases"]) <= 3
    # 各試行は1回だけ送った。
    assert sorted(requested_runs(server)) == sorted(
        [("a", i) for i in range(4)] + [("b", 5), ("b", 9), ("c", 0)]
    )


def test_split_keeps_plan_order_and_never_repeats_a_case_in_one_request():
    batches = split_pending(
        [("a", 0), ("a", 1), ("a", 2), ("b", 7), ("c", 1)], max_cases=2, max_runs=2
    )

    assert batches == [[("a", (0, 1))], [("a", (2,)), ("b", (7,))], [("c", (1,))]]


def test_semantic_results_do_not_depend_on_split_or_case_order(tmp_path):
    with make_repo(tmp_path, name="wide") as wide:
        run_evaluation(wide, FakeEvaluationServer(), sleep=no_sleep)
        expected = by_trial(wide)
    reordered = [CaseSpec("cc", C, [0]), CaseSpec("bb", B, [9, 5]), CaseSpec("aa", A, [3, 2, 1, 0])]
    with make_repo(
        tmp_path, reordered, name="narrow", maxCasesPerRequest=1, maxRunsPerRequest=1
    ) as narrow:
        run_evaluation(narrow, FakeEvaluationServer(), sleep=no_sleep)

        assert by_trial(narrow) == expected


def test_partial_responses_keep_completed_runs_and_resend_only_the_rest(tmp_path):
    server = FakeEvaluationServer(complete_limit=2)
    with make_repo(tmp_path) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.COMPLETED
        assert report.counters.completed_trials == 7
        # 未完了の番号は再送するので、送信数は完了数と分けて数える。
        assert report.counters.submitted_runs == 7 + 5 + 3 + 1
    # 各要求は前の応答で完了した番号を含まない（偽物は先頭の2試行だけ完了させる）。
    assert [[(c["caseId"], c["runIndices"]) for c in r["cases"]] for r in server.requests] == [
        [("a", [0, 1, 2, 3]), ("b", [5, 9]), ("c", [0])],
        [("a", [2, 3]), ("b", [5, 9]), ("c", [0])],
        [("b", [5, 9]), ("c", [0])],
        [("c", [0])],
    ]


def test_lost_responses_are_resent_with_the_same_seed_and_run_indices(tmp_path):
    server = FakeEvaluationServer(script=["lost", "lost"])
    slept: list[float] = []
    with make_repo(tmp_path, maxRetries=3) as repo:
        report = run_evaluation(repo, server, sleep=slept.append)

        assert report.stop_reason is StopReason.COMPLETED
        assert report.counters.completed_trials == 7
        # サーバーは3回実行したが、保存した結果は1件ずつ。送信数は再送込みで数える。
        assert server.executed_runs == 21
        assert report.counters.submitted_runs == 21
        assert len(repo.results()) == 7
        assert [a.failure_kind for a in repo.attempts()] == ["TRANSPORT", "TRANSPORT", None]
    assert server.requests[0] == server.requests[1] == server.requests[2]
    assert slept == [0.5, 1.0]


def test_resume_after_a_process_interruption_continues_from_unfinished_trials(tmp_path):
    path = tmp_path / "e.sqlite3"
    with make_repo(tmp_path, maxRunsPerRequest=3) as repo:
        server = FakeEvaluationServer(script=["ok", "interrupt"])
        with pytest.raises(KeyboardInterrupt):
            run_evaluation(repo, server, sleep=no_sleep)
        assert repo.counters().completed_trials == 3

    resumed_server = FakeEvaluationServer()
    with SqliteEvaluationRepository.open(path) as reopened:
        report = run_evaluation(reopened, resumed_server, sleep=no_sleep)

        assert report.stop_reason is StopReason.COMPLETED
        assert report.counters.completed_trials == 7
        assert [a.status for a in reopened.attempts()][:2] == ["SUCCEEDED", "ABANDONED"]
    # 再開後は完了済みの3試行を送らない。
    assert ("a", 0) not in requested_runs(resumed_server)
    assert len(requested_runs(resumed_server)) == 4


def test_budget_is_reserved_before_sending_and_trims_the_last_request(tmp_path):
    server = FakeEvaluationServer(script=["lost"])
    with make_repo(tmp_path, budget=6, maxRunsPerRequest=4) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.BUDGET_EXHAUSTED
        assert report.counters.submitted_runs == 6
        assert report.counters.completed_trials == 2
        # 予算到達後も保存済みの状態は残り、未完了分は計画に残る。
        assert len(repo.pending_trials()) == 5
    assert [sum(len(c["runIndices"]) for c in r["cases"]) for r in server.requests] == [4, 2]


def test_consecutive_retryable_failures_stop_at_the_retry_limit(tmp_path):
    server = FakeEvaluationServer(script=["lost"] * 10)
    with make_repo(tmp_path, maxRetries=2) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.RETRY_LIMIT_REACHED
        assert report.counters.completed_trials == 0
        assert len(repo.attempts()) == 3
        # 通信失敗を勝敗・スコアへ変換しない。
        assert repo.results() == []
        assert repo.sessions()[-1].stop_reason == "RETRY_LIMIT_REACHED"


def test_repeated_zero_progress_responses_stop_instead_of_looping(tmp_path):
    server = FakeEvaluationServer(complete_limit=0)
    with make_repo(tmp_path, maxConsecutiveNoProgress=3) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.NO_PROGRESS_LIMIT_REACHED
        assert len(server.requests) == 3
        assert repo.results() == []


@pytest.mark.parametrize(
    ("action", "reason"),
    [
        (("status", 422, "INVALID_COMMAND", "/cases/0/turnLimit"), StopReason.INVALID_INPUT),
        (("status", 503, "EXECUTION_LIMIT_EXCEEDED"), StopReason.EXECUTION_ERROR),
        (("status", 404, "ENDPOINT_DISABLED"), StopReason.ENDPOINT_UNAVAILABLE),
        (("status", 401, "UNAUTHORIZED"), StopReason.UNAUTHORIZED),
        (
            ("status", 422, "INVALID_COMMAND", "/expectedEngineRevision"),
            StopReason.ENVIRONMENT_MISMATCH,
        ),
        ("garbage", StopReason.RESPONSE_INVALID),
    ],
)
def test_non_retryable_failures_are_recorded_and_stop(tmp_path, action, reason):
    server = FakeEvaluationServer(script=[action])
    with make_repo(tmp_path) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is reason
        assert len(server.requests) == 1
        assert repo.results() == []
        assert repo.attempts()[0].status == "FAILED"


def test_a_changed_engine_is_not_mixed_into_the_evaluation(tmp_path):
    server = FakeEvaluationServer(script=["ok", ("engine", "eng-2")])
    with make_repo(tmp_path, maxRunsPerRequest=3) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.ENVIRONMENT_MISMATCH
        assert report.counters.completed_trials == 3
        assert {r.observation["runIndex"] for r in repo.results()} == {0, 1, 2}
    # 環境が確定した後の要求は期待revisionを送る（実APIなら実行前に422で止まる）。
    assert "expectedEngineRevision" not in server.requests[0]
    assert server.requests[1]["expectedEngineRevision"] == "eng-1"
    assert server.requests[1]["expectedCatalogRevision"] == "cat-1"


def test_configured_revisions_are_sent_from_the_first_request(tmp_path):
    server = FakeEvaluationServer()
    with make_repo(tmp_path, expectedEngineRevision="eng-1") as repo:
        run_evaluation(repo, server, sleep=no_sleep)

    assert server.requests[0]["expectedEngineRevision"] == "eng-1"
    assert "expectedCatalogRevision" not in server.requests[0]


@pytest.mark.parametrize(
    ("settings", "server_env"),
    [
        ({"expectedEngineRevision": "required-engine"}, {"engine_revision": "wrong-engine"}),
        ({"expectedCatalogRevision": "required-catalog"}, {"catalog_revision": "wrong-catalog"}),
    ],
)
def test_a_first_response_from_an_unexpected_environment_is_not_saved(
    tmp_path, settings, server_env
):
    # 実APIなら422で止まるが、200で返ってきても応答側で照合して受理しない。
    server = FakeEvaluationServer(**server_env)
    with make_repo(tmp_path, **settings) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.ENVIRONMENT_MISMATCH
        assert len(server.requests) == 1
        assert repo.results() == []
        assert repo.environment() is None
        assert repo.attempts()[0].failure_kind == "ENVIRONMENT_MISMATCH"


def test_matching_configured_revisions_establish_the_environment(tmp_path):
    server = FakeEvaluationServer()
    with make_repo(
        tmp_path, expectedEngineRevision="eng-1", expectedCatalogRevision="cat-1"
    ) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.COMPLETED
        assert repo.environment().engine_revision == "eng-1"


def test_stored_result_differing_from_a_resent_trial_stops_with_a_conflict(tmp_path):
    cases = [CaseSpec("a", A, [0])]
    with make_repo(tmp_path, cases) as repo:
        run_evaluation(repo, FakeEvaluationServer(), sleep=no_sleep)
        plan = repo.load_plan()
    # 同じ試行を、既に結果がある状態でもう一度受け取る（別プロセスの重複送信を再現）。
    case = plan.cases[0]
    request = EvaluationRequest(
        plan.contract, plan.seed, (RequestCase("a", case.match_request, (0,), case.expected_slots),)
    )
    server = FakeEvaluationServer(script=[("flip", "a", 0)])
    exchange = server.post_json(plan.contract.path, request.body())
    validated = validate_response(request, json.loads(exchange.body))
    with SqliteEvaluationRepository.open(tmp_path / "e.sqlite3") as repo:
        attempt = repo.reserve_attempt(repo.start_session(), request)
        with pytest.raises(ResultConflictError):
            repo.record_success(
                attempt, HttpExchange(200, exchange.body, None, "t", "t"), validated
            )


def test_request_limit_stops_a_session_and_resume_finishes(tmp_path):
    path = tmp_path / "e.sqlite3"
    with make_repo(tmp_path, maxRunsPerRequest=2) as repo:
        report = run_evaluation(repo, FakeEvaluationServer(), sleep=no_sleep, max_requests=1)
        assert report.stop_reason is StopReason.REQUEST_LIMIT_REACHED
        assert report.counters.completed_trials == 2

    with SqliteEvaluationRepository.open(path) as repo:
        assert run_evaluation(repo, FakeEvaluationServer(), sleep=no_sleep).stop_reason is (
            StopReason.COMPLETED
        )
        assert [s.stop_reason for s in repo.sessions()] == ["REQUEST_LIMIT_REACHED", "COMPLETED"]


def test_total_war_runs_are_evaluated_and_saved_as_whole_battles(tmp_path):
    tw = FakeTotalWarInput.of([["UNIT_A"], ["UNIT_A", "UNIT_B"]], [["UNIT_C"]])
    plan = create_plan(
        "TOTAL_WAR", [CaseSpec("tw", tw, [0, 1, 2])], seed="s", budget=Budget(max_submitted_runs=9)
    )
    server = FakeEvaluationServer()
    with SqliteEvaluationRepository.create(tmp_path / "tw.sqlite3", plan) as repo:
        report = run_evaluation(repo, server, sleep=no_sleep)

        assert report.stop_reason is StopReason.COMPLETED
        results = repo.results()
        assert len(results) == 3
        observation = results[0].observation
        assert {"stages", "defeatedFormationCounts"} <= observation.keys()
        assert [(u["formationNumber"], u["unitIndex"]) for u in observation["units"]] == [
            (1, 0),
            (2, 0),
            (2, 1),
            (1, 0),
        ]
    assert server.requests[0]["cases"][0]["allyFormations"] == tw.to_request()["allyFormations"]
    assert match_fingerprint("TOTAL_WAR", tw.to_request()) == plan.cases[0].match_fingerprint
