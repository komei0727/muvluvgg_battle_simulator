"""ローカルdevサーバー（`mise run dev`）向けのHTTPクライアント。

対象は `GET /api/v1/battle-simulation-catalog` と
`POST /api/v1/tactical-exercise-evaluations`（`docs/ddd/10_API設計.md`）。
本番Cloud Runでは後者が `EVALUATION_ENDPOINT_ENABLED=false` で閉じているため、
このツールはローカル配備だけを相手にする。
"""

from __future__ import annotations

from types import TracebackType
from typing import Any, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .models import FormationConfig

CATALOG_PATH = "/api/v1/battle-simulation-catalog"
EVALUATION_PATH = "/api/v1/tactical-exercise-evaluations"

DEFAULT_BASE_URL = "http://localhost:3000"
# 1チャンクはサーバー側の `SIMULATION_TIMEOUT_MS`（既定30秒）まで掛かり得る。
# クライアント側の待ちをそれより短くすると、完了した部分結果まで捨ててしまう。
DEFAULT_TIMEOUT_SECONDS = 120.0

# `R-TEX-11` #1: 味方は `PLAYABLE`、敵は `EXERCISE_ENEMY` からしか選べない。
PLAYABLE = "PLAYABLE"
EXERCISE_ENEMY = "EXERCISE_ENEMY"


class LabApiError(Exception):
    """APIが成功以外を返した、または応答が契約から外れている。"""


class _Response(BaseModel):
    # 応答に将来増えた項目でツールが壊れないようにする（読む側は加算的変更へ寛容にする）。
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class CatalogUnit(_Response):
    unit_definition_id: str = Field(alias="unitDefinitionId")
    display_name: str = Field(alias="displayName")
    category: str
    exercise_active: bool | None = Field(default=None, alias="exerciseActive")


class CatalogMemory(_Response):
    memory_definition_id: str = Field(alias="memoryDefinitionId")
    display_name: str = Field(alias="displayName")


class Catalog(_Response):
    catalog_revision: str = Field(alias="catalogRevision")
    units: list[CatalogUnit]
    memories: list[CatalogMemory]

    def unit(self, unit_definition_id: str) -> CatalogUnit | None:
        return next(
            (unit for unit in self.units if unit.unit_definition_id == unit_definition_id), None
        )

    def has_memory(self, memory_definition_id: str) -> bool:
        return any(memory.memory_definition_id == memory_definition_id for memory in self.memories)


class CandidateEvaluation(_Response):
    completed_runs: int = Field(alias="completedRuns")
    scores: list[int]
    break_counts: list[int] = Field(alias="breakCounts")
    completed_turns: list[int] = Field(alias="completedTurns")
    completion_reasons: list[str] = Field(alias="completionReasons")


class EvaluationResponse(_Response):
    catalog_revision: str = Field(alias="catalogRevision")
    seed: str
    runs_per_candidate: int = Field(alias="runsPerCandidate")
    candidates: list[CandidateEvaluation]


class LabApiClient:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout_seconds)

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def fetch_catalog(self) -> Catalog:
        return _parse(Catalog, self._get(CATALOG_PATH))

    def evaluate(self, body: dict[str, Any]) -> EvaluationResponse:
        return _parse(EvaluationResponse, self._post(EVALUATION_PATH, body))

    def _get(self, path: str) -> Any:
        try:
            response = self._client.get(path)
        except httpx.RequestError as error:
            raise LabApiError(_unreachable_message(error)) from error
        return _body_or_raise(response)

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        try:
            response = self._client.post(path, json=body)
        except httpx.RequestError as error:
            raise LabApiError(_unreachable_message(error)) from error
        return _body_or_raise(response)


def _unreachable_message(error: httpx.RequestError) -> str:
    return (
        f"APIへ到達できない: {error}. "
        "`mise run dev`（apps/api/）でdevサーバーを起動しているか、--base-url を確認する"
    )


def _body_or_raise(response: httpx.Response) -> Any:
    if response.status_code == httpx.codes.OK:
        return response.json()
    raise LabApiError(_error_message(response))


def _error_message(response: httpx.Response) -> str:
    error = _error_object(response)
    code = error.get("code", "UNKNOWN")
    message = error.get("message", response.text)
    lines = [f"{response.status_code} {code}: {message}"]
    if code == "ENDPOINT_DISABLED":
        # 実装が無いのではなく設定で閉じている（Q-TEX-19）。原因が設定であることを
        # 明示しないと、パスやバージョンの取り違えを疑って時間を溶かす。
        lines.append(
            "この配備は一括評価を提供していない。devサーバーを "
            "EVALUATION_ENDPOINT_ENABLED=true で起動する"
        )
    for violation in error.get("violations", []):
        path = violation.get("path", "")
        rule_id = violation.get("ruleId", "")
        lines.append(f"  - {path} {rule_id} {violation.get('message', '')}".rstrip())
    return "\n".join(lines)


def _error_object(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    error = body.get("error") if isinstance(body, dict) else None
    return error if isinstance(error, dict) else {}


def validate_against_catalog(config: FormationConfig, catalog: Catalog) -> list[str]:
    """編成YAMLをカタログと突き合わせ、見つかった問題をすべて返す。

    最初の1件で止めない。1000試行を投げる前の事前検査であり、IDの打ち間違いが
    複数あるときに1件ずつ往復させると、devサーバー起動込みの試行錯誤が長くなる。
    """
    errors: list[str] = []
    for unit in config.ally.units:
        errors.extend(_unit_errors(unit.unit_definition_id, "ally", PLAYABLE, catalog))
    errors.extend(_unit_errors(config.enemy.unit_definition_id, "enemy", EXERCISE_ENEMY, catalog))
    for memory_definition_id in config.ally.memory_definition_ids:
        if not catalog.has_memory(memory_definition_id):
            errors.append(f"ally.memoryDefinitionIds: 未知のメモリー {memory_definition_id}")
    return errors


def _unit_errors(
    unit_definition_id: str, side: str, required_category: str, catalog: Catalog
) -> list[str]:
    unit = catalog.unit(unit_definition_id)
    if unit is None:
        return [f"{side}: 未知のユニット {unit_definition_id}"]
    if unit.category != required_category:
        return [
            f"{side}: {unit_definition_id} は category={unit.category} であり "
            f"{required_category} ではない（R-TEX-11 #1）"
        ]
    return []


def _parse[T: _Response](model: type[T], payload: Any) -> T:
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        raise LabApiError(f"APIの応答が契約と合わない: {error}") from error
