"""手法へ見せる探索の状況（読み取り専用の写し）。

観測値は段階2の評価実行DBにある試行オブジェクトそのもので、探索側へは複製しない。ここでは
どの候補・どの要求の結果かを対応づけて渡すだけで、勝敗・スコアへの変換はしない。
未完了・評価の失敗は観測にならず、`incomplete_run_indices` と停止理由にだけ現れる。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .candidate import Candidate, Origin
from .problem import SearchProblem


@dataclass(frozen=True)
class Observation:
    candidate_id: str
    run_index: int
    # 評価APIが返した試行オブジェクト（段階2の保存値そのもの）。
    observation: Mapping[str, Any]
    round_number: int
    evaluation_id: str
    case_id: str
    seed: str = ""


@dataclass(frozen=True)
class Rejection:
    """検証で弾いた提案。送信していない。"""

    step: int
    candidate_id: str
    candidate: Candidate
    origin: Origin
    problems: tuple[str, ...]


@dataclass(frozen=True)
class CandidateEntry:
    candidate_id: str
    candidate: Candidate
    origins: tuple[Origin, ...]
    # 要求済みの試行番号（未完了・評価中を含む）。
    requested_run_indices: tuple[int, ...]
    observations: tuple[Observation, ...]
    # 閉じたラウンドで結果が得られなかった番号。
    incomplete_run_indices: tuple[int, ...]
    # 最後に推定した評価情報（推定前は `None`）。
    estimate: Mapping[str, Any] | None

    @property
    def next_run_index(self) -> int:
        """`TrialRequest(runs=...)` が次に割り当てる番号（要求していない最小の番号）。"""
        used = set(self.requested_run_indices)
        return next(i for i in range(len(used) + 1) if i not in used)


@dataclass(frozen=True)
class RequestOutcome:
    request_number: int
    candidate_id: str
    case_id: str
    tag: str | None
    run_indices: tuple[int, ...]
    observations: tuple[Observation, ...]
    incomplete_run_indices: tuple[int, ...]


@dataclass(frozen=True)
class RoundFeedback:
    """評価の1ラウンドの結果。要求ごとに、完了した観測と未完了の番号を分けて返す。

    `evaluation_stop_reason` が `COMPLETED` 以外なら部分結果である（`run_search` に
    `close_open_round=True` を渡して閉じたラウンド）。
    """

    round_number: int
    evaluation_id: str
    evaluation_stop_reason: str
    outcomes: tuple[RequestOutcome, ...]
    estimates: Mapping[str, Mapping[str, Any]]


@dataclass(frozen=True)
class BudgetView:
    # 探索全体の送信試行数（再送込み）の上限・使用量・残り。
    total: int
    used: int

    @property
    def remaining(self) -> int:
        return max(0, self.total - self.used)


@dataclass(frozen=True)
class RoundSummary:
    round_number: int
    step: int
    evaluation_id: str
    status: str
    evaluation_stop_reason: str | None
    seed: str = ""
    submitted_runs: int | None = None


@dataclass(frozen=True)
class SearchView:
    problem: SearchProblem
    # これから行うステップの番号（1始まり）。
    step: int
    candidates: Mapping[str, CandidateEntry]
    rejections: tuple[Rejection, ...]
    rounds: tuple[RoundSummary, ...]
    budget: BudgetView
    start_candidate_ids: tuple[str, ...] = field(default=())
