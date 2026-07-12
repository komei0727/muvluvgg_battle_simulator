import type { PositionRow } from "../catalog/catalog-enums.js";
import type { MemoryModifier, ModifierStat } from "../catalog/memory-definition.js";
import type { BaseStats } from "../catalog/unit-definition.js";
import { calculateCombatStat } from "./combat-stat-calculator.js";
import type { StatEffect } from "./effect-stacking-policy.js";
import { resolveAptitudePenalty } from "./position-aptitude-policy.js";
import { createPercentage, type Percentage } from "./percentage.js";
import type { FormationBonus } from "./formation-bonus-calculator.js";

export interface CombatStats {
  readonly maximumHp: number;
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
  readonly actionSpeed: number;
  readonly criticalDamageBonus: number;
  /**
   * R-ATR-02: 有利属性倍率の算出に使う。Memoryは`ModifierStat`に
   * `AFFINITY_BONUS`を持たないため補正対象にならず、Unit定義の値をそのまま写す。
   */
  readonly affinityBonus: number;
}

const ZERO = createPercentage(0);

/** R-BON-01〜03: `FormationBonus`は攻撃力・HP・防御力・会心率にしか及ばない。 */
function resolveFormationBonus(formationBonus: FormationBonus, stat: ModifierStat): Percentage {
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

function ratioEffectsFor(modifiers: readonly MemoryModifier[], stat: ModifierStat): StatEffect[] {
  return modifiers
    .filter((modifier) => modifier.stat === stat && modifier.valueType === "RATIO")
    .map((modifier) => ({ stacking: "STACKABLE", value: modifier.value }) as const);
}

function fixedCorrectionFor(modifiers: readonly MemoryModifier[], stat: ModifierStat): number {
  return modifiers
    .filter((modifier) => modifier.stat === stat && modifier.valueType === "FIXED")
    .reduce((sum, modifier) => sum + modifier.value, 0);
}

export interface StartingCombatStatsInput {
  readonly baseStats: BaseStats;
  readonly positionAptitudes: readonly PositionRow[];
  readonly row: PositionRow;
  readonly formationBonus: FormationBonus;
  readonly memoryModifiers: readonly MemoryModifier[];
}

/**
 * R-STA-01: 配置適性・編成補正・Memory補正を含む開始時の戦闘中ステータスを計算する。
 * `CombatStatCalculator`・`EffectStackingPolicy`・`PositionAptitudePolicy`を
 * ステータスごとに組み立てるだけの薄い合成層であり、戦闘中の再計算(R-STA-04)でも
 * 同じ`calculateCombatStat`をそのまま再利用できる。
 */
export function calculateStartingCombatStats(input: StartingCombatStatsInput): CombatStats {
  function stat(stat: ModifierStat, baseValue: number): number {
    return calculateCombatStat({
      baseValue,
      formationBonus: resolveFormationBonus(input.formationBonus, stat),
      aptitudePenalty: resolveAptitudePenalty(input.positionAptitudes, input.row, stat),
      ratioEffects: ratioEffectsFor(input.memoryModifiers, stat),
      fixedCorrection: fixedCorrectionFor(input.memoryModifiers, stat),
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
