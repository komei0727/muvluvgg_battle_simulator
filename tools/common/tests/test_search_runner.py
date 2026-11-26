"""探索の実行制御。テスト用の接続実装（台本どおりの提案・要求）と評価APIの偽物で確かめる。"""

import sqlite3

import pytest

from mlgg_lab_common.experiments.layout import create_search, open_search
from mlgg_lab_common.experiments.search_store import SearchStorageError, SqliteSearchStore
from mlgg_lab_common.models import Position
from mlgg_lab_common.search import operations as ops
from mlgg_lab_common.search.candidate import Candidate, CandidateUnit, Origin
from mlgg_lab_common.search.method import (
    Allocation,
    IncompatibleMethodError,
    Proposal,
    SearchMethod,
    TrialRequest,
)
from mlgg_lab_common.search.problem import SearchProblem, SearchProblemError
from mlgg_lab_common.search.runner import SearchStopReason, run_search
from mlgg_lab_common.testing import (
    FakeBattleSearchAdapter,
    FakeEvaluationServer,
    ObservedRunsEstimator,
    ScriptedAllocator,
    ScriptedProposer,
    scripted_method,
)

ADAPTER = FakeBattleSearchAdapter()
F0, F1, F2 = (Position(column=c, row="FRONT") for c in range(3))

START = Candidate(
    units=(
        CandidateUnit(unitDefinitionId="UNIT_A", position=F0),
        CandidateUnit(unitDefinitionId="UNIT_B", position=F1),
    ),
    memoryDefinitionIds=("MEM_X",),
)
NEXT = ops.replace_unit(START, 1, "UNIT_C")
ILLEGAL = ops.replace_unit(START, 1, "UNIT_OUTSIDE")
S, N, X = START.candidate_id, NEXT.candidate_id, ILLEGAL.candidate_id


def proposed(candidate, *operations, parents=(S,)):
    return Proposal(
        candidate,
        Origin(kind="PROPOSED", proposer="test", operations=operations, parents=parents),
    )


def build_problem(method: SearchMethod, *, budget=100, **api):
    return SearchProblem.model_validate(
        {
            "format": "BATTLE",
            "fixed": {
                "enemyFormation": {
                    "units": [
                        {"unitDefinitionId": "UNIT_E", "position": {"column": 1, "row": "FRONT"}}
                    ]
                },
                "turnLimit": 5,
            },
            "training": {"units": {}},
            "space": {
                "unitPool": ["UNIT_A", "UNIT_B", "UNIT_C"],
                "memoryPool": ["MEM_X"],
            },
            "starts": [START.model_dump(by_alias=True)],
            "execution": {
                "candidateSeed": "gen-1",
                "battleSeed": "battle-1",
                "budget": {"maxSubmittedRuns": budget},
                "api": {"retryBackoffSeconds": 0, **api},
            },
            "method": method.binding({"note": "台本どおり"}).model_dump(by_alias=True),
        }
    )


# 台本: 1) 次の候補と不正な候補を提案し、起点に3試行・次の候補に不連続な2試行を要求
#       2) 起点へ2試行を追加  3) 終了
PROPOSALS = [[proposed(NEXT, "replace_unit"), proposed(ILLEGAL, "replace_unit")], [], []]
ALLOCATIONS = [
    Allocation(
        requests=(
            TrialRequest(S, runs=3, tag="first"),
            TrialRequest(N, run_indices=(5, 9)),
        )
    ),
    Allocation(requests=(TrialRequest(S, runs=2, tag="more"),)),
    Allocation(finish=True, detail="台本の終わり"),
]


def new_method():
    return scripted_method(PROPOSALS, ALLOCATIONS)


def make_search(tmp_path, method=None, *, name="s", **problem_options):
    method = method or new_method()
    directory, store = create_search(
        tmp_path / "searches", build_problem(method, **problem_options), ADAPTER, search_id=name
    )
    return directory, store, method


def run(store, method, server, **options):
    return run_search(store, method, ADAPTER, server, sleep=lambda _: None, **options)


