"""`lab` コマンド。

    uv run lab stats configs/formation.yaml --runs 1000 --seed abc123 --out reports/

対象はローカルの devサーバー（`apps/api/` で `mise run dev`）である。本番Cloud Runは
一括評価を閉じているため（`EVALUATION_ENDPOINT_ENABLED`）、`--base-url` に本番を
指しても実行できない。
"""

from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer
from rich.console import Console
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn
from rich.table import Table

from .api import (
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_SECONDS,
    Catalog,
    LabApiClient,
    LabApiError,
    validate_against_catalog,
)
from .models import ConfigError, FormationConfig, load_formation_config
from .player_data import PlayerDataError, apply_player_data, load_player_data
from .runner import ChunkPlan, EvaluationRun, plan_chunks, run_evaluation
from .stats import build_summary, write_break_count_chart, write_runs_csv, write_score_histogram

# サーバー既定の `EVALUATION_MAX_TOTAL_RUNS`。候補1件なので総試行数の上限がそのまま
# 1リクエストの上限になる。devサーバーの設定を絞っている場合は `--chunk-size` で下げる。
DEFAULT_CHUNK_SIZE = 300

RUNS_CSV = "runs.csv"
SUMMARY_JSON = "summary.json"
SCORE_HISTOGRAM_PNG = "score-histogram.png"
BREAK_COUNT_PNG = "break-count-distribution.png"

app = typer.Typer(add_completion=False, help="戦術演習の統計サマリーを出すローカルツール")
console = Console()
error_console = Console(stderr=True)


@app.callback()
def main() -> None:
    """コマンドが1つでもサブコマンド形式（`lab stats ...`）を保つために置く。

    typerはコマンドが1つだけのときトップレベルへ畳み込み、`lab <config>` になる。
    後続のオプティマイザ（#509）でコマンドが増えたときに呼び出し方が変わると、
    それまでの手順・スクリプトが黙って壊れる。
    """


@app.command()
def stats(
    config_path: Annotated[Path, typer.Argument(help="編成定義YAML", exists=True)],
    runs: Annotated[int, typer.Option("--runs", min=1, help="総試行数")] = 100,
    seed: Annotated[str | None, typer.Option("--seed", help="省略時は生成して表示する")] = None,
    out: Annotated[Path, typer.Option("--out", help="レポート出力先")] = Path("reports"),
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    chunk_size: Annotated[
        int, typer.Option("--chunk-size", min=1, help="1リクエストあたりの試行数")
    ] = DEFAULT_CHUNK_SIZE,
    timeout_seconds: Annotated[
        float, typer.Option("--timeout", min=1.0, help="1リクエストの待ち時間（秒）")
    ] = DEFAULT_TIMEOUT_SECONDS,
) -> None:
    """同一編成を大量試行し、統計サマリーと生データを出力する。"""
    base_seed = seed if seed is not None else secrets.token_hex(8)
    config = _load(config_path, player_data)
    chunks = plan_chunks(total_runs=runs, base_seed=base_seed, chunk_size=chunk_size)

    # devサーバー未起動・エンドポイント無効・422はどれも利用者が直せる状況なので、
    # traceback ではなく1行のエラーとして返す。
    with LabApiClient(base_url, timeout_seconds=timeout_seconds) as client:
        try:
            catalog = client.fetch_catalog()
            _reject_catalog_violations(config, catalog)
            console.print(
                f"catalogRevision: [bold]{catalog.catalog_revision}[/] / seed: [bold]{base_seed}[/]"
            )
            run = _run_with_progress(client, config, chunks)
        except LabApiError as error:
            _abort(str(error))

    summary = build_summary(run, seed=base_seed, chunk_size=chunk_size)
    _write_reports(out, run, summary)
    _print_summary(summary)
    console.print(f"レポート: [bold]{out}[/]")


def _load(config_path: Path, player_data_path: Path | None) -> FormationConfig:
    try:
        config = load_formation_config(config_path)
        if player_data_path is None:
            return config
        config, warnings = apply_player_data(config, load_player_data(player_data_path))
    except (ConfigError, PlayerDataError) as error:
        _abort(str(error))
    for warning in warnings:
        error_console.print(f"[yellow]warning[/]: {warning}")
    return config


def _reject_catalog_violations(config: FormationConfig, catalog: Catalog) -> None:
    errors = validate_against_catalog(config, catalog)
    if errors:
        _abort("編成がCatalogと合わない:\n" + "\n".join(f"  - {error}" for error in errors))


def _run_with_progress(
    client: LabApiClient, config: FormationConfig, chunks: list[ChunkPlan]
) -> EvaluationRun:
    total = sum(chunk.runs for chunk in chunks)
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} runs"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(f"evaluating ({len(chunks)} chunks)", total=total)

        def advance(chunk: ChunkPlan, completed: int) -> None:
            # 要求数ではなく実完了数だけ進める。期限で切られたチャンクを満了扱いに
            # すると、バーが100%で終わったのに部分結果、という表示になる。
            progress.update(task, advance=completed)

        try:
            return run_evaluation(client, config, chunks, on_chunk_done=advance)
        except LabApiError:
            # 進捗バーを畳んでからエラーを出す。開いたままだとrichがバーの再描画で
            # メッセージを上書きする。
            progress.stop()
            raise


def _write_reports(out: Path, run: EvaluationRun, summary: dict[str, Any]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    write_runs_csv(run.records, out / RUNS_CSV)
    (out / SUMMARY_JSON).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    title = f"{run.completed_runs} runs / seed {summary['seed']}"
    write_score_histogram(
        [record.score for record in run.records], out / SCORE_HISTOGRAM_PNG, title=title
    )
    write_break_count_chart(
        [record.break_count for record in run.records], out / BREAK_COUNT_PNG, title=title
    )


def _print_summary(summary: dict[str, Any]) -> None:
    score = summary["score"]
    table = Table(title=f"score statistics ({summary['completedRuns']} runs)")
    table.add_column("metric")
    table.add_column("value", justify="right")
    rows: list[tuple[str, object]] = [
        ("runs (requested)", summary["requestedRuns"]),
        ("runs (completed)", summary["completedRuns"]),
        ("mean", score["mean"]),
        ("95% CI", _interval(score["ci_low"], score["ci_high"])),
        ("stdev", score["stdev"]),
        ("min", score["minimum"]),
        ("p05", score["p05"]),
        ("p25", score["p25"]),
        ("median", score["median"]),
        ("p75", score["p75"]),
        ("p95", score["p95"]),
        ("max", score["maximum"]),
        ("defeat rate", f"{summary['defeatRate']:.1%}"),
    ]
    for name, value in rows:
        table.add_row(name, _format(value))
    console.print(table)

    breaks = Table(title="break count distribution")
    breaks.add_column("breaks")
    breaks.add_column("runs", justify="right")
    for count, count_runs in summary["breakCountDistribution"].items():
        breaks.add_row(count, str(count_runs))
    console.print(breaks)

    if summary["partial"]:
        # 期限到達で試行が欠けたことを表の外にも出す。統計値だけ見ると要求どおりの
        # 試行数で出た数字と区別がつかない。
        error_console.print(
            f"[yellow]warning[/]: 部分結果 — 要求 {summary['requestedRuns']} 件に対し "
            f"{summary['completedRuns']} 件で集計した"
        )


def _interval(low: float | None, high: float | None) -> str:
    if low is None or high is None:
        return "-"
    return f"[{_format(low)}, {_format(high)}]"


def _format(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:,.1f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _abort(message: str) -> NoReturn:
    error_console.print(f"[red]error[/]: {message}")
    raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
