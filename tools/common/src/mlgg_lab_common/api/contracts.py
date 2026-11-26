"""評価API（seed付き大量試行）の要求・応答の契約と、応答の検証。

`docs/ddd/10_API設計.md`「通常戦闘を大量試行する」「総力戦を大量試行する」の写しである。
共通の部分（ヘッダー・ケース・試行番号の対応）と、形式ごとの試行の型（`FormatContract`）を
分けて持つ。戦闘の中身は再実装せず、APIが返した試行をそのまま観測値として扱う。

応答の検証は「要求と対応がつくか」を見る。

- ケースは `caseId`、試行は `runIndex` で対応づける。配列の位置には依存しない。
- 要求していないケース・番号、重複、完了と未完了の両方に載った番号、どちらにも載らない
  番号、件数の食い違いを不正として扱う。
- 試行のユニット集計は、要求した参加枠 `(side, formationNumber, unitIndex)` とちょうど
  対応しなければならない（同じユニットを複数枠へ置けるため、定義IDでは突き合わせない）。

戦術演習の評価APIは、試行番号を指定できる形への再設計が済んでいない。旧API向けの
seed変換・互換アダプターは作らない方針なので、ここでは契約を持たず、要求されたら
`UnsupportedFormatError` で止める。
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError

EvaluationFormat = Literal["BATTLE", "TOTAL_WAR", "TACTICAL_EXERCISE"]

# 評価APIの応答 `schemaVersion`。これ以外は読み替えずに止める。
RESPONSE_SCHEMA_VERSION = 1
MAX_RUN_INDEX = 4_294_967_295


class UnsupportedFormatError(ValueError):
    """評価APIの契約をまだ持たない形式。"""


class ResponseContractError(Exception):
    """応答が契約・要求と対応しない。見つかった問題をすべて持つ。"""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)
        super().__init__("評価APIの応答が要求と対応しない:\n" + "\n".join(self.problems))


class _Response(BaseModel):
    # 加算的に増えた項目では止めない。観測値は応答の生のオブジェクトを保存するので、
    # ここで読まない項目も失われない。
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


Outcome = Literal["ALLY_WIN", "ALLY_LOSE", "DRAW"]
CompletionReason = Literal[
    "SIMULTANEOUS_DEFEAT", "ENEMY_DEFEATED", "ALLY_DEFEATED", "TURN_LIMIT_REACHED"
]


class UnitRecord(_Response):
    side: Literal["ALLY", "ENEMY"]
    formation_number: StrictInt | None = Field(default=None, alias="formationNumber")
    unit_index: StrictInt = Field(alias="unitIndex", ge=0)
    unit_definition_id: str = Field(alias="unitDefinitionId")
    damage_dealt: StrictInt = Field(alias="damageDealt", ge=0)
    damage_taken: StrictInt = Field(alias="damageTaken", ge=0)
    healing_done: StrictInt = Field(alias="healingDone", ge=0)
    final_hp: float = Field(alias="finalHp", ge=0)
    maximum_hp: float = Field(alias="maximumHp", ge=0)
    combat_status: Literal["ACTIVE", "DEFEATED"] = Field(alias="combatStatus")
    deployed: StrictBool | None = None
    reappearance: StrictBool | None = None


class BattleRun(_Response):
    run_index: StrictInt = Field(alias="runIndex", ge=0, le=MAX_RUN_INDEX)
    # 通常戦闘に引き分けは無い。
    outcome: Literal["ALLY_WIN", "ALLY_LOSE"]
    completion_reason: CompletionReason = Field(alias="completionReason")
    completed_turn: StrictInt = Field(alias="completedTurn", ge=1)
    units: list[UnitRecord]


class TotalWarStage(_Response):
    stage_number: StrictInt = Field(alias="stageNumber", ge=1)
    ally_formation_number: StrictInt = Field(alias="allyFormationNumber", ge=1, le=3)
    enemy_formation_number: StrictInt = Field(alias="enemyFormationNumber", ge=1, le=3)
    start_turn: StrictInt = Field(alias="startTurn", ge=1)
    end_turn: StrictInt = Field(alias="endTurn", ge=1)
    defeated_sides: list[Literal["ALLY", "ENEMY"]] = Field(alias="defeatedSides", max_length=2)


class DefeatedFormationCounts(_Response):
    ally: StrictInt = Field(ge=0, le=3)
    enemy: StrictInt = Field(ge=0, le=3)


class TotalWarRun(_Response):
    run_index: StrictInt = Field(alias="runIndex", ge=0, le=MAX_RUN_INDEX)
    outcome: Outcome
    completion_reason: CompletionReason = Field(alias="completionReason")
    completed_turn: StrictInt = Field(alias="completedTurn", ge=1)
    stages: list[TotalWarStage]
    defeated_formation_counts: DefeatedFormationCounts = Field(alias="defeatedFormationCounts")
    units: list[UnitRecord]


class CaseResponse(_Response):
    case_id: str = Field(alias="caseId")
    # 試行の中身は形式ごとの型で別に検証する（生のオブジェクトを観測値として残すため）。
    runs: list[dict[str, Any]]
    incomplete_run_indices: list[StrictInt] = Field(alias="incompleteRunIndices")


class EvaluationResponse(_Response):
    schema_version: StrictInt = Field(alias="schemaVersion")
    seed: str
    seed_derivation_version: str = Field(alias="seedDerivationVersion")
    catalog_revision: str = Field(alias="catalogRevision")
    engine_revision: str = Field(alias="engineRevision")
    requested_runs: StrictInt = Field(alias="requestedRuns", ge=0)
    completed_runs: StrictInt = Field(alias="completedRuns", ge=0)
    partial: StrictBool
    cases: list[CaseResponse]


@dataclass(frozen=True)
class ExpectedSlot:
    """要求した参加枠1つ。応答のユニット集計はこれとちょうど対応しなければならない。"""

    side: Literal["ALLY", "ENEMY"]
    formation_number: int | None
    unit_index: int
    unit_definition_id: str

    @property
    def key(self) -> tuple[str, int | None, int]:
        return (self.side, self.formation_number, self.unit_index)


@dataclass(frozen=True)
class FormatContract:
    """形式ごとの評価APIの契約。"""

    format: EvaluationFormat
    path: str
    # 保存する観測値の形式の識別子。API契約が変われば変える。
    contract_id: str
    run_model: type[BaseModel]
    # 総力戦だけが `formationNumber` / `deployed` / `reappearance` を持つ。
    numbered_slots: bool
    # APIの既定の上限（`*_EVALUATION_MAX_CASES` / `*_MAX_TOTAL_RUNS`）。配備ごとに変わり得る
    # ので、実行設定で上書きできる初期値としてだけ使う。
    default_max_cases_per_request: int
    default_max_runs_per_request: int


BATTLE_CONTRACT = FormatContract(
    format="BATTLE",
    path="/api/v1/battle-evaluations",
    contract_id="battle-evaluations/v1/schemaVersion=1",
    run_model=BattleRun,
    numbered_slots=False,
    default_max_cases_per_request=64,
    default_max_runs_per_request=300,
)

TOTAL_WAR_CONTRACT = FormatContract(
    format="TOTAL_WAR",
    path="/api/v1/total-war-evaluations",
    contract_id="total-war-evaluations/v1/schemaVersion=1",
    run_model=TotalWarRun,
    numbered_slots=True,
    default_max_cases_per_request=32,
    default_max_runs_per_request=120,
)

_CONTRACTS: dict[str, FormatContract] = {
    BATTLE_CONTRACT.format: BATTLE_CONTRACT,
    TOTAL_WAR_CONTRACT.format: TOTAL_WAR_CONTRACT,
}


def contract_for(evaluation_format: str) -> FormatContract:
    if evaluation_format == "TACTICAL_EXERCISE":
        raise UnsupportedFormatError(
            "戦術演習の評価APIは試行番号を指定できる形への再設計が済んでいないため、"
            "共通の実行基盤から評価できない（旧APIへの互換アダプターは作らない）"
        )
    contract = _CONTRACTS.get(evaluation_format)
    if contract is None:
        raise UnsupportedFormatError(f"未知の評価形式: {evaluation_format!r}")
    return contract


@dataclass(frozen=True)
class RequestCase:
    case_id: str
    match_request: Mapping[str, Any]
    run_indices: tuple[int, ...]
    expected_slots: tuple[ExpectedSlot, ...]


@dataclass(frozen=True)
class EvaluationRequest:
    contract: FormatContract
    seed: str
    cases: tuple[RequestCase, ...]
    expected_catalog_revision: str | None = None
    expected_engine_revision: str | None = None

    @property
    def run_count(self) -> int:
        return sum(len(case.run_indices) for case in self.cases)

    def body(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "seed": self.seed,
            "cases": [
                {
                    "caseId": case.case_id,
                    **case.match_request,
                    "runIndices": list(case.run_indices),
                }
                for case in self.cases
            ],
        }
        if self.expected_catalog_revision is not None:
            body["expectedCatalogRevision"] = self.expected_catalog_revision
        if self.expected_engine_revision is not None:
            body["expectedEngineRevision"] = self.expected_engine_revision
        return body


@dataclass(frozen=True)
class ExecutionEnvironment:
    """試行結果の再現に効く実行環境の識別情報。これが違う結果は混ぜない。"""

    catalog_revision: str
    engine_revision: str
    seed_derivation_version: str
    contract_id: str

    def differences(self, other: ExecutionEnvironment) -> list[str]:
        return [
            f"{name}: {mine!r} → {theirs!r}"
            for name, mine, theirs in (
                ("catalogRevision", self.catalog_revision, other.catalog_revision),
                ("engineRevision", self.engine_revision, other.engine_revision),
                (
                    "seedDerivationVersion",
                    self.seed_derivation_version,
                    other.seed_derivation_version,
                ),
                ("contract", self.contract_id, other.contract_id),
            )
            if mine != theirs
        ]


@dataclass(frozen=True)
class CompletedRun:
    case_id: str
    run_index: int
    # 応答の試行オブジェクトそのもの。意味上の観測値の正本。
    observation: dict[str, Any]


@dataclass(frozen=True)
class ValidatedResponse:
    environment: ExecutionEnvironment
    completed: tuple[CompletedRun, ...]
    incomplete: tuple[tuple[str, int], ...]


def validate_response(request: EvaluationRequest, body: object) -> ValidatedResponse:
    """応答を契約と要求に照らして検証する。問題があれば全部まとめて `ResponseContractError`。"""
    try:
        response = EvaluationResponse.model_validate(body)
    except ValidationError as error:
        raise ResponseContractError([f"応答の形が契約と合わない: {error}"]) from error

    problems: list[str] = []
    if response.schema_version != RESPONSE_SCHEMA_VERSION:
        problems.append(
            f"schemaVersion={response.schema_version}（{RESPONSE_SCHEMA_VERSION} だけを読む）"
        )
    if response.seed != request.seed:
        problems.append(f"seed が要求と違う: {response.seed!r}（要求 {request.seed!r}）")

    requested = {case.case_id: case for case in request.cases}
    counts = Counter(case.case_id for case in response.cases)
    problems.extend(
        f"caseId {case_id!r} が応答に{count}回ある"
        for case_id, count in counts.items()
        if count > 1
    )
    problems.extend(
        f"要求していない caseId {case_id!r} が応答にある"
        for case_id in counts
        if case_id not in requested
    )
    problems.extend(
        f"要求した caseId {case_id!r} が応答に無い"
        for case_id in requested
        if case_id not in counts
    )

    completed: list[CompletedRun] = []
    incomplete: list[tuple[str, int]] = []
    for case_response in response.cases:
        case = requested.get(case_response.case_id)
        if case is None or counts[case_response.case_id] > 1:
            continue
        case_completed, case_problems = _validate_case(request.contract, case, case_response)
        problems.extend(case_problems)
        completed.extend(case_completed)
        incomplete.extend((case.case_id, index) for index in case_response.incomplete_run_indices)

    if response.requested_runs != request.run_count:
        problems.append(
            f"requestedRuns={response.requested_runs}（要求した試行数は {request.run_count}）"
        )
    returned_runs = sum(len(case.runs) for case in response.cases)
    if response.completed_runs != returned_runs:
        problems.append(
            f"completedRuns={response.completed_runs} と返った試行の数 {returned_runs} が違う"
        )
    if response.partial != (response.completed_runs < response.requested_runs):
        problems.append(
            f"partial={response.partial} が completedRuns={response.completed_runs} / "
            f"requestedRuns={response.requested_runs} と合わない"
        )
    if problems:
        raise ResponseContractError(problems)
    return ValidatedResponse(
        environment=ExecutionEnvironment(
            catalog_revision=response.catalog_revision,
            engine_revision=response.engine_revision,
            seed_derivation_version=response.seed_derivation_version,
            contract_id=request.contract.contract_id,
        ),
        completed=tuple(completed),
        incomplete=tuple(incomplete),
    )


def _validate_case(
    contract: FormatContract, case: RequestCase, response: CaseResponse
) -> tuple[list[CompletedRun], list[str]]:
    where = f"cases[{case.case_id!r}]"
    problems: list[str] = []
    requested = set(case.run_indices)
    completed: list[CompletedRun] = []
    seen: Counter[int] = Counter()
    for position, raw in enumerate(response.runs):
        try:
            run = contract.run_model.model_validate(raw)
        except ValidationError as error:
            problems.append(f"{where}.runs[{position}] が契約と合わない: {error}")
            continue
        run_index: int = run.run_index  # type: ignore[attr-defined]
        seen[run_index] += 1
        if run_index not in requested:
            problems.append(f"{where}: 要求していない runIndex {run_index} が完了に載っている")
            continue
        problems.extend(
            f"{where}.runIndex={run_index}: {problem}"
            for problem in _slot_problems(contract, case.expected_slots, run.units)  # type: ignore[attr-defined]
        )
        completed.append(CompletedRun(case.case_id, run_index, raw))
    problems.extend(
        f"{where}: runIndex {index} が完了に{count}回ある"
        for index, count in seen.items()
        if count > 1
    )
    incomplete = Counter(response.incomplete_run_indices)
    problems.extend(
        f"{where}: runIndex {index} が未完了に{count}回ある"
        for index, count in incomplete.items()
        if count > 1
    )
    problems.extend(
        f"{where}: 要求していない runIndex {index} が未完了に載っている"
        for index in incomplete
        if index not in requested
    )
    problems.extend(
        f"{where}: runIndex {index} が完了と未完了の両方に載っている"
        for index in sorted(set(seen) & set(incomplete))
    )
    problems.extend(
        f"{where}: runIndex {index} が完了にも未完了にも無い"
        for index in sorted(requested - set(seen) - set(incomplete))
    )
    return completed, problems


def _slot_problems(
    contract: FormatContract, expected: Sequence[ExpectedSlot], units: Sequence[UnitRecord]
) -> list[str]:
    problems: list[str] = []
    expected_by_key = {slot.key: slot for slot in expected}
    seen: Counter[tuple[str, int | None, int]] = Counter()
    for unit in units:
        key = (unit.side, unit.formation_number, unit.unit_index)
        seen[key] += 1
        slot = expected_by_key.get(key)
        if slot is None:
            problems.append(f"要求に無い参加枠 {key} の集計がある")
            continue
        if unit.unit_definition_id != slot.unit_definition_id:
            problems.append(
                f"参加枠 {key} のユニットが {unit.unit_definition_id}"
                f"（要求は {slot.unit_definition_id}）"
            )
        if contract.numbered_slots and (unit.deployed is None or unit.reappearance is None):
            problems.append(f"参加枠 {key} に deployed / reappearance が無い")
    problems.extend(
        f"参加枠 {key} の集計が{count}件ある" for key, count in seen.items() if count > 1
    )
    problems.extend(f"参加枠 {key} の集計が無い" for key in expected_by_key if key not in seen)
    return problems
