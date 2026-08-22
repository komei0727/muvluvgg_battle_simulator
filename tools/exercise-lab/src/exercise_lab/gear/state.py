"""理論値探索の状態保存と復元。中断した探索を、続きから同じ軌跡で回すために使う。

探索は数万試行規模になり、1回で走り切れないことがある。再開しても結果が変わらない
ためには、**乱数の位置と評価済みスコアの両方**を戻す必要がある（`optimize/state.py` と
同じ要求）。ギア探索での「乱数の位置」は2つある。

- 一括評価の乱数は送信seedと位相で決まるので、評価済みスコアを戻せば位置も戻る。
- **単発実行（レジーム観測）はseedを受け取らない。** 同じ配分を2度観測しても同じ署名が
  返る保証が無いため、観測した署名そのものを持ち越すしかない。

探索の手続き自体は決定的である（`gear/search.py`）。したがって再開は「先頭から回し直し、
評価と観測はキャッシュから読む」で足りる——中断した地点までは1試行も投げずに同じ道を
辿り、その先から新しい評価が始まる。段の途中まで進んだ状態を書き出す必要は無い。

**消費試行数は復元した時点でまとめて数えない**（`Evaluator.stage_record`）。まとめて
数えると、best-so-far 曲線の横軸が再開の時点で跳ね上がり、中断せず走らせた軌跡と
食い違う。探索がその候補を求めた時点で数えることで、横軸まで一致する。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..optimize.evaluator import CandidateRecord, EvaluationPhase, Evaluator
from .allocation import Allocation, GearPiece, UnitAllocation
from .final import final_phase
from .plan import PlanSettings
from .regime import CachingObserver, RegimeSignature
from .search import phases_for_climb

STATE_VERSION = 1

STATE_JSON = "state.json"


def plan_phases(settings: PlanSettings) -> tuple[EvaluationPhase, ...]:
    """探索が使う位相すべて。篩い・確定・最終選抜の3つ。

    状態を書き出すときも評価器を組むときもこの並びを使う。片方だけ数え漏らすと、
    再開後に最終選抜だけがもう一度走る（別の位相なのでキャッシュが効かない）。
    """
    screen, confirm = phases_for_climb(settings.climb)
    return (screen, confirm, final_phase(settings.climb, settings.final))


def plan_digest(start: Allocation, settings: PlanSettings) -> str:
    """基点と探索設定の指紋。別の条件で保存した状態を読ませないために使う。

    基点編成が変われば理論値そのものが変わり、試行数の設定が変われば位相の乱数範囲が
    ずれる。どちらも「続き」ではないので、再開を拒む。
    """
    payload = json.dumps(
        {"start": start.canonical_key(), "settings": asdict(settings)},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class PlanState:
    """書き出す状態。評価済みスコアと観測済み署名、そして予算の消費である。"""

    seed: str
    digest: str
    consumed_runs: int
    requested_runs: int
    records: dict[str, list[CandidateRecord[Allocation]]] = field(default_factory=dict)
    signatures: dict[str, RegimeSignature] = field(default_factory=dict)


def write_plan_state(path: Path, state: PlanState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(_encode(state), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def read_plan_state(path: Path) -> PlanState:
    payload = json.loads(path.read_text(encoding="utf-8"))
    version = payload.get("version")
    if version != STATE_VERSION:
        raise ValueError(
            f"{path}: 未対応の状態ファイル版 {version!r}（このツールは {STATE_VERSION} だけを読む）"
        )
    return PlanState(
        seed=payload["seed"],
        digest=payload["digest"],
        consumed_runs=payload["consumedRuns"],
        requested_runs=payload["requestedRuns"],
        records={
            name: [_decode_record(entry) for entry in entries]
            for name, entries in payload["records"].items()
        },
        signatures={
            entry["allocation"]: _decode_signature(entry["signature"])
            for entry in payload["signatures"]
        },
    )


@dataclass
class PlanCheckpoint:
    """評価器と観測器の状態を1つのファイルへ書き出す係。

    書き出すのは `ensure` が終わるたび（`CheckpointingSource`）と、新しい署名を観測した
    ときである。途中で落ちても、直前の巡までは投げ直さずに済む。
    """

    path: Path
    evaluator: Evaluator[Allocation]
    observer: CachingObserver
    seed: str
    digest: str
    phases: tuple[EvaluationPhase, ...]

    def save(self) -> None:
        write_plan_state(self.path, self.capture())

    def capture(self) -> PlanState:
        return PlanState(
            seed=self.seed,
            digest=self.digest,
            consumed_runs=self.evaluator.consumed_runs,
            requested_runs=self.evaluator.requested_runs,
            # まだ探索が求めていない読み戻しぶん（`staged_records`）も書き戻す。落とすと
            # 2度目の中断で、1度目までに払った試行を投げ直すことになる。
            records={
                phase.name: [
                    *self.evaluator.evaluated_records(phase),
                    *self.evaluator.staged_records(phase),
                ]
                for phase in self.phases
            },
            signatures=dict(self.observer.cache),
        )

    def restore(self) -> PlanState:
        """保存した状態を評価器と観測器へ戻す。条件が違えば読まない。"""
        state = read_plan_state(self.path)
        if state.seed != self.seed:
            raise ValueError(
                f"{self.path}: 保存時の seed {state.seed!r} と --seed {self.seed!r} が違う。"
                "同じseedで再開する（seedが変わると評価の乱数列そのものが変わる）"
            )
        if state.digest != self.digest:
            raise ValueError(
                f"{self.path}: 保存時と基点編成か探索設定が違う。"
                "同じ条件で再開するか、--resume を外して最初から回す"
            )
        by_name = {phase.name: phase for phase in self.phases}
        for name, records in state.records.items():
            phase = by_name.get(name)
            if phase is None:
                continue
            for record in records:
                self.evaluator.stage_record(phase, record)
        self.evaluator.adopt_requested_runs(state.requested_runs)
        self.observer.cache.update(state.signatures)
        return state


@dataclass
class CheckpointingSource:
    """`ensure` が終わるたびに状態を書き出す覆い。探索は評価器の他の面を使わない。"""

    evaluator: Any
    checkpoint: PlanCheckpoint

    @property
    def consumed_runs(self) -> int:
        return self.evaluator.consumed_runs

    def record_for(self, candidate, phase: EvaluationPhase):
        return self.evaluator.record_for(candidate, phase)

    def ensure(self, candidates, target: int, *, phase: EvaluationPhase):
        records = self.evaluator.ensure(candidates, target, phase=phase)
        self.checkpoint.save()
        return records


def _encode(state: PlanState) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "seed": state.seed,
        "digest": state.digest,
        "consumedRuns": state.consumed_runs,
        "requestedRuns": state.requested_runs,
        "records": {
            name: [_encode_record(record) for record in records]
            for name, records in state.records.items()
        },
        "signatures": [
            {"allocation": key, "signature": signature.to_dict()}
            for key, signature in sorted(state.signatures.items())
        ],
    }


def _encode_record(record: CandidateRecord[Allocation]) -> dict[str, Any]:
    """再開に要る列だけを書き出す。

    枠別の与ダメージ（`unitDamageTotals`）は落とせない——篩いの指標そのものであり、
    落とすと再開後の順位が総スコアでの代用に変わる（`gear/search.py`）。
    """
    return {
        "allocation": _encode_allocation(record.candidate),
        "scores": record.scores,
        "breakCounts": record.break_counts,
        "completionReasons": record.completion_reasons,
        "unitDamageTotals": [list(row) for row in record.unit_damage_totals],
    }


def _decode_record(payload: dict[str, Any]) -> CandidateRecord[Allocation]:
    return CandidateRecord(
        candidate=_decode_allocation(payload["allocation"]),
        scores=list(payload["scores"]),
        break_counts=list(payload["breakCounts"]),
        completion_reasons=list(payload["completionReasons"]),
        unit_damage_totals=[tuple(row) for row in payload["unitDamageTotals"]],
    )


def _encode_allocation(allocation: Allocation) -> list[dict[str, Any]]:
    return [
        {
            "unitDefinitionId": unit.unit_definition_id,
            "pieces": [
                {"stat": piece.stat, "tier": piece.tier, "grade": piece.grade}
                for piece in unit.pieces
            ],
        }
        for unit in allocation.units
    ]


def _decode_allocation(payload: list[dict[str, Any]]) -> Allocation:
    return Allocation(
        units=tuple(
            UnitAllocation(
                unit_definition_id=unit["unitDefinitionId"],
                pieces=tuple(
                    GearPiece(stat=piece["stat"], tier=piece["tier"], grade=piece["grade"])
                    for piece in unit["pieces"]
                ),
            )
            for unit in payload
        )
    )


def _decode_signature(payload: dict[str, Any]) -> RegimeSignature:
    return RegimeSignature(
        action_order=tuple(payload["actionOrder"]),
        assignments=dict(payload["assignments"]),
        consumers=dict(payload["consumers"]),
        holders=dict(payload["holders"]),
    )
