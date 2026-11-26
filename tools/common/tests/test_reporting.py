"""保存済みDBからの進捗・ケース別集計・エクスポート。APIへは接続しない。

集計の形式固有部分はラボが持つので、ここでは最小の `FormatAnalyzer` を使い、共通の規則
（ケース別・完了した固有試行だけ・0件は集計対象なし・出力の追跡性と再生成）を確かめる。
"""

import csv
import io
import json
import sqlite3

import pytest

from mlgg_lab_common.evaluation.models import Budget, ExecutionSettings
from mlgg_lab_common.evaluation.plan import CaseSpec, create_plan
from mlgg_lab_common.evaluation.runner import StopReason, run_evaluation
from mlgg_lab_common.reporting import (
    EXPORT_FORMAT_VERSION,
    CsvColumn,
    FormatAnalyzer,
    evaluation_status,
    export_evaluation,
    load_snapshot,
    read_evaluation,
    summarize_evaluation,
)
from mlgg_lab_common.statistics.summary import category_counts
from mlgg_lab_common.storage.layout import create_evaluation
from mlgg_lab_common.testing import FakeBattleInput, FakeEvaluationServer

A = FakeBattleInput.of(["UNIT_A"], ["UNIT_B"])
B = FakeBattleInput.of(["UNIT_C"], ["UNIT_B"], turn_limit=9)

ANALYZER = FormatAnalyzer(
    format="BATTLE",
    statistics_version=1,
    completion_reasons=("ENEMY_DEFEATED", "ALLY_DEFEATED"),
    case_statistics=lambda obs: {
        "outcomes": category_counts([o["outcome"] for o in obs], ["ALLY_WIN", "ALLY_LOSE"])
    },
    describe_statistics=lambda stats: [],
    describe_match=lambda match: f"turnLimit={match['turnLimit']}",
    csv_columns=(
        CsvColumn("outcome", lambda o: o.get("outcome"), "勝敗"),
        CsvColumn("missing", lambda o: o.get("noSuchKey"), "存在しない値"),
    ),
)


def no_sleep(_):
    pass


def make_evaluation(tmp_path, *, runs_a=(0, 1, 2, 3), runs_b=(0, 1), budget=1000, **settings):
    plan = create_plan(
        "BATTLE",
        [CaseSpec("a", A, list(runs_a)), CaseSpec("b", B, list(runs_b))],
        seed="s",
        budget=Budget(max_submitted_runs=budget),
        settings=ExecutionSettings(**settings),
        evaluation_id="e1",
    )
    return create_evaluation(tmp_path / "evaluations", plan)


def test_status_counts_planned_submitted_completed_and_failures_separately(tmp_path):
    _, repo = make_evaluation(tmp_path, maxRetries=0)
    server = FakeEvaluationServer(complete_limit=3, script=["ok", "lost"])
    with repo:
        report = run_evaluation(repo, server, sleep=no_sleep)
        assert report.stop_reason is StopReason.RETRY_LIMIT_REACHED
        status = evaluation_status(load_snapshot(repo))

    assert status["counters"] == {
        "plannedRuns": 6,
        "submittedRuns": 9,
        "completedTrials": 3,
        "pendingTrials": 3,
        "attempts": 2,
    }
    assert status["budget"] == {"maxSubmittedRuns": 1000, "remainingRuns": 991}
    assert status["failuresByKind"] == {"TRANSPORT": 1}
    assert status["lastSession"]["stopReason"] == "RETRY_LIMIT_REACHED"
    assert status["cases"] == [
        {"caseId": "a", "plannedTrials": 4, "completedTrials": 3, "pendingTrials": 1},
        {"caseId": "b", "plannedTrials": 2, "completedTrials": 0, "pendingTrials": 2},
    ]


