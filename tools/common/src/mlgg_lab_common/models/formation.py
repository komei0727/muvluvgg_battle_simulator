"""陣営に依存しない編成の値型と、`FormationRequest` へのAPI変換。

送信JSONは `docs/ddd/10_API設計.md`「FormationRequest」の写しである。APIは
`additionalProperties: false` なので、既定値と同値の項目は出力せずキー自体を落とす
（`apps/ui/src/features/formation/request-mapper.ts` と同じ規則）。

ユニットとメモリーは書いた順のまま送る。並べ替えると、同じ入力から作ったリクエストが
実装の都合で変わり得るうえ、送信順が結果へ影響した場合に利用者が順序を指定する手段が
無くなる。

味方・敵のどちらの編成にも同じ型を使う。どの戦闘形式で成立するか（演習の敵1体、
総力戦の1編成内重複禁止など）は各ラボが判定し、ここは `FormationRequest` そのものの
契約（R-FRM-01／02・強化指定の組み合わせ）だけを持つ。最終的な受理判定はAPIが行う。

単位: ここの値はすべてAPIへ送る単位で持つ（`module.*.ratio` は内部表現の小数、
`0.1` = 10%）。手持ちデータのパーセント表記からの変換は `inputs.player_data` が
取り込み時に1回だけ行い、この型へ入った後は変換しない。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

Row = Literal["FRONT", "REAR"]
Column = Annotated[int, Field(ge=0, le=2)]

GearStat = Literal[
    "MAXIMUM_HP",
    "ATTACK",
    "DEFENSE",
    "ACTION_SPEED",
    "CRITICAL_RATE",
    "CRITICAL_DAMAGE_BONUS",
    "AFFINITY_BONUS",
]
GearTier = Literal["II", "III"]
GearGrade = Literal["D", "C", "B", "A", "S"]

UNIT_TYPES: tuple[str, ...] = ("PHYSICAL", "ENERGY", "AGILE")
ATTRIBUTES: tuple[str, ...] = ("AGGRESSIVE", "SHY", "CUTE", "SMART", "COMICAL", "CLEVER")

# `10_API設計.md`「UnitEnhancementRequest」の `level` 省略時の値。
DEFAULT_UNIT_LEVEL = 200
# 同「rank」省略時の値（`LR+5`）。
DEFAULT_UNIT_RANK = 5
# `R-ENH-01`: 学園レベル省略時は全系統1（加算なし）。
DEFAULT_ACADEMY_LEVEL = 1
# `R-FRM-01`: 各編成は1〜5体、`R-FRM-04`: メモリーは最大6件。
MAX_FORMATION_UNITS = 5
MAX_MEMORIES = 6
MAX_GEARS = 9


class ConfigError(Exception):
    """編成の入力が契約から外れている。実行前に落とし、APIの422を待たない。"""


class Spec(BaseModel):
    # 未知キーは黙って無視せず落とす。綴り違いが既定動作へすり替わると、
    # 統計だけ見ても取り違えに気づけない。
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Position(Spec):
    column: Column
    row: Row


class Gear(Spec):
    stat: GearStat
    tier: GearTier
    grade: GearGrade


class AcademyLevels(Spec):
    unit_types: dict[str, int] = Field(default_factory=dict, alias="unitTypes")
    attributes: dict[str, int] = Field(default_factory=dict)


class ModuleStatOverride(Spec):
    """R-ENH-08: モジュール補正1ステータス分の上書き。値は`10_API設計.md`
    「ModuleStatOverrideRequest」と同じ単位（`ratio`は内部表現の小数）で書く。

    `FiniteFloat`: R-ENH-08は有限の実数だけを許可する。YAMLの`.inf`/`.nan`は
    PyYAMLがそのまま`float('inf')`等へ読むため、`float`のままでは通ってしまう。
    """

    fixed: FiniteFloat | None = None
    ratio: FiniteFloat | None = None


class ModuleOverride(Spec):
    """R-ENH-08: HP・攻撃力・防御力それぞれ独立に上書きできる。"""

    hp: ModuleStatOverride | None = None
    attack: ModuleStatOverride | None = None
    defense: ModuleStatOverride | None = None


class FormationUnitSpec(Spec):
    """編成の1枠（参加枠）。`None` は「未指定」であり、手持ちデータや既定値で埋める対象になる。"""

    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position
    level: int | None = Field(default=None, ge=1)
    rank: int | None = Field(default=None, ge=0, le=5)
    gears: list[Gear] | None = Field(default=None, max_length=MAX_GEARS)
    module: ModuleOverride | None = Field(default=None)


class FormationSpec(Spec):
    """1編成。ユニット・メモリーは書いた順のまま保持し、並べ替えない。

    `academy_levels` が `None` なのは「強化計算を使わない」、空の `AcademyLevels()` は
    「強化計算を使い、学園レベルは全系統1」であり、両者は別の意味を持つ。
    ユニット側も同じで、`gears=None` は未指定（手持ちデータで埋める対象）、
    `gears=[]` はギアなしの明示である。
    """

    units: list[FormationUnitSpec] = Field(min_length=1, max_length=MAX_FORMATION_UNITS)
    memory_definition_ids: list[str] = Field(
        default_factory=list, alias="memoryDefinitionIds", max_length=MAX_MEMORIES
    )
    academy_levels: AcademyLevels | None = Field(default=None, alias="academyLevels")

    @property
    def enhancement_enabled(self) -> bool:
        """陣営の `enhancement` を出力するか。

        `academyLevels` の有無を唯一の判定にする。ユニット側の `enhancement` は
        陣営側があるときだけ指定できる（`10_API設計.md`「FormationUnitRequest」）ため、
        両者の出力条件を別々に持つと片方だけ出て422になる組み合わせが作れてしまう。
        """
        return self.academy_levels is not None


def validate_formation(formation: FormationSpec, where: Path | str) -> None:
    """pydanticの宣言で表せない編成の受理条件（R-FRM-02の配置重複・強化指定の組み合わせ）。

    `where` はエラー文の位置（ファイルパスや `ally.formations[1]` のような入力内の位置）。
    """
    occupied: set[tuple[int, str]] = set()
    for unit in formation.units:
        key = (unit.position.column, unit.position.row)
        if key in occupied:
            raise ConfigError(
                f"{where}: 配置が重複している"
                f"（column={unit.position.column}, row={unit.position.row}）"
            )
        occupied.add(key)

    if formation.academy_levels is not None:
        _reject_unknown_academy_keys(formation.academy_levels, where)
        return
    for unit in formation.units:
        if (
            unit.level is not None
            or unit.rank is not None
            or unit.gears is not None
            or unit.module is not None
        ):
            raise ConfigError(
                f"{where}: academyLevels が無い編成のユニットへ"
                f" level / rank / gears / module は指定できない"
                f"（{unit.unit_definition_id}）。強化を使うなら academyLevels を書く"
            )


def build_formation_request(formation: FormationSpec) -> dict[str, Any]:
    """`FormationRequest` を組み立てる（味方・敵共通）。

    既定値と同値の項目を落とす判断をここへ集約する。呼び出し側ごとに規則を書き写すと、
    同じ編成から違う送信JSONが出て、結果を突き合わせられなくなる。
    """
    request: dict[str, Any] = {
        "units": [_unit_request(unit, formation.enhancement_enabled) for unit in formation.units],
        "memoryDefinitionIds": list(formation.memory_definition_ids),
    }
    if formation.academy_levels is not None:
        request["enhancement"] = {"academyLevels": _academy_levels(formation.academy_levels)}
    return request


def _unit_request(unit: FormationUnitSpec, enhancement_enabled: bool) -> dict[str, Any]:
    built: dict[str, Any] = {
        "unitDefinitionId": unit.unit_definition_id,
        "position": unit.position.model_dump(),
    }
    if not enhancement_enabled:
        return built
    level = DEFAULT_UNIT_LEVEL if unit.level is None else unit.level
    rank = DEFAULT_UNIT_RANK if unit.rank is None else unit.rank
    gears = [] if unit.gears is None else [gear.model_dump() for gear in unit.gears]
    module = _module_override(unit.module)
    # 既定と同値の強化はキーごと落とす。APIの省略時既定と同じ意味であり、
    # 出力すると送信JSONがUIの生成物と無用に食い違う。R-ENH-08: モジュール上書きが
    # 1件でもあれば、他が既定のままでも`enhancement`を出す。
    if level == DEFAULT_UNIT_LEVEL and rank == DEFAULT_UNIT_RANK and not gears and module is None:
        return built
    enhancement: dict[str, Any] = {"level": level, "gears": gears}
    if rank != DEFAULT_UNIT_RANK:
        enhancement["rank"] = rank
    if module is not None:
        enhancement["module"] = module
    built["enhancement"] = enhancement
    return built


def _module_stat_override(stat: ModuleStatOverride | None) -> dict[str, float] | None:
    if stat is None:
        return None
    built: dict[str, float] = {}
    if stat.fixed is not None:
        built["fixed"] = stat.fixed
    if stat.ratio is not None:
        built["ratio"] = stat.ratio
    return built or None


def _module_override(module: ModuleOverride | None) -> dict[str, dict[str, float]] | None:
    """R-ENH-08: 上書きが無いステータス・項目はキーごと省略する
    （`request-mapper.ts` の `buildModuleOverride`/`buildModuleStatOverride` と同じ規則）。"""
    if module is None:
        return None
    built: dict[str, dict[str, float]] = {}
    for stat_name, stat in (
        ("hp", module.hp),
        ("attack", module.attack),
        ("defense", module.defense),
    ):
        stat_built = _module_stat_override(stat)
        if stat_built is not None:
            built[stat_name] = stat_built
    return built or None


def _academy_levels(levels: AcademyLevels) -> dict[str, dict[str, int]]:
    """9キーをすべて出力する（未指定は1）。省略キーの既定はAPIと同じだが、
    再現条件を送信JSONだけで読み取れるようにするため明示する。"""
    return {
        "unitTypes": {key: levels.unit_types.get(key, DEFAULT_ACADEMY_LEVEL) for key in UNIT_TYPES},
        "attributes": {
            key: levels.attributes.get(key, DEFAULT_ACADEMY_LEVEL) for key in ATTRIBUTES
        },
    }


def _reject_unknown_academy_keys(levels: AcademyLevels, where: Path | str) -> None:
    for group, values, known in (
        ("unitTypes", levels.unit_types, UNIT_TYPES),
        ("attributes", levels.attributes, ATTRIBUTES),
    ):
        unknown = sorted(set(values) - set(known))
        if unknown:
            raise ConfigError(
                f"{where}: academyLevels.{group} に未知のキーがある: {', '.join(unknown)}"
            )
