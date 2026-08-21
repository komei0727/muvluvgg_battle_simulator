"""ローカルdevサーバー（`mise run dev`）向けのHTTPクライアント。

対象は `GET /api/v1/battle-simulation-catalog` と
`POST /api/v1/tactical-exercise-evaluations`（`docs/ddd/10_API設計.md`）。
本番Cloud Runでは後者が `EVALUATION_ENDPOINT_ENABLED=false` で閉じているため、
このツールはローカル配備だけを相手にする。
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass
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
    # 表示・検索・補完の説明にだけ使う。API契約上は必須だが、欠けても評価は成立するので
    # 既定値を持たせる（応答の加算的変更に寛容にする方針と揃える）。
    character_name: str = Field(default="", alias="characterName")
    role: str = ""
    position_aptitudes: list[str] = Field(default_factory=list, alias="positionAptitudes")
    # 探索の初期母集団（属性を揃えた構成・適性に合わせた配置）を組むのに使う。
    attribute: str = ""
    unit_type: str = Field(default="", alias="unitType")


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


@dataclass(frozen=True)
class AllyUnitSeries:
    """味方1枠ぶんの、試行ごとの与ダメージとブレイク回数。

    `formation_index` は送信した `allyFormation.units` の何番目かであり、これがユニット別
    配列の列番号でもある。同じユニットを2マスへ置ける（`allowDuplicateUnits`）以上、
    枠はIDでは特定できないので、両方を持たせる。
    """

    formation_index: int
    unit_definition_id: str
    damage_totals: tuple[int, ...]
    break_counts: tuple[int, ...]


class CandidateEvaluation(_Response):
    completed_runs: int = Field(alias="completedRuns")
    scores: list[int]
    break_counts: list[int] = Field(alias="breakCounts")
    completed_turns: list[int] = Field(alias="completedTurns")
    completion_reasons: list[str] = Field(alias="completionReasons")
    # ユニット別の集計。読まない用途（`lab stats`）を欠損で止めないため既定を空にする。
    # 形の検査は読むとき（`ally_unit_series`）に行う。
    ally_unit_damage_totals: list[list[int]] = Field(
        default_factory=list, alias="allyUnitDamageTotals"
    )
    ally_unit_break_counts: list[list[int]] = Field(
        default_factory=list, alias="allyUnitBreakCounts"
    )

    def ally_unit_series(self, unit_definition_ids: Sequence[str]) -> list[AllyUnitSeries]:
        """ユニット別の配列を、送信した編成順のユニットIDと組にして返す。

        `unit_definition_ids` はリクエストの `candidates[i].allyFormation.units` と同じ順で
        なければならない（`10_API設計.md`）。生の二重配列のまま渡すと、列番号と編成順の
        対応を読む側が各所で組み直すことになり、1か所でも取り違えると「別のユニットの
        与ダメージ」を黙って分析してしまう。対応を作れる入口をここ1つに絞る。
        """
        units = len(unit_definition_ids)
        self._reject_ragged("allyUnitDamageTotals", self.ally_unit_damage_totals, units)
        self._reject_ragged("allyUnitBreakCounts", self.ally_unit_break_counts, units)
        return [
            AllyUnitSeries(
                formation_index=index,
                unit_definition_id=unit_definition_id,
                damage_totals=tuple(row[index] for row in self.ally_unit_damage_totals),
                break_counts=tuple(row[index] for row in self.ally_unit_break_counts),
            )
            for index, unit_definition_id in enumerate(unit_definition_ids)
        ]

    def _reject_ragged(self, name: str, rows: Sequence[Sequence[int]], units: int) -> None:
        """行数（試行）と列数（編成枠）を確かめる。

        期限に達した候補は完了ぶんだけを返す（Q-TEX-18）ので、比べる相手は要求試行数では
        なく `completedRuns` である。
        """
        if len(rows) != self.completed_runs:
            raise LabApiError(
                f"{name} の行数 {len(rows)} が completedRuns {self.completed_runs} と合わない"
            )
        for index, row in enumerate(rows):
            if len(row) != units:
                raise LabApiError(
                    f"{name}[{index}] の要素数 {len(row)} が味方ユニット数 {units} と合わない"
                    "（内側はリクエストの allyFormation.units と同じ順・同じ長さ）"
                )


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


def search_units(
    catalog: Catalog,
    *,
    query: str | None = None,
    category: str | None = None,
    owned_ids: Collection[str] | None = None,
) -> list[CatalogUnit]:
    """ユニットを絞り込む。結果はID昇順（表示も貼り付けも並びが安定する）。

    照合はID・表示名・キャラクター名の部分一致。同じキャラの別バリアントが多いため
    キャラクター名だけでは絞り切れず、逆にIDだけだと日本語から辿れない。
    """
    found = [
        unit
        for unit in catalog.units
        if (category is None or unit.category == category)
        and (owned_ids is None or unit.unit_definition_id in owned_ids)
        and (
            query is None
            or _matches(query, unit.unit_definition_id, unit.display_name, unit.character_name)
        )
    ]
    return sorted(found, key=lambda unit: unit.unit_definition_id)


def search_memories(catalog: Catalog, *, query: str | None = None) -> list[CatalogMemory]:
    found = [
        memory
        for memory in catalog.memories
        if query is None or _matches(query, memory.memory_definition_id, memory.display_name)
    ]
    return sorted(found, key=lambda memory: memory.memory_definition_id)


def _matches(query: str, *fields: str) -> bool:
    # IDは英大文字なので、日本語の表示名と同じ関数で扱えるよう小文字化して比べる。
    lowered = query.casefold()
    return any(lowered in field.casefold() for field in fields)


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
            errors.append(
                f"ally.memoryDefinitionIds: 未知のメモリー {memory_definition_id}"
                f"（`lab memories --grep {_search_hint(memory_definition_id)}` で探せる）"
            )
    return errors


def validate_pools_against_catalog(
    *,
    unit_pool: Collection[str],
    memory_pool: Collection[str],
    enemy_unit_definition_id: str,
    catalog: Catalog,
) -> list[str]:
    """探索設定の候補プールをカタログと突き合わせ、見つかった問題をすべて返す。

    編成の検証（`validate_against_catalog`）と分けているのは、探索の入力が確定した編成
    ではなく「どの範囲から探すか」だからである。プール1件の打ち間違いで数千試行を
    投げ終えてから気づく、という事態を避けるために実行前へ置く。
    """
    errors: list[str] = []
    for unit_definition_id in unit_pool:
        errors.extend(_unit_errors(unit_definition_id, "unitPool", PLAYABLE, catalog))
    errors.extend(_unit_errors(enemy_unit_definition_id, "enemy", EXERCISE_ENEMY, catalog))
    for memory_definition_id in memory_pool:
        if not catalog.has_memory(memory_definition_id):
            errors.append(
                f"memoryPool: 未知のメモリー {memory_definition_id}"
                f"（`lab memories --grep {_search_hint(memory_definition_id)}` で探せる）"
            )
    return errors


def unit_hints(catalog: Catalog, unit_pool: Collection[str]) -> list[CatalogUnit]:
    """候補プールに載っているユニットのカタログ情報。ヒューリスティック種の材料。"""
    return [unit for unit in catalog.units if unit.unit_definition_id in unit_pool]


def _search_hint(definition_id: str) -> str:
    """検索コマンドへ渡す当たり。IDの接頭辞（`UNIT_`/`MEM_`）を落とした先頭語を使う。

    打ち間違いの多くは末尾のバリアント名なので、先頭語で引くと目当ての行が出る。
    """
    without_prefix = definition_id.split("_", 1)[-1]
    return without_prefix.split("_")[0] or definition_id


def _unit_errors(
    unit_definition_id: str, side: str, required_category: str, catalog: Catalog
) -> list[str]:
    unit = catalog.unit(unit_definition_id)
    if unit is None:
        return [
            f"{side}: 未知のユニット {unit_definition_id}"
            f"（`lab units --grep {_search_hint(unit_definition_id)}` で探せる）"
        ]
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