def sent_runs(server):
    return [
        (case["caseId"], index)
        for request in server.requests
        for case in request["cases"]
        for index in case["runIndices"]
    ]


def observed(method):
    """最後に見せた状況での、候補 → {試行番号: 観測値}。"""
    view = method.allocator.views[-1]
    return {
        cid: {o.run_index: o.observation for o in entry.observations}
        for cid, entry in view.candidates.items()
    }


# -- 一連の動作 --------------------------------------------------------------------


def test_scripted_search_evaluates_proposals_and_maps_results_back(tmp_path):
    server = FakeEvaluationServer()
    _, store, method = make_search(tmp_path)
    with store:
        report = run(store, method, server)

        assert report.stop_reason is SearchStopReason.METHOD_FINISHED
        assert report.detail == "台本の終わり"
        assert (report.steps, report.rounds_closed) == (3, 2)
        assert (report.budget.used, report.budget.remaining) == (7, 93)
        rounds = store.rounds()
        assert [(r.evaluation_id, r.status) for r in rounds] == [
            ("round-00001", "CLOSED"),
            ("round-00002", "CLOSED"),
        ]

    # 戦闘のseedは探索問題の battleSeed だけ。候補ID・要求IDを混ぜない。
    assert {request["seed"] for request in server.requests} == {"battle-1"}
    # 不正な候補は送らない。追加の試行は新しい番号（3, 4）を新しい評価計画で送る。
    assert [index for _, index in sent_runs(server)] == [0, 1, 2, 5, 9, 3, 4]
    assert all(case_id[5:] != X[2:14] for case_id, _ in sent_runs(server))

    final = method.allocator.views[-1]
    assert set(final.candidates) == {S, N}
    assert final.start_candidate_ids == (S,)
    assert [r.candidate_id for r in final.rejections] == [X]
    assert "UNIT_OUTSIDE は使用可能プールに無い" in final.rejections[0].problems[0]
    assert final.candidates[S].requested_run_indices == (0, 1, 2, 3, 4)
    assert final.candidates[S].estimate == {
        "sampleCount": 5,
        "runIndices": [0, 1, 2, 3, 4],
        "incompleteRunIndices": [],
    }
    assert final.candidates[N].estimate["runIndices"] == [5, 9]
    assert final.candidates[N].origins[0].operations == ("replace_unit",)

    # ラウンドの結果は要求ごと（タグ・番号）に返る。
    first = method.proposer.feedback[0]
    assert [(o.candidate_id, o.tag, o.run_indices) for o in first.outcomes] == [
        (S, "first", (0, 1, 2)),
        (N, None, (5, 9)),
    ]
    assert all(o.incomplete_run_indices == () for o in first.outcomes)
    assert first.evaluation_stop_reason == "COMPLETED"


def test_results_do_not_depend_on_how_requests_were_split_or_partially_answered(tmp_path):
    reference_server = FakeEvaluationServer()
    _, store, reference = make_search(tmp_path, name="wide")
    with store:
        run(store, reference, reference_server)

    # 細かい分割・部分応答（1要求2試行だけ完了）でも、候補と試行番号の対応は同じ。
    _, store, narrow = make_search(
        tmp_path, name="narrow", maxRunsPerRequest=2, maxCasesPerRequest=1
    )
    with store:
        report = run(store, narrow, FakeEvaluationServer(complete_limit=1))
        assert report.stop_reason is SearchStopReason.METHOD_FINISHED

    assert observed(narrow) == observed(reference)


# -- 中断・再開 ----------------------------------------------------------------------


