"""ブラウザに溜まった育成状態（localStorage `mlgg:player-data`）の取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `StoredPlayerData` を
そのまま写す。UIが同じキーへ書き続ける限り、編成YAMLへレベル・ギアを書き写さずに
実際の手持ちで評価できる。

YAMLに書かれた値が常に優先する。手持ちデータは「書かなかった項目の既定値」であり、
明示した値を上書きすると、YAMLを読んでも何を評価したのか分からなくなる。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import Field, StrictInt, ValidationError

from .models import (
    DEFAULT_UNIT_LEVEL,
    DEFAULT_UNIT_RANK,
    MAX_GEARS,
    AcademyLevels,
    AllyUnitSpec,
    FormationConfig,
    Gear,
    _Spec,
)

# `persistence.ts` の `PERSISTENCE_SCHEMA_VERSION`。異なる版は読み替えず落とす。
SUPPORTED_SCHEMA_VERSION = 1


class PlayerDataError(Exception):
    """手持ちデータが契約から外れている。"""


class StoredLevelLink(_Spec):
    """陣営のレベルリンク（`docs/ui-design/01_UI要求・画面設計.md` §5.6）。

    UI側の入力は `number | ""` だが、未入力（`""`）は書き戻しで前回値へ畳まれ
    保存データには残らない。`StoredUnitEnhancement.level` と同じ前提に立つ。
    """

    enabled: bool
    level: int


class StoredUnitEnhancement(_Spec):
    level: int
    # 陣営のレベルリンクから外した枠。リンク導入前のエクスポートには無い。
    link_excluded: bool = Field(default=False, alias="linkExcluded")
    # ランク導入前のエクスポートを取り直させないため既定値付き（`link_excluded` と同じ扱い）。
    # 値域は `AllyUnitSpec.rank` と同じ0〜5（`10_API設計.md`「UnitEnhancementRequest」）。
    # ここで弾かないと、範囲外の値がそのまま評価リクエストへ載りAPIの422で初めて気づく。
    # `StrictInt`: bool・float・数値文字列への標準変換を止める。`true` や `"3"` を
    # 3・整数と黙って同一視すると、書き間違いに気づけなくなる。
    rank: StrictInt = Field(default=DEFAULT_UNIT_RANK, ge=0, le=5)
    # 枠は9固定で、空枠はJSON上 `null` として並ぶ。
    gears: list[Gear | None]


class PlayerData(_Spec):
    schema_version: int = Field(alias="schemaVersion")
    academy_levels: AcademyLevels = Field(alias="academyLevels")
    # リンク導入前のエクスポートを取り直させないため任意項目とする。UI側も同じ理由で
    # `PERSISTENCE_SCHEMA_VERSION` を上げない。
    level_link: StoredLevelLink | None = Field(default=None, alias="levelLink")
    units: dict[str, StoredUnitEnhancement]


def resolved_level(stored: StoredUnitEnhancement | None, data: PlayerData) -> int:
    """リンクを解いた実効レベル。

    `apps/ui/src/features/formation/level-link.ts` の `resolveSlotLevel`
    （設計は `docs/ui-design/03_API・データ連携設計.md` §3.1）と同じ規則。
    リンクONの枠はリンクレベル、除外した枠は個別レベルを使う。リンクレベルが1以上の
    整数でないときは、UI側と同じく個別レベルへフォールバックする（片方だけが別の
    レベルで評価すると、探索結果が誤った前提に立つ）。

    手持ちデータに記録が無いユニット（`stored is None`）もリンク対象とする
    （`UI-API-024`）。UI側の書き戻しは直近に編集した枠だけなので、「置いただけで
    一度も強化入力を開いていないユニット」には記録が付かない。それはレベルリンクが
    狙っている母集団そのものであり、既定200で評価するとUIと結論が割れる。
    """
    link = data.level_link
    excluded = stored is not None and stored.link_excluded
    if link is not None and link.enabled and link.level >= 1 and not excluded:
        return link.level
    return DEFAULT_UNIT_LEVEL if stored is None else stored.level


def resolved_rank(stored: StoredUnitEnhancement | None) -> int:
    """実効ランク。レベルと違いリンクの仕組みを持たないため、手持ちの値をそのまま使う。"""
    return DEFAULT_UNIT_RANK if stored is None else stored.rank


def read_player_data_document(path: Path) -> dict[str, Any]:
    """検証したうえで**生のJSONのまま**返す。書き戻しはこれへ重ねる。

    模型（`PlayerData`）へ通してから組み直すと、このツールが読まない項目が書き戻しで
    落ちる。書き戻すのは編成に居る5体のギアだけであり、それ以外は入力の写しでよい。
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise PlayerDataError(f"{path}: JSONとして読めない: {error}") from error
    if not isinstance(raw, dict):
        raise PlayerDataError(f"{path}: トップレベルはオブジェクトでなければならない")
    version = raw.get("schemaVersion")
    if version != SUPPORTED_SCHEMA_VERSION:
        raise PlayerDataError(
            f"{path}: 未対応の schemaVersion={version!r}"
            f"（このツールは {SUPPORTED_SCHEMA_VERSION} だけを読む）"
        )
    try:
        PlayerData.model_validate(raw)
    except ValidationError as error:
        raise PlayerDataError(f"{path}: {error}") from error
    return raw


