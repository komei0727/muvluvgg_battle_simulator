"""試行ごとの生値から統計量を出す。

サーバーは統計量を返さない（`10_API設計.md`「TacticalExerciseCandidateEvaluationResponse」、
Q-TEX-16）。集計はここが唯一の実装であり、レポートに載る数値はすべてこの関数群を通す。
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import matplotlib

# 図はファイルへ書くだけで画面へは出さない。CLIから呼ばれるため、GUIバックエンドを
# 掴むとヘッドレス環境で失敗する。
matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .runner import EvaluationRun, RunRecord

# 平均の信頼区間は正規近似で出す。t分布を使わないのは依存（scipy）を増やさないためで、
# 想定する試行数（数百〜数千）では両者の差が表示桁に出ない。試行数が数十で終わった
# 部分結果では区間がやや狭くなる点をレポート側で明記する。
CONFIDENCE_LEVEL = 0.95
NORMAL_QUANTILE_95 = 1.959963984540054

ALLY_DEFEATED = "ALLY_DEFEATED"


@dataclass(frozen=True)
class ScoreSummary:
    count: int
    mean: float
    median: float
    # 試行1回では散らばりが定義できないため `None` にする。0を返すと
    # 「ばらつきが無い」という別の意味になる。
    stdev: float | None
    minimum: int
    maximum: int
    p05: float
    p25: float
    p75: float
    p95: float
    ci_low: float | None
    ci_high: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize_scores(scores: Sequence[int]) -> ScoreSummary:
    if len(scores) == 0:
        raise ValueError("統計を出すには1件以上のスコアが要る")
    values = np.asarray(scores, dtype=np.float64)
    mean = float(values.mean())
    stdev = float(values.std(ddof=1)) if len(scores) >= 2 else None
    half_width = None if stdev is None else NORMAL_QUANTILE_95 * stdev / float(np.sqrt(len(scores)))
    p05, p25, p75, p95 = (float(value) for value in np.percentile(values, [5, 25, 75, 95]))
    return ScoreSummary(
        count=len(scores),
        mean=mean,
        median=float(np.median(values)),
        stdev=stdev,
        minimum=int(min(scores)),
        maximum=int(max(scores)),
        p05=p05,
        p25=p25,
        p75=p75,
        p95=p95,
        ci_low=None if half_width is None else mean - half_width,
        ci_high=None if half_width is None else mean + half_width,
    )


def defeat_rate(completion_reasons: Sequence[str]) -> float:
    """`ALLY_DEFEATED` で終わった試行の割合。5ターン走り切れない編成を弾くための指標。"""
    if len(completion_reasons) == 0:
        raise ValueError("敗北率を出すには1件以上の完了理由が要る")
    defeated = sum(1 for reason in completion_reasons if reason == ALLY_DEFEATED)
    return defeated / len(completion_reasons)


def break_count_distribution(break_counts: Sequence[int]) -> dict[int, int]:
    """ブレイク回数ごとの試行数。回数の昇順で返し、表示側の並べ替えに依存させない。"""
    counter = Counter(break_counts)
    return {count: counter[count] for count in sorted(counter)}


RUNS_CSV_COLUMNS = (
    "run_index",
    "chunk_index",
    "chunk_seed",
    "run_index_in_chunk",
    "score",
    "break_count",
    "completed_turn",
    "completion_reason",
)


def write_runs_csv(records: Sequence[RunRecord], path: Path) -> None:
    """試行ごとの生値をCSVへ書く。列と並びを固定するのは、これが後段（横断分析・
    オプティマイザ）の正本になり、読み手が列位置を前提に書けるようにするため。"""
    frame = pd.DataFrame([asdict(record) for record in records], columns=list(RUNS_CSV_COLUMNS))
    frame.to_csv(path, index=False, lineterminator="\n")


def build_summary(run: EvaluationRun, *, seed: str, chunk_size: int) -> dict[str, Any]:
    """レポートの数値部分。`--seed` と同じ値で再実行したときに完全一致する内容だけを置く。

    再現に要る条件（seed・チャンクサイズ・実試行数）も併せて書く。部分結果は
    `requestedRuns` と `completedRuns` の差として残し、要求数へ丸めない。
    """
    scores = [record.score for record in run.records]
    return {
        "seed": seed,
        "chunkSize": chunk_size,
        "catalogRevision": run.catalog_revision,
        "requestedRuns": run.requested_runs,
        "completedRuns": run.completed_runs,
        "partial": run.is_partial,
        "score": summarize_scores(scores).to_dict(),
        "defeatRate": defeat_rate([record.completion_reason for record in run.records]),
        # JSONのキーは文字列でなければならないため、回数を文字列化して昇順で並べる。
        "breakCountDistribution": {
            str(count): runs
            for count, runs in break_count_distribution(
                [record.break_count for record in run.records]
            ).items()
        },
    }


def write_score_histogram(scores: Sequence[int], path: Path, *, title: str) -> None:
    figure, axes = plt.subplots(figsize=(8, 4.5))
    try:
        axes.hist(scores, bins=_histogram_bins(scores), color="#4c78a8", edgecolor="white")
        axes.set_title(title)
        axes.set_xlabel("score")
        axes.set_ylabel("runs")
        figure.tight_layout()
        figure.savefig(path, dpi=120)
    finally:
        plt.close(figure)


def _histogram_bins(scores: Sequence[int]) -> int:
    """試行数からビン数を決める（Sturges）。試行数だけで決まるので、同じ入力なら
    同じ図になる。"""
    return max(1, min(60, int(np.ceil(np.log2(len(scores)) + 1))))


def write_break_count_chart(break_counts: Sequence[int], path: Path, *, title: str) -> None:
    distribution = break_count_distribution(break_counts)
    figure, axes = plt.subplots(figsize=(8, 4.5))
    try:
        axes.bar(
            [str(count) for count in distribution],
            list(distribution.values()),
            color="#f58518",
        )
        axes.set_title(title)
        axes.set_xlabel("break count")
        axes.set_ylabel("runs")
        figure.tight_layout()
        figure.savefig(path, dpi=120)
    finally:
        plt.close(figure)
