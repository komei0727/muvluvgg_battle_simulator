"""評価コマンドの定義。

| コマンド    | 役割                                                    | 評価APIへの接続 |
| ----------- | ------------------------------------------------------- | --------------- |
| `evaluate`  | 評価設定 → 入力解決 → 計画をDBへ保存 → 実行            | する            |
| `resume`    | 保存済み計画の結果の無い試行を実行する                  | する            |
| `status`    | 計画・送信・完了・未完了・予算・停止理由                | しない          |
| `summarize` | ケース別の記述統計                                      | しない          |
| `export`    | JSONL / CSV / JSON                                      | しない          |

終了コード:

- 0: 成功（`evaluate` / `resume` はすべての試行が完了した）
- 1: 入力・設定・保存先の問題（評価設定の誤り、評価実行のディレクトリが無い等）
- 2: コマンドの使い方の誤り（typer）
- 3: 予算・要求数の上限で止まった。保存済みの状態は正常で、`resume` で続けられる
- 4: 通信・実行・応答・実行環境の問題で止まった（`status` で停止理由を確かめる）
- 130: Ctrl-C で中断した。`resume` で続けられる

戦闘結果としての敗北・引き分けはエラーではない（終了コードに影響しない）。
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, NoReturn, Protocol

import typer
from rich.console import Console

from ..api.client import EvaluationTransport
from ..evaluation.config import load_evaluation_config
from ..evaluation.models import EvaluationPlan, ExecutionSettings
from ..evaluation.runner import RequestProgress, RunReport, StopReason, run_evaluation
from ..inputs.draft import DraftError
from ..inputs.player_data import PlayerDataError
from ..models.formation import ConfigError
from ..reporting import (
    FormatAnalyzer,
    evaluation_status,
    export_evaluation,
    read_evaluation,
    resolve_evaluation_dir,
    summarize_evaluation,
)
from ..reporting.snapshot import EvaluationSnapshot
from ..storage.layout import create_evaluation, open_evaluation, write_manifest
from ..storage.repository import EvaluationRepository
from ..storage.sqlite import UnknownStorageFormatError
from .render import render_status, render_summary

EXIT_OK = 0
EXIT_INPUT_ERROR = 1
EXIT_INCOMPLETE = 3
EXIT_RUN_FAILED = 4
EXIT_INTERRUPTED = 130

ACCESS_KEY_ENV = "MLGG_LAB_ACCESS_KEY"
EXPORTS_DIR = "exports"

_INCOMPLETE = frozenset({StopReason.BUDGET_EXHAUSTED, StopReason.REQUEST_LIMIT_REACHED})
# 利用者の入力・ファイルに起因する失敗。スタックトレースではなく1行の説明で止める。
_INPUT_ERRORS = (
    ConfigError,
    DraftError,
    PlayerDataError,
    ValueError,
    OSError,
    KeyError,
    UnknownStorageFormatError,
    sqlite3.DatabaseError,
)


class Planner(Protocol):
    def __call__(
        self, config_path: Path, *, evaluation_id: str | None = None
    ) -> EvaluationPlan: ...


TransportFactory = Callable[[ExecutionSettings, str | None], EvaluationTransport]


def _http_transport(settings: ExecutionSettings, access_key: str | None) -> EvaluationTransport:
    return settings.http_client(access_key=access_key)


@dataclass(frozen=True)
class LabCommands:
    name: str
    format: str
    planner: Planner
    analyzer: FormatAnalyzer
    # テストは評価APIの偽物を返す。既定は計画の接続先・タイムアウトのHTTPクライアント。
    transport_factory: TransportFactory = _http_transport
    sleep: Callable[[float], None] = field(default=time.sleep)


def exit_code_for(reason: StopReason) -> int:
    if reason is StopReason.COMPLETED:
        return EXIT_OK
    if reason in _INCOMPLETE:
        return EXIT_INCOMPLETE
    return EXIT_RUN_FAILED


def build_lab_app(lab: LabCommands, *, help: str) -> typer.Typer:
    app = typer.Typer(add_completion=False, help=help, no_args_is_help=True)
    register_evaluation_commands(app, lab)
    return app


EvaluationArg = Annotated[
    Path, typer.Argument(help="評価実行のディレクトリ（data/evaluations/<evaluation-id>）")
]
MaxRequestsOpt = Annotated[
    int | None,
    typer.Option("--max-requests", min=1, help="この実行で送る要求の数の上限（予算とは別）"),
]
AccessKeyOpt = Annotated[
    str | None,
    typer.Option(
        "--access-key",
        envvar=ACCESS_KEY_ENV,
        show_envvar=True,
        help="評価APIのアクセスキー。保存しないので、要る配備では毎回渡す",
    ),
]
JsonOpt = Annotated[bool, typer.Option("--json", help="JSONで標準出力へ出す")]


def register_evaluation_commands(app: typer.Typer, lab: LabCommands) -> None:
    console = Console(highlight=False, soft_wrap=True)
    errors = Console(stderr=True, highlight=False, soft_wrap=True)

    def abort(message: str, code: int = EXIT_INPUT_ERROR) -> NoReturn:
        errors.print(f"[red]error[/]: {message}", markup=True)
        raise typer.Exit(code=code)

    def snapshot_of(evaluation: Path) -> tuple[Path, EvaluationSnapshot]:
        try:
            directory = resolve_evaluation_dir(evaluation)
            snapshot = read_evaluation(directory)
        except _INPUT_ERRORS as error:
            abort(str(error))
        check_format(snapshot.plan)
        return directory, snapshot

    def check_format(plan: EvaluationPlan) -> None:
        if plan.contract.format != lab.format:
            abort(
                f"{plan.evaluation_id} は {plan.contract.format} の評価実行で、"
                f"{lab.name}（{lab.format}）では扱わない"
            )

    def run(
        directory: Path,
        repository: EvaluationRepository,
        max_requests: int | None,
        access_key: str | None,
    ) -> int:
        plan = repository.load_plan()
        console.print(
            f"実行: {plan.evaluation_id}（{plan.contract.format}、計画 {plan.planned_runs} 試行・"
            f"予算 {plan.budget.max_submitted_runs} 試行）→ {plan.settings.base_url}"
        )
        transport = lab.transport_factory(plan.settings, access_key)
        try:
            report = run_evaluation(
                repository,
                transport,
                sleep=lab.sleep,
                max_requests=max_requests,
                on_progress=lambda progress: console.print(_progress_line(progress)),
            )
        except KeyboardInterrupt:
            write_manifest(directory, repository)
            errors.print(
                f"中断した。保存済みの結果は残っている。続きは `{lab.name} resume {directory}`"
            )
            return EXIT_INTERRUPTED
        finally:
            close = getattr(transport, "close", None)
            if callable(close):
                close()
        write_manifest(directory, repository)
        _print_report(report, directory, lab.name)
        return exit_code_for(report.stop_reason)

    def _print_report(report: RunReport, directory: Path, name: str) -> None:
        counters = report.counters
        pending = counters.planned_runs - counters.completed_trials
        out = console if report.stop_reason is StopReason.COMPLETED else errors
        out.print(
            f"停止理由: {report.stop_reason.value}"
            + (f"（{report.detail}）" if report.detail else "")
        )
        out.print(
            f"完了 {counters.completed_trials} / 計画 {counters.planned_runs} 試行"
            f"（未完了 {pending}、送信 {counters.submitted_runs} 試行・要求 {report.requests} 回）"
        )
        if pending:
            out.print(
                f"未完了の試行は集計に含めない。続きは `{name} resume {directory}`、"
                f"状況は `{name} status {directory}`"
            )

    @app.command("evaluate")
    def evaluate(
        config: Annotated[Path, typer.Argument(help="評価設定（YAML）")],
        evaluations_dir: Annotated[
            Path | None,
            typer.Option(
                "--evaluations-dir",
                help="評価実行の保存先。省略時は評価設定の output.evaluationsDir",
            ),
        ] = None,
        evaluation_id: Annotated[
            str | None,
            typer.Option("--evaluation-id", help="評価実行のID（省略時は日時から作る）"),
        ] = None,
        plan_only: Annotated[
            bool,
            typer.Option("--plan-only", help="計画を保存するだけで実行しない（後で resume する）"),
        ] = False,
        max_requests: MaxRequestsOpt = None,
        access_key: AccessKeyOpt = None,
    ) -> None:
        """評価設定を読み、入力を解決して計画を保存し、評価を実行する。"""
        try:
            loaded = load_evaluation_config(config, expected_format=lab.format)
            target = evaluations_dir or loaded.evaluations_dir
            if target is None:
                abort(
                    "評価実行の保存先が無い。評価設定に output.evaluationsDir を書くか、"
                    "--evaluations-dir を渡す"
                )
            plan = lab.planner(config, evaluation_id=evaluation_id)
            directory, repository = create_evaluation(target.expanduser().resolve(), plan)
        except _INPUT_ERRORS as error:
            abort(str(error))
        console.print(
            f"計画を保存した: {directory}（ケース {len(plan.cases)}・{plan.planned_runs} 試行）"
        )
        with repository:
            if plan_only:
                console.print(f"実行は `{lab.name} resume {directory}`")
                return
            code = run(directory, repository, max_requests, access_key)
        raise typer.Exit(code=code)

    @app.command("resume")
    def resume(
        evaluation: EvaluationArg,
        max_requests: MaxRequestsOpt = None,
        access_key: AccessKeyOpt = None,
    ) -> None:
        """保存済みの計画から、結果の無い試行だけを同じseed・試行番号で実行する。

        元の評価設定・編成YAML・育成JSONは読み直さない（書き換えても条件は変わらない）。
        接続先・要求上限・予算は計画を作った時の値を使う。
        """
        try:
            directory = resolve_evaluation_dir(evaluation)
            repository = open_evaluation(directory)
        except _INPUT_ERRORS as error:
            abort(str(error))
        with repository:
            check_format(repository.load_plan())
            code = run(directory, repository, max_requests, access_key)
        raise typer.Exit(code=code)

    @app.command("status")
    def status(evaluation: EvaluationArg, as_json: JsonOpt = False) -> None:
        """計画・送信・完了・未完了の件数、予算、停止理由を表示する（APIへ接続しない）。"""
        _, snapshot = snapshot_of(evaluation)
        document = evaluation_status(snapshot)
        if as_json:
            print(json.dumps(document, ensure_ascii=False, indent=2))
            return
        render_status(console, document)

    @app.command("summarize")
    def summarize(
        evaluation: EvaluationArg,
        case: Annotated[
            list[str] | None,
            typer.Option("--case", help="表示するケースID（繰り返し指定できる。省略時は全ケース）"),
        ] = None,
        as_json: JsonOpt = False,
    ) -> None:
        """保存済みの完了結果をケース別の記述統計として表示する（APIへ接続しない）。"""
        _, snapshot = snapshot_of(evaluation)
        try:
            document = summarize_evaluation(snapshot, lab.analyzer, case_ids=case)
        except KeyError as error:
            abort(str(error.args[0]))
        if as_json:
            print(json.dumps(document, ensure_ascii=False, indent=2))
            return
        render_summary(console, document, lab.analyzer)

    @app.command("export")
    def export(
        evaluation: EvaluationArg,
        out: Annotated[
            Path | None,
            typer.Option("--out", "-o", help=f"出力先。省略時は <評価実行>/{EXPORTS_DIR}"),
        ] = None,
    ) -> None:
        """保存結果を trials.jsonl / trials.csv / summary.json / cases.json へ書き出す。

        SQLiteが正本で、出力は何度でも再生成できる（APIへ接続しない）。
        """
        directory, snapshot = snapshot_of(evaluation)
        try:
            result = export_evaluation(snapshot, lab.analyzer, out or directory / EXPORTS_DIR)
        except OSError as error:
            abort(str(error))
        pending = snapshot.counters.planned_runs - snapshot.counters.completed_trials
        console.print(
            f"{result.directory} へ書き出した（完了 {result.trials} 試行・未完了 {pending} 試行）"
        )
        for path in result.files.values():
            console.print(f"  {path.name}")


def _progress_line(progress: RequestProgress) -> str:
    counters = progress.counters
    head = f"要求 #{progress.requests}: "
    if progress.failure is not None:
        head += f"失敗 {progress.failure.splitlines()[0]}"
    else:
        head += f"新規完了 +{progress.new_results}"
    return (
        f"{head} | 完了 {counters.completed_trials}/{counters.planned_runs} 試行"
        f" | 送信 {counters.submitted_runs} 試行"
    )
