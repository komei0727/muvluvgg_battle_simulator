"""基点編成とギア配分の橋渡し（評価器の `FormationSource`）。

送信JSONの組み立ては `models.build_ally_formation` を通す。既定値と同値の項目を落とす
規則を書き写すと、`lab stats` と `lab gear-sensitivity` が同じ編成から違うJSONを出す。

基点編成のうち**ギア以外はすべて固定**する。ユニットの選抜と配置・メモリー・敵・現在
レベル・学園レベルを動かさないのは、それらが順位セレクタの当て先を変えてしまい、
「ギア1枚の限界効用」を測っているつもりで別の量を測ることになるためである。
"""

from __future__ import annotations

from typing import Any

from ..models import ConfigError, FormationConfig, build_ally_formation, build_enemy_formation
from .allocation import Allocation, build_allocation


def base_allocation(config: FormationConfig) -> Allocation:
    """基点編成のギアを配分へ写す。索引は `allyFormation.units` の並びと同じ。"""
    return build_allocation(
        (unit.unit_definition_id, unit.gears or []) for unit in config.ally.units
    )


class GearFormationSource:
    """配分を送信JSONの味方編成へ直す。評価器と配分型はここだけで繋がる。"""

    def __init__(self, config: FormationConfig) -> None:
        if not config.enhancement_enabled:
            # 陣営の強化指定なしにユニットの `gears` は送れない（`10_API設計.md`）。
            # ギアを動かす分析は強化計算が有効な編成でしか成り立たない。
            raise ConfigError(
                "ギア分析には ally.academyLevels が要る（--player-data を渡すか YAML へ書く）。"
                "陣営の強化指定なしにユニットのギアは送れない"
            )
        violations = base_allocation(config).violations()
        if violations:
            # 基点そのものが実在しない構成なら、近傍を測っても意味が無い。
            # 手持ちデータが同一ステータス4枚以上を持っている場合がここに来る。
            raise ConfigError(
                "基点編成のギアが規則を満たしていない:\n"
                + "\n".join(f"  - {violation}" for violation in violations)
            )
        self._config = config

    @property
    def config(self) -> FormationConfig:
        return self._config

    def base_allocation(self) -> Allocation:
        return base_allocation(self._config)

    def enemy_formation(self) -> dict[str, Any]:
        return build_enemy_formation(self._config.enemy)

    def ally_formation(self, allocation: Allocation) -> dict[str, Any]:
        return build_ally_formation(self.formation_config(allocation))

    def formation_config(self, allocation: Allocation) -> FormationConfig:
        """基点編成のギアだけを差し替えた編成定義。他の項目は写しのまま残す。"""
        units = [
            unit.model_copy(update={"gears": allocation.units[index].to_gears()})
            for index, unit in enumerate(self._config.ally.units)
        ]
        ally = self._config.ally.model_copy(update={"units": units})
        return self._config.model_copy(update={"ally": ally})
