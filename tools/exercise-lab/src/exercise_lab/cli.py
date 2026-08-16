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
from random import Random
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
    unit_hints,
    validate_against_catalog,
    validate_pools_against_catalog,
)
from .draft import DraftError, load_exercise_draft
from .models import (
    ConfigError,
    FormationConfig,
    dump_formation_config,
    load_formation_config,
)
from .optimize.algorithms import (
    ALGORITHMS,
    GenerationReport,
    SearchContext,
    SearchSettings,
    build_algorithm,
    final_selection_cost,
    minimum_budget,
    racing_cost,
)
from .optimize.algorithms import (
    optimize as run_optimization,
)
from .optimize.evaluator import Evaluator, phases_for
from .optimize.operators import UnitHint
from .optimize.report import (
    build_optimization_summary,
    write_best_so_far_chart,
    write_comparison_chart,
)
from .optimize.search_config import (
    SearchConfig,
    load_search_config,
    resolve_unit_enhancements,
)
from .player_data import PlayerData, PlayerDataError, apply_player_data, load_player_data
from .runner import ChunkPlan, EvaluationRun, plan_chunks, run_evaluation
from .schema import build_formation_json_schema, build_search_json_schema
from .stats import build_summary, write_break_count_chart, write_runs_csv, write_score_histogram

# サーバー既定の `EVALUATION_MAX_TOTAL_RUNS`。候補1件なので総試行数の上限がそのまま
# 1リクエストの上限になる。devサーバーの設定を絞っている場合は `--chunk-size` で下げる。
DEFAULT_CHUNK_SIZE = 300

RUNS_CSV = "runs.csv"
SUMMARY_JSON = "summary.json"
SCORE_HISTOGRAM_PNG = "score-histogram.png"
BREAK_COUNT_PNG = "break-count-distribution.png"

OPTIMIZATION_JSON = "optimization.json"
EVALUATIONS_CSV = "evaluations.csv"
BEST_SO_FAR_PNG = "best-so-far.png"
STATE_JSON = "state.json"
COMPARISON_JSON = "comparison.json"
COMPARISON_PNG = "comparison.png"

DEFAULT_ALGORITHM = "local-search"
DEFAULT_BUDGET_RUNS = 5000

DEFAULT_SCHEMA_DIR = Path(".schema")
FORMATION_SCHEMA_JSON = "formation.schema.json"
SEARCH_SCHEMA_JSON = "search.schema.json"

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
    out: Annotated[Path, typer.Option("--out", "-o", help="出力ディレクトリ")] = DEFAULT_SCHEMA_DIR,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """YAML用の JSON Schema を Catalog から生成する（エディタ補完用）。

    編成定義（`lab stats`）と探索設定（`lab optimize`）で書式が違うため、
    Schemaも2つ出す。どちらも実IDを enum に焼くので、Catalog を更新したら作り直す。
    """
    catalog = _fetch_catalog(base_url)
    out.mkdir(parents=True, exist_ok=True)
    written = [
        (out / FORMATION_SCHEMA_JSON, build_formation_json_schema(catalog), "編成定義YAML"),
        (out / SEARCH_SCHEMA_JSON, build_search_json_schema(catalog), "探索設定YAML"),
    ]
    for path, document, _ in written:
        path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    console.print(
        f"[bold]{out}[/] へ書き出した（catalogRevision {catalog.catalog_revision}）。"
        "各YAMLの先頭へ対応する行を置くと補完が効く:"
    )
    for path, _, label in written:
        console.print(f"  {label}: # yaml-language-server: $schema={path}", highlight=False)


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


