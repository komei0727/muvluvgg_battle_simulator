"""編成YAMLの読み込みと、一括評価リクエストJSONへの変換。

送信JSONは `docs/ddd/10_API設計.md`「FormationRequest」「TacticalExerciseEvaluationRequest」
の写しである。APIは `additionalProperties: false` なので、既定値と同値の項目は
出力せずキー自体を落とす（`apps/ui/src/features/formation/request-mapper.ts` と同じ規則）。

ユニットとメモリーはYAMLに書いた順のまま送る。並べ替えると、同じYAMLから作った
リクエストが実装の都合で変わり得るうえ、送信順が結果へ影響した場合に利用者が
順序を指定する手段が無くなる。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

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
# `R-TEX-01` #2: 味方は1〜5体、メモリーは最大6件。
MAX_ALLY_UNITS = 5
MAX_MEMORIES = 6
MAX_GEARS = 9


class ConfigError(Exception):
    """編成YAMLが契約から外れている。実行前に落とし、APIの422を待たない。"""


class _Spec(BaseModel):
    # 未知キーは黙って無視せず落とす。綴り違いが既定動作へすり替わると、
    # 統計だけ見ても取り違えに気づけない。
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Position(_Spec):
    column: Column
    row: Row


class Gear(_Spec):
    stat: GearStat
    tier: GearTier
    grade: GearGrade


class AcademyLevels(_Spec):
    unit_types: dict[str, int] = Field(default_factory=dict, alias="unitTypes")
    attributes: dict[str, int] = Field(default_factory=dict)


class AllyUnitSpec(_Spec):
    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position
    level: int | None = Field(default=None, ge=1)
    rank: int | None = Field(default=None, ge=0, le=5)
    gears: list[Gear] | None = Field(default=None, max_length=MAX_GEARS)


class AllySpec(_Spec):
    units: list[AllyUnitSpec] = Field(min_length=1, max_length=MAX_ALLY_UNITS)
    memory_definition_ids: list[str] = Field(
        default_factory=list, alias="memoryDefinitionIds", max_length=MAX_MEMORIES
    )
    academy_levels: AcademyLevels | None = Field(default=None, alias="academyLevels")


class EnemySpec(_Spec):
    """`R-TEX-01` #3: 敵はちょうど1体でメモリーを持たない。強化も指定できない。"""

    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position


class FormationConfig(_Spec):
    ally: AllySpec
    enemy: EnemySpec

    @property
    def enhancement_enabled(self) -> bool:
        """陣営の `enhancement` を出力するか。

        `academyLevels` の有無を唯一の判定にする。ユニット側の `enhancement` は
        陣営側があるときだけ指定できる（`10_API設計.md`「FormationUnitRequest」）ため、
        両者の出力条件を別々に持つと片方だけ出て422になる組み合わせが作れてしまう。
        """
        return self.ally.academy_levels is not None


def load_formation_config(path: Path) -> FormationConfig:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: トップレベルはマッピングでなければならない")
    try:
        config = FormationConfig.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    _validate(config, path)
    return config


def _validate(config: FormationConfig, path: Path) -> None:
    occupied: set[tuple[int, str]] = set()
    for unit in config.ally.units:
        key = (unit.position.column, unit.position.row)
        if key in occupied:
            raise ConfigError(
                f"{path}: 味方の配置が重複している"
                f"（column={unit.position.column}, row={unit.position.row}）"
            )
        occupied.add(key)

    if config.ally.academy_levels is not None:
        _reject_unknown_academy_keys(config.ally.academy_levels, path)
        return
    for unit in config.ally.units:
        if unit.level is not None or unit.rank is not None or unit.gears is not None:
            raise ConfigError(
                f"{path}: ally.academyLevels が無いユニットへ level / rank / gears は指定できない"
                f"（{unit.unit_definition_id}）。強化を使うなら ally.academyLevels を書く"
            )


def build_evaluation_request(
    config: FormationConfig,
    *,
    runs_per_candidate: int,
    seed: str,
) -> dict[str, Any]:
    """`TacticalExerciseEvaluationRequest` の本文を組み立てる。候補は常に1件。"""
    return {
        "enemyFormation": build_enemy_formation(config.enemy),
        "candidates": [{"allyFormation": build_ally_formation(config)}],
        "runsPerCandidate": runs_per_candidate,
        "seed": seed,
    }


def build_enemy_formation(enemy: EnemySpec) -> dict[str, Any]:
    return {
        "units": [
            {
                "unitDefinitionId": enemy.unit_definition_id,
                "position": enemy.position.model_dump(),
            }
        ],
        "memoryDefinitionIds": [],
    }


