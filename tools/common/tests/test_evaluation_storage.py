"""SQLite保存。実DBで計画・要求履歴・結果・一意制約・保存形式の識別を確かめる。"""

import sqlite3

import pytest

from mlgg_lab_common.api.client import HttpExchange
from mlgg_lab_common.api.contracts import (
    CompletedRun,
    EvaluationRequest,
    ExecutionEnvironment,
    RequestCase,
    ValidatedResponse,
)
from mlgg_lab_common.evaluation.budget import BudgetExhaustedError
from mlgg_lab_common.evaluation.models import Budget
from mlgg_lab_common.evaluation.plan import CaseSpec, create_plan
from mlgg_lab_common.storage.migrations import STORAGE_FORMAT_VERSION
from mlgg_lab_common.storage.repository import (
    EnvironmentMismatchError,
    ResultConflictError,
)
from mlgg_lab_common.storage.sqlite import (
    SqliteEvaluationRepository,
    UnknownStorageFormatError,
)
from mlgg_lab_common.testing import FakeBattleInput, battle_run

ENV = ExecutionEnvironment("cat-1", "eng-1", "SD1", "battle-evaluations/v1/schemaVersion=1")
EXCHANGE = HttpExchange(200, "{}", None, "t0", "t1")


def make_plan(budget: int = 100):
    battle = FakeBattleInput.of(["UNIT_A", "UNIT_A"], ["UNIT_B"])
    other = FakeBattleInput.of(["UNIT_C"], ["UNIT_B"], turn_limit=9)
    return create_plan(
        "BATTLE",
        [CaseSpec("b-second", other, [3, 1]), CaseSpec("a-first", battle, [0, 42])],
        seed="s",
        budget=Budget(max_submitted_runs=budget),
        evaluation_id="ev-1",
        created_at="2026-11-26T00:00:00+00:00",
    )


@pytest.fixture
def repo(tmp_path):
    with SqliteEvaluationRepository.create(tmp_path / "e.sqlite3", make_plan()) as repository:
        yield repository


def request_for(repository, *pairs):
    plan = repository.load_plan()
    cases = {c.case_id: c for c in plan.cases}
    grouped: dict[str, list[int]] = {}
    for case_id, run_index in pairs:
        grouped.setdefault(case_id, []).append(run_index)
    return EvaluationRequest(
        contract=plan.contract,
        seed=plan.seed,
        cases=tuple(
            RequestCase(cid, cases[cid].match_request, tuple(runs), cases[cid].expected_slots)
            for cid, runs in grouped.items()
        ),
    )


def success(repository, request, runs, *, env=ENV, incomplete=()):
    plan = repository.load_plan()
    slots = {c.case_id: c.expected_slots for c in plan.cases}
    return ValidatedResponse(
        environment=env,
        completed=tuple(CompletedRun(cid, i, battle_run(i, slots[cid])) for cid, i in runs),
        incomplete=tuple(incomplete),
    )


def test_plan_round_trips_through_the_database(tmp_path):
    plan = make_plan()
    path = tmp_path / "e.sqlite3"
    SqliteEvaluationRepository.create(path, plan).close()

    with SqliteEvaluationRepository.open(path) as reopened:
        assert reopened.load_plan() == plan


def test_pending_trials_follow_plan_case_order_then_run_index(repo):
    assert repo.pending_trials() == [
        ("b-second", 1),
        ("b-second", 3),
        ("a-first", 0),
        ("a-first", 42),
    ]


def test_success_saves_results_and_removes_them_from_pending(repo):
    session = repo.start_session()
    request = request_for(repo, ("a-first", 0), ("a-first", 42))
    attempt = repo.reserve_attempt(session, request)

    outcome = repo.record_success(
        attempt, EXCHANGE, success(repo, request, [("a-first", 42)], incomplete=[("a-first", 0)])
    )

    assert (outcome.new_results, outcome.duplicate_results) == (1, 0)
    assert ("a-first", 42) not in repo.pending_trials()
    assert ("a-first", 0) in repo.pending_trials()
    assert repo.environment() == ENV
    stored = repo.results()
    assert [(r.case_id, r.run_index) for r in stored] == [("a-first", 42)]
    assert stored[0].observation["runIndex"] == 42
    counters = repo.counters()
    assert (counters.planned_runs, counters.submitted_runs, counters.completed_trials) == (4, 2, 1)
    trials = repo.attempt_trials(attempt)
    assert trials == {("a-first", 0): "INCOMPLETE", ("a-first", 42): "COMPLETED"}


def test_reservation_counts_against_the_budget_before_sending(tmp_path):
    with SqliteEvaluationRepository.create(tmp_path / "e.sqlite3", make_plan(budget=3)) as repo:
        session = repo.start_session()
        repo.reserve_attempt(session, request_for(repo, ("a-first", 0), ("a-first", 42)))

        with pytest.raises(BudgetExhaustedError):
            repo.reserve_attempt(session, request_for(repo, ("b-second", 1), ("b-second", 3)))

        # 予約は送信前に残るので、中断してもこの分は送信済みとして数える。
        assert repo.counters().submitted_runs == 2


