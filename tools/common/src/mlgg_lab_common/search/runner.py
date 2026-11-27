"""探索の実行制御（形式・手法に依らない）。

    探索問題
      → 手法が候補を提案（検証して登録・不正は記録して弾く）
      → 手法が候補と試行を要求（番号を割り当て・予算を確認）
      → 段階2の評価計画を新しく作って実行・保存（ラウンド）
      → 観測を候補・要求へ対応づけて推定し、手法へ返す
      → 手法の状態を保存して次のステップへ

1ステップ = 提案と配分を1回ずつ。評価するステップは1つのラウンド（= 段階2の評価実行1つ）を
作る。ラウンドの評価計画は後から書き換えず、追加の試行は次のラウンドの新しい計画になる。

止まる理由（`SearchStopReason`）:

- `METHOD_FINISHED`: 配分が終了を返した
- `METHOD_IDLE`: 配分が要求も終了も返さなかった（同じ状態で呼び続けない）
- `BUDGET_EXHAUSTED`: 探索全体の送信予算が尽きた・要求が残りを超えた（送信しない）
- `STEP_LIMIT_REACHED`: この実行の `max_steps` に達した
- `INTERRUPTED`: `should_stop()` が真を返した（外部からの中断）
- `EVALUATION_STOPPED`: 評価が完了せずに止まった。ラウンドは開いたまま残り、再開で続きを実行する
- `INVALID_REQUEST`: 未登録の候補・使用済みの試行番号などを要求した（送信しない）

どこで止まっても、確定済みのステップ・閉じたラウンドと手法の状態はDBに残る。再開は同じ関数を
もう一度呼ぶだけでよく、開いたラウンドがあれば先にその評価を続ける。閉じたラウンドの観測は
ラウンドごとに1回だけ手法へ渡り、予算は段階2が数えた送信試行数（再送込み）で数える。

収束判定・候補の採否・打ち切りの方針は持たない（手法の責務）。
"""

from __future__ import annotations

import json
import random
import shutil
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ..api.client import EvaluationTransport
from ..api.contracts import MAX_RUN_INDEX, ExecutionEnvironment
from ..evaluation.models import Budget, ExecutionSettings
from ..evaluation.plan import CaseSpec, create_plan
from ..evaluation.runner import StopReason, run_evaluation
from ..experiments.search_store import (
    ClosedRequest,
    NewRequest,
    SqliteSearchStore,
    StoredRequest,
)
from ..storage.layout import create_evaluation, open_evaluation, write_manifest
from ..storage.sqlite import SqliteEvaluationRepository
from .adapter import FormatSearchAdapter
from .candidate import Candidate, Origin, candidate_id, materialize
from .constraints import check_candidate
from .method import Allocation, IncompatibleMethodError, Proposal, SearchMethod
from .problem import SearchProblem
from .view import (
    BudgetView,
    CandidateEntry,
    Observation,
    Rejection,
    RequestOutcome,
    RoundFeedback,
    RoundSummary,
    SearchView,
)

# 乱数を受け取る部品。評価情報の推定は乱数を使わない（観測だけから決まる）。
_RNG_ROLES = ("proposer", "allocator")


class SearchStopReason(StrEnum):
    METHOD_FINISHED = "METHOD_FINISHED"
    METHOD_IDLE = "METHOD_IDLE"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    STEP_LIMIT_REACHED = "STEP_LIMIT_REACHED"
    INTERRUPTED = "INTERRUPTED"
    EVALUATION_STOPPED = "EVALUATION_STOPPED"
    INVALID_REQUEST = "INVALID_REQUEST"


@dataclass(frozen=True)
class SearchReport:
    stop_reason: SearchStopReason
    detail: str | None
    # この実行で進めたステップ数・閉じたラウンド数。
    steps: int
    rounds_closed: int
    budget: BudgetView
    # `EVALUATION_STOPPED` / `BUDGET_EXHAUSTED` で評価が止まったときの段階2の停止理由。
    evaluation_stop_reason: str | None = None


