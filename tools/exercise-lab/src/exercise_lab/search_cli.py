"""戦術演習の対話型探索を操作するCLI。"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from enum import StrEnum
from itertools import islice
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from pydantic import ValidationError

from mlgg_lab_common.cli.commands import ACCESS_KEY_ENV
from mlgg_lab_common.evaluation.identity import canonical_json
from mlgg_lab_common.evaluation.plan import PlanError
from mlgg_lab_common.experiments.layout import create_search, open_search
from mlgg_lab_common.experiments.search_store import (
    SearchBusyError,
    SearchStorageError,
    SqliteSearchStore,
)
from mlgg_lab_common.inputs.catalog import CatalogClient, LabApiError
from mlgg_lab_common.models import ConfigError
from mlgg_lab_common.search.candidate import dump_candidate, effective_gears
from mlgg_lab_common.search.method import IncompatibleMethodError
from mlgg_lab_common.search.operations import OperationError
from mlgg_lab_common.search.problem import SearchProblemError
from mlgg_lab_common.search.runner import SearchStopReason, run_search
from mlgg_lab_common.storage.layout import open_evaluation

from .search_config import load_exercise_search_config, plan_exercise_search
from .search_round import (
    RoundInput,
    confirmation_reserve,
    enumerate_candidates,
    interactive_method,
    saved_candidates,
)
from .search_space import EXERCISE_SEARCH

app = typer.Typer(help="対話型の戦術演習探索を作成・実行・再開する")
AccessKey = Annotated[str | None, typer.Option("--access-key", envvar=ACCESS_KEY_ENV)]
Directory = Annotated[Path, typer.Argument(help="search init が返した searchDir")]
RequestCap = Annotated[
    int,
    typer.Option(min=1, help="HTTPリクエストあたりの試行数上限。保存済みAPI上限も適用"),
]
RequestLimit = Annotated[int | None, typer.Option(min=1, help="この実行で送信するリクエスト数上限")]
SEARCH_ERRORS = (
    OSError,
    ConfigError,
    ValidationError,
    SearchProblemError,
    PlanError,
    LabApiError,
    SearchStorageError,
    SearchBusyError,
    IncompatibleMethodError,
    OperationError,
)


class KindOption(StrEnum):
    MEMORY = "memory"
    PLACEMENT = "placement"
    GEAR = "gear"
    UNIT = "unit"


class PhaseOption(StrEnum):
    SCREENING = "screening"
    CONFIRMATION = "confirmation"


@contextmanager
def open_exercise_search(directory: Path) -> Iterator[SqliteSearchStore]:
    with open_search(directory) as store:
        if store.load_problem().format != EXERCISE_SEARCH.format:
            raise ConfigError(f"{directory}: 戦術演習の探索ディレクトリが必要")
        yield store


def emit(payload: dict) -> None:
    typer.echo(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False))


def abort(error: Exception) -> NoReturn:
    typer.echo(str(error), err=True)
    raise typer.Exit(1)


@app.command()
def init(
    config: Annotated[Path, typer.Argument(help="探索条件を記した evaluation.yaml")],
    search_id: Annotated[str | None, typer.Option("--id")] = None,
    access_key: AccessKey = None,
) -> None:
    """設定と編成ライブラリを解決して探索を作成する。"""
    try:
        if search_id is not None and not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", search_id
        ):
            raise ConfigError("--id は英数字で始まり、英数字・ピリオド・_・- で指定する")
        settings = load_exercise_search_config(config).execution.api
        with CatalogClient(
            settings.base_url, timeout_seconds=settings.timeout_seconds, access_key=access_key
        ) as client:
            catalog = client.fetch_catalog()
        plan = plan_exercise_search(config, method=interactive_method().binding(), catalog=catalog)
        _, store = create_search(
            plan.searches_dir, plan.problem, EXERCISE_SEARCH, search_id=search_id
        )
        with store:
            emit(status_payload(store))
    except SEARCH_ERRORS as error:
        abort(error)


@app.command()
def candidates(
    directory: Directory,
    parent: Annotated[str | None, typer.Option(help="変更元の candidateId")] = None,
    kind: Annotated[KindOption | None, typer.Option(help="列挙する変更の種類")] = None,
    limit: Annotated[int, typer.Option(min=1)] = 50,
    offset: Annotated[int, typer.Option(min=0)] = 0,
) -> None:
    """登録済みの候補、または起点から作れる変更候補をJSONで返す。"""
    try:
        with open_exercise_search(directory) as store:
            if (parent is None) != (kind is None):
                raise ConfigError("--parent と --kind は両方指定する")
            registered = saved_candidates(store)
            problem = store.load_problem()
            if parent is None:
                entries = (
                    {
                        "candidateId": cid,
                        "candidate": dump_candidate(candidate),
                        "effectiveGears": [
                            [
                                gear.model_dump(mode="json")
                                for gear in effective_gears(problem, unit)
                            ]
                            for unit in candidate.units
                        ],
                    }
                    for cid, candidate in registered.items()
                )
            else:
                if parent not in registered:
                    raise ConfigError(f"起点候補 {parent} が見つからない")
                entries = enumerate_candidates(problem, registered[parent], kind)
            page = list(islice(entries, offset, offset + limit + 1))
            emit(
                {
                    "candidates": page[:limit],
                    "offset": offset,
                    "nextOffset": offset + limit if len(page) > limit else None,
                }
            )
    except SEARCH_ERRORS as error:
        abort(error)


@app.command()
def status(
    directory: Directory,
    trials: Annotated[
        bool, typer.Option(help="候補ごとの要求済み・完了済み試行番号を含める")
    ] = False,
) -> None:
    """探索の候補・完了試行・送信予算・再開対象をJSONで返す。"""
    try:
        with open_exercise_search(directory) as store:
            emit(status_payload(store, include_trials=trials))
    except SEARCH_ERRORS as error:
        abort(error)


@app.command("round")
def execute_round(
    directory: Directory,
    request: Annotated[str, typer.Argument(help="ラウンド指示のJSONファイル。- は標準入力")],
    max_runs_per_request: RequestCap = 80,
    max_requests: RequestLimit = None,
    access_key: AccessKey = None,
) -> None:
    """候補と試行条件を受け取り、1ラウンドを実行する。"""
    try:
        raw = sys.stdin.read() if request == "-" else Path(request).read_text(encoding="utf-8")
        command = RoundInput.model_validate_json(raw)
        digest = hashlib.sha256(
            canonical_json(command.model_dump(mode="json", by_alias=True)).encode()
        ).hexdigest()
        _execute(directory, access_key, max_runs_per_request, max_requests, command, digest)
    except SEARCH_ERRORS as error:
        abort(error)


@app.command()
def resume(
    directory: Directory,
    max_runs_per_request: RequestCap = 80,
    max_requests: RequestLimit = None,
    close_partial: Annotated[
        bool, typer.Option(help="送信せず完了済みの試行でラウンドを閉じる")
    ] = False,
    access_key: AccessKey = None,
) -> None:
    """開いているラウンドの未完了試行を再開する。"""
    try:
        _execute(
            directory, access_key, max_runs_per_request, max_requests, close_partial=close_partial
        )
    except SEARCH_ERRORS as error:
        abort(error)


def _execute(
    directory: Path,
    access_key: str | None,
    max_runs_per_request: int,
    max_requests: int | None,
    command: RoundInput | None = None,
    digest: str = "",
    *,
    close_partial: bool = False,
) -> None:
    with open_exercise_search(directory) as store:
        method = interactive_method(store, command)
        settings = store.load_problem().execution.api
        try:
            with settings.http_client(access_key=access_key) as transport:
                report = run_search(
                    store,
                    method,
                    EXERCISE_SEARCH,
                    transport,
                    max_steps=0 if command is None else 1,
                    submission=None if command is None else (command.id, digest),
                    max_runs_per_request=max_runs_per_request,
                    max_requests=max_requests,
                    close_open_round=close_partial,
                )
        except KeyboardInterrupt:
            payload = status_payload(store)
            payload["execution"] = {"stopReason": "INTERRUPTED"}
            emit(payload)
            raise typer.Exit(130) from None
        payload = status_payload(store)
        payload["execution"] = {
            "stopReason": report.stop_reason,
            "evaluationStopReason": report.evaluation_stop_reason,
            "detail": report.detail,
            "roundsClosed": report.rounds_closed,
        }
        if command is not None:
            payload["execution"]["roundId"] = command.id
        else:
            attempted = payload["rounds"][-1] if report.rounds_closed else payload["openRound"]
            if attempted is not None:
                payload["execution"]["roundId"] = attempted["roundId"]
        emit(payload)
        if report.stop_reason is SearchStopReason.INVALID_REQUEST:
            raise typer.Exit(1)
        if report.stop_reason is not SearchStopReason.STEP_LIMIT_REACHED:
            raise typer.Exit(2 if payload["openRound"] is not None else 1)


def status_payload(store: SqliteSearchStore, *, include_trials: bool = False) -> dict:
    problem = store.load_problem()
    rounds = []
    saved_rounds = store.rounds()
    requests = defaultdict(list)
    for request in store.requests():
        requests[request.round_number].append(request)
    submitted = confirmation_submitted = 0
    for round_ in saved_rounds:
        with open_evaluation(store.evaluations_dir / round_.evaluation_id) as repo:
            plan = repo.load_plan()
            with repo.read_transaction():
                counters = repo.counters()
                sessions = repo.sessions()
                completed = defaultdict(list)
                if include_trials and round_.status == "OPEN":
                    for result in repo.results():
                        completed[result.case_id].append(result.run_index)
            if sessions:
                last_reason = sessions[-1].stop_reason
                if last_reason is None:
                    last_reason = "RUNNING" if repo.is_running() else "INTERRUPTED"
            else:
                last_reason = None
        rows = []
        for request in requests[round_.round_number]:
            row = {
                "candidateId": request.candidate_id,
                "caseId": request.case_id,
                "plannedRuns": len(request.run_indices),
            }
            if include_trials:
                row.update(
                    {
                        "runIndices": request.run_indices,
                        "completedRunIndices": (
                            request.completed
                            if request.completed is not None
                            else sorted(completed[request.case_id])
                        ),
                    }
                )
            rows.append(row)
        rounds.append(
            {
                "roundNumber": round_.round_number,
                "roundId": round_.submission_id,
                "evaluationId": round_.evaluation_id,
                "status": round_.status,
                "seed": plan.seed,
                "plannedRuns": counters.planned_runs,
                "completedRuns": counters.completed_trials,
                "submittedRuns": counters.submitted_runs,
                "requests": rows,
                "evaluationStopReason": round_.evaluation_stop_reason or last_reason,
            }
        )
        submitted += counters.submitted_runs
        if plan.seed == problem.method.settings.get("trials", {}).get("confirmationSeed"):
            confirmation_submitted += counters.submitted_runs
    total = problem.execution.budget.max_submitted_runs
    starts = list(dict.fromkeys(candidate.candidate_id for candidate in problem.starts))
    reserve = confirmation_reserve(problem, len(starts), confirmation_submitted)
    return {
        "searchId": store.search_id(),
        "searchDir": str(store.directory.resolve()),
        "initialCandidates": [
            {"formationId": formation_id, "candidateId": candidate.candidate_id}
            for formation_id, candidate in zip(
                problem.method.settings.get("starts", []), problem.starts, strict=True
            )
        ]
        if "starts" in problem.method.settings
        else [{"candidateId": cid} for cid in starts],
        "candidateCount": len(saved_candidates(store)),
        "rejectedProposals": [
            {"step": item.step, "candidateId": item.candidate_id, "problems": item.problems}
            for item in [p for p in store.proposals() if not p.accepted][-10:]
        ],
        "budget": {
            "total": total,
            "submitted": submitted,
            "remaining": max(0, total - submitted),
            "reservedForConfirmation": reserve,
            "availableForScreening": max(0, total - submitted - reserve),
        },
        "rounds": rounds,
        "openRound": next((row for row in rounds if row["status"] == "OPEN"), None),
        "warnings": problem.provenance.warnings,
    }
