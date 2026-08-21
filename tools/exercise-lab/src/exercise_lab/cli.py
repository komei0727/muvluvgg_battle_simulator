"""`lab` コマンド。

    uv run lab stats configs/formation.yaml --runs 1000 --seed abc123 --out reports/

対象はローカルの devサーバー（`apps/api/` で `mise run dev`）である。本番Cloud Runは
一括評価を閉じているため（`EVALUATION_ENDPOINT_ENABLED`）、`--base-url` に本番を
指しても実行できない。
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
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
from .gear.allocation import (
    DEFAULT_ADD_RANK,
    SEARCHED_STATS,
    Allocation,
    GearAllocationError,
    rank_from_label,
)
from .gear.formation import GearFormationSource
from .gear.neighborhood import Move, neighborhood
from .gear.plan import (
    PlanResult,
    PlanSettings,
    SignatureObserver,
    observation_count,
    plan_budget,
    plan_gear_allocation,
)
from .gear.plan import minimum_budget as minimum_plan_budget
from .gear.regime import RegimeSignature, observe_signature
from .gear.report import (
    STAT_LABELS,
    allocation_rows,
    build_plan_summary,
    build_sensitivity_summary,
    move_text,
    utility_rows,
    write_moves_csv,
)
from .gear.search import ClimbSettings, phases_for_climb
from .gear.sensitivity import (
    DetectableMargins,
    SensitivityResult,
    SensitivitySettings,
    analyse,
    detectable_margins,
    planned_runs,
)
from .gear.sensitivity import (
    phases_for as gear_phases_for,
)
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
from .optimize.fitness import Objective
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
from .player_data import (
    PlayerData,
    PlayerDataError,
    StoredUnitEnhancement,
    apply_player_data,
    load_player_data,
    resolved_level,
)
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

GEAR_PLAN_JSON = "gear-plan.json"
GEAR_PLAN_EVALUATIONS_CSV = "gear-plan-evaluations.csv"

GEAR_SENSITIVITY_JSON = "gear-sensitivity.json"
GEAR_MOVES_CSV = "gear-moves.csv"
GEAR_EVALUATIONS_CSV = "gear-evaluations.csv"

OPTIMIZATION_JSON = "optimization.json"
EVALUATIONS_CSV = "evaluations.csv"
BEST_SO_FAR_PNG = "best-so-far.png"
STATE_JSON = "state.json"
COMPARISON_JSON = "comparison.json"
COMPARISON_PNG = "comparison.png"

DEFAULT_ALGORITHM = "local-search"
DEFAULT_BUDGET_RUNS = 5000

# ギア感度分析の既定。篩いは平均のペア差なので浅くてよいが、確定は期待日次ベストで
# 実効サンプルが試行数の36%（k=5）しかないため、平均を見るときの約3倍を積む。
DEFAULT_SCREEN_RUNS = 60
DEFAULT_CONFIRM_RUNS = 200
DEFAULT_VERIFY_RUNS = 200
DEFAULT_SURVIVORS = 10
DEFAULT_TOP_MOVES = 5

# 理論値探索の既定。1反復の近傍は5ユニット×約24手＝約120候補で、評価APIの上限
# （候補数≦32・候補数×試行数≦300）に収まるよう篩いは30候補×10試行＝1リクエストにする。
DEFAULT_CLIMB_SCREEN_RUNS = 10
DEFAULT_CLIMB_CONFIRM_RUNS = 30
DEFAULT_CLIMB_SURVIVORS = 16
DEFAULT_MAX_ITERATIONS = 12
DEFAULT_RESTARTS = 4
DEFAULT_PUSH_STEPS = 4
DEFAULT_PLAN_BUDGET_RUNS = 60000

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
# `lab stats ... --player-data local_storage/player-data.json` を使う。
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
            row.append("-" if stored is None else _owned_level(stored, data))
        table.add_row(*row)
    console.print(table)


def _owned_level(stored: StoredUnitEnhancement, data: PlayerData) -> str:
    """実効レベルを出す。リンク由来の値には`*`を付ける。

    表の用途は編成YAMLへ書き写すIDと値を引くことなので、個別に入力した値と
    リンクで一括指定された値を見分けられないと、リンクを外したときに戻る値を
    取り違える。
    """
    level = resolved_level(stored, data)
    return f"{level}*" if level != stored.level else str(level)


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


def _diff(value: float) -> str:
    """差は符号つきで出す。0を挟む向きが読み取れないと限界効用の表として使えない。"""
    return f"{value:+,.0f}"


def _diff_interval(low: float, high: float) -> str:
    return f"[{_diff(low)}, {_diff(high)}]"


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
                    "bestExpectedBest": summary["topFormations"][0]["expectedBest"]
                    if summary["topFormations"]
                    else None,
                    "bestMean": summary["topFormations"][0]["mean"]
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
    for column in ("best fitness", "E[best]", "mean", "runs", "stopped"):
        table.add_column(column, justify="right")
    for entry in sorted(
        comparison["algorithms"],
        key=lambda item: item["bestFitness"] if item["bestFitness"] is not None else float("-inf"),
        reverse=True,
    ):
        table.add_row(
            entry["algorithm"],
            _format(entry["bestFitness"]),
            _format(entry["bestExpectedBest"]),
            _format(entry["bestMean"]),
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
    best_of = summary["objective"]["bestOf"]
    guard_days = 1.0 - summary["objective"]["guardQuantile"]
    table = Table(
        title=f"top {len(summary['topFormations'])} formations"
        f"（{summary['consumedRuns']:,} runs / stopped: {summary['stoppedBecause']}）"
    )
    columns = (
        "rank",
        "fitness",
        f"E[best{best_of}]",
        "median best",
        f"{guard_days:.0%} floor",
        "mean",
        "defeat",
        "n",
    )
    for column in columns:
        table.add_column(column, justify="right" if column != "rank" else "left")
    for formation in summary["topFormations"]:
        table.add_row(
            str(formation["rank"]),
            _format(formation["fitness"]),
            _format(formation["expectedBest"]),
            _format(formation["medianBest"]),
            _format(formation["guaranteedBest"]),
            _format(formation["mean"]),
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


@app.command("gear-sensitivity")
def gear_sensitivity(
    config_path: Annotated[Path, typer.Argument(help="基点となる編成定義YAML", exists=True)],
    seed: Annotated[str | None, typer.Option("--seed", help="省略時は生成して表示する")] = None,
    out: Annotated[Path, typer.Option("--out", help="レポート出力先")] = Path("reports"),
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    screen_runs: Annotated[
        int, typer.Option("--screen-runs", min=2, help="篩いの試行数（全手ぶん）")
    ] = DEFAULT_SCREEN_RUNS,
    confirm_runs: Annotated[
        int, typer.Option("--confirm-runs", min=2, help="確定の試行数（篩いを通った手）")
    ] = DEFAULT_CONFIRM_RUNS,
    verify_runs: Annotated[
        int, typer.Option("--verify-runs", min=2, help="確認走の試行数（上位手と同時適用）")
    ] = DEFAULT_VERIFY_RUNS,
    survivors: Annotated[
        int, typer.Option("--survivors", min=1, help="確定へ通す手の上限")
    ] = DEFAULT_SURVIVORS,
    top_moves: Annotated[
        int, typer.Option("--top", min=1, help="確認走と同時適用に載せる上位手の数")
    ] = DEFAULT_TOP_MOVES,
    include_rank: Annotated[
        bool, typer.Option("--include-rank", help="種別・ランクの変更（単価表）も近傍へ含める")
    ] = False,
    add_rank: Annotated[
        str, typer.Option("--add-rank", help="追加の手が挿す1枚の種別・ランク（例 II-C）")
    ] = DEFAULT_ADD_RANK.label,
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
    """基点編成に対し、ギア1手の限界効用を実測する。

    探索変数はギア配分だけである。ユニット・配置・メモリー・敵・レベル・学園レベルは
    基点編成のまま固定する。**基点を変えたら結果は無効になる。**
    """
    base_seed = seed if seed is not None else secrets.token_hex(8)
    objective = Objective()
    config = _load(config_path, player_data)
    try:
        settings = SensitivitySettings(
            screen_runs=screen_runs,
            confirm_runs=confirm_runs,
            verify_runs=verify_runs,
            survivors=survivors,
            top_moves=top_moves,
            include_rank=include_rank,
            add_rank=rank_from_label(add_rank),
        )
        source = GearFormationSource(config)
    except (ConfigError, GearAllocationError) as error:
        _abort(str(error))

    base = source.base_allocation()
    moves = neighborhood(base, include_rank=settings.include_rank, add_rank=settings.add_rank)
    if not moves:
        _abort(
            "1手も生成できなかった。基点編成のギアが動かせる状態にない"
            f"（探索対象は {', '.join(SEARCHED_STATS)} の5種）"
        )
    plan = planned_runs(settings, move_count=len(moves))

    with LabApiClient(base_url, timeout_seconds=timeout_seconds) as client:
        try:
            catalog = client.fetch_catalog()
        except LabApiError as error:
            _abort(str(error))
        _reject_catalog_violations(config, catalog)
        console.print(
            f"catalogRevision: [bold]{catalog.catalog_revision}[/] / seed: [bold]{base_seed}[/]"
        )
        _print_gear_plan(settings, moves=len(moves), plan=plan)
        result = _run_gear_sensitivity(
            client,
            source,
            base,
            moves,
            settings=settings,
            objective=objective,
            base_seed=base_seed,
            out=out,
            plan=plan,
            max_candidates=max_candidates,
            max_total_runs=max_total_runs,
        )
        catalog_revision = result.catalog_revision or catalog.catalog_revision

    summary = build_sensitivity_summary(
        result.analysis,
        config=config,
        catalog=catalog,
        settings=settings,
        objective=objective,
        seed=base_seed,
        catalog_revision=catalog_revision,
        planned_runs=plan,
        consumed_runs=result.consumed_runs,
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / GEAR_SENSITIVITY_JSON).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_moves_csv(result.analysis, out / GEAR_MOVES_CSV)
    _print_gear_sensitivity(result.analysis, summary, catalog)
    console.print(f"レポート: [bold]{out}[/]")


@dataclass
class _GearRun:
    analysis: SensitivityResult
    consumed_runs: int
    catalog_revision: str


def _run_gear_sensitivity(
    client: LabApiClient,
    source: GearFormationSource,
    base: Allocation,
    moves: Sequence[Move],
    *,
    settings: SensitivitySettings,
    objective: Objective,
    base_seed: str,
    out: Path,
    plan: dict[str, int],
    max_candidates: int,
    max_total_runs: int,
) -> _GearRun:
    out.mkdir(parents=True, exist_ok=True)
    phases = gear_phases_for(settings)
    evaluator = Evaluator(
        client,
        source,
        base_seed=base_seed,
        phases=phases,
        max_candidates=max_candidates,
        max_total_runs=max_total_runs,
        log_path=out / GEAR_EVALUATIONS_CSV,
    )
    try:
        # 基点だけ先に測る。「この予算では ±X までしか見えない」を、近傍を投げる前に
        # 出すためで、見えない差を追って数千試行を払う前に予算を見直せる。
        base_record = evaluator.ensure([base], settings.screen_runs, phase=phases[0])[0]
        if base_record.sample_count < 2:
            _abort(
                f"基点編成の試行が {base_record.sample_count} 件しか完了しなかった。"
                "--screen-runs を下げるか、devサーバーの WORKER_MAX_THREADS を上げる"
            )
        _print_detectable(
            detectable_margins(base_record.scores, runs=settings.screen_runs, objective=objective),
            confirm_runs=settings.confirm_runs,
            objective=objective,
        )
        analysis = _analyse_with_progress(
            base,
            moves,
            evaluator,
            settings=settings,
            objective=objective,
            seed=base_seed,
            total=plan["total"],
            done=evaluator.consumed_runs,
        )
    except (LabApiError, ValueError) as error:
        _abort(str(error))
    return _GearRun(
        analysis=analysis,
        consumed_runs=evaluator.consumed_runs,
        catalog_revision=evaluator.catalog_revision,
    )


def _analyse_with_progress(
    base: Allocation,
    moves: Sequence[Move],
    evaluator: Evaluator,
    *,
    settings: SensitivitySettings,
    objective: Objective,
    seed: str,
    total: int,
    done: int,
) -> SensitivityResult:
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} runs"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(f"1手近傍 {len(moves)} 手", total=total, completed=done)

        def advance(phase_name: str) -> None:
            progress.update(task, completed=evaluator.consumed_runs, description=phase_name)

        try:
            return analyse(
                base,
                moves,
                _ProgressEvaluator(evaluator, advance),
                settings=settings,
                objective=objective,
                seed=seed,
            )
        except (LabApiError, ValueError):
            # 進捗バーを畳んでからエラーを出す。開いたままだとrichが再描画で上書きする。
            progress.stop()
            raise


@dataclass
class _ProgressEvaluator:
    """`ensure` の前後で進捗を進めるだけの薄い覆い。分析は評価器の他の面を使わない。"""

    evaluator: Evaluator
    advance: Any

    @property
    def consumed_runs(self) -> int:
        return self.evaluator.consumed_runs

    def record_for(self, candidate, phase):
        return self.evaluator.record_for(candidate, phase)

    def ensure(self, candidates, target, *, phase):
        self.advance(f"{phase.name} ({len(candidates)} 候補 × {target} 試行)")
        records = self.evaluator.ensure(candidates, target, phase=phase)
        self.advance(phase.name)
        return records


def _print_gear_plan(settings: SensitivitySettings, *, moves: int, plan: dict[str, int]) -> None:
    table = Table(title=f"予算の内訳（1手近傍 {moves} 手）")
    table.add_column("段")
    table.add_column("指標")
    table.add_column("候補", justify="right")
    table.add_column("試行/候補", justify="right")
    table.add_column("試行数", justify="right")
    table.add_row(
        "篩い", "平均のペア差", str(1 + moves), str(settings.screen_runs), f"{plan['screen']:,}"
    )
    table.add_row(
        "確定",
        "期待日次ベスト＋保証値",
        str(1 + min(settings.survivors, moves)),
        str(settings.confirm_runs),
        f"{plan['confirm']:,}",
    )
    table.add_row(
        "確認走",
        "別の乱数範囲",
        str(2 + min(settings.top_moves, moves)),
        str(settings.verify_runs),
        f"{plan['verify']:,}",
    )
    table.add_row("合計", "", "", "", f"{plan['total']:,}")
    console.print(table)


def _print_detectable(
    margins: DetectableMargins, *, confirm_runs: int, objective: Objective
) -> None:
    console.print(
        f"この予算で見える差: 篩い（{margins.runs} 試行）±{margins.mean_absolute:,.0f}"
        f"（±{margins.mean_ratio:.1%}） / 期待日次ベスト ±{margins.expected_best_absolute:,.0f}"
        f"（±{margins.expected_best_ratio:.1%}）。"
        f"期待日次ベストは実効サンプルが試行数の "
        f"{objective.effective_samples(confirm_runs) / confirm_runs:.0%} しかなく、"
        "平均を見るときの約3倍の試行数が要る"
    )


def _print_gear_sensitivity(
    result: SensitivityResult, summary: dict[str, Any], catalog: Catalog
) -> None:
    map_table = Table(title="限界効用マップ（Δ期待日次ベスト / 1枚積んだとき）")
    map_table.add_column("ユニット")
    for stat in SEARCHED_STATS:
        map_table.add_column(STAT_LABELS[stat], justify="right")
    for label, values in utility_rows(result, catalog):
        map_table.add_row(label, *values)
    console.print(map_table)
    console.print(
        "括弧付きは信頼区間が0を跨いだ手（効果ゼロではなく、この試行数では見えない）。"
        "`上限3枚` は積む手が存在しない欄"
    )

    top = Table(title=f"上位 {len(result.top_moves)} 手（確定順 = 期待日次ベスト＋保証値）")
    for column in ("順位", "ユニット", "手", "Δ確定", "95% CI", "Δ確認走", "平均差", "敗北率"):
        top.add_column(column, justify="left" if column in ("順位", "ユニット", "手") else "right")
    for rank, (entry, reported) in enumerate(
        zip(result.top_moves, summary["topMoves"], strict=True), start=1
    ):
        confirm = entry.confirm
        verify = entry.verify
        top.add_row(
            str(rank),
            reported["displayName"],
            move_text(entry.move),
            _diff(confirm.expected_best_diff),
            _diff_interval(confirm.expected_best_ci_low, confirm.expected_best_ci_high),
            "-" if verify is None else _diff(verify.expected_best_diff),
            _diff(confirm.mean_diff),
            f"{confirm.defeat_rate:.1%}",
        )
    console.print(top)

    combined = summary["combined"]
    if combined is not None and result.combined is not None:
        applied = "\n".join(
            f"  {entry['displayName']}: {move_text(move)}"
            for entry, move in zip(combined["applied"], result.combined.applied, strict=True)
        )
        verify = combined["verify"]
        console.print(
            f"[bold]上位 {len(combined['applied'])} 手を同時適用[/]\n{applied}\n"
            f"  Δ期待日次ベスト {_diff(verify['expectedBestDiff'])}"
            f" {_diff_interval(verify['expectedBestCiLow'], verify['expectedBestCiHigh'])}"
            " / 1手ずつの合計とは一致しない"
        )
        for skipped, move in zip(combined["skipped"], result.combined.skipped, strict=True):
            error_console.print(
                f"[yellow]warning[/]: {skipped['unitDefinitionId']} {move_text(move)}"
                " は先の手と両立せず同時適用から外した"
            )

    console.print(f"[yellow]{summary['caveat']}[/]")
    console.print(
        "なぜ動いたかは評価APIからは出ない（数値しか返らない）。上位手を適用した編成で"
        "単体実行を1回回し、UIの効果トレースで確認する"
    )
    for warning in result.warnings:
        error_console.print(f"[yellow]warning[/]: {warning}")


@app.command("gear-plan")
def gear_plan(
    config_path: Annotated[Path, typer.Argument(help="基点となる編成定義YAML", exists=True)],
    budget: Annotated[
        int, typer.Option("--budget", min=1, help="シミュレーション総試行数の上限")
    ] = DEFAULT_PLAN_BUDGET_RUNS,
    seed: Annotated[str | None, typer.Option("--seed", help="省略時は生成して表示する")] = None,
    out: Annotated[Path, typer.Option("--out", help="レポート出力先")] = Path("reports"),
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    screen_runs: Annotated[
        int, typer.Option("--screen-runs", min=2, help="篩いの試行数（1反復の全手ぶん）")
    ] = DEFAULT_CLIMB_SCREEN_RUNS,
    confirm_runs: Annotated[
        int, typer.Option("--confirm-runs", min=2, help="確定の試行数")
    ] = DEFAULT_CLIMB_CONFIRM_RUNS,
    survivors: Annotated[
        int, typer.Option("--survivors", min=1, help="確定へ通す手の上限")
    ] = DEFAULT_CLIMB_SURVIVORS,
    max_iterations: Annotated[
        int, typer.Option("--max-iterations", min=1, help="1本の山登りの最大反復数")
    ] = DEFAULT_MAX_ITERATIONS,
    restarts: Annotated[
        int, typer.Option("--restarts", min=0, help="レジーム再スタートの本数")
    ] = DEFAULT_RESTARTS,
    push_steps: Annotated[
        int, typer.Option("--push-steps", min=1, help="1本の再スタートで押す最大手数")
    ] = DEFAULT_PUSH_STEPS,
    include_rank: Annotated[
        bool, typer.Option("--include-rank", help="種別・ランクの変更も近傍へ含める")
    ] = False,
    add_rank: Annotated[
        str, typer.Option("--add-rank", help="空枠へ挿す1枚の種別・ランク（例 II-C）")
    ] = DEFAULT_ADD_RANK.label,
    assume_yes: Annotated[
        bool, typer.Option("--yes", "-y", help="所要時間の確認を省いて実行する")
    ] = False,
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
    """現状の手持ちを起点に、理論値のギア配分を探す（Phase A→B→C）。

    探索変数はギア配分だけである。ユニット・配置・メモリー・敵・レベル・学園レベルは
    基点編成のまま固定する。**基点を変えたら結果は無効になる。**
    """
    base_seed = seed if seed is not None else secrets.token_hex(8)
    objective = Objective()
    config = _load(config_path, player_data)
    try:
        settings = PlanSettings(
            climb=ClimbSettings(
                screen_runs=screen_runs,
                confirm_runs=confirm_runs,
                survivors=survivors,
                max_iterations=max_iterations,
                include_rank=include_rank,
                add_rank=rank_from_label(add_rank),
            ),
            restarts=restarts,
            push_steps=push_steps,
        )
        source = GearFormationSource(config)
    except (ConfigError, GearAllocationError) as error:
        _abort(str(error))

    start = source.base_allocation()
    moves = neighborhood(
        start, include_rank=settings.climb.include_rank, add_rank=settings.climb.add_rank
    )
    if not moves:
        _abort("1手も生成できなかった。基点編成のギアが動かせる状態にない")
    plan = plan_budget(settings, move_count=len(moves))
    # `optimize` 側の `minimum_budget` と名前が衝突するため別名で読む。
    minimum = minimum_plan_budget(settings, move_count=len(moves))
    observations = observation_count(settings)

    out.mkdir(parents=True, exist_ok=True)
    with LabApiClient(base_url, timeout_seconds=timeout_seconds) as client:
        try:
            catalog = client.fetch_catalog()
        except LabApiError as error:
            _abort(str(error))
        _reject_catalog_violations(config, catalog)
        console.print(
            f"catalogRevision: [bold]{catalog.catalog_revision}[/] / seed: [bold]{base_seed}[/]"
        )
        _print_plan_budget(
            settings,
            moves=len(moves),
            plan=plan,
            budget=budget,
            minimum=minimum,
            observations=observations,
        )
        if budget < minimum:
            # 校正リクエストを投げる前に落とす。校正も予算の内であり、1反復も回せない
            # 予算で「校正だけ実行して何も探索しない」結果を返さない。
            _abort(
                f"予算 {budget:,} 試行では1反復も回せない（1反復 {minimum:,} 試行。"
                "校正で測る基点は篩いがキャッシュから読むので別勘定にはならない）。"
                f"--budget を {minimum:,} 以上にするか、--screen-runs / --confirm-runs /"
                " --survivors を下げる"
            )
        evaluator = Evaluator(
            client,
            source,
            base_seed=base_seed,
            phases=phases_for_climb(settings.climb),
            max_candidates=max_candidates,
            max_total_runs=max_total_runs,
            log_path=out / GEAR_PLAN_EVALUATIONS_CSV,
        )
        observer = _CachingObserver(client, source)
        try:
            _calibrate(
                evaluator,
                observer,
                start,
                settings=settings,
                budget=min(budget, plan["total"]),
                observations=observations,
                assume_yes=assume_yes,
            )
            result = _run_plan_with_progress(
                start,
                evaluator,
                observer,
                settings=settings,
                objective=objective,
                budget=budget,
                total=min(budget, plan["total"]),
            )
        except (LabApiError, ValueError) as error:
            _abort(str(error))
        catalog_revision = evaluator.catalog_revision or catalog.catalog_revision

    summary = build_plan_summary(
        result,
        config=config,
        catalog=catalog,
        settings=settings,
        objective=objective,
        seed=base_seed,
        catalog_revision=catalog_revision,
        budget=plan,
        budget_runs=budget,
        observations=observer.calls,
    )
    (out / GEAR_PLAN_JSON).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    _print_plan(result, summary, catalog)
    console.print(f"レポート: [bold]{out}[/]")


@dataclass
class _CachingObserver:
    """単発実行でレジーム署名を取る。同じ配分は1度しか観測しない。

    単発実行はseedを受け取らない（`10_API設計.md`「TacticalExerciseRequest」）ので、
    同じ配分を2度観測しても同じ署名が返る保証が無い。畳んでおかないと、押した手を
    1つ戻しただけで「レジームが変わった」と読める結果が出うる。
    """

    client: LabApiClient
    source: GearFormationSource
    cache: dict[str, RegimeSignature] = field(default_factory=dict)
    calls: int = 0
    elapsed_seconds: float = 0.0

    def observe(self, allocation) -> RegimeSignature:
        key = allocation.canonical_key()
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        started = time.perf_counter()
        signature, _ = observe_signature(self.client, self.source, allocation)
        self.elapsed_seconds += time.perf_counter() - started
        self.calls += 1
        self.cache[key] = signature
        return signature


def _calibrate(
    evaluator: Evaluator,
    observer: _CachingObserver,
    start,
    *,
    settings: PlanSettings,
    budget: int,
    observations: int,
    assume_yes: bool,
) -> None:
    """実測してから総所要時間を出し、続行を確認する。

    校正に使うのは捨て実行ではない——基点の観測（Phase A で要る）と、基点の篩い評価
    （最初の反復で要る）をそのまま計る。数万試行を投げる前に、待ち時間が見合うかを
    利用者が決められるようにする。
    """
    observer.observe(start)
    screen_phase, _ = phases_for_climb(settings.climb)
    started = time.perf_counter()
    record = evaluator.ensure([start], settings.climb.screen_runs, phase=screen_phase)[0]
    elapsed = time.perf_counter() - started
    if record.sample_count < 1 or elapsed <= 0.0:
        _abort("校正リクエストで1試行も完了しなかった。devサーバーの状態を確かめる")
    rate = record.sample_count / elapsed
    estimate = budget / rate + observations * observer.elapsed_seconds / max(1, observer.calls)
    console.print(
        f"校正: {rate:,.0f} 試行/秒（{record.sample_count} 試行を {elapsed:.1f} 秒）/"
        f" 単発実行 {observer.elapsed_seconds / max(1, observer.calls):.1f} 秒"
    )
    console.print(
        f"上限まで回した場合の見積り: [bold]{_duration(estimate)}[/]"
        f"（評価 {budget:,} 試行 + 単発実行 {observations} 回）"
    )
    if assume_yes:
        return
    if not typer.confirm("続行する？", default=True):
        raise typer.Exit(code=0)


def _duration(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f} 秒"
    if seconds < 5400:
        return f"{seconds / 60:.0f} 分"
    return f"{seconds / 3600:.1f} 時間"


def _run_plan_with_progress(
    start,
    evaluator: Evaluator,
    observer: SignatureObserver,
    *,
    settings: PlanSettings,
    objective: Objective,
    budget: int,
    total: int,
) -> PlanResult:
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} runs"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Phase B", total=total, completed=evaluator.consumed_runs)

        def advance(description: str) -> None:
            progress.update(
                task, completed=min(total, evaluator.consumed_runs), description=description
            )

        try:
            return plan_gear_allocation(
                start,
                _ProgressEvaluator(evaluator, lambda name: advance(name)),
                _ProgressObserver(observer, advance),
                settings=settings,
                objective=objective,
                budget_runs=budget,
            )
        except (LabApiError, ValueError):
            progress.stop()
            raise


@dataclass
class _ProgressObserver:
    """観測のたびに進捗の説明を書き換えるだけの覆い。"""

    observer: SignatureObserver
    advance: Any

    def observe(self, allocation):
        self.advance("Phase A/C 観測")
        return self.observer.observe(allocation)


def _print_plan_budget(
    settings: PlanSettings,
    *,
    moves: int,
    plan: dict[str, int],
    budget: int,
    minimum: int,
    observations: int,
) -> None:
    table = Table(title=f"予算の内訳（1手近傍 {moves} 手）")
    table.add_column("項目")
    table.add_column("内訳")
    table.add_column("試行数", justify="right")
    table.add_row(
        "1反復",
        f"篩い {1 + moves} 候補 × {settings.climb.screen_runs} +"
        f" 確定 {1 + min(settings.climb.survivors, moves)} 候補 × {settings.climb.confirm_runs}",
        f"{plan['perIteration']:,}",
    )
    table.add_row(
        "1本の山登り", f"最大 {settings.climb.max_iterations} 反復", f"{plan['perClimb']:,}"
    )
    table.add_row("全体", f"基点 + 再スタート {settings.restarts} 本", f"{plan['total']:,}")
    table.add_row("上限（--budget）", "これを超えて評価を発行しない", f"{budget:,}")
    table.add_row("最低予算", "1反復ぶん。届かなければ実行前に失敗する", f"{minimum:,}")
    console.print(table)
    console.print(f"単発実行（レジーム観測）は最大 {observations} 回。試行数の予算とは別勘定")


def _print_plan(result: PlanResult, summary: dict[str, Any], catalog: Catalog) -> None:
    _print_signature(result.base_signature, title="基点のレジーム署名")

    climb = Table(title=f"Phase B: 基点からの山登り（{result.base_climb.stopped_because}）")
    for column in ("反復", "ユニット", "手", "Δ確定", "Δ自ユニット与ダメ"):
        climb.add_column(column, justify="left" if column in ("ユニット", "手") else "right")
    for step in summary["baseClimb"]["steps"]:
        climb.add_row(
            str(step["iteration"]),
            step["displayName"],
            step["move"],
            _diff(step["fitnessGain"]),
            _diff(step["damageGain"]),
        )
    console.print(climb)
    if not summary["baseClimb"]["steps"]:
        console.print("基点は既に1手近傍の局所最適だった")

    if result.restarts:
        restarts = Table(title="Phase C: レジーム再スタート")
        for column in ("本", "成分", "向き", "枠", "押した手", "結果", "Δ確定"):
            restarts.add_column(
                column, justify="left" if column not in ("本", "Δ確定") else "right"
            )
        for attempt, reported in zip(result.restarts, summary["restarts"], strict=True):
            gain = "-"
            if attempt.climb is not None and result.ranking:
                gain = _diff(_gain_over_base(result, attempt.climb.best))
            restarts.add_row(
                str(attempt.index),
                attempt.component,
                attempt.direction,
                str(attempt.slot_index),
                str(len(attempt.moves)),
                reported["stoppedBecause"],
                gain,
            )
        console.print(restarts)

    best = Table(title="到達したギア配分（括弧は基点からの増減）")
    best.add_column("ユニット")
    for stat in SEARCHED_STATS:
        best.add_column(STAT_LABELS[stat], justify="right")
    for label, values in allocation_rows(result.best, result.start, catalog):
        best.add_row(label, *values)
    console.print(best)

    signatures = Table(title="到達したレジーム署名")
    for column in ("署名", "観測点", "成分の当て先"):
        signatures.add_column(column)
    for entry in result.signatures:
        signatures.add_row(
            entry.signature.digest(),
            entry.origin,
            ", ".join(
                f"{component}→{recipient}"
                for component, recipient in sorted(entry.signature.assignments.items())
            )
            or "-",
        )
    console.print(signatures)
    untouched = [
        f"{attempt.component} を {attempt.direction} へ押しても署名が変わらなかった"
        for attempt in result.restarts
        if not attempt.changed
    ]
    for line in untouched:
        console.print(f"[dim]{line}[/]")

    console.print(f"[yellow]{summary['caveat']}[/]")
    console.print(f"[dim]{summary['rankingCaveat']}[/]")
    for warning in result.warnings:
        error_console.print(f"[yellow]warning[/]: {warning}")


def _gain_over_base(result: PlanResult, allocation) -> float:
    """基点から登った枝の到達点に対する差。枝どうしの比較はこの差で読む。"""
    ranked = {candidate.canonical_key(): fitness for candidate, fitness in result.ranking}
    baseline = ranked.get(result.base_climb.best.canonical_key())
    fitness = ranked.get(allocation.canonical_key())
    if baseline is None or fitness is None:
        return 0.0
    return fitness - baseline


def _print_signature(signature: RegimeSignature, *, title: str) -> None:
    table = Table(title=f"{title}（{signature.digest()}）")
    table.add_column("成分")
    table.add_column("当て先")
    table.add_row("行動順", " → ".join(signature.action_order) or "-")
    for component, recipient in sorted(signature.assignments.items()):
        table.add_row(component, recipient)
    for component, consumer in sorted(signature.consumers.items()):
        table.add_row(f"{component}（消費）", consumer or "-")
    console.print(table)


def _abort(message: str) -> NoReturn:
    error_console.print(f"[red]error[/]: {message}")
    raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