def round_evaluation_id(round_number: int) -> str:
    return f"round-{round_number:05d}"


def run_search(
    store: SqliteSearchStore,
    method: SearchMethod,
    adapter: FormatSearchAdapter,
    transport: EvaluationTransport,
    *,
    max_steps: int | None = None,
    should_stop: Callable[[], bool] | None = None,
    close_open_round: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    submission: tuple[str, str] | None = None,
    max_runs_per_request: int | None = None,
    max_requests: int | None = None,
) -> SearchReport:
    """探索を実行・再開する。

    `close_open_round=True` は、前回止まったラウンドの評価を続けずに、その時点の部分結果
    （完了分の観測と未完了の番号）で閉じて手法へ返す。評価が続けられない（入力不正・予算切れ等）
    ラウンドを先へ進めるときに使う。未完了の番号は結果にならず、同じ候補では再利用しない。
    """
    with store.exclusive_run():
        return _SearchRun(
            store, method, adapter, transport, sleep, max_runs_per_request, max_requests
        ).run(
            max_steps=max_steps,
            should_stop=should_stop,
            close_open_round=close_open_round,
            submission=submission,
        )


@dataclass
class _CandidateState:
    candidate: Candidate
    origins: list[Origin] = field(default_factory=list)
    requested: dict[str, set[int]] = field(default_factory=dict)
    observations: list[Observation] = field(default_factory=list)
    incomplete: dict[str, list[int]] = field(default_factory=dict)
    estimate: dict[str, Any] | None = None


