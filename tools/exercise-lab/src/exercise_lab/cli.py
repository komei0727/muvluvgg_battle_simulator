"""`lab` コマンド。

    uv run lab stats configs/formation.yaml --runs 1000 --seed abc123 --out reports/

対象はローカルの devサーバー（`apps/api/` で `mise run dev`）である。本番Cloud Runは
一括評価を閉じているため（`EVALUATION_ENDPOINT_ENABLED`）、`--base-url` に本番を
指しても実行できない。
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Sequence
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
    CatalogUnit,
    LabApiClient,
    LabApiError,
    search_memories,
    search_units,
    validate_against_catalog,
)
from .draft import DraftError, load_exercise_draft
from .models import (
    ConfigError,
    FormationConfig,
    dump_formation_config,
    load_formation_config,
)
from .player_data import PlayerData, PlayerDataError, apply_player_data, load_player_data
from .runner import ChunkPlan, EvaluationRun, plan_chunks, run_evaluation
from .schema import build_formation_json_schema
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


@app.command("import-draft")
def import_draft(
    draft_path: Annotated[
        Path,
        typer.Argument(help="localStorage `mlgg:last-draft:exercise` のJSON", exists=True),
    ],
    out: Annotated[
        Path | None, typer.Option("--out", "-o", help="出力先。省略時は標準出力")
    ] = None,
) -> None:
    """UIで組んだ演習編成を編成定義YAMLへ変換する。IDの転記を不要にする入口。"""
    try:
        config = load_exercise_draft(draft_path)
    except DraftError as error:
        _abort(str(error))
    document = _IMPORTED_HEADER.format(source=draft_path.name) + dump_formation_config(config)
    if out is None:
        # 標準出力へはヘッダーごと出す。リダイレクトしてもそのまま使える。
        print(document, end="")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(document, encoding="utf-8")
    console.print(
        f"[bold]{out}[/] を書き出した（味方{len(config.ally.units)}体 /"
        f" メモリー{len(config.ally.memory_definition_ids)}件 /"
        f" 敵 {config.enemy.unit_definition_id}）"
    )


# 生成物であることと、育成状態がここに無いことをファイル自身に持たせる。
# 後から開いた人が「レベルが書いていない＝レベル200で評価される」と誤読しないため。
_IMPORTED_HEADER = """\
# {source} から `lab import-draft` で生成した編成定義。
#
# 育成状態（レベル・ギア・学園レベル）は含まない。実際の育成で評価するには
# `lab stats ... --player-data player-data.json` を使う。
#
# エディタ補完を効かせるには `lab schema` でSchemaを生成したうえで、次の行の
# 先頭の `#` を1つ削り、パスをこのファイルからの相対で合わせる。
#
# `# yaml-language-server:` はコメントではなく有効なディレクティブなので、
# 最初から効かせておくと、まだ生成していないSchemaを指してエディタが赤くなる。
## yaml-language-server: $schema=../.schema/formation.schema.json

