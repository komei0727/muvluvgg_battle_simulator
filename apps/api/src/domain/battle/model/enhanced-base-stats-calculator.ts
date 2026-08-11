import type { BaseStats, UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { resolveAcademyLevelAddition, type AcademyLevels } from "./academy-level-policy.js";
import { calculateGearRatios, type GearSpecification } from "./gear-customization-policy.js";

/**
 * R-ENH-03 #1: タイプ装備は強化対象の全ユニットへ常時適用する固定加算。
 * 個別のON/OFFは持たない（Q-ENH-04）。
 */
const TYPE_EQUIPMENT_ADDITION = { hp: 19320, attack: 14340, defense: 7980 } as const;

/** R-ENH-03 #2: モジュールの固定加算。 */
const MODULE_FIXED_ADDITION = { hp: 3628, attack: 2721, defense: 1515 } as const;

/**
 * R-ENH-03 #2: モジュールの割合補正。パーセント値9%を内部表現（R-NUM-01）へ
 * 変換した値で、HP・攻撃力・防御力にだけ掛かる。
 */
const MODULE_RATIO = 0.09;

/** R-ENH-05 #1: `baseStats`が表すレベル。指定が無いユニットはこのレベルとして扱う。 */
export const DEFAULT_UNIT_LEVEL = 200;

/** ユニット単位の強化指定と、陣営から降りてくる学園レベル（R-ENH-01 #1）。 */
export interface UnitEnhancement {
  readonly academyLevels?: AcademyLevels;
  readonly level?: number;
  readonly gears?: readonly GearSpecification[];
}

/** 強化計算が参照するユニット定義の部分集合。 */
export type EnhancementTarget = Pick<
  UnitDefinition,
  "attribute" | "unitType" | "baseStats" | "levelGrowth"
>;

/**
 * R-ENH-06: 算出結果が負になる場合は0へ、最大HPが1未満になる場合は1へ切り上げる。
 * 丸めはこのクランプだけで、途中値・最終値とも全精度のまま返す（R-NUM-01）。
 */
function clampAtLeast(value: number, minimum: number): number {
  return value < minimum ? minimum : value;
}

/**
 * R-ENH-06: 強化後基本ステータスを算出する純関数。R-STA-01の基本値としてだけ使い、
 * 編成補正・適性補正・戦闘中補正はこの値に対して既存規則のまま合成する。
 *
 * 強化指定の値域（学園レベル・現在レベルが1以上の整数、ギア0〜9個）と、
 * `levelGrowth`を持たないユニットへの`level ≠ 200`の拒否（R-ENH-05 #5）は
 * Command検証・参照検証の責務であり、ここでは検査しない
 * （`09_アプリケーション設計.md`「Command検証」）。成長値が無いユニットは
 * 成長量0として扱うため、既定レベル200では両者の結果が一致する。
 */
export function calculateEnhancedBaseStats(
  definition: EnhancementTarget,
  enhancement: UnitEnhancement,
): BaseStats {
  const { baseStats } = definition;
  const academy = resolveAcademyLevelAddition(
    enhancement.academyLevels,
    definition.unitType,
    definition.attribute,
  );
  const gearRatios = calculateGearRatios(enhancement.gears);
  const levelDelta = (enhancement.level ?? DEFAULT_UNIT_LEVEL) - DEFAULT_UNIT_LEVEL;
  const growth = definition.levelGrowth;

  /**
   * R-ENH-06: HP・攻撃力・防御力の共通式。固定加算をすべて足したあとに
   * モジュールの割合補正とギア合計割合を掛ける。
   */
  function equippedStat(parts: {
    readonly baseValue: number;
    readonly academyAddition: number;
    readonly typeEquipment: number;
    readonly moduleFixed: number;
    readonly growthPerLevel: number;
    readonly gearRatio: number;
  }): number {
    const additive =
      parts.baseValue +
      parts.academyAddition +
      parts.typeEquipment +
      parts.moduleFixed +
      levelDelta * parts.growthPerLevel;
    return additive * (1 + MODULE_RATIO + parts.gearRatio);
  }

  return {
    maximumHp: clampAtLeast(
      equippedStat({
        baseValue: baseStats.maximumHp,
        academyAddition: academy.hp,
        typeEquipment: TYPE_EQUIPMENT_ADDITION.hp,
        moduleFixed: MODULE_FIXED_ADDITION.hp,
        growthPerLevel: growth?.hp ?? 0,
        gearRatio: gearRatios.MAXIMUM_HP,
      }),
      1,
    ),
    attack: clampAtLeast(
      equippedStat({
        baseValue: baseStats.attack,
        academyAddition: academy.attack,
        typeEquipment: TYPE_EQUIPMENT_ADDITION.attack,
        moduleFixed: MODULE_FIXED_ADDITION.attack,
        growthPerLevel: growth?.attack ?? 0,
        gearRatio: gearRatios.ATTACK,
      }),
      0,
    ),
    defense: clampAtLeast(
      equippedStat({
        baseValue: baseStats.defense,
        academyAddition: academy.defense,
        typeEquipment: TYPE_EQUIPMENT_ADDITION.defense,
        moduleFixed: MODULE_FIXED_ADDITION.defense,
        growthPerLevel: growth?.defense ?? 0,
        gearRatio: gearRatios.DEFENSE,
      }),
      0,
    ),
    // R-ENH-06: 行動速度は学園レベル・タイプ装備・モジュールの対象外で、
    // レベル増加とギアだけが掛かる。
    actionSpeed: clampAtLeast(
      (baseStats.actionSpeed + levelDelta * (growth?.actionSpeed ?? 0)) *
        (1 + gearRatios.ACTION_SPEED),
      0,
    ),
    // R-ENH-06: 会心率・会心ダメージボーナス・属性相性ボーナスはギア合計割合の
    // 単純加算のみ（既に内部表現の小数なので割合補正としては掛けない）。
    criticalRate: clampAtLeast(baseStats.criticalRate + gearRatios.CRITICAL_RATE, 0),
    criticalDamageBonus: clampAtLeast(
      baseStats.criticalDamageBonus + gearRatios.CRITICAL_DAMAGE_BONUS,
      0,
    ),
    affinityBonus: clampAtLeast(baseStats.affinityBonus + gearRatios.AFFINITY_BONUS, 0),
    // R-ENH-01 #5: AP・PP・EXゲージ最大値は強化対象外。
    maximumAp: baseStats.maximumAp,
    maximumPp: baseStats.maximumPp,
  };
}