class _SearchRun:
    def __init__(
        self,
        store: SqliteSearchStore,
        method: SearchMethod,
        adapter: FormatSearchAdapter,
        transport: EvaluationTransport,
        sleep: Callable[[float], None],
        max_runs_per_request: int | None,
        max_requests: int | None,
    ) -> None:
        self.store = store
        self.method = method
        self.adapter = adapter
        self.transport = transport
        self.sleep = sleep
        self.max_runs_per_request = max_runs_per_request
        self.max_requests = max_requests
        self.problem: SearchProblem = store.load_problem()
        if adapter.format != self.problem.format:
            raise IncompatibleMethodError(
                f"アダプターの形式 {adapter.format} は探索の形式 {self.problem.format} と違う"
            )
        method.check_binding(self.problem.method)
        seed = self.problem.execution.candidate_seed
        self.rngs = {role: random.Random(f"{seed}/{role}") for role in _RNG_ROLES}
        self.step = 0
        self._restore_states()

        self._environment: ExecutionEnvironment | None = None
        self.candidates: dict[str, _CandidateState] = {}
        self.start_ids: list[str] = []
        self.rejections: list[Rejection] = []
        self.rounds = store.rounds()
        self._load_history()

    # -- 復元 ------------------------------------------------------------------

    def _restore_states(self) -> None:
        checkpoint = self.store.latest_checkpoint()
        if checkpoint is None:
            return
        for role, component in self.method.components().items():
            saved = checkpoint.states.get(role)
            if saved is None:
                raise IncompatibleMethodError(f"{role}: 保存済みの状態が無い")
            descriptor = component.descriptor
            if (saved["componentId"], saved["version"]) != (
                descriptor.component_id,
                descriptor.version,
            ):
                raise IncompatibleMethodError(
                    f"{role}: 保存済みの状態は {saved['componentId']}@{saved['version']} のもの"
                )
            if saved["stateVersion"] != component.state_version:
                raise IncompatibleMethodError(
                    f"{role}: 状態の版 {saved['stateVersion']} は接続した部品の版"
                    f" {component.state_version} と違う（読み替えない）"
                )
            component.load_state(saved["state"])
            if role in self.rngs:
                version, internal, gauss = saved["rng"]
                self.rngs[role].setstate((version, tuple(internal), gauss))
        self.step = checkpoint.step

    def _load_history(self) -> None:
        for proposal in self.store.proposals():
            if proposal.accepted:
                state = self.candidates.setdefault(
                    proposal.candidate_id, _CandidateState(proposal.candidate)
                )
                state.origins.append(proposal.origin)
                if proposal.origin.kind == "START" and proposal.candidate_id not in self.start_ids:
                    self.start_ids.append(proposal.candidate_id)
            else:
                self.rejections.append(
                    Rejection(
                        proposal.step,
                        proposal.candidate_id,
                        proposal.candidate,
                        proposal.origin,
                        proposal.problems,
                    )
                )
        requests_by_round: dict[int, list[StoredRequest]] = {}
        seeds = {r.round_number: r.seed or self.problem.execution.battle_seed for r in self.rounds}
        for request in self.store.requests():
            requests_by_round.setdefault(request.round_number, []).append(request)
            self.candidates[request.candidate_id].requested.setdefault(
                seeds[request.round_number], set()
            ).update(request.run_indices)
        for stored_round in self.rounds:
            if stored_round.status != "CLOSED":
                continue
            with self._open_round_repository(stored_round.evaluation_id) as repo:
                results = _results_by_case(repo)
            for request in requests_by_round.get(stored_round.round_number, []):
                completed = request.completed or ()
                state = self.candidates[request.candidate_id]
                state.observations.extend(
                    self._observation(
                        stored_round.round_number,
                        stored_round.evaluation_id,
                        request,
                        index,
                        results[(request.case_id, index)],
                        seeds[stored_round.round_number],
                    )
                    for index in completed
                )
                state.incomplete.setdefault(seeds[stored_round.round_number], []).extend(
                    request.incomplete or ()
                )
        for _round, estimated_id, estimate in self.store.estimates():
            self.candidates[estimated_id].estimate = estimate

    def _observation(
        self,
        round_number: int,
        evaluation_id: str,
        request: StoredRequest,
        run_index: int,
        observation: Mapping[str, Any],
        seed: str,
    ) -> Observation:
        return Observation(
            candidate_id=request.candidate_id,
            run_index=run_index,
            observation=observation,
            round_number=round_number,
            evaluation_id=evaluation_id,
            case_id=request.case_id,
            seed=seed,
        )

    def _open_round_repository(self, evaluation_id: str) -> SqliteEvaluationRepository:
        return open_evaluation(self.store.evaluations_dir / evaluation_id)

    # -- 実行 ------------------------------------------------------------------

    def run(
        self,
        *,
        max_steps: int | None,
        should_stop: Callable[[], bool] | None,
        close_open_round: bool,
        submission: tuple[str, str] | None,
    ) -> SearchReport:
        session = self.store.start_session()
        steps = 0
        closed = 0

        def stop(
            reason: SearchStopReason, detail: str | None = None, evaluation: str | None = None
        ) -> SearchReport:
            self.store.finish_session(session, reason.value, detail)
            return SearchReport(reason, detail, steps, closed, self._budget(), evaluation)

        open_round = next((r for r in self.rounds if r.status == "OPEN"), None)
        if submission is not None:
            identifier, digest = submission
            previous = next((r for r in self.rounds if r.submission_id == identifier), None)
            if previous is not None:
                if previous.submission_digest != digest:
                    return stop(
                        SearchStopReason.INVALID_REQUEST, f"{identifier}: 同じ指示IDに異なる内容"
                    )
                if previous.status == "CLOSED":
                    return stop(
                        SearchStopReason.STEP_LIMIT_REACHED, f"{previous.evaluation_id}: 実行済み"
                    )
                max_steps = 0
            elif open_round is not None:
                return stop(
                    SearchStopReason.INVALID_REQUEST,
                    f"{open_round.evaluation_id}: 先に resume する",
                )
        if open_round is not None:
            # 停止要求があれば、開いたラウンドの評価を続けない（送信・予算消費を進めない）。
            if should_stop is not None and should_stop():
                return stop(
                    SearchStopReason.INTERRUPTED, "外部から中断した（開いたラウンドは未完了のまま）"
                )
            if close_open_round:
                with self._open_round_repository(open_round.evaluation_id) as repo:
                    sessions = repo.sessions()
                    # 段階2の最後の実行の停止理由。理由が無いのはプロセスごと止まった実行。
                    reason = (
                        (sessions[-1].stop_reason or "INTERRUPTED") if sessions else "NOT_STARTED"
                    )
                    self._close_round(
                        open_round.round_number, open_round.evaluation_id, repo, reason
                    )
            else:
                report = self._evaluate_round(open_round.round_number, open_round.evaluation_id)
                if report is not None:
                    return stop(*report)
            closed += 1

        while True:
            if should_stop is not None and should_stop():
                return stop(SearchStopReason.INTERRUPTED, "外部から中断した")
            if max_steps is not None and steps >= max_steps:
                return stop(
                    SearchStopReason.STEP_LIMIT_REACHED, f"この実行のステップ数上限 {max_steps}"
                )
            budget = self._budget()
            if budget.remaining == 0:
                return stop(
                    SearchStopReason.BUDGET_EXHAUSTED,
                    f"探索全体の送信予算 {budget.total} 試行を使い切った",
                )

            self.step += 1
            steps += 1
            proposals = list(self.method.proposer.propose(self._view(), self.rngs["proposer"]))
            recorded = self._register(proposals)
            allocation = self.method.allocator.allocate(self._view(), self.rngs["allocator"])

            if allocation.finish:
                self.store.commit_step(self.step, recorded, self._states())
                if allocation.requests:
                    return stop(SearchStopReason.INVALID_REQUEST, "終了と同時に試行を要求している")
                return stop(SearchStopReason.METHOD_FINISHED, allocation.detail)
            if not allocation.requests:
                self.store.commit_step(self.step, recorded, self._states())
                return stop(
                    SearchStopReason.METHOD_IDLE,
                    allocation.detail or "試行の要求も終了も返さなかった",
                )
            seed = (
                allocation.seed
                if allocation.seed is not None
                else self.problem.execution.battle_seed
            )
            if not seed.strip() or allocation.reserve_runs < 0:
                self.store.commit_step(self.step, recorded, self._states())
                return stop(SearchStopReason.INVALID_REQUEST, "seed または予約試行数が不正")
            available = max(0, budget.remaining - allocation.reserve_runs)
            wanted = sum(
                request.runs or len(request.run_indices or ()) for request in allocation.requests
            )
            if wanted > available:
                self.store.commit_step(self.step, recorded, self._states())
                scope = "一次探索の" if allocation.reserve_runs else "探索全体の"
                return stop(
                    SearchStopReason.BUDGET_EXHAUSTED,
                    f"要求した {wanted} 試行が{scope}残り予算 {available} を超える"
                    "（送信していない）",
                )
            requests, problems = self._assign(allocation, seed)
            if problems:
                self.store.commit_step(self.step, recorded, self._states())
                return stop(SearchStopReason.INVALID_REQUEST, "; ".join(problems))
            round_number = max((r.round_number for r in self.rounds), default=0) + 1
            evaluation_id = round_evaluation_id(round_number)
            self._create_round_evaluation(evaluation_id, requests, available, seed)
            self.store.commit_step(
                self.step,
                recorded,
                self._states(),
                round_number=round_number,
                evaluation_id=evaluation_id,
                requests=requests,
                seed=seed,
                submission=submission,
            )
            for request in requests:
                self.candidates[request.candidate_id].requested.setdefault(seed, set()).update(
                    request.run_indices
                )
            self.rounds = self.store.rounds()

            report = self._evaluate_round(round_number, evaluation_id)
            if report is not None:
                return stop(*report)
            closed += 1

    def _evaluate_round(
        self, round_number: int, evaluation_id: str
    ) -> tuple[SearchStopReason, str | None, str] | None:
        """ラウンドの評価を（続きから）実行し、完了したら閉じる。止まったら停止理由を返す。"""
        with self._open_round_repository(evaluation_id) as repo:
            try:
                report = run_evaluation(
                    repo,
                    self.transport,
                    sleep=self.sleep,
                    max_requests=self.max_requests,
                    max_runs_per_request=self.max_runs_per_request,
                    shrink_on_partial=self.max_runs_per_request is not None,
                )
            finally:
                write_manifest(self.store.evaluations_dir / evaluation_id, repo)
            if report.stop_reason is not StopReason.COMPLETED:
                reason = (
                    SearchStopReason.BUDGET_EXHAUSTED
                    if report.stop_reason is StopReason.BUDGET_EXHAUSTED
                    else SearchStopReason.EVALUATION_STOPPED
                )
                detail = (
                    f"ラウンド {round_number}（{evaluation_id}）の評価が"
                    f" {report.stop_reason.value} で止まった: {report.detail}"
                )
                return reason, detail, report.stop_reason.value
            mismatch = self._environment_mismatch(repo)
            if mismatch:
                return (
                    SearchStopReason.EVALUATION_STOPPED,
                    f"ラウンド {round_number}（{evaluation_id}）の実行環境が探索の実行環境と違う: "
                    + "; ".join(mismatch),
                    "ENVIRONMENT_MISMATCH",
                )
            self._close_round(round_number, evaluation_id, repo, report.stop_reason.value)
        return None

    def _pinned_environment(self) -> ExecutionEnvironment | None:
        """探索で最初に確定した実行環境（最も若いラウンドの評価実行が確定した環境）。

        ラウンドごとの評価実行は環境を独立に確定するので、ここで探索全体の基準を1つに決め、
        後続ラウンドの期待revisionと、ラウンドを閉じるときの照合に使う。
        """
        if self._environment is None:
            for stored_round in self.rounds:
                with self._open_round_repository(stored_round.evaluation_id) as repo:
                    environment = repo.environment()
                if environment is not None:
                    self._environment = environment
                    break
        return self._environment

    def _environment_mismatch(self, repo: SqliteEvaluationRepository) -> list[str]:
        environment, pinned = repo.environment(), self._pinned_environment()
        if environment is None or pinned is None:
            return []
        return pinned.differences(environment)

    def _close_round(
        self,
        round_number: int,
        evaluation_id: str,
        repo: SqliteEvaluationRepository,
        evaluation_stop_reason: str,
    ) -> None:
        results = _results_by_case(repo)
        if self._environment_mismatch(repo):
            # 違う実行環境の結果は同じ条件の標本として混ぜない。観測にせず未完了として閉じる。
            results = {}
            evaluation_stop_reason = "ENVIRONMENT_MISMATCH"
        requests = [r for r in self.store.requests() if r.round_number == round_number]
        seed = repo.load_plan().seed
        outcomes: list[RequestOutcome] = []
        closed: list[ClosedRequest] = []
        for request in requests:
            observations = tuple(
                self._observation(
                    round_number,
                    evaluation_id,
                    request,
                    index,
                    results[(request.case_id, index)],
                    seed,
                )
                for index in request.run_indices
                if (request.case_id, index) in results
            )
            completed = tuple(o.run_index for o in observations)
            incomplete = tuple(i for i in request.run_indices if i not in set(completed))
            state = self.candidates[request.candidate_id]
            state.observations.extend(observations)
            state.incomplete.setdefault(seed, []).extend(incomplete)
            outcomes.append(
                RequestOutcome(
                    request_number=request.request_number,
                    candidate_id=request.candidate_id,
                    case_id=request.case_id,
                    tag=request.tag,
                    run_indices=request.run_indices,
                    observations=observations,
                    incomplete_run_indices=incomplete,
                )
            )
            closed.append(ClosedRequest(request.request_number, completed, incomplete))

        estimates: dict[str, dict[str, Any]] = {}
        for touched in dict.fromkeys(r.candidate_id for r in requests):
            estimate = self.method.estimator.estimate(self._entry(touched))
            if not isinstance(estimate, dict):
                raise TypeError(f"評価情報はJSONオブジェクト（dict）で返す: {type(estimate)!r}")
            _require_json(estimate, f"{touched} の評価情報")
            self.candidates[touched].estimate = estimate
            estimates[touched] = estimate

        feedback = RoundFeedback(
            round_number=round_number,
            evaluation_id=evaluation_id,
            evaluation_stop_reason=evaluation_stop_reason,
            outcomes=tuple(outcomes),
            estimates=estimates,
        )
        for component in self.method.components().values():
            component.observe(feedback)
        self.store.close_round(
            round_number,
            step=self.step,
            evaluation_stop_reason=evaluation_stop_reason,
            submitted_runs=repo.counters().submitted_runs,
            outcomes=closed,
            estimates=estimates,
            states=self._states(),
        )
        self.rounds = self.store.rounds()

    def _create_round_evaluation(
        self, evaluation_id: str, requests: list[NewRequest], remaining: int, seed: str
    ) -> None:
        cases = [
            CaseSpec(
                request.case_id,
                self.adapter.build_input(
                    self.problem,
                    materialize(self.problem, self.candidates[request.candidate_id].candidate),
                ),
                request.run_indices,
            )
            for request in requests
        ]
        plan = create_plan(
            self.problem.format,
            cases,
            seed=seed,
            # 探索全体の残りをこのラウンドの送信予算にする。段階2が再送込みで数えて守るので、
            # ラウンドを順に重ねても探索全体の上限を超えない。
            budget=Budget(maxSubmittedRuns=remaining),
            settings=self._round_settings(),
            evaluation_id=evaluation_id,
        )
        directory = self.store.evaluations_dir / evaluation_id
        if directory.exists():
            # ラウンドを確定する前に止まった実行の残骸。ラウンドに載っていないので1件も
            # 送っていない（送信はラウンドの確定後）。作り直す。
            with open_evaluation(directory) as orphan:
                if orphan.counters().submitted_runs != 0:  # pragma: no cover - 防御
                    raise RuntimeError(f"{directory}: 送信済みの評価実行を作り直さない")
            shutil.rmtree(directory)
        _, repo = create_evaluation(self.store.evaluations_dir, plan)
        repo.close()

    def _round_settings(self) -> ExecutionSettings:
        """新しいラウンドの実行設定。探索の実行環境が確定していれば期待revisionとして引き継ぐ。

        段階2は期待revisionがあれば初回の応答から照合し、違う環境の結果を保存せずに止まる。
        """
        settings = self.problem.execution.api
        pinned = self._pinned_environment()
        if pinned is None:
            return settings
        return settings.model_copy(
            update={
                "expected_catalog_revision": pinned.catalog_revision,
                "expected_engine_revision": pinned.engine_revision,
            }
        )

    # -- 提案・要求の検証 ---------------------------------------------------------

    def _register(
        self, proposals: list[Proposal]
    ) -> list[tuple[str, Candidate, Origin, tuple[str, ...]]]:
        recorded: list[tuple[str, Candidate, Origin, tuple[str, ...]]] = []
        for proposal in proposals:
            cid = candidate_id(proposal.candidate)
            problems = tuple(check_candidate(self.problem, self.adapter, proposal.candidate))
            recorded.append((cid, proposal.candidate, proposal.origin, problems))
            if problems:
                self.rejections.append(
                    Rejection(self.step, cid, proposal.candidate, proposal.origin, problems)
                )
                continue
            state = self.candidates.setdefault(cid, _CandidateState(proposal.candidate))
            state.origins.append(proposal.origin)
        return recorded

    def _assign(self, allocation: Allocation, seed: str) -> tuple[list[NewRequest], list[str]]:
        problems: list[str] = []
        requests: list[NewRequest] = []
        used = {cid: set(state.requested.get(seed, ())) for cid, state in self.candidates.items()}
        for number, request in enumerate(allocation.requests, start=1):
            where = f"requests[{number - 1}]"
            cid = request.candidate_id
            if cid not in self.candidates:
                problems.append(f"{where}: 登録されていない候補 {cid}")
                continue
            if (request.runs is None) == (request.run_indices is None):
                problems.append(f"{where}: runs と run_indices のどちらか一方を指定する")
                continue
            if request.runs is not None:
                if isinstance(request.runs, bool) or request.runs < 1:
                    problems.append(f"{where}: runs は1以上")
                    continue
                indices = unused_run_indices(used[cid], request.runs)
            else:
                indices = tuple(request.run_indices or ())
                bad = [
                    i
                    for i in indices
                    if isinstance(i, bool) or not isinstance(i, int) or not 0 <= i <= MAX_RUN_INDEX
                ]
                if not indices or bad:
                    problems.append(f"{where}: 試行番号が無い・範囲外 {bad}")
                    continue
                if len(set(indices)) != len(indices):
                    problems.append(f"{where}: 試行番号が重複している")
                    continue
            reused = sorted(set(indices) & used[cid])
            if reused:
                problems.append(f"{where}: {cid} で要求済みの試行番号 {reused} を使っている")
                continue
            if indices and max(indices) > MAX_RUN_INDEX:
                problems.append(f"{where}: 試行番号が上限 {MAX_RUN_INDEX} を超える")
                continue
            used[cid].update(indices)
            requests.append(
                NewRequest(
                    request_number=number,
                    candidate_id=cid,
                    case_id=f"q{number:03d}-{cid.removeprefix('c-')[:12]}",
                    tag=request.tag,
                    run_indices=indices,
                )
            )
        return requests, problems

    # -- 写し・状態 ----------------------------------------------------------------

    def _entry(self, cid: str) -> CandidateEntry:
        state = self.candidates[cid]
        seed = self.problem.execution.battle_seed
        return CandidateEntry(
            candidate_id=cid,
            candidate=state.candidate,
            origins=tuple(state.origins),
            requested_run_indices=tuple(sorted(state.requested.get(seed, ()))),
            observations=tuple(state.observations),
            incomplete_run_indices=tuple(state.incomplete.get(seed, ())),
            estimate=state.estimate,
        )

    def _view(self) -> SearchView:
        return SearchView(
            problem=self.problem,
            step=self.step,
            candidates={cid: self._entry(cid) for cid in self.candidates},
            rejections=tuple(self.rejections),
            rounds=tuple(
                RoundSummary(
                    r.round_number,
                    r.step,
                    r.evaluation_id,
                    r.status,
                    r.evaluation_stop_reason,
                    r.seed or self.problem.execution.battle_seed,
                    r.submitted_runs,
                )
                for r in self.rounds
            ),
            budget=self._budget(),
            start_candidate_ids=tuple(self.start_ids),
        )

    def _budget(self) -> BudgetView:
        used = 0
        for stored_round in self.rounds:
            if stored_round.status == "CLOSED" and stored_round.submitted_runs is not None:
                used += stored_round.submitted_runs
            else:
                with self._open_round_repository(stored_round.evaluation_id) as repo:
                    used += repo.counters().submitted_runs
        return BudgetView(total=self.problem.execution.budget.max_submitted_runs, used=used)

    def _states(self) -> dict[str, Any]:
        states: dict[str, Any] = {}
        for role, component in self.method.components().items():
            state = component.dump_state()
            _require_json(state, f"{role} の状態")
            rng = self.rngs.get(role)
            states[role] = {
                "componentId": component.descriptor.component_id,
                "version": component.descriptor.version,
                "stateVersion": component.state_version,
                "state": state,
                "rng": None if rng is None else list(rng.getstate()),
            }
        return states


def unused_run_indices(used: set[int] | frozenset[int], count: int) -> tuple[int, ...]:
    """まだ要求していない番号を小さい順に `count` 個。

    候補をまたいで同じ番号（= 同じ乱数列）で比べられるよう、空いた番号から埋める。
    """
    found: list[int] = []
    index = 0
    while len(found) < count:
        if index not in used:
            found.append(index)
        index += 1
    return tuple(found)


def _results_by_case(repo: SqliteEvaluationRepository) -> dict[tuple[str, int], dict[str, Any]]:
    return {(r.case_id, r.run_index): r.observation for r in repo.results()}


def _require_json(value: Any, where: str) -> None:
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise TypeError(f"{where} がJSONとして保存できない: {error}") from error