def test_in_flight_attempts_are_abandoned_on_restart_but_still_count(tmp_path):
    path = tmp_path / "e.sqlite3"
    with SqliteEvaluationRepository.create(path, make_plan()) as repo:
        repo.reserve_attempt(repo.start_session(), request_for(repo, ("a-first", 0)))

    with SqliteEvaluationRepository.open(path) as reopened:
        assert reopened.abandon_in_flight() == 1
        assert reopened.counters().submitted_runs == 1
        assert [a.status for a in reopened.attempts()] == ["ABANDONED"]


def test_same_observation_twice_is_a_duplicate_not_a_second_row(repo):
    session = repo.start_session()
    for _ in range(2):
        request = request_for(repo, ("a-first", 0))
        attempt = repo.reserve_attempt(session, request)
        outcome = repo.record_success(attempt, EXCHANGE, success(repo, request, [("a-first", 0)]))

    assert (outcome.new_results, outcome.duplicate_results) == (0, 1)
    assert len(repo.results()) == 1


def test_a_different_observation_for_the_same_trial_is_a_conflict(repo):
    session = repo.start_session()
    request = request_for(repo, ("a-first", 0))
    repo.record_success(
        repo.reserve_attempt(session, request), EXCHANGE, success(repo, request, [("a-first", 0)])
    )
    changed = success(repo, request, [("a-first", 0)])
    changed.completed[0].observation["outcome"] = "ALLY_LOSE"
    attempt = repo.reserve_attempt(session, request)

    with pytest.raises(ResultConflictError, match="a-first"):
        repo.record_success(attempt, EXCHANGE, changed)

    # 既存の結果は上書きしない。衝突は要求の履歴へ残す。
    assert repo.results()[0].observation["outcome"] == "ALLY_WIN"
    assert repo.attempts()[-1].failure_kind == "RESULT_CONFLICT"


def test_results_of_another_environment_are_not_mixed_in(repo):
    session = repo.start_session()
    request = request_for(repo, ("a-first", 0))
    repo.record_success(
        repo.reserve_attempt(session, request), EXCHANGE, success(repo, request, [("a-first", 0)])
    )
    other = ExecutionEnvironment("cat-1", "eng-2", "SD1", ENV.contract_id)
    request = request_for(repo, ("a-first", 42))
    attempt = repo.reserve_attempt(session, request)

    with pytest.raises(EnvironmentMismatchError, match="engineRevision"):
        repo.record_success(attempt, EXCHANGE, success(repo, request, [("a-first", 42)], env=other))

    assert len(repo.results()) == 1
    assert repo.attempts()[-1].failure_kind == "ENVIRONMENT_MISMATCH"


def test_failures_are_kept_as_history(repo):
    attempt = repo.reserve_attempt(repo.start_session(), request_for(repo, ("a-first", 0)))
    repo.record_failure(
        attempt, HttpExchange(None, None, "ReadTimeout", "t0", "t1"), "TRANSPORT", None, "lost"
    )

    (record,) = repo.attempts()
    assert (record.status, record.failure_kind, record.transport_error) == (
        "FAILED",
        "TRANSPORT",
        "ReadTimeout",
    )
    assert repo.pending_trials()[2] == ("a-first", 0)


def test_results_cannot_be_overwritten_even_with_raw_sql(repo, tmp_path):
    session = repo.start_session()
    request = request_for(repo, ("a-first", 0))
    repo.record_success(
        repo.reserve_attempt(session, request), EXCHANGE, success(repo, request, [("a-first", 0)])
    )
    connection = sqlite3.connect(repo.path)
    with pytest.raises(sqlite3.DatabaseError):
        connection.execute("UPDATE results SET observation_json = '{}'")
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute(
            "INSERT INTO results (trial_id, attempt_id, observation_format, observation_json,"
            " observation_digest, recorded_at) SELECT trial_id, attempt_id, observation_format,"
            " observation_json, observation_digest, recorded_at FROM results"
        )
    connection.close()


def test_unknown_storage_format_is_not_read(tmp_path):
    path = tmp_path / "e.sqlite3"
    SqliteEvaluationRepository.create(path, make_plan()).close()
    connection = sqlite3.connect(path)
    connection.execute(f"PRAGMA user_version = {STORAGE_FORMAT_VERSION + 1}")
    connection.commit()
    connection.close()

    with pytest.raises(UnknownStorageFormatError, match="保存形式"):
        SqliteEvaluationRepository.open(path)


def test_foreign_sqlite_files_are_not_read(tmp_path):
    path = tmp_path / "other.sqlite3"
    sqlite3.connect(path).close()

    with pytest.raises(UnknownStorageFormatError):
        SqliteEvaluationRepository.open(path)


def test_create_refuses_to_overwrite_an_existing_database(tmp_path):
    path = tmp_path / "e.sqlite3"
    SqliteEvaluationRepository.create(path, make_plan()).close()

    with pytest.raises(FileExistsError):
        SqliteEvaluationRepository.create(path, make_plan())