"""


@app.command()
def units(
    grep: Annotated[
        str | None, typer.Option("--grep", help="ID・表示名・キャラクター名の部分一致")
    ] = None,
    category: Annotated[
        str | None, typer.Option("--category", help="PLAYABLE / EXERCISE_ENEMY")
    ] = None,
    owned: Annotated[bool, typer.Option("--owned", help="手持ちのユニットだけに絞る")] = False,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    as_yaml: Annotated[bool, typer.Option("--yaml", help="編成YAMLへ貼れる形で出す")] = False,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """Catalog のユニットを検索してIDを引く。"""
    data = _player_data_for_owned(owned, player_data)
    catalog = _fetch_catalog(base_url)
    found = search_units(
        catalog,
        query=grep,
        category=category,
        owned_ids=None if data is None else set(data.units),
    )
    _reject_no_match(found, grep)
    if as_yaml:
        console.print(_units_yaml(found), highlight=False)
        return
    _print_units(found, catalog.catalog_revision, data)


@app.command()
def memories(
    grep: Annotated[str | None, typer.Option("--grep", help="ID・表示名の部分一致")] = None,
    as_yaml: Annotated[bool, typer.Option("--yaml", help="編成YAMLへ貼れる形で出す")] = False,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """Catalog のメモリーを検索してIDを引く。"""
    catalog = _fetch_catalog(base_url)
    found = search_memories(catalog, query=grep)
    _reject_no_match(found, grep)
    if as_yaml:
        console.print("\n".join(f"- {memory.memory_definition_id}" for memory in found))
        return
    table = Table(title=f"memories ({len(found)}) / catalogRevision {catalog.catalog_revision}")
    _add_id_column(table, "memoryDefinitionId", [m.memory_definition_id for m in found])
    table.add_column("displayName")
    for memory in found:
        table.add_row(memory.memory_definition_id, memory.display_name)
    console.print(table)


@app.command()
def schema(
    out: Annotated[Path, typer.Option("--out", "-o", help="出力先")] = Path(
        ".schema/formation.schema.json"
    ),
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """編成YAML用の JSON Schema を Catalog から生成する（エディタ補完用）。"""
    catalog = _fetch_catalog(base_url)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(build_formation_json_schema(catalog), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    console.print(
        f"[bold]{out}[/] を書き出した（catalogRevision {catalog.catalog_revision}）。"
        "編成YAMLの先頭へ次の行を置くと補完が効く:"
    )
    console.print(f"  # yaml-language-server: $schema={out}", highlight=False)


def _fetch_catalog(base_url: str) -> Catalog:
    with LabApiClient(base_url) as client:
        try:
            return client.fetch_catalog()
        except LabApiError as error:
            _abort(str(error))


def _player_data_for_owned(owned: bool, player_data: Path | None) -> PlayerData | None:
    if not owned:
        return None
    if player_data is None:
        _abort("--owned には --player-data が要る（手持ちの一覧はそのファイルにしかない）")
    try:
        return load_player_data(player_data)
    except PlayerDataError as error:
        _abort(str(error))


def _reject_no_match(found: Sequence[object], grep: str | None) -> None:
    # 空の表を出して「該当なし」を読み取らせない。検索の絞り込みすぎは打ち間違いと
    # 見分けがつかないので、条件を添えて失敗させる。
    if found:
        return
    condition = "（条件なし）" if grep is None else f"（--grep {grep}）"
    _abort(f"該当するものが無い{condition}")


def _print_units(
    found: Sequence[CatalogUnit], catalog_revision: str, data: PlayerData | None
) -> None:
    table = Table(title=f"units ({len(found)}) / catalogRevision {catalog_revision}")
    _add_id_column(table, "unitDefinitionId", [unit.unit_definition_id for unit in found])
    for column in ("displayName", "category", "role", "aptitudes"):
        table.add_column(column)
    if data is not None:
        table.add_column("level", justify="right")
    for unit in found:
        row = [
            unit.unit_definition_id,
            unit.display_name,
            unit.category,
            unit.role,
            "/".join(unit.position_aptitudes),
        ]
        if data is not None:
            stored = data.units.get(unit.unit_definition_id)
            row.append("-" if stored is None else str(stored.level))
        table.add_row(*row)
    console.print(table)


def _add_id_column(table: Table, header: str, values: Sequence[str]) -> None:
    """ID列は必ず1行へ収める。

    IDはこの表を出す目的そのもので、省略記号で切れても折り返されてもコピーできない。
    最長のIDぶんの幅を先に確保し、幅が足りないときは表示名の側を削らせる。
    """
    table.add_column(
        header, no_wrap=True, min_width=max((len(value) for value in values), default=len(header))
    )


# 貼り付けたときに枠が重複しないよう、前衛→後衛・column昇順で別々の枠を割り当てる。
# 6件を超えたら一巡させる（そこまで貼るなら手で直すことになる）。
_PLACEHOLDER_POSITIONS = [(row, column) for row in ("FRONT", "REAR") for column in (0, 1, 2)]


def _units_yaml(found: Sequence[CatalogUnit]) -> str:
    lines = ["# position は仮置き。実際の配置へ直す（結果に影響する）。"]
    for index, unit in enumerate(found):
        row, column = _PLACEHOLDER_POSITIONS[index % len(_PLACEHOLDER_POSITIONS)]
        lines.append(f"- unitDefinitionId: {unit.unit_definition_id}")
        lines.append(f"  position: {{ column: {column}, row: {row} }}")
    return "\n".join(lines)


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

    _reject_empty_run(run, chunk_size)
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


def _reject_empty_run(run: EvaluationRun, chunk_size: int) -> None:
    """完了0件を、空のレポートではなく原因つきのエラーにする。

    `completedRuns: 0` は期限到達時の正当な応答（Q-TEX-18）だが、統計は1件も出せない。
    ヘッダーだけの `runs.csv` を残すと、後段が「0件という結果」と「そもそも走らなかった」を
    区別できなくなるため、レポートを書かずに終える。
    """
    if run.completed_runs > 0:
        return
    _abort(
        f"完了した試行が0件だったため統計を出せない（要求 {run.requested_runs} 件）。"
        f"期限（サーバーの SIMULATION_TIMEOUT_MS）内に1試行も終わっていない。"
        f"--chunk-size を今の {chunk_size} より下げるか、devサーバーの WORKER_MAX_THREADS を"
        "上げる。1試行そのものが重い編成の可能性もあるので、まず --runs 1 で確かめる"
    )


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