def test_an_unfinished_session_is_shown_as_interrupted(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    with repo, pytest.raises(KeyboardInterrupt):
        run_evaluation(repo, FakeEvaluationServer(script=["interrupt"]), sleep=no_sleep)

    status = evaluation_status(read_evaluation(directory))
    # 実行していたプロセスが居なくなった（ロックが外れている）ので中断と判定できる。
    assert status["running"] is False
    assert status["lastSession"]["stopReason"] == "INTERRUPTED"
    assert status["attemptsByStatus"] == {"IN_FLIGHT": 1}
    assert status["counters"]["completedTrials"] == 0


def test_summary_is_per_case_and_counts_only_completed_unique_trials(tmp_path):
    directory, repo = make_evaluation(tmp_path, maxRetries=0)
    with repo:
        run_evaluation(
            repo, FakeEvaluationServer(complete_limit=3, script=["ok", "lost"]), sleep=no_sleep
        )
    summary = summarize_evaluation(read_evaluation(directory), ANALYZER)

    a, b = summary["cases"]
    assert (a["caseId"], a["sampleSize"], a["pendingTrials"]) == ("a", 3, 1)
    assert a["match"] == "turnLimit=5"
    assert sum(e["count"] for e in a["statistics"]["outcomes"].values()) == 3
    assert sum(e["count"] for e in a["completionReasons"].values()) == 3
    # 完了0件のケースは0で埋めず「集計対象なし」（null）にする。
    assert (b["sampleSize"], b["statistics"], b["completionReasons"]) == (0, None, None)
    assert summary["environment"]["engineRevision"] == "eng-1"
    assert summary["counters"]["pendingTrials"] == 3


def test_summary_can_select_cases_and_rejects_unknown_ones(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    with repo:
        run_evaluation(repo, FakeEvaluationServer(), sleep=no_sleep)
    snapshot = read_evaluation(directory)

    assert [
        c["caseId"] for c in summarize_evaluation(snapshot, ANALYZER, case_ids=["b"])["cases"]
    ] == ["b"]
    with pytest.raises(KeyError, match="nope"):
        summarize_evaluation(snapshot, ANALYZER, case_ids=["nope"])


def test_summary_refuses_an_analyzer_of_another_format(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    repo.close()
    other = FormatAnalyzer(**{**ANALYZER.__dict__, "format": "TOTAL_WAR"})

    with pytest.raises(ValueError, match="TOTAL_WAR"):
        summarize_evaluation(read_evaluation(directory), other)


def test_export_files_trace_back_to_cases_trials_and_environment(tmp_path):
    directory, repo = make_evaluation(tmp_path, maxRetries=0)
    with repo:
        run_evaluation(
            repo, FakeEvaluationServer(complete_limit=3, script=["ok", "lost"]), sleep=no_sleep
        )
        results = repo.results()
    snapshot = read_evaluation(directory)
    out = tmp_path / "out"
    export_evaluation(snapshot, ANALYZER, out)

    lines = [json.loads(line) for line in (out / "trials.jsonl").read_text().splitlines()]
    assert [(r["caseId"], r["runIndex"]) for r in lines] == [
        (r.case_id, r.run_index) for r in results
    ]
    assert all(r["exportFormatVersion"] == EXPORT_FORMAT_VERSION for r in lines)
    assert [r["observation"] for r in lines] == [r.observation for r in results]
    assert {r["engineRevision"] for r in lines} == {"eng-1"}

    rows = list(csv.DictReader(io.StringIO((out / "trials.csv").read_text())))
    assert [(r["case_id"], int(r["run_index"])) for r in rows] == [
        (r["caseId"], r["runIndex"]) for r in lines
    ]
    assert [r["trial_key"] for r in rows] == [r["trialKey"] for r in lines]
    assert {r["outcome"] for r in rows} <= {"ALLY_WIN", "ALLY_LOSE"}
    # 観測値に無い値は空欄。0や敗北へ読み替えない。
    assert {r["missing"] for r in rows} == {""}

    cases = json.loads((out / "cases.json").read_text())
    by_case = {c["caseId"]: c for c in cases["cases"]}
    assert {r["match_fingerprint"] for r in rows} == {by_case["a"]["matchFingerprint"]}
    assert by_case["a"]["matchRequest"]["turnLimit"] == 5
    assert by_case["a"]["pendingRunIndices"] == [3]
    assert by_case["b"]["completedRunIndices"] == []
    assert by_case["b"]["pendingRunIndices"] == [0, 1]

    summary = json.loads((out / "summary.json").read_text())
    assert summary["exportFormatVersion"] == EXPORT_FORMAT_VERSION
    assert summary["source"]["evaluationId"] == "e1"
    assert [c["name"] for c in summary["files"]["trials.csv"]["columns"]][-2:] == [
        "outcome",
        "missing",
    ]
    assert summary["summary"]["cases"][1]["statistics"] is None


def test_export_is_regenerated_byte_for_byte_from_the_same_db(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    with repo:
        run_evaluation(repo, FakeEvaluationServer(), sleep=no_sleep)
    first, second = tmp_path / "1", tmp_path / "2"
    export_evaluation(read_evaluation(directory), ANALYZER, first)
    export_evaluation(read_evaluation(directory), ANALYZER, second)

    for name in ("trials.jsonl", "trials.csv", "summary.json", "cases.json"):
        assert (first / name).read_bytes() == (second / name).read_bytes(), name


def test_export_with_no_completed_trials_keeps_counts_and_empty_tables(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    repo.close()
    out = tmp_path / "out"
    export_evaluation(read_evaluation(directory), ANALYZER, out)

    assert (out / "trials.jsonl").read_text() == ""
    assert (out / "trials.csv").read_text().splitlines()[0].startswith("evaluation_id,case_id")
    assert len((out / "trials.csv").read_text().splitlines()) == 1
    summary = json.loads((out / "summary.json").read_text())
    assert summary["source"]["environment"] is None
    assert summary["summary"]["counters"]["pendingTrials"] == 6
    assert [c["statistics"] for c in summary["summary"]["cases"]] == [None, None]


def test_reading_a_missing_evaluation_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        read_evaluation(tmp_path / "nothing")


class WriteBetweenReads:
    """読み出しの途中（件数を読んだ直後）に、別の接続で評価を進める。

    読み出し全体が1つの読み取りトランザクションなら、別接続のコミットは待たされ
    （待ち時間0なので失敗し）、写しは1時点の値だけを持つ。
    """

    def __init__(self, repo, path):
        self._repo = repo
        self._path = path
        self.write_error = None

    def __getattr__(self, name):
        return getattr(self._repo, name)

    def counters(self):
        counters = self._repo.counters()
        from mlgg_lab_common.storage.sqlite import SqliteEvaluationRepository

        other = SqliteEvaluationRepository.open(self._path)
        other._db.execute("PRAGMA busy_timeout = 0")
        try:
            run_evaluation(other, FakeEvaluationServer(), sleep=no_sleep)
        except sqlite3.OperationalError as error:
            self.write_error = error
        finally:
            other.close()
        return counters


def test_a_snapshot_reads_one_point_in_time_even_while_another_process_writes(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    with repo:
        hooked = WriteBetweenReads(repo, directory / "evaluation.sqlite3")
        snapshot = load_snapshot(hooked)

    # 読み出しの途中では別接続はコミットできない（待ち時間0なので即座に失敗する）。
    assert "locked" in str(hooked.write_error)
    assert snapshot.counters.completed_trials == len(snapshot.results)
    assert (snapshot.environment is None) == (len(snapshot.results) == 0)
    summary = summarize_evaluation(snapshot, ANALYZER)
    assert summary["counters"]["completedTrials"] == sum(c["sampleSize"] for c in summary["cases"])


def test_a_running_evaluation_is_shown_as_running_not_interrupted(tmp_path):
    directory, repo = make_evaluation(tmp_path)
    seen = []
    with repo:
        run_evaluation(
            repo,
            FakeEvaluationServer(),
            sleep=no_sleep,
            max_requests=1,
            on_progress=lambda _: seen.append(evaluation_status(read_evaluation(directory))),
        )

    assert seen and seen[0]["lastSession"]["stopReason"] == "RUNNING"
    assert seen[0]["running"] is True
    after = evaluation_status(read_evaluation(directory))
    assert after["running"] is False
    assert after["lastSession"]["stopReason"] == "COMPLETED"


def test_a_second_run_of_the_same_evaluation_is_refused_while_one_is_running(tmp_path):
    from mlgg_lab_common.evaluation.runner import EvaluationBusyError
    from mlgg_lab_common.storage.layout import open_evaluation

    directory, repo = make_evaluation(tmp_path)
    refused = []

    def try_second_run(_):
        with open_evaluation(directory) as other:
            try:
                run_evaluation(other, FakeEvaluationServer(), sleep=no_sleep)
            except EvaluationBusyError as error:
                refused.append(error)

    with repo:
        report = run_evaluation(
            repo, FakeEvaluationServer(), sleep=no_sleep, on_progress=try_second_run
        )

    assert report.stop_reason is StopReason.COMPLETED
    assert refused
    # 二重に走らなかった: 送信は計画どおり1回分だけ。
    assert report.counters.submitted_runs == 6