def build_ally_formation(config: FormationConfig) -> dict[str, Any]:
    """`FormationRequest`（味方）を組み立てる。

    複数候補を1リクエストへ載せる一括評価（`optimize/`）も同じ規則で組む必要があるため
    公開している。既定値と同値の項目を落とす判断をここへ集約しないと、候補ごとに
    送信JSONが揺れて `lab stats` の結果と突き合わせられなくなる。
    """
    formation: dict[str, Any] = {
        "units": [_ally_unit(unit, config.enhancement_enabled) for unit in config.ally.units],
        "memoryDefinitionIds": list(config.ally.memory_definition_ids),
    }
    academy_levels = config.ally.academy_levels
    if academy_levels is not None:
        formation["enhancement"] = {"academyLevels": _academy_levels(academy_levels)}
    return formation


def _ally_unit(unit: AllyUnitSpec, enhancement_enabled: bool) -> dict[str, Any]:
    built: dict[str, Any] = {
        "unitDefinitionId": unit.unit_definition_id,
        "position": unit.position.model_dump(),
    }
    if not enhancement_enabled:
        return built
    level = DEFAULT_UNIT_LEVEL if unit.level is None else unit.level
    rank = DEFAULT_UNIT_RANK if unit.rank is None else unit.rank
    gears = [] if unit.gears is None else [gear.model_dump() for gear in unit.gears]
    # 既定と同値の強化はキーごと落とす。APIの省略時既定と同じ意味であり、
    # 出力すると送信JSONがUIの生成物と無用に食い違う。
    if level == DEFAULT_UNIT_LEVEL and rank == DEFAULT_UNIT_RANK and not gears:
        return built
    enhancement: dict[str, Any] = {"level": level, "gears": gears}
    if rank != DEFAULT_UNIT_RANK:
        enhancement["rank"] = rank
    built["enhancement"] = enhancement
    return built


def _academy_levels(levels: AcademyLevels) -> dict[str, dict[str, int]]:
    """9キーをすべて出力する（未指定は1）。省略キーの既定はAPIと同じだが、
    レポートの再現条件を送信JSONだけで読み取れるようにするため明示する。"""
    return {
        "unitTypes": {key: levels.unit_types.get(key, DEFAULT_ACADEMY_LEVEL) for key in UNIT_TYPES},
        "attributes": {
            key: levels.attributes.get(key, DEFAULT_ACADEMY_LEVEL) for key in ATTRIBUTES
        },
    }


def _reject_unknown_academy_keys(levels: AcademyLevels, path: Path) -> None:
    for group, values, known in (
        ("unitTypes", levels.unit_types, UNIT_TYPES),
        ("attributes", levels.attributes, ATTRIBUTES),
    ):
        unknown = sorted(set(values) - set(known))
        if unknown:
            raise ConfigError(
                f"{path}: academyLevels.{group} に未知のキーがある: {', '.join(unknown)}"
            )


class _FlowMapping(dict[str, object]):
    """1行（flow style）で書き出すマッピング。座標のような短い値を縦に展開しない。"""


def _represent_flow_mapping(dumper: yaml.SafeDumper, data: _FlowMapping) -> yaml.Node:
    return dumper.represent_mapping("tag:yaml.org,2002:map", data, flow_style=True)


yaml.SafeDumper.add_representer(_FlowMapping, _represent_flow_mapping)


def dump_formation_config(config: FormationConfig) -> str:
    """編成YAMLを書き出す。`load_formation_config` が読み戻せる形だけを出す。

    強化情報（`academyLevels` / `level` / `gears`）は出力しない。育成状態の正本は
    `--player-data` であり、YAMLへ焼くと同じ値が2か所に生まれる。
    """
    document = {
        "ally": {
            "units": [
                {
                    "unitDefinitionId": unit.unit_definition_id,
                    "position": _FlowMapping(column=unit.position.column, row=unit.position.row),
                }
                for unit in config.ally.units
            ],
            "memoryDefinitionIds": list(config.ally.memory_definition_ids),
        },
        "enemy": {
            "unitDefinitionId": config.enemy.unit_definition_id,
            "position": _FlowMapping(
                column=config.enemy.position.column, row=config.enemy.position.row
            ),
        },
    }
    return yaml.dump(
        document,
        Dumper=yaml.SafeDumper,
        # キー順は上の辞書のまま（アルファベット順に崩さない）。日本語IDは無いが、
        # 将来入っても読める形にしておく。
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    )
