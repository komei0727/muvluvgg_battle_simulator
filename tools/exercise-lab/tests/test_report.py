"""レポート出力。`runs.csv` は後段の分析の正本なので、列と並びを固定する。"""

import json

from exercise_lab.runner import EvaluationRun, RunRecord
from exercise_lab.stats import (
    build_summary,
    write_break_count_chart,
    write_runs_csv,
    write_score_histogram,
)

RECORDS = [
    RunRecord(
        run_index=index,
        chunk_index=index // 2,
        chunk_seed=f"abc#{(index // 2) * 2}",
        run_index_in_chunk=index % 2,
        score=(index + 1) * 10,
        break_count=index,
        completed_turn=5,
        completion_reason="TURN_LIMIT_REACHED" if index else "ALLY_DEFEATED",
    )
    for index in range(4)
]

RUN = EvaluationRun(requested_runs=5, records=RECORDS, catalog_revision="2026-06-28.1")


def test_runs_csv_has_a_fixed_column_order_and_one_row_per_run(tmp_path):
    path = tmp_path / "runs.csv"

    write_runs_csv(RUN.records, path)

    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == (
        "run_index,chunk_index,chunk_seed,run_index_in_chunk,"
        "score,break_count,completed_turn,completion_reason"
    )
    assert lines[1] == "0,0,abc#0,0,10,0,5,ALLY_DEFEATED"
    assert len(lines) == 1 + len(RECORDS)


def test_runs_csv_is_byte_identical_for_the_same_records(tmp_path):
    first = tmp_path / "a.csv"
    second = tmp_path / "b.csv"

    write_runs_csv(RUN.records, first)
    write_runs_csv(RUN.records, second)

    assert first.read_bytes() == second.read_bytes()


def test_summary_records_the_requested_and_actual_run_counts(tmp_path):
    summary = build_summary(RUN, seed="abc", chunk_size=2)

    assert summary["requestedRuns"] == 5
    assert summary["completedRuns"] == 4
    assert summary["partial"] is True
    assert summary["seed"] == "abc"
    assert summary["chunkSize"] == 2
    assert summary["catalogRevision"] == "2026-06-28.1"


def test_summary_carries_the_statistics_and_the_break_distribution():
    summary = build_summary(RUN, seed="abc", chunk_size=2)

    assert summary["score"]["count"] == 4
    assert summary["score"]["mean"] == 25.0
    assert summary["defeatRate"] == 0.25
    assert summary["breakCountDistribution"] == {"0": 1, "1": 1, "2": 1, "3": 1}


def test_summary_is_json_serialisable_and_stable():
    first = json.dumps(build_summary(RUN, seed="abc", chunk_size=2), sort_keys=True)
    second = json.dumps(build_summary(RUN, seed="abc", chunk_size=2), sort_keys=True)

    assert first == second


def test_charts_are_written(tmp_path):
    histogram = tmp_path / "score-histogram.png"
    breaks = tmp_path / "break-count-distribution.png"

    write_score_histogram([record.score for record in RECORDS], histogram, title="t")
    write_break_count_chart([record.break_count for record in RECORDS], breaks, title="t")

    assert histogram.stat().st_size > 0
    assert breaks.stat().st_size > 0