@app.command()
def optimize(
    config_path: Annotated[Path, typer.Argument(help="探索設定YAML", exists=True)],
    budget: Annotated[
        int, typer.Option("--budget", min=1, help="シミュレーション総試行数の上限")
    ] = DEFAULT_BUDGET_RUNS,
    seed: Annotated[str | None, typer.Option("--seed", help="省略時は生成して表示する")] = None,
    out: Annotated[Path, typer.Option("--out", help="レポート出力先")] = Path("reports"),
    algorithm: Annotated[
        str, typer.Option("--algorithm", help=f"{' / '.join(sorted(ALGORITHMS))}")
    ] = DEFAULT_ALGORITHM,
    resume: Annotated[
        bool, typer.Option("--resume", help="出力先の state.json から再開する")
    ] = False,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    max_candidates: Annotated[
        int, typer.Option("--max-candidates", min=1, help="1リクエストの候補数上限")
    ] = 32,
    max_total_runs: Annotated[
        int, typer.Option("--max-total-runs", min=1, help="1リクエストの総試行数上限")
    ] = 300,
    timeout_seconds: Annotated[
        float, typer.Option("--timeout", min=1.0, help="1リクエストの待ち時間（秒）")
    ] = DEFAULT_TIMEOUT_SECONDS,
) -> None:
    """候補プールから、スコアの期待値が高く下振れの小さい編成を探す。"""
    base_seed = seed if seed is not None else secrets.token_hex(8)
    config = _load_search_config(config_path, player_data)
    try:
        search = build_algorithm(algorithm)
    except ValueError as error:
        _abort(str(error))

    with LabApiClient(base_url, timeout_seconds=timeout_seconds) as client:
        catalog = _validated_catalog(client, config)
        console.print(
            f"catalogRevision: [bold]{catalog.catalog_revision}[/] /"
            f" seed: [bold]{base_seed}[/] / algorithm: [bold]{algorithm}[/]"
        )
        _print_budget_plan(config, budget)
        summary, _ = _run_optimization(
            search,
            config,
            client,
            catalog,
            base_seed=base_seed,
            budget=budget,
            out=out,
            resume=resume,
            max_candidates=max_candidates,
            max_total_runs=max_total_runs,
        )

    _print_optimization(summary)
    console.print(f"レポート: [bold]{out}[/]")


@app.command()
def compare(
    config_path: Annotated[Path, typer.Argument(help="探索設定YAML", exists=True)],
    budget: Annotated[
        int, typer.Option("--budget", min=1, help="1アルゴリズムあたりの総試行数の上限")
    ] = DEFAULT_BUDGET_RUNS,
    seed: Annotated[str | None, typer.Option("--seed", help="省略時は生成して表示する")] = None,
    out: Annotated[Path, typer.Option("--out", help="レポート出力先")] = Path("reports/compare"),
    algorithm: Annotated[
        list[str] | None,
        typer.Option("--algorithm", help="比較対象。繰り返し指定できる。省略時は全実装"),
    ] = None,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    max_candidates: Annotated[
        int, typer.Option("--max-candidates", min=1, help="1リクエストの候補数上限")
    ] = 32,
    max_total_runs: Annotated[
        int, typer.Option("--max-total-runs", min=1, help="1リクエストの総試行数上限")
    ] = 300,
    timeout_seconds: Annotated[
        float, typer.Option("--timeout", min=1.0, help="1リクエストの待ち時間（秒）")
    ] = DEFAULT_TIMEOUT_SECONDS,
) -> None:
    """複数の探索アルゴリズムを同一予算・同一seedで走らせ、採用の根拠を残す。

    アルゴリズムごとに評価器を作り直す。評価キャッシュを共有すると、後から走る実装が
    先の実装の試行にただ乗りして、消費試行数あたりの比較が成り立たなくなる。
    """
    base_seed = seed if seed is not None else secrets.token_hex(8)
    names = list(algorithm) if algorithm else sorted(ALGORITHMS)
    config = _load_search_config(config_path, player_data)
    searches = []
    for name in names:
        try:
            searches.append((name, build_algorithm(name)))
        except ValueError as error:
            _abort(str(error))

    entries: list[dict[str, Any]] = []
    histories: dict[str, Any] = {}
    with LabApiClient(base_url, timeout_seconds=timeout_seconds) as client:
        catalog = _validated_catalog(client, config)
        console.print(
            f"catalogRevision: [bold]{catalog.catalog_revision}[/] / seed: [bold]{base_seed}[/]"
        )
        _print_budget_plan(config, budget)
        for name, search in searches:
            console.print(f"[bold]{name}[/] を実行中")
            summary, result = _run_optimization(
                search,
                config,
                client,
                catalog,
                base_seed=base_seed,
                budget=budget,
                out=out / name,
                resume=False,
                max_candidates=max_candidates,
                max_total_runs=max_total_runs,
            )
            histories[name] = result.history
            entries.append(
                {
                    "algorithm": name,
                    "consumedRuns": summary["consumedRuns"],
                    "stoppedBecause": summary["stoppedBecause"],
                    "bestFitness": summary["topFormations"][0]["fitness"]
                    if summary["topFormations"]
                    else None,
                    "bestMean": summary["topFormations"][0]["mean"]
                    if summary["topFormations"]
                    else None,
                    "bestCvar": summary["topFormations"][0]["cvar"]
                    if summary["topFormations"]
                    else None,
                    "report": str(out / name / OPTIMIZATION_JSON),
                }
            )

    out.mkdir(parents=True, exist_ok=True)
    comparison = {"seed": base_seed, "budgetRuns": budget, "algorithms": entries}
    (out / COMPARISON_JSON).write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_comparison_chart(
        histories, out / COMPARISON_PNG, title=f"budget {budget:,} runs / seed {base_seed}"
    )
    _print_comparison(comparison)
    console.print(f"レポート: [bold]{out}[/]")


