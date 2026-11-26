"""試行計画の作成と検証。

    解決済みの対戦入力（各ラボ） + seed + ケースごとの試行番号 + 実行設定・予算
      → 送信する対戦条件・参加枠・試行番号を確定した計画

計画は解決済み入力のスナップショットと送信内容を自己完結で持つ。保存後は元の編成YAML・
育成JSONを読み直さない——元ファイルが書き換わっても、再開で条件が変わらないようにする。
候補生成・戦略選択はここに含めない（ケースは呼び出し側が明示的に並べる）。
"""

from __future__ import annotations

import json
import secrets
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from ..api.contracts import MAX_RUN_INDEX, ExpectedSlot, contract_for
from ..models.participants import ParticipantSlot
from ..models.resolved import ResolvedInput, dump_resolved_input
from .identity import match_fingerprint
from .models import Budget, EvaluationPlan, ExecutionSettings, PlannedCase


class PlanError(ValueError):
    """計画として成立しない。見つかった問題をすべて持つ。"""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)
        super().__init__("試行計画を作れない:\n" + "\n".join(f"  - {p}" for p in self.problems))


class EvaluableInput(Protocol):
    """各ラボの解決済み入力（`ResolvedBattleInput` 等）が持つ口。"""

    format: str

    def to_request(self) -> dict[str, Any]: ...

    def participant_slots(self) -> list[ParticipantSlot]: ...


@dataclass(frozen=True)
class CaseSpec:
    case_id: str
    input: EvaluableInput
    run_indices: Sequence[int]


def run_range(count: int, *, start: int = 0) -> list[int]:
    return list(range(start, start + count))


def new_evaluation_id(now: datetime | None = None) -> str:
    moment = now or datetime.now(UTC)
    return f"{moment:%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"


def create_plan(
    evaluation_format: str,
    cases: Sequence[CaseSpec],
    *,
    seed: str,
    budget: Budget,
    settings: ExecutionSettings | None = None,
    evaluation_id: str | None = None,
    created_at: str | None = None,
) -> EvaluationPlan:
    contract = contract_for(evaluation_format)
    problems: list[str] = []
    if not seed.strip():
        problems.append("seed が空")
    if not cases:
        problems.append("ケースが無い")
    counts = Counter(case.case_id for case in cases)
    problems.extend(f"caseId {cid!r} が重複している" for cid, n in counts.items() if n > 1)

    planned: list[PlannedCase] = []
    for position, case in enumerate(cases):
        where = f"cases[{position}]（{case.case_id!r}）"
        if not case.case_id.strip():
            problems.append(f"{where}: caseId が空")
        if case.input.format != contract.format:
            problems.append(
                f"{where}: 入力の形式 {case.input.format} は計画の形式 {contract.format} と違う"
            )
            continue
        problems.extend(f"{where}: {p}" for p in _run_index_problems(case.run_indices))
        match_request = case.input.to_request()
        planned.append(
            PlannedCase(
                case_id=case.case_id,
                input_snapshot=_snapshot(case.input),
                match_request=match_request,
                expected_slots=tuple(
                    ExpectedSlot(
                        side=slot.key.side,
                        formation_number=slot.key.formation_number,
                        unit_index=slot.key.unit_index,
                        unit_definition_id=slot.unit_definition_id,
                    )
                    for slot in case.input.participant_slots()
                ),
                run_indices=tuple(case.run_indices),
                match_fingerprint=match_fingerprint(contract.format, match_request),
            )
        )
    if problems:
        raise PlanError(problems)
    return EvaluationPlan(
        evaluation_id=evaluation_id or new_evaluation_id(),
        contract=contract,
        seed=seed,
        settings=(settings or ExecutionSettings()).resolved_for(contract),
        budget=budget,
        cases=tuple(planned),
        created_at=created_at or datetime.now(UTC).isoformat(timespec="seconds"),
    )


def _run_index_problems(run_indices: Sequence[int]) -> list[str]:
    if not run_indices:
        return ["試行番号が無い"]
    problems = [
        f"試行番号 {index} が0～{MAX_RUN_INDEX}の整数ではない"
        for index in run_indices
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= MAX_RUN_INDEX
    ]
    problems.extend(
        f"試行番号 {index} が重複している" for index, n in Counter(run_indices).items() if n > 1
    )
    return problems


def _snapshot(resolved: EvaluableInput) -> dict[str, Any]:
    if isinstance(resolved, ResolvedInput):
        return json.loads(dump_resolved_input(resolved))
    raise TypeError(f"解決済み入力（ResolvedInput）ではない: {type(resolved).__name__}")
