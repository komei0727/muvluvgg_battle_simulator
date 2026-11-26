"""`status` / `summarize` の人が読む表示。値は `reporting` の構造をそのまま使う。"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from rich.console import Console
from rich.markup import escape

from ..reporting.analyzer import FormatAnalyzer
from ..reporting.text import format_ratios

NO_SAMPLES = "集計対象なし"


def _environment_line(environment: Mapping[str, Any] | None) -> str:
    if environment is None:
        return "実行環境: 未確定（完了した試行が無い）"
    return (
        f"実行環境: catalog {environment['catalogRevision']} / "
        f"engine {environment['engineRevision']} / "
        f"seedDerivation {environment['seedDerivationVersion']}"
    )


def _stop_line(last: Mapping[str, Any] | None) -> str:
    if last is None:
        return "最後の停止: まだ実行していない"
    if last["stopReason"] == "RUNNING":
        return "状態: RUNNING（別のプロセスが実行中。resume は拒否される）"
    if last["stopReason"] == "INTERRUPTED":
        return (
            "最後の停止: INTERRUPTED（停止理由を記録する前に実行が終わった。resume で続けられる）"
        )
    if last["stopReason"] == "UNKNOWN":
        return "状態: UNKNOWN（停止理由が無く、実行中かどうかを確かめられない）"
    detail = f"（{last['detail']}）" if last.get("detail") else ""
    return f"最後の停止: {last['stopReason']}{detail}"


def render_status(console: Console, status: Mapping[str, Any]) -> None:
    counters = status["counters"]
    budget = status["budget"]
    lines = [
        f"[bold]{escape(status['evaluationId'])}[/] ({status['format']}, {status['contractId']})",
        f"seed: {escape(status['seed'])} / 作成: {status['createdAt']}",
        escape(_environment_line(status["environment"])),
        f"試行: 計画 {counters['plannedRuns']} / 完了 {counters['completedTrials']}"
        f" / 未完了 {counters['pendingTrials']}",
        f"送信: {counters['submittedRuns']} 試行（再送・未完了分を含む）"
        f" / 要求 {counters['attempts']} 回"
        f" / 予算 {budget['maxSubmittedRuns']}（残り {budget['remainingRuns']}）",
        "要求の結末: " + _counts(status["attemptsByStatus"]),
        "失敗の内訳: " + _counts(status["failuresByKind"]),
        escape(_stop_line(status["lastSession"])) + f" / 実行 {status['sessions']} 回",
        "ケース:",
    ]
    lines += [
        f"  {escape(c['caseId'])}: 完了 {c['completedTrials']} / 計画 {c['plannedTrials']}"
        f"（未完了 {c['pendingTrials']}）"
        for c in status["cases"]
    ]
    console.print("\n".join(lines), markup=True)


def render_summary(console: Console, summary: Mapping[str, Any], analyzer: FormatAnalyzer) -> None:
    counters = summary["counters"]
    console.print(
        f"[bold]{escape(summary['evaluationId'])}[/]"
        f" ({summary['format']}, {summary['contractId']})",
        markup=True,
    )
    console.print(
        "\n".join(
            [
                f"seed: {summary['seed']}",
                _environment_line(summary["environment"]),
                f"試行: 計画 {counters['plannedRuns']} / 完了 {counters['completedTrials']}"
                f" / 未完了 {counters['pendingTrials']}",
                _stop_line(summary["lastSession"]),
            ]
        ),
        markup=False,
    )
    if counters["pendingTrials"]:
        console.print("未完了・失敗した試行は集計に含めない（件数だけを示す）。", markup=False)
    for case in summary["cases"]:
        console.print(f"\n[bold]== {escape(case['caseId'])} ==[/]", markup=True)
        lines = [
            f"対戦条件: {case['match']}",
            f"標本数: {case['sampleSize']}（計画 {case['plannedTrials']}・"
            f"未完了 {case['pendingTrials']}）",
        ]
        if case["statistics"] is None:
            lines.append(NO_SAMPLES)
        else:
            lines.append("終了理由: " + format_ratios(case["completionReasons"]))
            lines += analyzer.describe_statistics(case["statistics"])
        console.print("\n".join(f"  {line}" for line in lines), markup=False)


def _counts(counts: Mapping[str, int]) -> str:
    return ", ".join(f"{k} {v}" for k, v in counts.items()) or "なし"