def _validated_catalog(client: LabApiClient, config: SearchConfig) -> Catalog:
    try:
        catalog = client.fetch_catalog()
    except LabApiError as error:
        _abort(str(error))
    _reject_pool_violations(config, catalog)
    return catalog


def _run_optimization(
    search,
    config: SearchConfig,
    client: LabApiClient,
    catalog: Catalog,
    *,
    base_seed: str,
    budget: int,
    out: Path,
    resume: bool,
    max_candidates: int,
    max_total_runs: int,
):
    out.mkdir(parents=True, exist_ok=True)
    context = _build_context(
        config,
        client,
        catalog,
        base_seed=base_seed,
        budget=budget,
        out=out,
        max_candidates=max_candidates,
        max_total_runs=max_total_runs,
    )
    try:
        result = _optimize_with_progress(search, context, resume=resume, budget=budget)
    except (LabApiError, ValueError) as error:
        _abort(str(error))

    summary = build_optimization_summary(
        result.top,
        config=config,
        catalog=catalog,
        algorithm=result.algorithm,
        seed=base_seed,
        budget_runs=budget,
        consumed_runs=result.consumed_runs,
        stopped_because=result.stopped_because,
        history=result.history,
        catalog_revision=context.evaluator.catalog_revision or catalog.catalog_revision,
    )
    (out / OPTIMIZATION_JSON).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_best_so_far_chart(
        result.history, out / BEST_SO_FAR_PNG, title=f"{result.algorithm} / seed {base_seed}"
    )
    return summary, result


def _print_comparison(comparison: dict[str, Any]) -> None:
    table = Table(
        title=f"algorithm comparison（budget {comparison['budgetRuns']:,} runs /"
        f" seed {comparison['seed']}）"
    )
    table.add_column("algorithm")
    for column in ("best fitness", "mean", "CVaR", "runs", "stopped"):
        table.add_column(column, justify="right")
    for entry in sorted(
        comparison["algorithms"],
        key=lambda item: item["bestFitness"] if item["bestFitness"] is not None else float("-inf"),
        reverse=True,
    ):
        table.add_row(
            entry["algorithm"],
            _format(entry["bestFitness"]),
            _format(entry["bestMean"]),
            _format(entry["bestCvar"]),
            _format(entry["consumedRuns"]),
            entry["stoppedBecause"],
        )
    console.print(table)


def _load_search_config(config_path: Path, player_data_path: Path | None) -> SearchConfig:
    try:
        config = load_search_config(config_path)
        if player_data_path is None:
            return config
        config, warnings = resolve_unit_enhancements(config, load_player_data(player_data_path))
    except (ConfigError, PlayerDataError) as error:
        _abort(str(error))
    for warning in warnings:
        error_console.print(f"[yellow]warning[/]: {warning}")
    return config


def _reject_pool_violations(config: SearchConfig, catalog: Catalog) -> None:
    errors = validate_pools_against_catalog(
        unit_pool=config.unit_pool,
        memory_pool=config.memory_pool,
        enemy_unit_definition_id=config.enemy.unit_definition_id,
        catalog=catalog,
    )
    if errors:
        _abort("探索設定がCatalogと合わない:\n" + "\n".join(f"  - {error}" for error in errors))


