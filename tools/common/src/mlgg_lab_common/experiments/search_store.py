"""探索の履歴・チェックポイントのSQLite保存。

    <searches-dir>/<search-id>/
      search.sqlite3              # 探索問題・候補と由来・要求と評価実行の対応・推定・手法の状態
      search.sqlite3.lock         # 実行中だけ保持する排他ロック
      evaluations/<evaluation-id>/  # 段階2の評価実行（ラウンドごとに1つ。生の対戦結果の正本）

生の対戦結果は段階2の評価実行DBにだけあり、ここへは複製しない。ここが持つのは「どの候補の
どの要求が、どの評価実行のどのケース・試行番号か」という対応と、閉じたラウンドの完了・
未完了の番号、手法の推定・状態である。

書き込みは1つの論理的な区切り（ステップの確定・ラウンドを閉じる）ごとに1トランザクションで
行い、手法の状態もその中で保存する。どこで止まっても「直前の区切りまで」が残る。
"""

from __future__ import annotations

import fcntl
import json
import os
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Self

from ..search.candidate import Candidate, Origin, dump_candidate
from ..search.problem import SearchProblem, dump_problem, load_problem

# "MLGS"（MuvLuv GG Search）。評価実行DB（"MLGE"）と取り違えない。
APPLICATION_ID = 0x4D4C4753
SEARCH_STORAGE_VERSION = 2
DB_FILE = "search.sqlite3"
EVALUATIONS_DIR = "evaluations"

_SCHEMA = """
CREATE TABLE search (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  search_id TEXT NOT NULL,
  format TEXT NOT NULL,
  problem_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  first_step INTEGER NOT NULL
);
CREATE TABLE proposals (
  proposal_number INTEGER PRIMARY KEY,
  step INTEGER NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED')),
  problems_json TEXT NOT NULL
);
CREATE TABLE rounds (
  round_number INTEGER PRIMARY KEY,
  step INTEGER NOT NULL,
  evaluation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  evaluation_stop_reason TEXT,
  submitted_runs INTEGER,
  closed_at TEXT,
  seed TEXT,
  submission_id TEXT,
  submission_digest TEXT
);
CREATE UNIQUE INDEX rounds_submission_id ON rounds (submission_id);
CREATE TABLE round_requests (
  round_number INTEGER NOT NULL REFERENCES rounds(round_number),
  request_number INTEGER NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
  case_id TEXT NOT NULL,
  tag TEXT,
  run_indices_json TEXT NOT NULL,
  completed_json TEXT,
  incomplete_json TEXT,
  PRIMARY KEY (round_number, request_number),
  UNIQUE (round_number, case_id)
);
CREATE TABLE estimates (
  round_number INTEGER NOT NULL REFERENCES rounds(round_number),
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
  estimate_json TEXT NOT NULL,
  PRIMARY KEY (round_number, candidate_id)
);
CREATE TABLE checkpoints (
  checkpoint_number INTEGER PRIMARY KEY,
  step INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  states_json TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stop_reason TEXT,
  detail TEXT
);
"""


class SearchStorageError(Exception):
    """探索のDBではない・知らない保存形式・保存内容が壊れている。"""


class SearchBusyError(Exception):
    """同じ探索を別の実行が実行している。"""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _json(value: Any) -> str:
    # 状態・推定はJSONで保存して読み戻す。NaN等の非標準値は読み戻せない形なので保存しない。
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


@dataclass(frozen=True)
class StoredProposal:
    step: int
    candidate_id: str
    candidate: Candidate
    origin: Origin
    accepted: bool
    problems: tuple[str, ...]


@dataclass(frozen=True)
class StoredRequest:
    round_number: int
    request_number: int
    candidate_id: str
    case_id: str
    tag: str | None
    run_indices: tuple[int, ...]
    # ラウンドを閉じるまで `None`。
    completed: tuple[int, ...] | None
    incomplete: tuple[int, ...] | None


