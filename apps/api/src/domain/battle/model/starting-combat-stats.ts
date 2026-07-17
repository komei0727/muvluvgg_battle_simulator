import type {
  FormationCorrectableStat,
  PositionRow,
} from "../../catalog/definitions/catalog-enums.js";
import type { BaseStats } from "../../catalog/definitions/unit-definition.js";
import { calculateCombatStat } from "./combat-stat-calculator.js";
import { resolveAptitudePenalty } from "./position-aptitude-policy.js";
import { createPercentage, type Percentage } from "../../shared/percentage.js";
import type { FormationBonus } from "./formation-bonus-calculator.js";

export interface CombatStats {
  readonly maximumHp: number;
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
  readonly actionSpeed: number;
  readonly criticalDamageBonus: number;
  /**
   * R-ATR-02: 有利属性倍率の算出に使う。`FormationCorrectableStat`に
   * `AFFINITY_BONUS`を持たないため補正対象にならず、Unit定義の値をそのまま写す。
   */
  readonly affinityBonus: number;
}

const ZERO = createPercentage(0);

/** R-BON-01〜03: `FormationBonus`は攻撃力・HP・防御力・会心率にしか及ばない。 */
function resolveFormationBonus(
  formationBonus: FormationBonus,
  stat: FormationCorrectableStat,
): Percentage {
  switch (stat) {
    case "MAXIMUM_HP":
      return formationBonus.hpBonus;
    case "ATTACK":
      return formationBonus.attackBonus;
    case "DEFENSE":
      return formationBonus.defenseBonus;
    case "CRITICAL_RATE":
      return formationBonus.criticalRateBonus;
    case "ACTION_SPEED":
    case "CRITICAL_DAMAGE_BONUS":
      return ZERO;
  }
}

export interface StartingCombatStatsInput {
  readonly baseStats: BaseStats;
  readonly positionAptitudes: readonly PositionRow[];
  readonly row: PositionRow;
  readonly formationBonus: FormationBonus;
}

/**
 * R-STA-01: 配置適性・編成補正を含む開始時の戦闘中ステータスを計算する。
 * `CombatStatCalculator`・`PositionAptitudePolicy`をステータスごとに組み立てるだけの
 * 薄い合成層であり、戦闘中の再計算(R-STA-04)でも同じ`calculateCombatStat`をそのまま
 * 再利用できる。Memory由来のstat補正(`APPLY_STAT_MOD`)はMemory発動エンジンが
 * `AppliedEffect`として解決した後、通常バフと同じ経路で`calculateCombatStat`へ渡す
 * ため、ここでは扱わない（`13_実装計画.md`参照）。
 */
export function calculateStartingCombatStats(input: StartingCombatStatsInput): CombatStats {
  function stat(stat: FormationCorrectableStat, baseValue: number): number {
    return calculateCombatStat({
      baseValue,
      formationBonus: resolveFormationBonus(input.formationBonus, stat),
      aptitudePenalty: resolveAptitudePenalty(input.positionAptitudes, input.row, stat),
      ratioEffects: [],
      fixedCorrection: 0,
    });
  }

  return {
    maximumHp: stat("MAXIMUM_HP", input.baseStats.maximumHp),
    attack: stat("ATTACK", input.baseStats.attack),
    defense: stat("DEFENSE", input.baseStats.defense),
    criticalRate: stat("CRITICAL_RATE", input.baseStats.criticalRate),
    actionSpeed: stat("ACTION_SPEED", input.baseStats.actionSpeed),
    criticalDamageBonus: stat("CRITICAL_DAMAGE_BONUS", input.baseStats.criticalDamageBonus),
    affinityBonus: input.baseStats.affinityBonus,
  };
}
