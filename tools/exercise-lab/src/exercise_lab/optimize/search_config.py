"""探索設定YAMLの読み込みと、候補から編成リクエストへの変換。

編成そのもの（`lab stats` が読む `formation.yaml`）とは別の書式である。あちらが
「1つの編成を確定して大量試行する」入力なのに対し、こちらは「どの範囲から探すか」を
与える入力で、確定した編成を持たない。

送信JSONの組み立ては `models.build_ally_formation` を通す。既定値と同値の項目を
落とす規則を書き写すと、`lab stats` と `lab optimize` で同じ編成から違うJSONが出る。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, ValidationError, model_validator

from ..models import (
    AcademyLevels,
    AllySpec,
    AllyUnitSpec,
    ConfigError,
    EnemySpec,
    FormationConfig,
    Position,
    _Spec,
)
from ..player_data import PlayerData
from .candidate import (
    MAX_MEMORIES,
    MAX_UNITS,
    Candidate,
    Cell,
    Constraints,
    Placement,
    cell_index,
    repair,
)
from .fitness import DEFAULT_ALPHA, DEFAULT_MEAN_WEIGHT, MIN_RELIABLE_TAIL_SAMPLES, RiskPolicy

# 評価スケジュールの既定。第1段は平均だけで足切りし、CVaRは尾部が育ってから使う
# （`fitness.cvar_is_reliable`）。段ごとの値は累計試行数であって増分ではない。
DEFAULT_STAGE_RUNS = (8, 24, 72)
# 最終選抜（SAR型レース）は探索で使っていないseed範囲で回す。
DEFAULT_FINAL_STAGE_RUNS = (50, 100)
DEFAULT_POPULATION_SIZE = 40
DEFAULT_FINAL_POOL_SIZE = 24
DEFAULT_TOP_K = 5
DEFAULT_PATIENCE = 8

# 既知の良編成が初期母集団を埋め尽くすと多様性を失い、最終解がかえって悪くなる。
MAX_SEED_SHARE = 0.25

# `SearchConfig` の項目のうち、YAMLの入力ではなく実行時に埋める枠。
# 生成するJSON Schemaからも外す（補完候補に出さない）。
INTERNAL_FIELDS = frozenset({"unit_enhancements"})


class SeedFormationSpec(_Spec):
    """既知の良編成。`formation.yaml` の `ally` と同じ形にして写せるようにする。"""

    units: list[AllyUnitSpec] = Field(min_length=1, max_length=MAX_UNITS)
    memory_definition_ids: list[str] = Field(
        default_factory=list, alias="memoryDefinitionIds", max_length=MAX_MEMORIES
    )


class FixedPlacementSpec(_Spec):
    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position


class ConstraintsSpec(_Spec):
    allow_duplicate_units: bool = Field(default=False, alias="allowDuplicateUnits")
    fixed_placements: list[FixedPlacementSpec] = Field(
        default_factory=list, alias="fixedPlacements"
    )
    required_units: list[str] = Field(default_factory=list, alias="requiredUnits")
    required_memories: list[str] = Field(default_factory=list, alias="requiredMemories")


class RiskSpec(_Spec):
    alpha: float = Field(default=DEFAULT_ALPHA, gt=0.0, le=1.0)
    # YAMLのキーは計画・Issueと揃えて `lambda`。Pythonの予約語なので名前は変えるが同じλ。
    mean_weight: float = Field(default=DEFAULT_MEAN_WEIGHT, alias="lambda", ge=0.0, le=1.0)


class ScheduleSpec(_Spec):
    population_size: int = Field(default=DEFAULT_POPULATION_SIZE, alias="populationSize", ge=2)
    stage_runs: tuple[int, ...] = Field(default=DEFAULT_STAGE_RUNS, alias="stageRuns", min_length=1)
    final_pool_size: int = Field(default=DEFAULT_FINAL_POOL_SIZE, alias="finalPoolSize", ge=1)
    final_stage_runs: tuple[int, ...] = Field(
        default=DEFAULT_FINAL_STAGE_RUNS, alias="finalStageRuns", min_length=1
    )
    top_k: int = Field(default=DEFAULT_TOP_K, alias="topK", ge=1)
    patience: int = Field(default=DEFAULT_PATIENCE, ge=1)

    @model_validator(mode="after")
    def _check_monotonic(self) -> ScheduleSpec:
        for label, runs in (
            ("stageRuns", self.stage_runs),
            ("finalStageRuns", self.final_stage_runs),
        ):
            if any(runs[index] >= runs[index + 1] for index in range(len(runs) - 1)):
                raise ValueError(f"{label} は段ごとに増える累計試行数でなければならない: {runs}")
            if runs[0] < 1:
                raise ValueError(f"{label} の試行数は1以上でなければならない: {runs}")
        if self.top_k > self.final_pool_size:
            raise ValueError(
                f"topK={self.top_k} は finalPoolSize={self.final_pool_size} を超えられない"
            )
        return self


class OperatorWeightsSpec(_Spec):
    """近傍生成の演算子を選ぶ重み。

    配置とメモリーの最適化が主で、ユニット入替は「未知の組み合わせを適度に探す」ための
    低頻度の手である。既定はその方針をそのまま数値にしてある。
    """

    unit_swap: float = Field(default=0.18, alias="unitSwap", ge=0.0)
    # 人数を動かす手。無いと編成人数が初期値から変わらず、探索空間から次元が落ちる。
    unit_add: float = Field(default=0.06, alias="unitAdd", ge=0.0)
    unit_remove: float = Field(default=0.02, alias="unitRemove", ge=0.0)
    placement_move: float = Field(default=0.17, alias="placementMove", ge=0.0)
    placement_swap: float = Field(default=0.17, alias="placementSwap", ge=0.0)
    row_flip: float = Field(default=0.09, alias="rowFlip", ge=0.0)
    memory_swap: float = Field(default=0.19, alias="memorySwap", ge=0.0)
    memory_add: float = Field(default=0.07, alias="memoryAdd", ge=0.0)
    memory_remove: float = Field(default=0.05, alias="memoryRemove", ge=0.0)

    def as_dict(self) -> dict[str, float]:
        return {
            "unit_swap": self.unit_swap,
            "unit_add": self.unit_add,
            "unit_remove": self.unit_remove,
            "placement_move": self.placement_move,
            "placement_swap": self.placement_swap,
            "row_flip": self.row_flip,
            "memory_swap": self.memory_swap,
            "memory_add": self.memory_add,
            "memory_remove": self.memory_remove,
        }

    def normalized(self) -> dict[str, float]:
        weights = self.as_dict()
        total = sum(weights.values())
        if total <= 0.0:
            raise ValueError("演算子の重みが全て0で、近傍を生成できない")
        return {name: weight / total for name, weight in weights.items()}


class SearchConfig(_Spec):
    enemy: EnemySpec
    unit_pool: list[str] = Field(alias="unitPool", min_length=1)
    memory_pool: list[str] = Field(default_factory=list, alias="memoryPool")
    academy_levels: AcademyLevels | None = Field(default=None, alias="academyLevels")
    constraint_spec: ConstraintsSpec = Field(default_factory=ConstraintsSpec, alias="constraints")
    known_formations: list[SeedFormationSpec] = Field(default_factory=list, alias="knownFormations")
    risk: RiskSpec = Field(default_factory=RiskSpec)
    schedule: ScheduleSpec = Field(default_factory=ScheduleSpec)
    operator_weights: OperatorWeightsSpec = Field(
        default_factory=OperatorWeightsSpec, alias="operatorWeights"
    )
    # プール内ユニットの強化。`--player-data` の取り込み結果を保持する枠であり、
    # YAMLからは書けない（`INTERNAL_FIELDS` で入口を塞いでいる）。育成状態の正本を
    # 2か所へ置くと、どちらで評価したのか後から分からなくなる。
    unit_enhancements: dict[str, AllyUnitSpec] = Field(default_factory=dict, exclude=True)

    @property
    def risk_policy(self) -> RiskPolicy:
        return RiskPolicy(alpha=self.risk.alpha, mean_weight=self.risk.mean_weight)

    @property
    def constraints(self) -> Constraints:
        return Constraints(
            unit_pool=tuple(self.unit_pool),
            memory_pool=tuple(self.memory_pool),
            allow_duplicate_units=self.constraint_spec.allow_duplicate_units,
            fixed_placements=tuple(
                Placement(
                    unit_definition_id=fixed.unit_definition_id,
                    cell=Cell(column=fixed.position.column, row=fixed.position.row),
                )
                for fixed in self.constraint_spec.fixed_placements
            ),
            required_units=tuple(self.constraint_spec.required_units),
            required_memories=tuple(self.constraint_spec.required_memories),
        )

    def seed_candidates(self) -> tuple[Candidate, ...]:
        """既知の良編成を候補へ直す。重複は畳む。

        壊れた種（プール外・マス重複）も矯正して取り込む。手で書き写した編成が
        1文字違うだけで黙って落ちると、種を入れたつもりの探索が種なしで走る。
        """
        constraints = self.constraints
        seeds: list[Candidate] = []
        seen: set[str] = set()
        for formation in self.known_formations:
            candidate = repair(
                Candidate(
                    placements=tuple(
                        Placement(
                            unit_definition_id=unit.unit_definition_id,
                            cell=Cell(column=unit.position.column, row=unit.position.row),
                        )
                        for unit in formation.units
                    ),
                    memory_definition_ids=tuple(formation.memory_definition_ids),
                ),
                constraints,
            )
            key = candidate.canonical_key()
            if key not in seen:
                seen.add(key)
                seeds.append(candidate)
        return tuple(seeds)

    def max_seed_count(self) -> int:
        """初期母集団へ入れてよい種の上限。多様性を失わせないための頭打ち。"""
        return max(1, int(self.schedule.population_size * MAX_SEED_SHARE))

    def formation_config(self, candidate: Candidate) -> FormationConfig:
        """候補を `lab stats` と同じ編成定義へ直す。送信JSONの組み立てはそこへ委ねる。

        並びは前列→後衛・列昇順へ揃える。送信順は結果に影響しないが、同じ編成から
        常に同じJSONが出ないと、評価ログとUIの編成表を突き合わせるときに読み手が迷う。
        """
        units = [
            self._ally_unit(placement.unit_definition_id, placement.cell)
            for placement in sorted(candidate.placements, key=lambda p: cell_index(p.cell))
        ]
        return FormationConfig(
            ally=AllySpec.model_construct(
                units=units,
                memory_definition_ids=list(candidate.memory_definition_ids),
                academy_levels=self.academy_levels,
            ),
            enemy=self.enemy,
        )

    def _ally_unit(self, unit_definition_id: str, cell: Cell) -> AllyUnitSpec:
        position = Position(column=cell.column, row=cell.row)
        enhancement = self.unit_enhancements.get(unit_definition_id)
        if enhancement is None:
            return AllyUnitSpec.model_construct(
                unit_definition_id=unit_definition_id, position=position
            )
        return enhancement.model_copy(update={"position": position})


def load_search_config(path: Path) -> SearchConfig:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: トップレベルはマッピングでなければならない")
    _reject_internal_fields(raw, path)
    try:
        config = SearchConfig.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    _validate(config, path)
    return config


def _reject_internal_fields(raw: dict[str, Any], path: Path) -> None:
    """内部の枠をYAMLから埋めさせない。

    モデルの項目である以上、名前で書けば pydantic は受け取ってしまう（`extra="forbid"`
    は未知キーしか弾かない）。黙って通すと、`--player-data` とYAMLの2か所に育成状態が
    生まれ、どちらで評価したのか後から追えなくなる。
    """
    written = sorted(set(raw) & INTERNAL_FIELDS)
    if written:
        raise ConfigError(
            f"{path}: {', '.join(written)} はYAMLへ書けない内部項目である。"
            "ユニットのレベル・ギアは --player-data で渡す"
        )


def _validate(config: SearchConfig, path: Path) -> None:
    try:
        # 制約の整合（固定・必須がプールにあるか、5体に収まるか）は `Constraints` が持つ。
        # 組み立てを走らせること自体が検証であり、戻り値はここでは使わない。
        _ = config.constraints
        config.operator_weights.normalized()
    except ValueError as error:
        raise ConfigError(f"{path}: {error}") from error

    policy = config.risk_policy
    final_runs = config.schedule.final_stage_runs[-1]
    if not policy.cvar_is_reliable(final_runs):
        raise ConfigError(
            f"{path}: 最終選抜の試行数 {final_runs} では CVaR の尾部が "
            f"{policy.tail_size(final_runs)} 件しかなく、{MIN_RELIABLE_TAIL_SAMPLES} 件に届かない。"
            f"finalStageRuns を増やすか risk.alpha を上げる"
        )

    unknown_memories = sorted(set(_seed_memory_ids(config)) - set(config.memory_pool))
    if unknown_memories:
        # 種は矯正して取り込むが、プールに無いIDは「書いたのに探索されない」ので
        # 打ち間違いと区別できるよう明示的に落とす。
        raise ConfigError(
            f"{path}: knownFormations が候補プールに無いメモリーを指している: "
            f"{', '.join(unknown_memories)}"
        )


def _seed_memory_ids(config: SearchConfig) -> list[str]:
    return [
        memory_id
        for formation in config.known_formations
        for memory_id in formation.memory_definition_ids
    ]


def resolve_unit_enhancements(
    config: SearchConfig, data: PlayerData
) -> tuple[SearchConfig, list[str]]:
    """手持ちデータから、候補プール全ユニットのレベル・ギアを解決する。

    `lab stats` の `apply_player_data` と同じ規則だが、対象が「編成に入っている5体」では
    なく「プール全件」である点が違う。探索中はどの5体が選ばれるか決まっていないため、
    先に全件ぶんを解いておく。
    """
    warnings: list[str] = []
    enhancements: dict[str, AllyUnitSpec] = {}
    for unit_definition_id in config.unit_pool:
        stored = data.units.get(unit_definition_id)
        if stored is None:
            warnings.append(
                f"{unit_definition_id} は手持ちデータに無い（レベル200・ギアなしとして評価する）"
            )
            continue
        enhancements[unit_definition_id] = AllyUnitSpec.model_construct(
            unit_definition_id=unit_definition_id,
            position=Position(column=0, row="FRONT"),
            level=stored.level,
            # 空枠を除いた枠順のまま送る（`request-mapper.ts` の `buildUnitEnhancement` と同じ）。
            gears=[gear for gear in stored.gears if gear is not None],
        )
    return (
        config.model_copy(
            update={
                "unit_enhancements": enhancements,
                # YAMLに書いた学園レベルが常に優先する。手持ちは書かなかったときだけ効く。
                "academy_levels": config.academy_levels or data.academy_levels,
            }
        ),
        warnings,
    )


def dump_search_config_template(document: dict[str, Any]) -> str:
    return yaml.safe_dump(document, allow_unicode=True, sort_keys=False, default_flow_style=False)
