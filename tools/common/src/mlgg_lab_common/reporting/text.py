"""記述統計の値を人が読む1行にする（`summarize` の表示・各ラボの `describe_statistics` 用）。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def format_ratios(counts: Mapping[str, Mapping[str, Any]]) -> str:
    """`category_counts` の結果を「名前 件数 (比率)」の並びにする。"""
    return ", ".join(
        f"{name} {entry['count']} ({entry['ratio']:.1%})" for name, entry in counts.items()
    )


def format_numeric(summary: Mapping[str, Any], *, digits: int = 1) -> str:
    """`NumericSummary.to_dict()` を1行にする。"""
    stdev = "-" if summary["stdev"] is None else f"{summary['stdev']:.{digits}f}"
    return (
        f"平均 {summary['mean']:.{digits}f} / 中央値 {summary['median']:.{digits}f}"
        f" / 標準偏差 {stdev} / 最小 {summary['min']:g} / 最大 {summary['max']:g}"
        f" / p05 {summary['p05']:.{digits}f} / p25 {summary['p25']:.{digits}f}"
        f" / p75 {summary['p75']:.{digits}f} / p95 {summary['p95']:.{digits}f}"
        f"（n={summary['count']}）"
    )


def format_frequency(entries: Sequence[Mapping[str, Any]]) -> str:
    """`frequency` の結果を「値: 件数 (比率)」の並びにする。"""
    return ", ".join(f"{e['value']}: {e['count']} ({e['ratio']:.1%})" for e in entries)


def describe_formation(formation: Mapping[str, Any]) -> str:
    """送信する編成（`FormationRequest`）を「ユニットID, … + メモリーn件」にする。並びは送信順。"""
    units = ", ".join(str(unit["unitDefinitionId"]) for unit in formation.get("units", []))
    memories = len(formation.get("memoryDefinitionIds", []))
    return f"[{units}]" + (f" + メモリー{memories}件" if memories else "")
