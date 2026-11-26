"""評価実行の保存のSQLite実装。

1プロセスから1つずつ書く前提で使う（同じDBへ複数の実行を同時に走らせない）。書き込みは
すべて `BEGIN IMMEDIATE` のトランザクションで行い、要求の予約・結果の反映が途中で
切れても、DBには「確保済みの要求」か「反映済みの結果」のどちらかだけが残る。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Self

from ..api.client import HttpExchange
from ..api.contracts import (
    EvaluationRequest,
    ExecutionEnvironment,
    ExpectedSlot,
    ValidatedResponse,
    contract_for,
)
from ..evaluation.budget import BudgetExhaustedError, Counters, remaining_runs
from ..evaluation.identity import canonical_json, observation_digest, trial_key
from ..evaluation.models import (
    PLAN_FORMAT_VERSION,
    Budget,
    EvaluationPlan,
    ExecutionSettings,
    PlannedCase,
)
from .migrations import APPLICATION_ID, MIGRATIONS, STORAGE_FORMAT_VERSION
from .repository import (
    AttemptRecord,
    EnvironmentMismatchError,
    ResultConflictError,
    SaveOutcome,
    SessionRecord,
    StoredResult,
)


class UnknownStorageFormatError(Exception):
    """このツールのDBではない、またはこのツールが知らない保存形式。"""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class SqliteEvaluationRepository:
    def __init__(self, path: Path, connection: sqlite3.Connection) -> None:
        self.path = path
        self._db = connection

    # -- 作成・オープン ---------------------------------------------------------

    @classmethod
    def create(cls, path: Path, plan: EvaluationPlan) -> Self:
        if path.exists():
            raise FileExistsError(f"{path}: 既にある評価実行のDBは作り直さない")
        path.parent.mkdir(parents=True, exist_ok=True)
        repository = cls(path, _connect(path))
        try:
            with repository._transaction() as db:
                for script in MIGRATIONS:
                    _execute_script(db, script)
                db.execute(f"PRAGMA application_id = {APPLICATION_ID}")
                db.execute(f"PRAGMA user_version = {STORAGE_FORMAT_VERSION}")
                repository._insert_plan(db, plan)
        except BaseException:
            repository.close()
            path.unlink(missing_ok=True)
            raise
        return repository

    @classmethod
    def open(cls, path: Path) -> Self:
        if not path.is_file():
            raise FileNotFoundError(f"{path}: 評価実行のDBが無い")
        repository = cls(path, _connect(path))
        try:
            repository._check_and_migrate()
        except BaseException:
            repository.close()
            raise
        return repository

    def _check_and_migrate(self) -> None:
        application_id = self._db.execute("PRAGMA application_id").fetchone()[0]
        version = self._db.execute("PRAGMA user_version").fetchone()[0]
        if application_id != APPLICATION_ID:
            raise UnknownStorageFormatError(f"{self.path}: 評価実行のDBではない")
        if version > STORAGE_FORMAT_VERSION:
            raise UnknownStorageFormatError(
                f"{self.path}: 保存形式 {version} はこのツール（{STORAGE_FORMAT_VERSION} まで）より"
                "新しい。ツールを更新してから開く"
            )
        for target in range(version + 1, STORAGE_FORMAT_VERSION + 1):
            with self._transaction() as db:
                _execute_script(db, MIGRATIONS[target - 1])
                db.execute(f"PRAGMA user_version = {target}")

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
        self._db.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield self._db
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        self._db.execute("COMMIT")

    # -- 計画 -------------------------------------------------------------------

    def _insert_plan(self, db: sqlite3.Connection, plan: EvaluationPlan) -> None:
        db.execute(
            "INSERT INTO evaluations (evaluation_id, format, contract_id, plan_format_version,"
            " seed, settings_json, max_submitted_runs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                plan.evaluation_id,
                plan.contract.format,
                plan.contract.contract_id,
                PLAN_FORMAT_VERSION,
                plan.seed,
                plan.settings.model_dump_json(by_alias=True),
                plan.budget.max_submitted_runs,
                plan.created_at,
            ),
        )
        for ordinal, case in enumerate(plan.cases):
            db.execute(
                "INSERT INTO cases (case_id, ordinal, match_fingerprint, input_schema_version,"
                " input_json, match_request_json, expected_slots_json)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    case.case_id,
                    ordinal,
                    case.match_fingerprint,
                    case.input_snapshot.get("schemaVersion"),
                    canonical_json(case.input_snapshot),
                    canonical_json(case.match_request),
                    canonical_json([_slot_json(slot) for slot in case.expected_slots]),
                ),
            )
            db.executemany(
                "INSERT INTO trials (case_id, run_index, trial_key) VALUES (?, ?, ?)",
                [
                    (case.case_id, index, trial_key(case.match_fingerprint, plan.seed, index))
                    for index in case.run_indices
                ],
            )

    def load_plan(self) -> EvaluationPlan:
        row = self._db.execute(
            "SELECT evaluation_id, format, contract_id, plan_format_version, seed, settings_json,"
            " max_submitted_runs, created_at FROM evaluations"
        ).fetchone()
        (evaluation_id, fmt, contract_id, plan_version, seed, settings, budget, created_at) = row
        contract = contract_for(fmt)
        if plan_version != PLAN_FORMAT_VERSION or contract_id != contract.contract_id:
            raise UnknownStorageFormatError(
                f"{self.path}: 計画の形式 {plan_version} / 契約 {contract_id} は"
                f"このツール（{PLAN_FORMAT_VERSION} / {contract.contract_id}）と違う"
            )
        runs: dict[str, list[int]] = {}
        for case_id, run_index in self._db.execute(
            "SELECT case_id, run_index FROM trials ORDER BY trial_id"
        ):
            runs.setdefault(case_id, []).append(run_index)
        rows = self._db.execute(
            "SELECT case_id, match_fingerprint, input_json, match_request_json,"
            " expected_slots_json FROM cases ORDER BY ordinal"
        ).fetchall()
        cases = tuple(
            PlannedCase(
                case_id=case_id,
                input_snapshot=json.loads(input_json),
                match_request=json.loads(match_request_json),
                expected_slots=tuple(_slot_of(s) for s in json.loads(slots_json)),
                run_indices=tuple(runs.get(case_id, ())),
                match_fingerprint=fingerprint,
            )
            for case_id, fingerprint, input_json, match_request_json, slots_json in rows
        )
        return EvaluationPlan(
            evaluation_id=evaluation_id,
            contract=contract,
            seed=seed,
            settings=ExecutionSettings.model_validate_json(settings),
            budget=Budget(max_submitted_runs=budget),
            cases=cases,
            created_at=created_at,
        )

    def environment(self) -> ExecutionEnvironment | None:
        row = self._db.execute(
            "SELECT catalog_revision, engine_revision, seed_derivation_version,"
            " environment_contract_id FROM evaluations"
        ).fetchone()
        return None if row[0] is None else ExecutionEnvironment(*row)

    def pending_trials(self) -> list[tuple[str, int]]:
        return [
            (case_id, run_index)
            for case_id, run_index in self._db.execute(
                "SELECT t.case_id, t.run_index FROM trials t JOIN cases c USING (case_id)"
                " LEFT JOIN results r USING (trial_id) WHERE r.trial_id IS NULL"
                " ORDER BY c.ordinal, t.run_index"
            )
        ]

    def counters(self) -> Counters:
        planned, submitted, completed, attempts = self._db.execute(
            "SELECT (SELECT COUNT(*) FROM trials),"
            " (SELECT COALESCE(SUM(run_count), 0) FROM attempts),"
            " (SELECT COUNT(*) FROM results),"
            " (SELECT COUNT(*) FROM attempts)"
        ).fetchone()
        return Counters(planned, submitted, completed, attempts)

    # -- 実行の履歴 -------------------------------------------------------------

    def start_session(self) -> int:
        with self._transaction() as db:
            cursor = db.execute("INSERT INTO sessions (started_at) VALUES (?)", (_now(),))
        return _rowid(cursor)

    def finish_session(self, session_id: int, stop_reason: str, detail: str | None) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE sessions SET finished_at = ?, stop_reason = ?, detail = ?"
                " WHERE session_id = ?",
                (_now(), stop_reason, detail, session_id),
            )

    def abandon_in_flight(self) -> int:
        with self._transaction() as db:
            cursor = db.execute(
                "UPDATE attempts SET status = 'ABANDONED', failure_kind = 'ABANDONED',"
                " failure_message = '送信中のまま実行が終わった（応答の有無は不明）'"
                " WHERE status = 'IN_FLIGHT'"
            )
        return cursor.rowcount

    def reserve_attempt(self, session_id: int, request: EvaluationRequest) -> int:
        with self._transaction() as db:
            (max_runs,) = db.execute("SELECT max_submitted_runs FROM evaluations").fetchone()
            remaining = remaining_runs(max_runs, self.counters())
            if request.run_count > remaining:
                raise BudgetExhaustedError(
                    f"送信予算の残り {remaining} 試行では {request.run_count} 試行を送れない"
                )
            cursor = db.execute(
                "INSERT INTO attempts (session_id, status, run_count, request_json, reserved_at)"
                " VALUES (?, 'IN_FLIGHT', ?, ?, ?)",
                (session_id, request.run_count, canonical_json(request.body()), _now()),
            )
            attempt_id = _rowid(cursor)
            for case in request.cases:
                for run_index in case.run_indices:
                    db.execute(
                        "INSERT INTO attempt_trials (attempt_id, trial_id, outcome)"
                        " SELECT ?, trial_id, 'PENDING' FROM trials"
                        " WHERE case_id = ? AND run_index = ?",
                        (attempt_id, case.case_id, run_index),
                    )
                    if db.execute("SELECT changes()").fetchone()[0] != 1:
                        raise ValueError(f"計画に無い試行 {case.case_id!r}#{run_index} は送れない")
        return attempt_id

    def record_failure(
        self,
        attempt_id: int,
        exchange: HttpExchange | None,
        kind: str,
        code: str | None,
        message: str,
    ) -> None:
        with self._transaction() as db:
            self._finish_attempt(
                db, attempt_id, "FAILED", exchange, kind=kind, code=code, message=message
            )

    def record_success(
        self, attempt_id: int, exchange: HttpExchange, response: ValidatedResponse
    ) -> SaveOutcome:
        try:
            with self._transaction() as db:
                self._establish_environment(db, response.environment)
                outcome = self._insert_results(db, attempt_id, response)
                self._finish_attempt(
                    db,
                    attempt_id,
                    "SUCCEEDED",
                    exchange,
                    environment=response.environment,
                    completed=len(response.completed),
                    outcome=outcome,
                )
        except EnvironmentMismatchError as error:
            self._record_rejected(attempt_id, exchange, response, "ENVIRONMENT_MISMATCH", error)
            raise
        except ResultConflictError as error:
            self._record_rejected(attempt_id, exchange, response, "RESULT_CONFLICT", error)
            raise
        return outcome

    def _record_rejected(
        self,
        attempt_id: int,
        exchange: HttpExchange,
        response: ValidatedResponse,
        kind: str,
        error: Exception,
    ) -> None:
        with self._transaction() as db:
            self._finish_attempt(
                db,
                attempt_id,
                "FAILED",
                exchange,
                kind=kind,
                message=str(error),
                environment=response.environment,
                completed=len(response.completed),
            )

    def _establish_environment(
        self, db: sqlite3.Connection, environment: ExecutionEnvironment
    ) -> None:
        established = self.environment()
        if established is None:
            # 初回は保存済みの環境が無いので、設定で固定した期待revisionと照合する。APIは
            # 期待revisionの不一致を422で拒むが、200で返った応答もここで受理しない。
            settings = self.load_plan().settings
            differences = [
                f"{name}: 期待 {expected!r} → 応答 {actual!r}"
                for name, expected, actual in (
                    (
                        "catalogRevision",
                        settings.expected_catalog_revision,
                        environment.catalog_revision,
                    ),
                    (
                        "engineRevision",
                        settings.expected_engine_revision,
                        environment.engine_revision,
                    ),
                )
                if expected is not None and expected != actual
            ]
            if differences:
                raise EnvironmentMismatchError(
                    "設定した期待revisionと実行環境が違う: " + "; ".join(differences)
                )
            db.execute(
                "UPDATE evaluations SET catalog_revision = ?, engine_revision = ?,"
                " seed_derivation_version = ?, environment_contract_id = ?,"
                " environment_established_at = ?",
                (
                    environment.catalog_revision,
                    environment.engine_revision,
                    environment.seed_derivation_version,
                    environment.contract_id,
                    _now(),
                ),
            )
            return
        differences = established.differences(environment)
        if differences:
            raise EnvironmentMismatchError(
                "保存済みの結果と実行環境が違う: " + "; ".join(differences)
            )

    def _insert_results(
        self, db: sqlite3.Connection, attempt_id: int, response: ValidatedResponse
    ) -> SaveOutcome:
        new = duplicate = 0
        conflicts: list[str] = []
        recorded_at = _now()
        for run in response.completed:
            trial_id = self._trial_id(db, run.case_id, run.run_index)
            digest = observation_digest(run.observation)
            existing = db.execute(
                "SELECT observation_digest FROM results WHERE trial_id = ?", (trial_id,)
            ).fetchone()
            if existing is not None:
                if existing[0] == digest:
                    duplicate += 1
                else:
                    conflicts.append(f"{run.case_id!r}#{run.run_index}")
                continue
            db.execute(
                "INSERT INTO results (trial_id, attempt_id, observation_format, observation_json,"
                " observation_digest, outcome, completion_reason, completed_turn, recorded_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    trial_id,
                    attempt_id,
                    response.environment.contract_id,
                    canonical_json(run.observation),
                    digest,
                    run.observation.get("outcome"),
                    run.observation.get("completionReason"),
                    run.observation.get("completedTurn"),
                    recorded_at,
                ),
            )
            new += 1
        if conflicts:
            raise ResultConflictError(
                "同じ試行から保存済みと違う観測値が返った: " + ", ".join(conflicts)
            )
        for run in response.completed:
            self._mark(db, attempt_id, run.case_id, run.run_index, "COMPLETED")
        for case_id, run_index in response.incomplete:
            self._mark(db, attempt_id, case_id, run_index, "INCOMPLETE")
        return SaveOutcome(new_results=new, duplicate_results=duplicate)

    def _mark(
        self, db: sqlite3.Connection, attempt_id: int, case_id: str, run_index: int, outcome: str
    ) -> None:
        db.execute(
            "UPDATE attempt_trials SET outcome = ? WHERE attempt_id = ? AND trial_id = ?",
            (outcome, attempt_id, self._trial_id(db, case_id, run_index)),
        )

    def _trial_id(self, db: sqlite3.Connection, case_id: str, run_index: int) -> int:
        row = db.execute(
            "SELECT trial_id FROM trials WHERE case_id = ? AND run_index = ?",
            (case_id, run_index),
        ).fetchone()
        if row is None:
            raise ValueError(f"計画に無い試行 {case_id!r}#{run_index}")
        return int(row[0])

    def _finish_attempt(
        self,
        db: sqlite3.Connection,
        attempt_id: int,
        status: str,
        exchange: HttpExchange | None,
        *,
        kind: str | None = None,
        code: str | None = None,
        message: str | None = None,
        environment: ExecutionEnvironment | None = None,
        completed: int | None = None,
        outcome: SaveOutcome | None = None,
    ) -> None:
        db.execute(
            "UPDATE attempts SET status = ?, started_at = ?, finished_at = ?, http_status = ?,"
            " response_body = ?, transport_error = ?, failure_kind = ?, failure_code = ?,"
            " failure_message = ?, completed_runs = ?, new_results = ?, duplicate_results = ?,"
            " catalog_revision = ?, engine_revision = ?, seed_derivation_version = ?"
            " WHERE attempt_id = ? AND status = 'IN_FLIGHT'",
            (
                status,
                exchange.started_at if exchange else None,
                exchange.finished_at if exchange else _now(),
                exchange.status if exchange else None,
                exchange.body if exchange else None,
                exchange.transport_error if exchange else None,
                kind,
                code,
                message,
                completed,
                outcome.new_results if outcome else None,
                outcome.duplicate_results if outcome else None,
                environment.catalog_revision if environment else None,
                environment.engine_revision if environment else None,
                environment.seed_derivation_version if environment else None,
                attempt_id,
            ),
        )
        if db.execute("SELECT changes()").fetchone()[0] != 1:
            raise ValueError(f"要求 {attempt_id} は送信中ではない（既に記録済み）")

    # -- 読み出し ---------------------------------------------------------------

    def results(self) -> list[StoredResult]:
        return [
            StoredResult(case_id, run_index, json.loads(observation), attempt_id)
            for case_id, run_index, observation, attempt_id in self._db.execute(
                "SELECT t.case_id, t.run_index, r.observation_json, r.attempt_id"
                " FROM results r JOIN trials t USING (trial_id) JOIN cases c USING (case_id)"
                " ORDER BY c.ordinal, t.run_index"
            )
        ]

    def attempts(self) -> list[AttemptRecord]:
        return [
            AttemptRecord(*row)
            for row in self._db.execute(
                "SELECT attempt_id, session_id, status, run_count, http_status, transport_error,"
                " failure_kind, failure_code, failure_message, completed_runs, new_results,"
                " duplicate_results FROM attempts ORDER BY attempt_id"
            )
        ]

    def attempt_trials(self, attempt_id: int) -> dict[tuple[str, int], str]:
        return {
            (case_id, run_index): outcome
            for case_id, run_index, outcome in self._db.execute(
                "SELECT t.case_id, t.run_index, a.outcome FROM attempt_trials a"
                " JOIN trials t USING (trial_id) WHERE a.attempt_id = ?",
                (attempt_id,),
            )
        }

    def sessions(self) -> list[SessionRecord]:
        return [
            SessionRecord(*row)
            for row in self._db.execute(
                "SELECT session_id, started_at, finished_at, stop_reason, detail FROM sessions"
                " ORDER BY session_id"
            )
        ]


def _connect(path: Path) -> sqlite3.Connection:
    # 自動のトランザクション管理を切り、`BEGIN IMMEDIATE` を明示的に使う。
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _execute_script(db: sqlite3.Connection, script: str) -> None:
    # `executescript` は暗黙にCOMMITするので、文ごとに流してトランザクション内に留める。
    # トリガー本体の `;` で切らないよう、`sqlite3.complete_statement` で文の終わりを見る。
    statement = ""
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            if statement.strip():
                db.execute(statement)
            statement = ""
    if statement.strip():
        db.execute(statement)


def _rowid(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:  # pragma: no cover - INSERT は必ず行IDを持つ
        raise RuntimeError("行IDが取れない")
    return cursor.lastrowid


def _slot_json(slot: ExpectedSlot) -> dict[str, Any]:
    return {
        "side": slot.side,
        "formationNumber": slot.formation_number,
        "unitIndex": slot.unit_index,
        "unitDefinitionId": slot.unit_definition_id,
    }


def _slot_of(raw: dict[str, Any]) -> ExpectedSlot:
    return ExpectedSlot(
        side=raw["side"],
        formation_number=raw["formationNumber"],
        unit_index=raw["unitIndex"],
        unit_definition_id=raw["unitDefinitionId"],
    )