def test_resume_after_an_interrupted_evaluation_keeps_history_state_and_budget_consistent(
    tmp_path,
):
    reference_server = FakeEvaluationServer()
    _, store, reference = make_search(tmp_path, name="ref")
    with store:
        run(store, reference, reference_server)

    directory, store, first = make_search(tmp_path, name="cut", maxRunsPerRequest=2)
    # 1ラウンド目の2つ目の要求の後でプロセスが落ちる。
    with store, pytest.raises(KeyboardInterrupt):
        run(store, first, FakeEvaluationServer(script=["ok", "interrupt"]))
    assert first.allocator.position == 1

    resumed = new_method()
    server = FakeEvaluationServer()
    with open_search(directory) as reopened:
        report = run(reopened, resumed, server)

        assert report.stop_reason is SearchStopReason.METHOD_FINISHED
        # 中断した要求の分（実行済みかもしれない）も送信数へ数える。
        assert report.budget.used == 7 + 2
        assert [s.stop_reason for s in reopened.sessions()] == [None, "METHOD_FINISHED"]

    # 再開した手法は、保存した状態（台本の位置・乱数）から続く。同じステップを繰り返さない。
    assert resumed.allocator.position == 3
    assert len(resumed.allocator.views) == 2
    assert resumed.proposer.rng_draws == reference.proposer.rng_draws[1:]
    # 再開後は完了済みの試行を送らない。観測は候補ごとに1回ずつ。
    assert ("q001-" + S[2:14], 0) not in sent_runs(server)
    assert observed(resumed) == observed(reference)
    # 中断したラウンドの推定は再開後に1回だけ作る。
    assert resumed.estimator.calls == [S, N, S]
    assert [f.round_number for f in resumed.proposer.feedback] == [1, 2]


def test_external_stop_and_step_limit_resume_without_repeating_steps(tmp_path):
    directory, store, method = make_search(tmp_path)
    with store:
        report = run(store, method, FakeEvaluationServer(), max_steps=1)
        assert report.stop_reason is SearchStopReason.STEP_LIMIT_REACHED
        assert report.rounds_closed == 1

    second = new_method()
    with open_search(directory) as store:
        report = run(store, second, FakeEvaluationServer(), should_stop=lambda: True)
        assert report.stop_reason is SearchStopReason.INTERRUPTED
        assert report.steps == 0

    third = new_method()
    server = FakeEvaluationServer()
    with open_search(directory) as store:
        report = run(store, third, server)
        assert report.stop_reason is SearchStopReason.METHOD_FINISHED
    assert [index for _, index in sent_runs(server)] == [3, 4]
    assert third.allocator.position == 3


def test_a_round_left_unrecorded_by_a_crash_is_rebuilt_before_sending(tmp_path, monkeypatch):
    directory, store, method = make_search(tmp_path)
    original = SqliteSearchStore.commit_step

    def crash_before_recording_round(self, step, proposals, states, **round_fields):
        if round_fields.get("round_number") is not None:
            raise RuntimeError("確定前に落ちた")
        return original(self, step, proposals, states, **round_fields)

    monkeypatch.setattr(SqliteSearchStore, "commit_step", crash_before_recording_round)
    server = FakeEvaluationServer()
    with store, pytest.raises(RuntimeError):
        run(store, method, server)
    assert server.requests == []
    assert (directory / "evaluations" / "round-00001").exists()

    monkeypatch.setattr(SqliteSearchStore, "commit_step", original)
    with open_search(directory) as reopened:
        report = run(reopened, new_method(), server)
        assert report.stop_reason is SearchStopReason.METHOD_FINISHED
        assert report.budget.used == 7


# -- 予算・失敗・不正な要求 ---------------------------------------------------------------


def test_requests_beyond_the_remaining_budget_are_not_sent(tmp_path):
    server = FakeEvaluationServer()
    _, store, method = make_search(tmp_path, budget=4)
    with store:
        report = run(store, method, server)

        assert report.stop_reason is SearchStopReason.BUDGET_EXHAUSTED
        assert "5 試行が探索全体の残り予算 4 を超える" in report.detail
        assert server.requests == []
        assert report.budget.used == 0