def load_player_data(path: Path) -> PlayerData:
    return PlayerData.model_validate(read_player_data_document(path))


def overlaid_player_data(
    document: Mapping[str, Any],
    data: PlayerData,
    allocations: Sequence[tuple[str, Sequence[Gear]]],
) -> tuple[dict[str, Any], list[str]]:
    """入力の手持ちデータへ、編成に居るユニットのギアだけを重ねた文書を返す。

    **ゼロから組み立てない。** このコマンドが知っているのは編成5体のギアだけであり、
    レベル・学園レベル・レベルリンク・編成外のユニットの記録は入力のものをそのまま
    引き継ぐ。組み直すとそれらが失われ、次の編成探索が別の育成状態で走る。

    記録の無いユニットには、**実際に評価に使ったレベル**（`resolved_level`）で記録を
    作る。既定200と書くと、リンクで別のレベルを評価していた場合に書き戻した瞬間から
    前提が変わる。

    同じユニットを2枠へ置いた編成は枠ごとのギアを持てない（記録はIDで引く）。最初の枠の
    ぶんだけを書き、落とした枠を警告に残す。
    """
    written = copy.deepcopy(dict(document))
    units = dict(written.get("units") or {})
    warnings: list[str] = []
    seen: set[str] = set()
    for unit_definition_id, gears in allocations:
        if unit_definition_id in seen:
            warnings.append(
                f"{unit_definition_id} は編成に2枠あるが、手持ちデータはユニットIDで引くため"
                "枠ごとのギアを持てない。最初の枠のぶんだけを書き戻した"
            )
            continue
        seen.add(unit_definition_id)
        stored = units.get(unit_definition_id)
        if stored is None:
            level = resolved_level(None, data)
            warnings.append(
                f"{unit_definition_id} は手持ちデータに記録が無かったため、"
                f"評価に使ったレベル{level}で新しい記録を作った"
            )
            units[unit_definition_id] = {"level": level, "gears": _gear_slots(gears)}
            continue
        units[unit_definition_id] = {**stored, "gears": _gear_slots(gears)}
    written["units"] = units
    return written, warnings


def _gear_slots(gears: Sequence[Gear]) -> list[dict[str, str] | None]:
    """9枠ぶんの並び。空枠は `null` で埋める（`persistence.ts` と同じ形）。"""
    slots: list[dict[str, str] | None] = [gear.model_dump() for gear in gears]
    slots.extend([None] * (MAX_GEARS - len(slots)))
    return slots


def apply_player_data(
    config: FormationConfig, data: PlayerData
) -> tuple[FormationConfig, list[str]]:
    """手持ちデータを編成へ適用し、適用後の編成と警告一覧を返す。

    警告は握り潰さず呼び出し側へ返す。手持ちに無いユニットはレベル200・ギアなしで
    評価されるため、黙って進むと「育成済みのつもりの編成」の統計が出てしまう。
    """
    warnings: list[str] = []
    units = [_apply_unit(unit, data, warnings) for unit in config.ally.units]
    ally = config.ally.model_copy(
        update={
            "units": units,
            "academy_levels": config.ally.academy_levels or data.academy_levels,
        }
    )
    return config.model_copy(update={"ally": ally}), warnings


def _apply_unit(unit: AllyUnitSpec, data: PlayerData, warnings: list[str]) -> AllyUnitSpec:
    stored = data.units.get(unit.unit_definition_id)
    level = resolved_level(stored, data)
    rank = resolved_rank(stored)
    if stored is None:
        # ギアが無いことは実際の欠落なので警告は残す。レベルはリンクで決まり得るため
        # 200と断定せず、実際に評価する値を書く。
        warnings.append(
            f"{unit.unit_definition_id} は手持ちデータに無い"
            f"（レベル{level}・ギアなしとして評価する）"
        )
    elif len(stored.gears) > MAX_GEARS:
        raise PlayerDataError(
            f"{unit.unit_definition_id}: ギア枠が{MAX_GEARS}件を超えている（{len(stored.gears)}件）"
        )
    update = {}
    if unit.level is None:
        update["level"] = level
    if unit.rank is None:
        update["rank"] = rank
    if unit.gears is None and stored is not None:
        # 空枠を除いた枠順のまま送る（`request-mapper.ts` の `buildUnitEnhancement` と同じ）。
        update["gears"] = [gear for gear in stored.gears if gear is not None]
    return unit.model_copy(update=update) if update else unit
