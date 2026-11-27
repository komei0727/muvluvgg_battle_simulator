"""保存済みの試行を、単発演習APIで詳細ログ付きに再生する（`exercise-lab inspect`）。

評価実行のDBが持つ seed・送信した対戦条件・試行番号・確定した実行環境から `replay` を
組み立てて `POST /api/v1/tactical-exercises` へ送る。行動順・対象選択・効果の付与と消費を、
保存した試行と同じ乱数条件で確かめるためである。

再生結果のスコア・ブレイク回数・終了理由・完了ターンが保存値と一致したときだけ詳細ログを
`<評価実行>/traces/<caseId>-<runIndex>.json` へ保存する。一致しない再生を残すと、別の戦闘の
ログを保存済みの試行の説明として読んでしまう。
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer
from rich.console import Console

from mlgg_lab_common.api.client import classify_exchange
from mlgg_lab_common.cli import (
    EXIT_INPUT_ERROR,
    EXIT_RUN_FAILED,
    LabCommands,
)
from mlgg_lab_common.cli.commands import ACCESS_KEY_ENV
from mlgg_lab_common.reporting import read_evaluation, resolve_evaluation_dir
from mlgg_lab_common.reporting.snapshot import EvaluationSnapshot
from mlgg_lab_common.storage.sqlite import UnknownStorageFormatError

REPLAY_PATH = "/api/v1/tactical-exercises"
TRACES_DIR = "traces"
# 保存済みの試行と照合する戦闘結果。実行ごとに発行するID（battleId）は含めない。
COMPARED_FIELDS = ("totalScore", "breakCount", "completionReason", "completedTurn")


class InspectError(Exception):
    """入力（評価実行・ケース・試行番号）の問題。終了コード1。"""


class ReplayFailedError(Exception):
    """再生APIの失敗、または保存済みの試行と一致しない再生。終了コード4。"""


@dataclass(frozen=True)
class ReplayPlan:
    case_id: str
    run_index: int
    request: dict[str, Any]
    saved: dict[str, Any]
    catalog_revision: str


@dataclass(frozen=True)
class InspectReport:
    case_id: str
    run_index: int
    saved: dict[str, Any]
    replayed: dict[str, Any]
    event_count: int
    trace_path: Path

    def to_json(self) -> dict[str, Any]:
        return {
            "caseId": self.case_id,
            "runIndex": self.run_index,
            "saved": self.saved,
            "replayed": self.replayed,
            "eventCount": self.event_count,
            "tracePath": str(self.trace_path),
        }


def plan_replay(snapshot: EvaluationSnapshot, case_id: str, run_index: int) -> ReplayPlan:
    """保存済みの完了試行から再生要求を組み立てる。評価APIへは接続しない。"""
    try:
        case = snapshot.case(case_id)
    except KeyError:
        known = ", ".join(c.case_id for c in snapshot.plan.cases)
        raise InspectError(f"計画に無いケース: {case_id}（あるのは {known}）") from None
    saved = next(
        (r for r in snapshot.results_of(case_id) if r.run_index == run_index),
        None,
    )
    if saved is None:
        raise InspectError(
            f"{case_id} の試行 {run_index} は完了していない。再生できるのは保存済みの完了試行だけ"
        )
    environment = snapshot.environment
    if environment is None:
        raise InspectError("評価実行の実行環境が確定していない（完了した試行が無い）")
    request = dict(case.match_request) | {
        "replay": {
            "seed": snapshot.plan.seed,
            "runIndex": run_index,
            "expectedCatalogRevision": environment.catalog_revision,
            "expectedEngineRevision": environment.engine_revision,
            "expectedSeedDerivationVersion": environment.seed_derivation_version,
        }
    }
    return ReplayPlan(
        case_id=case_id,
        run_index=run_index,
        request=request,
        saved={field: saved.observation[field] for field in COMPARED_FIELDS},
        catalog_revision=environment.catalog_revision,
    )


def check_replay(plan: ReplayPlan, response: Any) -> dict[str, Any]:
    """再生応答を保存値と照合し、再生側の値を返す。食い違いは `ReplayFailedError`。"""
    try:
        result = response["result"]
        replayed = {field: result[field] for field in COMPARED_FIELDS}
        catalog_revision = response["catalogRevision"]
        events = response["events"]
        response["initialState"]
        response["stateTransitions"]
    except (KeyError, TypeError) as error:
        raise ReplayFailedError(f"再生APIの応答を読めない: {error!r}") from error
    mismatches = [
        f"{field}: 保存 {plan.saved[field]!r} / 再生 {replayed[field]!r}"
        for field in COMPARED_FIELDS
        if replayed[field] != plan.saved[field]
    ]
    if catalog_revision != plan.catalog_revision:
        mismatches.append(
            f"catalogRevision: 保存 {plan.catalog_revision} / 再生 {catalog_revision}"
        )
    if mismatches:
        raise ReplayFailedError(
            "保存済みの試行と再生結果が一致しない:\n" + "\n".join(f"  - {m}" for m in mismatches)
        )
    if not isinstance(events, list) or not events:
        raise ReplayFailedError("再生APIの応答に詳細イベントが無い")
    return replayed


def _write_atomically(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(text)
        Path(temporary).replace(path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def inspect_run(
    directory: Path, snapshot: EvaluationSnapshot, case_id: str, run_index: int, transport: Any
) -> InspectReport:
    plan = plan_replay(snapshot, case_id, run_index)
    exchange = transport.post_json(REPLAY_PATH, plan.request)
    failure = classify_exchange(exchange)
    if failure is not None:
        raise ReplayFailedError(f"再生APIが失敗した（{failure.kind.value}）: {failure.message}")
    try:
        response = json.loads(exchange.body or "")
    except ValueError as error:
        raise ReplayFailedError(f"再生APIの応答がJSONでない: {error}") from error
    replayed = check_replay(plan, response)
    trace_path = directory / TRACES_DIR / f"{case_id}-{run_index}.json"
    _write_atomically(trace_path, json.dumps(response, ensure_ascii=False, indent=2) + "\n")
    return InspectReport(
        case_id=case_id,
        run_index=run_index,
        saved=plan.saved,
        replayed=replayed,
        event_count=len(response["events"]),
        trace_path=trace_path,
    )


def register_inspect_command(app: typer.Typer, lab: LabCommands) -> None:
    console = Console(highlight=False, soft_wrap=True)
    errors = Console(stderr=True, highlight=False, soft_wrap=True)

    def abort(message: str, code: int) -> NoReturn:
        errors.print(f"[red]error[/]: {message}", markup=True)
        raise typer.Exit(code=code)

    @app.command("inspect")
    def inspect(
        evaluation: Annotated[
            Path, typer.Argument(help="評価実行のディレクトリ（data/evaluations/<evaluation-id>）")
        ],
        case: Annotated[str, typer.Option("--case", help="再生するケースID")],
        run: Annotated[int, typer.Option("--run", min=0, help="再生する試行番号（runIndex）")],
        access_key: Annotated[
            str | None,
            typer.Option(
                "--access-key",
                envvar=ACCESS_KEY_ENV,
                show_envvar=True,
                help="APIのアクセスキー。保存しないので、要る配備では毎回渡す",
            ),
        ] = None,
        as_json: Annotated[bool, typer.Option("--json", help="JSONで標準出力へ出す")] = False,
    ) -> None:
        """保存済みの完了試行を単発演習APIで詳細ログ付きに再生し、保存値と照合して保存する。

        接続先は評価を実行した時の計画の値を使う。評価APIを開いた配備（`EVALUATION_ENDPOINT_ENABLED`）
        でだけ再生できる。
        """
        try:
            directory = resolve_evaluation_dir(evaluation)
            snapshot = read_evaluation(directory)
        except (
            OSError,
            ValueError,
            KeyError,
            UnknownStorageFormatError,
            sqlite3.DatabaseError,
        ) as error:
            abort(str(error), EXIT_INPUT_ERROR)
        if snapshot.plan.contract.format != lab.format:
            abort(
                f"{snapshot.plan.evaluation_id} は {snapshot.plan.contract.format} の評価実行で、"
                f"{lab.name}（{lab.format}）では扱わない",
                EXIT_INPUT_ERROR,
            )
        transport = lab.transport_factory(snapshot.plan.settings, access_key)
        try:
            report = inspect_run(directory, snapshot, case, run, transport)
        except InspectError as error:
            abort(str(error), EXIT_INPUT_ERROR)
        except ReplayFailedError as error:
            abort(str(error), EXIT_RUN_FAILED)
        finally:
            close = getattr(transport, "close", None)
            if callable(close):
                close()
        if as_json:
            print(json.dumps(report.to_json(), ensure_ascii=False, indent=2))
            return
        values = "・".join(f"{field} {report.replayed[field]}" for field in COMPARED_FIELDS)
        console.print(f"{case} / 試行 {run}: 保存済みの試行と一致（{values}）")
        console.print(f"詳細ログ（イベント {report.event_count} 件）: {report.trace_path}")
