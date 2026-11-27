"""探索結果の比較・詳細再生コマンド。"""

from __future__ import annotations

from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from mlgg_lab_common.api.contracts import MAX_RUN_INDEX

from .search_cli import (
    SEARCH_ERRORS,
    AccessKey,
    Directory,
    PhaseOption,
    abort,
    emit,
    open_exercise_search,
)
from .search_inspect import inspect_trials
from .search_reports import compare_candidates


def compare(
    directory: Directory,
    baseline: Annotated[str, typer.Option(help="基準の candidateId")],
    candidate: Annotated[
        list[str] | None, typer.Option(help="比較先の candidateId。繰り返し指定可")
    ] = None,
    phase: Annotated[PhaseOption, typer.Option()] = PhaseOption.SCREENING,
    as_json: Annotated[
        bool, typer.Option("--json", help="試行参照と変更履歴を含むJSONを返す")
    ] = False,
) -> None:
    """同じ seed・試行番号で完了した試行を比較する。"""
    try:
        with open_exercise_search(directory) as store:
            result = compare_candidates(store, baseline, candidate or [], phase)
        if as_json:
            emit(result)
            return
        table = Table(
            title=f"{phase.value} / 基準 {baseline}",
            caption="各差分の [下限, 上限] は対応ブートストラップの95%区間",
        )
        table.add_column("候補")
        table.add_column("対応試行", justify="right")
        table.add_column("平均スコア差", justify="right")
        table.add_column(f"best-of-{result['bestOf']}期待値差", justify="right")
        for row in result["comparisons"]:
            table.add_row(
                row["candidateId"],
                str(row["pairedRuns"]),
                _delta_text(row["meanScore"]),
                _delta_text(row["expectedBest"]),
            )
        Console().print(table)
    except SEARCH_ERRORS as error:
        abort(error)


def _delta_text(metric: dict) -> str:
    delta = metric["delta"]
    if delta is None:
        return "—"
    interval = metric["confidenceInterval95"]
    if interval is None:
        return f"{delta:+,.0f}"
    return f"{delta:+,.0f} [{interval[0]:+,.0f}, {interval[1]:+,.0f}]"


def inspect(
    directory: Directory,
    candidate: Annotated[str, typer.Option(help="詳細再生する candidateId")],
    run_index: Annotated[
        list[int], typer.Option(min=0, max=MAX_RUN_INDEX, help="試行番号。繰り返し指定可")
    ],
    baseline: Annotated[
        str | None, typer.Option(help="同じ試行番号で再生する基準の candidateId")
    ] = None,
    phase: Annotated[PhaseOption, typer.Option()] = PhaseOption.SCREENING,
    evaluation_id: Annotated[str | None, typer.Option(help="試行参照の evaluationId")] = None,
    unit: Annotated[
        list[str] | None, typer.Option(help="抜粋するユニット定義ID。繰り返し指定可")
    ] = None,
    effect: Annotated[
        list[str] | None, typer.Option(help="抜粋する効果定義ID。繰り返し指定可")
    ] = None,
    event_limit: Annotated[int, typer.Option(min=0, help="種別ごとのイベント抜粋上限")] = 12,
    access_key: AccessKey = None,
) -> None:
    """試行を詳細再生し、スコア・行動順・対象・効果の要約をJSONで返す。"""
    try:
        with open_exercise_search(directory) as store:
            emit(
                inspect_trials(
                    store,
                    candidate,
                    run_index,
                    phase,
                    baseline,
                    evaluation_id,
                    unit or [],
                    effect or [],
                    event_limit,
                    access_key,
                )
            )
    except SEARCH_ERRORS as error:
        abort(error)
