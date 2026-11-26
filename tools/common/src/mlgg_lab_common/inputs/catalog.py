"""Catalog（`GET /api/v1/battle-simulation-catalog`）の取得と検索。

相手はローカルのdevサーバー（`apps/api/` で `mise run dev`）を既定にする。Catalogは
公開APIなので `--base-url` で他の配備も指せる。
"""

from __future__ import annotations

from collections.abc import Collection
from types import TracebackType
from typing import Any, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..models.formation import FormationSpec, GearGrade, GearStat, GearTier

CATALOG_PATH = "/api/v1/battle-simulation-catalog"

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_TIMEOUT_SECONDS = 30.0

# `R-TEX-11`: ユニット定義のカテゴリ。どの形式でどちらを使えるか（演習の敵は
# `EXERCISE_ENEMY`、それ以外はすべて `PLAYABLE`）は各ラボが決める。
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
    # 表示・検索・補完の説明にだけ使う。API契約上は必須だが、欠けても入力の解決は
    # 成立するので既定値を持たせる（応答の加算的変更に寛容にする方針と揃える）。
    character_name: str = Field(default="", alias="characterName")
    role: str = ""
    position_aptitudes: list[str] = Field(default_factory=list, alias="positionAptitudes")
    attribute: str = ""
    unit_type: str = Field(default="", alias="unitType")


class CatalogMemory(_Response):
    memory_definition_id: str = Field(alias="memoryDefinitionId")
    display_name: str = Field(alias="displayName")


class CatalogGearEffectValue(_Response):
    tier: GearTier
    grade: GearGrade
    # `R-ENH-04` #3 の表の値をパーセントポイントのまま受ける。内部表現（`/100`）へは
    # 直さない——換算規則の正本はTypeScript側にあり、ここで二重に持たない。
    percentage_points: float = Field(alias="percentagePoints")


class CatalogGearEffect(_Response):
    stat: GearStat
    application: str = ""
    values: list[CatalogGearEffectValue] = Field(default_factory=list)


class Catalog(_Response):
    catalog_revision: str = Field(alias="catalogRevision")
    units: list[CatalogUnit]
    memories: list[CatalogMemory]
    # ギア効果表（`R-ENH-04` #3）。応答へ後から加わった項目なので、欠けても他の
    # コマンドが止まらないよう既定を空にする。
    gear_effects: list[CatalogGearEffect] = Field(default_factory=list, alias="gearEffects")

    def unit(self, unit_definition_id: str) -> CatalogUnit | None:
        return next(
            (unit for unit in self.units if unit.unit_definition_id == unit_definition_id), None
        )

    def has_memory(self, memory_definition_id: str) -> bool:
        return any(memory.memory_definition_id == memory_definition_id for memory in self.memories)


class CatalogClient:
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
        try:
            response = self._client.get(CATALOG_PATH)
        except httpx.RequestError as error:
            raise LabApiError(
                f"APIへ到達できない: {error}. "
                "`mise run dev`（apps/api/）でdevサーバーを起動しているか、--base-url を確認する"
            ) from error
        if response.status_code != httpx.codes.OK:
            raise LabApiError(_error_message(response))
        try:
            return Catalog.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise LabApiError(f"APIの応答が契約と合わない: {error}") from error


def _error_message(response: httpx.Response) -> str:
    error = _error_object(response)
    code = error.get("code", "UNKNOWN")
    message = error.get("message", response.text)
    lines = [f"{response.status_code} {code}: {message}"]
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


def search_hint(definition_id: str) -> str:
    """検索コマンドへ渡す当たり。IDの接頭辞（`UNIT_`/`MEM_`）を落とした先頭語を使う。

    打ち間違いの多くは末尾のバリアント名なので、先頭語で引くと目当ての行が出る。
    """
    without_prefix = definition_id.split("_", 1)[-1]
    return without_prefix.split("_")[0] or definition_id


# 検索コマンドの案内に使うCLI。IDを引く入口は今のところ exercise-lab だけにある。
SEARCH_COMMAND = "exercise-lab"


def unit_errors(
    unit_definition_id: str,
    where: str,
    required_category: str,
    catalog: Catalog,
    *,
    rule: str,
) -> list[str]:
    """未知ID・編成プール違反を、検索コマンドの当たり付きで返す。

    `rule` は編成プール違反の根拠（`R-TEX-11 #1` 等）。形式ごとに項番が違うため
    呼び出し側が渡す。
    """
    unit = catalog.unit(unit_definition_id)
    if unit is None:
        return [
            f"{where}: 未知のユニット {unit_definition_id}"
            f"（`{SEARCH_COMMAND} units --grep {search_hint(unit_definition_id)}` で探せる）"
        ]
    if unit.category != required_category:
        return [
            f"{where}: {unit_definition_id} は category={unit.category} であり "
            f"{required_category} ではない（{rule}）"
        ]
    return []


def memory_errors(
    memory_definition_ids: Collection[str], where: str, catalog: Catalog
) -> list[str]:
    return [
        f"{where}: 未知のメモリー {memory_definition_id}"
        f"（`{SEARCH_COMMAND} memories --grep {search_hint(memory_definition_id)}` で探せる）"
        for memory_definition_id in memory_definition_ids
        if not catalog.has_memory(memory_definition_id)
    ]


def formation_reference_errors(
    formation: FormationSpec,
    where: str,
    catalog: Catalog,
    *,
    required_category: str,
    rule: str,
) -> list[str]:
    """1編成のユニット・メモリーの参照をCatalogと突き合わせ、問題をすべて返す。

    最初の1件で止めない。IDの打ち間違いが複数あるときに1件ずつ往復させると、
    devサーバー起動込みの試行錯誤が長くなる。ここは事前検証であり、最終的な
    受理判定はAPIが行う。
    """
    errors: list[str] = []
    for index, unit in enumerate(formation.units):
        errors.extend(
            unit_errors(
                unit.unit_definition_id,
                f"{where}.units[{index}]",
                required_category,
                catalog,
                rule=rule,
            )
        )
    errors.extend(
        memory_errors(formation.memory_definition_ids, f"{where}.memoryDefinitionIds", catalog)
    )
    return errors