def test_resends_count_against_the_search_budget_and_partial_rounds_can_be_closed(tmp_path):
    # 5試行の要求が応答を失う → 再送できるのは残りの1試行だけ。
    directory, store, method = make_search(tmp_path, budget=6, maxRunsPerRequest=5)
    server = FakeEvaluationServer(script=["lost"])
    with store:
        report = run(store, method, server)
        assert report.stop_reason is SearchStopReason.BUDGET_EXHAUSTED
        assert report.evaluation_stop_reason == "BUDGET_EXHAUSTED"
        assert report.budget.used == 6

    # 続きを実行しても予算を超えて送らない。
    with open_search(directory) as reopened:
        report = run(reopened, new_method(), server)
        assert report.stop_reason is SearchStopReason.BUDGET_EXHAUSTED
    assert sum(len(c["runIndices"]) for r in server.requests for c in r["cases"]) == 6

    # 部分結果で閉じると、完了分の観測と未完了の番号が要求元へ返る（敗北・0へ変換しない）。
    closer = new_method()
    with open_search(directory) as reopened:
        report = run(reopened, closer, server, close_open_round=True)
        assert report.stop_reason is SearchStopReason.BUDGET_EXHAUSTED
        assert report.rounds_closed == 1
    feedback = closer.allocator.feedback[0]
    assert feedback.evaluation_stop_reason == "BUDGET_EXHAUSTED"
    start, following = feedback.outcomes
    assert (start.run_indices, len(start.observations), start.incomplete_run_indices) == (
        (0, 1, 2),
        1,
        (1, 2),
    )
    assert following.observations == () and following.incomplete_run_indices == (5, 9)
    assert feedback.estimates[N] == {
        "sampleCount": 0,
        "runIndices": [],
        "incompleteRunIndices": [5, 9],
    }


@pytest.mark.parametrize(
    ("script", "evaluation_reason"),
    [
        ([("status", 422, "INVALID_COMMAND", "/cases/0/turnLimit")], "INVALID_INPUT"),
        (["garbage"], "RESPONSE_INVALID"),
    ],
)
def test_evaluation_errors_stop_without_fabricating_results(tmp_path, script, evaluation_reason):
    directory, store, method = make_search(tmp_path)
    with store:
        report = run(store, method, FakeEvaluationServer(script=script))
        assert report.stop_reason is SearchStopReason.EVALUATION_STOPPED
        assert report.evaluation_stop_reason == evaluation_reason
        assert store.rounds()[0].status == "OPEN"
    assert method.proposer.feedback == []

    closer = new_method()
    with open_search(directory) as reopened:
        run(reopened, closer, FakeEvaluationServer(), close_open_round=True, max_steps=0)
    feedback = closer.proposer.feedback[0]
    assert feedback.evaluation_stop_reason == evaluation_reason
    assert all(o.observations == () for o in feedback.outcomes)
    assert feedback.estimates[S]["sampleCount"] == 0


def test_zero_completion_responses_stop_instead_of_looping(tmp_path):
    server = FakeEvaluationServer(complete_limit=0)
    _, store, method = make_search(tmp_path)
    with store:
        report = run(store, method, server)
        assert report.stop_reason is SearchStopReason.EVALUATION_STOPPED
        assert report.evaluation_stop_reason == "NO_PROGRESS_LIMIT_REACHED"
    assert len(server.requests) == 3


@pytest.mark.parametrize(
    ("request_", "message"),
    [
        (TrialRequest("c-unknown", runs=1), "登録されていない候補"),
        (TrialRequest(X, runs=1), "登録されていない候補"),
        (TrialRequest(S, runs=1, run_indices=(1,)), "どちらか一方"),
        (TrialRequest(S, runs=0), "runs は1以上"),
        (TrialRequest(S, run_indices=(1, 1)), "重複"),
    ],
)
def test_invalid_requests_are_rejected_before_sending(tmp_path, request_, message):
    method = scripted_method([[proposed(ILLEGAL)]], [Allocation(requests=(request_,))])
    server = FakeEvaluationServer()
    _, store, method = make_search(tmp_path, method)
    with store:
        report = run(store, method, server)
        assert report.stop_reason is SearchStopReason.INVALID_REQUEST
        assert message in report.detail
    assert server.requests == []


def test_run_indices_already_requested_for_a_candidate_are_not_reused(tmp_path):
    method = scripted_method(
        [],
        [
            Allocation(requests=(TrialRequest(S, run_indices=(4, 7)),)),
            Allocation(requests=(TrialRequest(S, run_indices=(7, 8)),)),
        ],
    )
    server = FakeEvaluationServer()
    _, store, method = make_search(tmp_path, method)
    with store:
        report = run(store, method, server)
        assert report.stop_reason is SearchStopReason.INVALID_REQUEST
        assert "要求済みの試行番号 [7]" in report.detail
    assert [index for _, index in sent_runs(server)] == [4, 7]