def _build_context(
    config: SearchConfig,
    client: LabApiClient,
    catalog: Catalog,
    *,
    base_seed: str,
    budget: int,
    out: Path,
    max_candidates: int,
    max_total_runs: int,
) -> SearchContext:
    search_phase, final_phase = phases_for(config.schedule)
    evaluator = Evaluator(
        client,
        config,
        base_seed=base_seed,
        phases=(search_phase, final_phase),
        max_candidates=max_candidates,
        max_total_runs=max_total_runs,
        log_path=out / EVALUATIONS_CSV,
    )
    return SearchContext(
        config=config,
        evaluator=evaluator,
        search_phase=search_phase,
        final_phase=final_phase,
        # seedから乱数を起こす。`--seed` が同じなら候補の作られ方まで同じになる。
        rng=Random(base_seed),
        settings=SearchSettings(budget_runs=budget, patience=config.schedule.patience),
        hints=tuple(
            UnitHint(
                unit_definition_id=unit.unit_definition_id,
                position_aptitudes=tuple(unit.position_aptitudes),
                attribute=unit.attribute,
                unit_type=unit.unit_type,
                role=unit.role,
            )
            for unit in unit_hints(catalog, config.unit_pool)
        ),
        state_path=out / STATE_JSON,
    )


def _print_budget_plan(config: SearchConfig, budget: int) -> None:
    reserve = final_selection_cost(config.schedule)
    generation = racing_cost(config.schedule.population_size, config.schedule.stage_runs)
    console.print(
        f"予算 {budget:,} 試行 = 探索 {budget - reserve:,} + 最終選抜 {reserve:,}"
        f"（上位{config.schedule.top_k}件を試行数 {config.schedule.final_stage_runs[-1]} で確定）"
    )
    console.print(
        f"1世代あたり最大 {generation:,} 試行 / 最低予算 {minimum_budget(config.schedule):,} 試行"
    )


def _optimize_with_progress(search, context: SearchContext, *, resume: bool, budget: int):
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} runs"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("searching", total=budget)

        def advance(report: GenerationReport) -> None:
            progress.update(
                task,
                completed=report.consumed_runs,
                description=f"gen {report.generation} / best {report.best_fitness:,.0f}",
            )

        context.on_generation = advance
        try:
            return run_optimization(search, context, resume=resume)
        except (LabApiError, ValueError):
            # 進捗バーを畳んでからエラーを出す。開いたままだとrichが再描画で上書きする。
            progress.stop()
            raise


def _print_optimization(summary: dict[str, Any]) -> None:
    table = Table(
        title=f"top {len(summary['topFormations'])} formations"
        f"（{summary['consumedRuns']:,} runs / stopped: {summary['stoppedBecause']}）"
    )
    for column in ("rank", "fitness", "mean", "95% CI", "CVaR", "defeat", "n"):
        table.add_column(column, justify="right" if column != "rank" else "left")
    for formation in summary["topFormations"]:
        table.add_row(
            str(formation["rank"]),
            _format(formation["fitness"]),
            _format(formation["mean"]),
            _interval(formation["ci95Low"], formation["ci95High"]),
            _format(formation["cvar"]),
            f"{formation['defeatRate']:.1%}",
            str(formation["sampleCount"]),
        )
    console.print(table)

    for formation in summary["topFormations"]:
        console.print(_formation_lines(formation))

    for warning in summary["warnings"]:
        error_console.print(f"[yellow]warning[/]: {warning}")


def _formation_lines(formation: dict[str, Any]) -> str:
    """UIへ写せる形で1編成を出す。IDだけでは画面上で探せないため表示名を添える。"""
    lines = [f"[bold]#{formation['rank']}[/] （fitness {_format(formation['fitness'])}）"]
    for unit in formation["formation"]["units"]:
        enhancement = ""
        if unit["level"] is not None:
            gears = f" / {', '.join(unit['gears'])}" if unit["gears"] else ""
            enhancement = f"  Lv.{unit['level']}{gears}"
        lines.append(
            f"  {unit['row']:<5} col{unit['column']}  {unit['displayName']}"
            f" ({unit['unitDefinitionId']}){enhancement}"
        )
    for memory in formation["formation"]["memories"]:
        lines.append(
            f"  memory {memory['order']}  {memory['displayName']} ({memory['memoryDefinitionId']})"
        )
    return "\n".join(lines)


def _abort(message: str) -> NoReturn:
    error_console.print(f"[red]error[/]: {message}")
    raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
