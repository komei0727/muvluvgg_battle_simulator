"""手法の接続契約。

探索手法は次の3つの部品を組み合わせて接続する。どれも差し替えられ、共通基盤は中身を
解釈しない。

| 部品                  | 責務                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `CandidateProposer`   | 起点・過去の観測から候補を提案する（`propose`）                      |
| `TrialAllocator`      | どの候補に何試行を要求するか・いつ終えるかを決める（`allocate`）     |
| `ObjectiveEstimator`  | 候補の観測から用途に応じた評価情報を作る（`estimate`）               |

各部品は自分の状態を `dump_state` / `load_state` で保存・復元する。状態はJSONで、共通基盤は
識別子（`descriptor`）・状態の版（`state_version`）と一緒に保存するだけで中身を読まない。
再開時に識別子・版が違えば読み込まずに止める（`IncompatibleMethodError`）。

評価情報（`estimate` の戻り値）は1つの点推定値に限らない任意のJSONオブジェクトで、標本数・
分布・推定区間などを手法が決めて入れる。共通基盤は保存して `SearchView` で見せるだけ。
具体的なスコア計算・勝率推定・追加試行や打ち切りの判断は、ここでは実装しない。

乱数: 共通基盤は提案用・配分用に `candidateSeed` から作った `random.Random` を渡し、その状態を
チェックポイントへ保存する。部品は自前の乱数を持ってもよいが、そのときは状態に含める。
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .candidate import Candidate, Origin
from .problem import ComponentDescriptor, MethodBinding
from .view import CandidateEntry, RoundFeedback, SearchView

JsonValue = Any


class IncompatibleMethodError(Exception):
    """保存済みの探索と、接続した部品・状態の識別子や版が合わない。黙って読み込まない。"""


@dataclass(frozen=True)
class Proposal:
    candidate: Candidate
    origin: Origin


@dataclass(frozen=True)
class TrialRequest:
    """候補1つへの試行の要求。`runs`（件数）か `run_indices`（番号の列）のどちらか一方。

    `runs` はその候補でまだ要求していない最小の番号から順に割り当てる。`run_indices` は
    不連続でよいが、同じ候補で前に要求した番号は使えない（同じ試行の二重計上を防ぐ）。
    `tag` は手法が要求へ付ける任意の印で、結果とともに返る。
    """

    candidate_id: str
    runs: int | None = None
    run_indices: tuple[int, ...] | None = None
    tag: str | None = None


@dataclass(frozen=True)
class Allocation:
    """配分の決定。`finish=True` は手法の終了（要求は持てない）。

    `finish=False` で要求が空なら、共通基盤は「手法が何もしない」として止める（無限ループを
    作らない）。
    """

    requests: tuple[TrialRequest, ...] = ()
    finish: bool = False
    detail: str | None = None
    seed: str | None = None
    reserve_runs: int = 0


class MethodComponent(Protocol):
    descriptor: ComponentDescriptor
    state_version: int

    def dump_state(self) -> JsonValue: ...

    def load_state(self, state: JsonValue) -> None: ...

    def observe(self, feedback: RoundFeedback) -> None:
        """評価の1ラウンドが閉じたときに呼ばれる。何もしなくてよい。"""
        ...


class CandidateProposer(MethodComponent, Protocol):
    def propose(self, view: SearchView, rng: random.Random) -> Sequence[Proposal]: ...


class TrialAllocator(MethodComponent, Protocol):
    def allocate(self, view: SearchView, rng: random.Random) -> Allocation: ...


class ObjectiveEstimator(MethodComponent, Protocol):
    def estimate(self, entry: CandidateEntry) -> dict[str, JsonValue]: ...


@dataclass(frozen=True)
class SearchMethod:
    proposer: CandidateProposer
    allocator: TrialAllocator
    estimator: ObjectiveEstimator

    def components(self) -> dict[str, MethodComponent]:
        return {
            "proposer": self.proposer,
            "allocator": self.allocator,
            "estimator": self.estimator,
        }

    def binding(self, settings: dict[str, Any] | None = None) -> MethodBinding:
        """探索問題へ書く接続情報。`settings` は手法の設定（記録用）。"""
        return MethodBinding(
            proposer=self.proposer.descriptor,
            allocator=self.allocator.descriptor,
            estimator=self.estimator.descriptor,
            settings=settings or {},
        )

    def check_binding(self, binding: MethodBinding) -> None:
        for role, component in self.components().items():
            expected: ComponentDescriptor = getattr(binding, role)
            if component.descriptor != expected:
                raise IncompatibleMethodError(
                    f"{role}: 保存済みの探索は {expected.component_id}@{expected.version} で"
                    f"作られている（接続したのは "
                    f"{component.descriptor.component_id}@{component.descriptor.version}）"
                )
