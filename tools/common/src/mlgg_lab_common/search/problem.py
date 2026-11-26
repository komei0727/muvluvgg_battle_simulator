"""探索問題（固定相手に対する味方編成の探索）の定義。

探索問題は「何を固定し、味方の何を・どの範囲で動かし、どの条件で評価するか」を自己完結で
持つ。作成時に入力（編成YAML・育成JSON）を解決して写し取り、実行途中で元ファイルを読み直さない。

- 固定条件 `fixed`: 形式別（相手編成・規定ターン数・演習対象）
- 味方の育成 `training`: 学園レベルとユニットごとのレベル・ランク・ギア・モジュール
- 探索範囲 `space`: 使用可能プール・配置・人数・固定指定
- ギア条件 `gear`: 固定／調整あり・変更可能範囲・資源制約
- 起点編成 `starts`: 解決済みの候補（複数可）
- 実行条件 `execution`: 探索全体の予算・候補生成用と戦闘用のseed・接続先
- 接続情報 `method`: 手法の部品の識別子・版・手法の設定

固定条件は形式ごとに型が違うので、共通モデルはJSONのまま持ち、解釈は各ラボのアダプター
（`search.adapter.FormatSearchAdapter`）が行う。候補（`search.candidate.Candidate`）は
味方側だけを持つので、候補操作で相手条件を変える経路は構造上ない。

目的関数・探索アルゴリズムに依存する設定は共通の項目にしない。手法の設定は
`method.settings` に不透明なJSONとして記録するだけで、共通基盤は解釈しない。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, NonNegativeInt, field_validator

from ..evaluation.models import Budget, ExecutionSettings
from ..models.formation import (
    MAX_FORMATION_UNITS,
    MAX_GEARS,
    MAX_MEMORIES,
    AcademyLevels,
    Gear,
    GearGrade,
    GearStat,
    GearTier,
    ModuleOverride,
    Position,
    Spec,
)
from ..models.resolved import InputProvenance
from .candidate import Candidate

# 探索問題の保存形式。探索DBの保存形式（`experiments.search_store`）とは別に数える。
SEARCH_PROBLEM_FORMAT_VERSION = 1

# 固定相手の探索を扱う形式。総力戦は対象外（編成列・出撃順を持つため別の問題になる）。
SearchFormat = Literal["BATTLE", "TACTICAL_EXERCISE"]
GearMode = Literal["FIXED", "ADJUSTABLE"]


class SearchProblemError(ValueError):
    """探索問題として成立しない。見つかった問題をすべて持つ。"""

    def __init__(self, problems: list[str]) -> None:
        self.problems = list(problems)
        super().__init__("探索問題を作れない:\n" + "\n".join(f"  - {p}" for p in self.problems))


class UnitTraining(Spec):
    """1ユニット定義の育成条件。`None` はAPIの既定値（レベル200・LR+5・ギアなし）。

    ユニットIDで引くので、入れ替えで枠へ入ったユニットにも同じ値が当たる（枠ではなく
    ユニット定義に付く）。
    """

    level: int | None = Field(default=None, ge=1)
    rank: int | None = Field(default=None, ge=0, le=5)
    gears: list[Gear] | None = Field(default=None, max_length=MAX_GEARS)
    module: ModuleOverride | None = None

    @property
    def is_specified(self) -> bool:
        return any(v is not None for v in (self.level, self.rank, self.gears, self.module))


class AllyTraining(Spec):
    """味方の育成条件。`academy_levels=None` は強化計算を使わない（`FormationSpec` と同じ意味）。"""

    academy_levels: AcademyLevels | None = Field(default=None, alias="academyLevels")
    units: dict[str, UnitTraining] = Field(default_factory=dict)

    def for_unit(self, unit_definition_id: str) -> UnitTraining:
        return self.units.get(unit_definition_id, UnitTraining())


class FixedUnit(Spec):
    """必ず編成へ入れるユニット。`position` を書くとその配置に固定する。"""

    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position | None = None


class FixedMemory(Spec):
    """必ず編成へ入れるメモリー。`index` を書くとメモリー列のその位置に固定する。"""

    memory_definition_id: str = Field(alias="memoryDefinitionId", min_length=1)
    index: int | None = Field(default=None, ge=0, lt=MAX_MEMORIES)


class SearchSpace(Spec):
    """味方側の探索範囲。

    重複の既定は「許さない」: APIはR-FRM-03で同じユニットを複数枠へ置けるが、使用可能
    プールは手持ちの1体ずつを表すことが多いため、許すときは明示させる。
    """

    unit_pool: list[str] = Field(alias="unitPool", min_length=1)
    memory_pool: list[str] = Field(default_factory=list, alias="memoryPool")
    # 置いてよい配置。`None` は盤面の6か所すべて。
    allowed_positions: list[Position] | None = Field(default=None, alias="allowedPositions")
    min_units: int = Field(default=1, ge=1, le=MAX_FORMATION_UNITS, alias="minUnits")
    max_units: int = Field(
        default=MAX_FORMATION_UNITS, ge=1, le=MAX_FORMATION_UNITS, alias="maxUnits"
    )
    min_memories: int = Field(default=0, ge=0, le=MAX_MEMORIES, alias="minMemories")
    max_memories: int = Field(default=MAX_MEMORIES, ge=0, le=MAX_MEMORIES, alias="maxMemories")
    allow_duplicate_units: bool = Field(default=False, alias="allowDuplicateUnits")
    allow_duplicate_memories: bool = Field(default=False, alias="allowDuplicateMemories")
    fixed_units: list[FixedUnit] = Field(default_factory=list, alias="fixedUnits")
    fixed_memories: list[FixedMemory] = Field(default_factory=list, alias="fixedMemories")


class GearResourceLimit(Spec):
    """編成全体で使えるギアの数の上限。`None` の項目は「その項目を問わない」。

    例: `{tier: III, grade: S, maxCount: 4}` は「III・Sのギアは編成全体で4個まで」。
    数えるのは実際に送るギア（調整したギアと、調整しなかったユニットの育成条件のギア）。
    """

    stat: GearStat | None = None
    tier: GearTier | None = None
    grade: GearGrade | None = None
    max_count: NonNegativeInt = Field(alias="maxCount")

    def matches(self, gear: Gear) -> bool:
        return (
            (self.stat is None or gear.stat == self.stat)
            and (self.tier is None or gear.tier == self.tier)
            and (self.grade is None or gear.grade == self.grade)
        )


class GearPolicy(Spec):
    """ギア条件。

    - `FIXED`: 各ユニットの育成条件のギアを使う。候補はギアを持たない（変更を拒否する）。
    - `ADJUSTABLE`: 候補が枠ごとにギアを指定できる。指定しない枠は育成条件のギアを使う。
      許可した能力・段階・等級・個数と資源制約の範囲だけを受け入れる。
    """

    mode: GearMode = "FIXED"
    # 調整してよいユニット。`None` はプールの全ユニット。
    adjustable_unit_ids: list[str] | None = Field(default=None, alias="adjustableUnitIds")
    allowed_stats: list[GearStat] | None = Field(default=None, alias="allowedStats")
    allowed_tiers: list[GearTier] | None = Field(default=None, alias="allowedTiers")
    allowed_grades: list[GearGrade] | None = Field(default=None, alias="allowedGrades")
    max_gears_per_unit: int = Field(default=MAX_GEARS, ge=0, le=MAX_GEARS, alias="maxGearsPerUnit")
    resource_limits: list[GearResourceLimit] = Field(default_factory=list, alias="resourceLimits")


class ComponentDescriptor(Spec):
    """接続した部品の識別子と版。再開時に同じ部品かを確かめる。"""

    component_id: str = Field(alias="componentId", min_length=1)
    version: str = Field(min_length=1)


class MethodBinding(Spec):
    """接続する手法の部品。`settings` は手法の設定で、共通基盤は解釈せず記録だけする。"""

    proposer: ComponentDescriptor
    allocator: ComponentDescriptor
    estimator: ComponentDescriptor
    settings: dict[str, Any] = Field(default_factory=dict)


class SearchExecution(Spec):
    """実行条件。

    `candidate_seed` は候補生成・試行配分の乱数、`battle_seed` は評価APIへ送るseedで、
    互いに独立している。戦闘の乱数列は `(battle_seed, runIndex)` だけで決まり、候補ID・
    要求IDは混ぜない。`budget` は探索全体の送信試行数（再送込み）の上限。
    """

    candidate_seed: str = Field(alias="candidateSeed", min_length=1)
    battle_seed: str = Field(alias="battleSeed", min_length=1)
    budget: Budget
    api: ExecutionSettings = Field(default_factory=ExecutionSettings)


class SearchProblem(Spec):
    problem_format_version: Literal[1] = Field(
        default=SEARCH_PROBLEM_FORMAT_VERSION, alias="problemFormatVersion"
    )
    format: SearchFormat
    # 形式別の固定条件（例: 通常戦闘は `enemyFormation` と `turnLimit`）。解釈は各ラボ。
    fixed: dict[str, Any]
    training: AllyTraining
    space: SearchSpace
    gear: GearPolicy = Field(default_factory=GearPolicy)
    starts: list[Candidate] = Field(default_factory=list)
    execution: SearchExecution
    method: MethodBinding
    provenance: InputProvenance = Field(default_factory=InputProvenance)

    @field_validator("fixed")
    @classmethod
    def _fixed_is_not_empty(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not value:
            raise ValueError("固定条件（fixed）が空")
        return value


def dump_problem(problem: SearchProblem) -> dict[str, Any]:
    return problem.model_dump(mode="json", by_alias=True, exclude_none=True)


def load_problem(payload: dict[str, Any]) -> SearchProblem:
    version = payload.get("problemFormatVersion")
    if version != SEARCH_PROBLEM_FORMAT_VERSION:
        raise ValueError(
            f"未対応の problemFormatVersion={version!r}"
            f"（{SEARCH_PROBLEM_FORMAT_VERSION} だけを読む）"
        )
    return SearchProblem.model_validate(payload)
