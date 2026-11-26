"""評価実行のDBを読み出した不変の写し。

読み出しはDBだけで完結し、評価APIへ接続しない。元の編成YAML・育成JSONも読まない
（計画が解決済み入力と送信内容を持つ）。

評価の実行中に別プロセスから読んでも、写しは1時点の値だけを持つ（読み出し全体を
1つの読み取りトランザクションで行う）。件数・結果・実行環境が食い違わない。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..api.contracts import ExecutionEnvironment
from ..evaluation.budget import Counters
from ..evaluation.identity import trial_key
from ..evaluation.models import EvaluationPlan, PlannedCase
from ..storage.layout import DB_FILE, open_evaluation
from ..storage.migrations import STORAGE_FORMAT_VERSION
from ..storage.repository import (
    AttemptRecord,
    EvaluationRepository,
    SessionRecord,
    StoredResult,
)


@dataclass(frozen=True)
class EvaluationSnapshot:
    plan: EvaluationPlan
    environment: ExecutionEnvironment | None
    counters: Counters
    # 計画のケース順、ケース内は試行番号の昇順。
    results: tuple[StoredResult, ...]
    attempts: tuple[AttemptRecord, ...]
    sessions: tuple[SessionRecord, ...]
    # 読んだ時点で別の実行がこの評価を実行していたか。判定できなければ `None`。
    running: bool | None = None
    storage_format_version: int = STORAGE_FORMAT_VERSION

    def results_of(self, case_id: str) -> list[StoredResult]:
        return [result for result in self.results if result.case_id == case_id]

    def pending_run_indices(self, case: PlannedCase) -> list[int]:
        done = {result.run_index for result in self.results_of(case.case_id)}
        return [index for index in sorted(case.run_indices) if index not in done]

    def trial_key_of(self, result: StoredResult) -> str:
        case = self.case(result.case_id)
        return trial_key(case.match_fingerprint, self.plan.seed, result.run_index)

    def case(self, case_id: str) -> PlannedCase:
        for case in self.plan.cases:
            if case.case_id == case_id:
                return case
        raise KeyError(case_id)

    def select_cases(self, case_ids: list[str] | None) -> list[PlannedCase]:
        """指定したケース（計画の順）。未知のIDは `KeyError` でまとめて報告する。"""
        if not case_ids:
            return list(self.plan.cases)
        known = {case.case_id for case in self.plan.cases}
        unknown = [case_id for case_id in case_ids if case_id not in known]
        if unknown:
            raise KeyError(f"計画に無いケース: {', '.join(unknown)}（あるのは {', '.join(known)}）")
        wanted = set(case_ids)
        return [case for case in self.plan.cases if case.case_id in wanted]


def load_snapshot(repository: EvaluationRepository) -> EvaluationSnapshot:
    with repository.read_transaction():
        plan = repository.load_plan()
        environment = repository.environment()
        counters = repository.counters()
        results = tuple(repository.results())
        attempts = tuple(repository.attempts())
        sessions = tuple(repository.sessions())
        # 実行中かどうかも同じトランザクションの中で見る。実行側は停止理由をコミットしてから
        # ロックを外すので、読み取り中はその停止を挟めず、「停止理由なし・ロックなし」を
        # 実行中の評価について見ることはない。
        running = repository.is_running()
    return EvaluationSnapshot(
        plan=plan,
        environment=environment,
        counters=counters,
        results=results,
        attempts=attempts,
        sessions=sessions,
        running=running,
    )


def resolve_evaluation_dir(path: Path) -> Path:
    """評価実行のディレクトリ。DBファイルそのものを渡されてもよい。"""
    resolved = path.expanduser().resolve()
    if resolved.is_file() and resolved.name == DB_FILE:
        return resolved.parent
    if not (resolved / DB_FILE).is_file():
        raise FileNotFoundError(f"{path}: 評価実行のディレクトリではない（{DB_FILE} が無い）")
    return resolved


def read_evaluation(path: Path) -> EvaluationSnapshot:
    with open_evaluation(resolve_evaluation_dir(path)) as repository:
        return load_snapshot(repository)