def test_a_method_that_neither_requests_nor_finishes_stops_the_search(tmp_path):
    method = scripted_method([], [Allocation(detail="様子見")])
    _, store, method = make_search(tmp_path, method)
    with store:
        report = run(store, method, FakeEvaluationServer())
        assert report.stop_reason is SearchStopReason.METHOD_IDLE
        assert report.detail == "様子見"


def test_the_same_candidate_from_several_origins_is_one_candidate_with_all_origins(tmp_path):
    again = proposed(START, "swap_positions", "swap_positions", parents=(S,))
    method = scripted_method([[again]], [Allocation(finish=True)])
    _, store, method = make_search(tmp_path, method)
    with store:
        run(store, method, FakeEvaluationServer())
    entry = method.allocator.views[0].candidates[S]
    assert [o.kind for o in entry.origins] == ["START", "PROPOSED"]


# -- 接続・保存形式の不一致 ------------------------------------------------------------


def test_a_different_method_or_state_version_is_not_loaded_silently(tmp_path):
    directory, store, method = make_search(tmp_path)
    with store:
        run(store, method, FakeEvaluationServer(), max_steps=1)

    other = SearchMethod(ScriptedProposer([]), ScriptedAllocator([]), ObservedRunsEstimator())
    other.proposer.descriptor = other.proposer.descriptor.model_copy(update={"version": "test-2"})
    with (
        open_search(directory) as reopened,
        pytest.raises(IncompatibleMethodError, match="proposer"),
    ):
        run(reopened, other, FakeEvaluationServer())

    newer_state = new_method()
    newer_state.allocator.state_version = 2
    with (
        open_search(directory) as reopened,
        pytest.raises(IncompatibleMethodError, match="状態の版"),
    ):
        run(reopened, newer_state, FakeEvaluationServer())


def test_only_search_databases_of_the_known_format_are_opened(tmp_path):
    directory, store, _ = make_search(tmp_path)
    store.close()
    db = sqlite3.connect(directory / "search.sqlite3")
    db.execute("PRAGMA user_version = 99")
    db.close()
    with pytest.raises(SearchStorageError, match="保存形式 99"):
        open_search(directory)
    evaluation_db = directory / "evaluations"
    evaluation_db.mkdir(exist_ok=True)
    with pytest.raises(SearchStorageError, match="探索のDBではない"):
        SqliteSearchStore.open(_foreign_db(tmp_path))


def _foreign_db(tmp_path):
    path = tmp_path / "other.sqlite3"
    sqlite3.connect(path).close()
    return path


def test_an_illegal_problem_is_not_saved(tmp_path):
    method = new_method()
    problem = build_problem(method).model_copy(update={"starts": [ILLEGAL]})
    with pytest.raises(SearchProblemError, match="UNIT_OUTSIDE"):
        create_search(tmp_path, problem, ADAPTER, search_id="bad")
    assert not (tmp_path / "bad").exists()


def test_runs_fill_the_smallest_unrequested_indices_of_the_candidate(tmp_path):
    method = scripted_method(
        [[proposed(NEXT)]],
        [
            Allocation(requests=(TrialRequest(S, run_indices=(4, 1)),)),
            Allocation(requests=(TrialRequest(S, runs=3), TrialRequest(N, runs=2))),
            Allocation(requests=(TrialRequest(S, runs=2),)),
        ],
    )
    server = FakeEvaluationServer()
    _, store, method = make_search(tmp_path, method)
    with store:
        run(store, method, server)
    # 候補ごとに、要求していない最小の番号から埋める（候補をまたいで同じ番号で比べられる）。
    assert [index for _, index in sent_runs(server)] == [1, 4, 0, 2, 3, 0, 1, 5, 6]
    assert method.allocator.views[-1].candidates[S].next_run_index == 7
