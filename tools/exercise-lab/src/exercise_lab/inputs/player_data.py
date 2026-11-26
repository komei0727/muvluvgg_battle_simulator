"""ブラウザに溜まった育成状態（localStorage `mlgg:player-data`）の取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `StoredPlayerData` を
そのまま写す。UIが同じキーへ書き続ける限り、編成へレベル・ギアを書き写さずに
実際の手持ちで評価できる。

明示した編成の値が常に優先する。手持ちデータは「書かなかった項目の既定値」であり、
明示した値を上書きすると、編成を読んでも何を評価したのか分からなくなる。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import Field, FiniteFloat, StrictInt, ValidationError

from .models import (
    DEFAULT_UNIT_LEVEL,
    DEFAULT_UNIT_RANK,
    MAX_GEARS,
    AcademyLevels,
    AllySpec,
    AllyUnitSpec,
    Gear,
    ModuleOverride,
    ModuleStatOverride,
    Spec,
)

# `persistence.ts` の `PERSISTENCE_SCHEMA_VERSION`。異なる版は読み替えず落とす。
SUPPORTED_SCHEMA_VERSION = 1


class PlayerDataError(Exception):
    """手持ちデータが契約から外れている。"""


class StoredLevelLink(Spec):
    """陣営のレベルリンク（`docs/ui-design/01_UI要求・画面設計.md` §5.6）。

    UI側の入力は `number | ""` だが、未入力（`""`）は書き戻しで前回値へ畳まれ
    保存データには残らない。`StoredUnitEnhancement.level` と同じ前提に立つ。
    """

    enabled: bool
    level: int


class StoredModuleStatOverride(Spec):
    """R-ENH-08: モジュール補正1ステータス分の手持ちデータ表現。

    `persistence.ts` の `ModuleStatOverrideInput` と同じ形——`fixed`/`ratio`は
    未上書きを`""`で表す（キー省略ではない）。`ratio`はUI表示のパーセント単位
    （例: `10` = 10%）で保存され、APIの内部表現の小数への変換は
    `resolved_module` が行う（`request-mapper.ts` の `buildModuleStatOverride` と同じ）。

    `FiniteFloat`: R-ENH-08は有限の実数だけを許可する。`json`は`Infinity`/`NaN`を
    非標準拡張として読めてしまうため、`float`のままでは通ってしまう
    （`models.ModuleStatOverride` と同じ理由）。
    """

    fixed: FiniteFloat | Literal[""] = ""
    ratio: FiniteFloat | Literal[""] = ""


class StoredModuleOverride(Spec):
    # `module`導入前のエクスポートには無いため、`link_excluded`/`rank`と同じく
    # 全項目`""`（上書きなし）を既定にする。
    hp: StoredModuleStatOverride = Field(default_factory=StoredModuleStatOverride)
    attack: StoredModuleStatOverride = Field(default_factory=StoredModuleStatOverride)
    defense: StoredModuleStatOverride = Field(default_factory=StoredModuleStatOverride)


class StoredUnitEnhancement(Spec):
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
    # module導入前のエクスポートを取り直させないため既定値付き（`rank`と同じ扱い）。
    module: StoredModuleOverride = Field(default_factory=StoredModuleOverride)


class PlayerData(Spec):
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
    レベルで評価すると、UIと結論が割れる）。

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


def _resolved_module_stat(stat: StoredModuleStatOverride) -> ModuleStatOverride | None:
    fixed = None if stat.fixed == "" else stat.fixed
    ratio = None if stat.ratio == "" else stat.ratio / 100
    if fixed is None and ratio is None:
        return None
    return ModuleStatOverride(fixed=fixed, ratio=ratio)


def resolved_module(stored: StoredUnitEnhancement | None) -> ModuleOverride | None:
    """R-ENH-08: 手持ちのモジュール補正上書きをAPI形式（`ratio`は内部表現の小数）へ変換する。

    1項目も上書きしていなければ`None`を返す——編成で`module`を書かなかったのと
    同じ扱いにし、呼び出し側が「書かなかった項目だけ埋める」規約をそのまま適用できる
    ようにする。
    """
    if stored is None:
        return None
    hp = _resolved_module_stat(stored.module.hp)
    attack = _resolved_module_stat(stored.module.attack)
    defense = _resolved_module_stat(stored.module.defense)
    if hp is None and attack is None and defense is None:
        return None
    return ModuleOverride(hp=hp, attack=attack, defense=defense)


def load_player_data(path: Path) -> PlayerData:
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
        return PlayerData.model_validate(raw)
    except ValidationError as error:
        raise PlayerDataError(f"{path}: {error}") from error


def apply_player_data(ally: AllySpec, data: PlayerData) -> tuple[AllySpec, list[str]]:
    """手持ちデータを味方編成へ適用し、適用後の編成と警告一覧を返す。

    枠ごとに解決する。同じユニットを2枠へ置いた編成でも、片方の枠へ明示した値が
    もう片方へ移ることはない（手持ちデータ側の記録はIDで引くので、未指定の項目には
    同じ値が入る）。

    警告は握り潰さず呼び出し側へ返す。手持ちに無いユニットはギアなしで評価されるため、
    黙って進むと「育成済みのつもりの編成」の結果が出てしまう。
    """
    warnings: list[str] = []
    units = [_apply_unit(unit, data, warnings) for unit in ally.units]
    applied = ally.model_copy(
        update={
            "units": units,
            # 明示した学園レベルが常に優先する。手持ちは書かなかったときだけ効く。
            "academy_levels": ally.academy_levels or data.academy_levels,
        }
    )
    return applied, warnings


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
    if unit.module is None:
        module = resolved_module(stored)
        if module is not None:
            update["module"] = module
    return unit.model_copy(update=update) if update else unit