@dataclass(frozen=True)
class StoredRound:
    round_number: int
    step: int
    evaluation_id: str
    status: str
    evaluation_stop_reason: str | None
    submitted_runs: int | None
    seed: str | None = None
    submission_id: str | None = None
    submission_digest: str | None = None


@dataclass(frozen=True)
class StoredCheckpoint:
    step: int
    states: dict[str, Any]


@dataclass(frozen=True)
class StoredSession:
    session_id: int
    started_at: str
    finished_at: str | None
    stop_reason: str | None
    detail: str | None


@dataclass(frozen=True)
class NewRequest:
    request_number: int
    candidate_id: str
    case_id: str
    tag: str | None
    run_indices: tuple[int, ...]


@dataclass(frozen=True)
class ClosedRequest:
    request_number: int
    completed: tuple[int, ...]
    incomplete: tuple[int, ...]


class SqliteSearchStore:
    def __init__(self, path: Path, connection: sqlite3.Connection) -> None:
        self.path = path
        self._db = connection

    @property
    def directory(self) -> Path:
        return self.path.parent

    @property
    def evaluations_dir(self) -> Path:
        return self.directory / EVALUATIONS_DIR

    # -- 作成・オープン ---------------------------------------------------------

    @classmethod
    def create(
        cls,
        path: Path,
        search_id: str,
        problem: SearchProblem,
        starts: Sequence[tuple[str, Candidate, Origin]],
    ) -> Self:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        except FileExistsError as error:
            raise FileExistsError(f"{path}: 既にある探索のDBは作り直さない") from error
        os.close(descriptor)
        store = None
        try:
            store = cls(path, _connect(path))
            with store._transaction() as db:
                _execute_script(db, _SCHEMA)
                db.execute(f"PRAGMA application_id = {APPLICATION_ID}")
                db.execute(f"PRAGMA user_version = {SEARCH_STORAGE_VERSION}")
                db.execute(
                    "INSERT INTO search VALUES (1, ?, ?, ?, ?)",
                    (search_id, problem.format, _json(dump_problem(problem)), _now()),
                )
                for candidate_id, candidate, origin in starts:
                    store._insert_proposal(db, 0, candidate_id, candidate, origin, ())
        except BaseException:
            if store is not None:
                store.close()
            path.unlink(missing_ok=True)
            raise
        return store

    @classmethod
    def open(cls, path: Path) -> Self:
        if not path.is_file():
            raise FileNotFoundError(f"{path}: 探索のDBが無い")
        store = cls(path, _connect(path))
        try:
            application_id = store._db.execute("PRAGMA application_id").fetchone()[0]
            version = store._db.execute("PRAGMA user_version").fetchone()[0]
            if application_id != APPLICATION_ID:
                raise SearchStorageError(f"{path}: 探索のDBではない")
            if version == 1:
                with store._transaction() as db:
                    version = db.execute("PRAGMA user_version").fetchone()[0]
                    if version == 1:
                        db.execute("ALTER TABLE rounds ADD COLUMN seed TEXT")
                        db.execute("ALTER TABLE rounds ADD COLUMN submission_id TEXT")
                        db.execute("ALTER TABLE rounds ADD COLUMN submission_digest TEXT")
                        db.execute(
                            "CREATE UNIQUE INDEX rounds_submission_id ON rounds (submission_id)"
                        )
                        db.execute(f"PRAGMA user_version = {SEARCH_STORAGE_VERSION}")
                        version = SEARCH_STORAGE_VERSION
            if version != SEARCH_STORAGE_VERSION:
                raise SearchStorageError(
                    f"{path}: 保存形式 {version} はこのツール（{SEARCH_STORAGE_VERSION}）と違う。"
                    "黙って読み替えない"
                )
        except BaseException:
            store.close()
            raise
        return store

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
    def exclusive_run(self) -> Iterator[None]:
        lock_path = self.path.with_name(self.path.name + ".lock")
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise SearchBusyError(f"{self.path}: 別の実行がこの探索を実行している") from error
            yield
        finally:
            os.close(descriptor)

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield self._db
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        self._db.execute("COMMIT")

    # -- 読み出し ----------------------------------------------------------------

    def search_id(self) -> str:
        return str(self._db.execute("SELECT search_id FROM search").fetchone()[0])

    def load_problem(self) -> SearchProblem:
        row = self._db.execute("SELECT problem_json FROM search").fetchone()
        return load_problem(json.loads(row[0]))

    def proposals(self) -> list[StoredProposal]:
        rows = self._db.execute(
            "SELECT step, candidate_id, candidate_json, origin_json, status, problems_json"
            " FROM proposals ORDER BY proposal_number"
        ).fetchall()
        return [
            StoredProposal(
                step=row[0],
                candidate_id=row[1],
                candidate=Candidate.model_validate(json.loads(row[2])),
                origin=Origin.model_validate(json.loads(row[3])),
                accepted=row[4] == "ACCEPTED",
                problems=tuple(json.loads(row[5])),
            )
            for row in rows
        ]

    def rounds(self) -> list[StoredRound]:
        rows = self._db.execute(
            "SELECT round_number, step, evaluation_id, status, evaluation_stop_reason,"
            " submitted_runs, seed, submission_id, submission_digest"
            " FROM rounds ORDER BY round_number"
        ).fetchall()
        return [StoredRound(*row) for row in rows]

    def requests(self) -> list[StoredRequest]:
        rows = self._db.execute(
            "SELECT round_number, request_number, candidate_id, case_id, tag, run_indices_json,"
            " completed_json, incomplete_json FROM round_requests"
            " ORDER BY round_number, request_number"
        ).fetchall()
        return [
            StoredRequest(
                round_number=row[0],
                request_number=row[1],
                candidate_id=row[2],
                case_id=row[3],
                tag=row[4],
                run_indices=tuple(json.loads(row[5])),
                completed=None if row[6] is None else tuple(json.loads(row[6])),
                incomplete=None if row[7] is None else tuple(json.loads(row[7])),
            )
            for row in rows
        ]

    def estimates(self) -> list[tuple[int, str, dict[str, Any]]]:
        rows = self._db.execute(
            "SELECT round_number, candidate_id, estimate_json FROM estimates"
            " ORDER BY round_number, candidate_id"
        ).fetchall()
        return [(row[0], row[1], json.loads(row[2])) for row in rows]

    def latest_checkpoint(self) -> StoredCheckpoint | None:
        row = self._db.execute(
            "SELECT step, states_json FROM checkpoints ORDER BY checkpoint_number DESC LIMIT 1"
        ).fetchone()
        return None if row is None else StoredCheckpoint(row[0], json.loads(row[1]))

    def sessions(self) -> list[StoredSession]:
        rows = self._db.execute(
            "SELECT session_id, started_at, finished_at, stop_reason, detail FROM sessions"
            " ORDER BY session_id"
        ).fetchall()
        return [StoredSession(*row) for row in rows]

    # -- 書き込み ----------------------------------------------------------------

    def start_session(self) -> int:
        with self._transaction() as db:
            cursor = db.execute("INSERT INTO sessions (started_at) VALUES (?)", (_now(),))
            return int(cursor.lastrowid or 0)

    def finish_session(self, session_id: int, stop_reason: str, detail: str | None) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE sessions SET finished_at = ?, stop_reason = ?, detail = ?"
                " WHERE session_id = ?",
                (_now(), stop_reason, detail, session_id),
            )

    def commit_step(
        self,
        step: int,
        proposals: Sequence[tuple[str, Candidate, Origin, Sequence[str]]],
        states: dict[str, Any],
        *,
        round_number: int | None = None,
        evaluation_id: str | None = None,
        requests: Sequence[NewRequest] = (),
        seed: str | None = None,
        submission: tuple[str, str] | None = None,
    ) -> None:
        """1ステップの提案・（あれば）新しいラウンドと要求・手法の状態を確定する。"""
        with self._transaction() as db:
            for candidate_id, candidate, origin, problems in proposals:
                self._insert_proposal(db, step, candidate_id, candidate, origin, problems)
            if round_number is not None:
                submission_id, digest = submission or (None, None)
                db.execute(
                    "INSERT INTO rounds (round_number, step, evaluation_id, status, seed,"
                    " submission_id, submission_digest) VALUES (?, ?, ?, 'OPEN', ?, ?, ?)",
                    (round_number, step, evaluation_id, seed, submission_id, digest),
                )
                for request in requests:
                    db.execute(
                        "INSERT INTO round_requests (round_number, request_number, candidate_id,"
                        " case_id, tag, run_indices_json) VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            round_number,
                            request.request_number,
                            request.candidate_id,
                            request.case_id,
                            request.tag,
                            _json(list(request.run_indices)),
                        ),
                    )
            self._insert_checkpoint(db, step, states)

    def close_round(
        self,
        round_number: int,
        *,
        step: int,
        evaluation_stop_reason: str,
        submitted_runs: int,
        outcomes: Sequence[ClosedRequest],
        estimates: dict[str, dict[str, Any]],
        states: dict[str, Any],
    ) -> None:
        """ラウンドの完了・未完了の番号、推定、観測後の手法の状態を1トランザクションで残す。

        既に閉じたラウンドは閉じ直さない（観測・予算の二重計上を防ぐ）。
        """
        with self._transaction() as db:
            updated = db.execute(
                "UPDATE rounds SET status = 'CLOSED', evaluation_stop_reason = ?,"
                " submitted_runs = ?, closed_at = ? WHERE round_number = ? AND status = 'OPEN'",
                (evaluation_stop_reason, submitted_runs, _now(), round_number),
            ).rowcount
            if updated != 1:
                raise SearchStorageError(f"ラウンド {round_number} は開いていない")
            for outcome in outcomes:
                db.execute(
                    "UPDATE round_requests SET completed_json = ?, incomplete_json = ?"
                    " WHERE round_number = ? AND request_number = ?",
                    (
                        _json(list(outcome.completed)),
                        _json(list(outcome.incomplete)),
                        round_number,
                        outcome.request_number,
                    ),
                )
            for candidate_id, estimate in estimates.items():
                db.execute(
                    "INSERT INTO estimates VALUES (?, ?, ?)",
                    (round_number, candidate_id, _json(estimate)),
                )
            self._insert_checkpoint(db, step, states)

    def _insert_proposal(
        self,
        db: sqlite3.Connection,
        step: int,
        candidate_id: str,
        candidate: Candidate,
        origin: Origin,
        problems: Sequence[str],
    ) -> None:
        candidate_json = _json(dump_candidate(candidate))
        accepted = not problems
        if accepted:
            db.execute(
                "INSERT OR IGNORE INTO candidates VALUES (?, ?, ?)",
                (candidate_id, candidate_json, step),
            )
        db.execute(
            "INSERT INTO proposals (step, candidate_id, candidate_json, origin_json, status,"
            " problems_json) VALUES (?, ?, ?, ?, ?, ?)",
            (
                step,
                candidate_id,
                candidate_json,
                _json(origin.model_dump(mode="json")),
                "ACCEPTED" if accepted else "REJECTED",
                _json(list(problems)),
            ),
        )

    def _insert_checkpoint(self, db: sqlite3.Connection, step: int, states: dict[str, Any]) -> None:
        db.execute(
            "INSERT INTO checkpoints (step, created_at, states_json) VALUES (?, ?, ?)",
            (step, _now(), _json(states)),
        )


def _execute_script(db: sqlite3.Connection, script: str) -> None:
    # `executescript` は暗黙にCOMMITするため、トランザクションの中では文ごとに流す。
    for statement in script.split(";"):
        if statement.strip():
            db.execute(statement)


def _connect(path: Path) -> sqlite3.Connection:
    # 自動のトランザクション管理を切り、`BEGIN IMMEDIATE` を明示的に使う。
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("PRAGMA foreign_keys = ON")
    return connection
