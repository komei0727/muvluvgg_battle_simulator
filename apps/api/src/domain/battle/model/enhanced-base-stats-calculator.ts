import type { BaseStats, UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { resolveAcademyLevelAddition, type AcademyLevels } from "./academy-level-policy.js";
import { calculateGearRatios, type GearSpecification } from "./gear-customization-policy.js";

/**
 * R-ENH-03 #1: タイプ装備は強化対象の全ユニットへ常時適用する固定加算。
 * 個別のON/OFFは持たない（Q-ENH-04）。
 */
const TYPE_EQUIPMENT_ADDITION = { hp: 21600, attack: 16020, defense: 8920 } as const;

/** R-ENH-03 #2/R-ENH-08 #1: モジュールの固定加算の既定値。 */
const MODULE_FIXED_ADDITION = { hp: 4288, attack: 3216, defense: 1790 } as const;

/**
 * R-ENH-03 #2/R-ENH-08 #1: モジュールの割合補正の既定値。パーセント値10%を内部表現
 * （R-NUM-01）へ変換した値で、HP・攻撃力・防御力にだけ掛かる。
 */
const MODULE_RATIO = 0.1;

/**
 * R-ENH-08: モジュールの固定加算・割合補正のユニット単位の上書き。片方だけの
 * 指定も許す——省略した項目は既定値（`MODULE_FIXED_ADDITION`/`MODULE_RATIO`）を
 * 使う。値域は有限の実数であればよく、符号やレンジは制限しない
 * （最終値はR-ENH-06のクランプで非負になるため）。
 */
export interface ModuleStatOverride {
  readonly fixed?: number;
  readonly ratio?: number;
}

/** R-ENH-08: HP・攻撃力・防御力それぞれ独立に上書きできる。 */
export interface ModuleOverride {
  readonly hp?: ModuleStatOverride;
  readonly attack?: ModuleStatOverride;
  readonly defense?: ModuleStatOverride;
}

/** R-ENH-05 #1: `baseStats`が表すレベル。指定が無いユニットはこのレベルとして扱う。 */
export const DEFAULT_UNIT_LEVEL = 200;

/** R-ENH-07 #1: `baseStats`が表すランク（`LR+5`）。指定が無いユニットはこのランクとして扱う。 */
export const DEFAULT_UNIT_RANK = 5;

/**
 * ユニット単位の強化指定と、陣営から降りてくる学園レベル（R-ENH-01 #1）。
 * 各項目は「無指定＝既定値」であり、呼び出し側が任意フィールドを素通しで
 * 組み立てられるよう明示的に`undefined`も受ける。
 */
export interface UnitEnhancement {
  readonly academyLevels?: AcademyLevels | undefined;
  readonly level?: number | undefined;
  readonly rank?: number | undefined;
  readonly gears?: readonly GearSpecification[] | undefined;
  readonly module?: ModuleOverride | undefined;
}

/** 強化計算が参照するユニット定義の部分集合。 */
export type EnhancementTarget = Pick<
  UnitDefinition,
  "attribute" | "unitType" | "baseStats" | "levelGrowth" | "rankGrowth"
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
 * 強化指定の値域（学園レベル・現在レベルが1以上の整数、ランクが0〜5の整数、ギア0〜9個）と、
 * `levelGrowth`を持たないユニットへの`level ≠ 200`の拒否（R-ENH-05 #5）・
 * `rankGrowth`を持たないユニットへの`rank ≠ 5`の拒否（R-ENH-07 #5）は
 * Command検証・参照検証の責務であり、ここでは検査しない
 * （`09_アプリケーション設計.md`「Command検証」）。成長値が無いユニットは
 * 成長量0として扱うため、既定レベル200・既定ランク5では両者の結果が一致する。
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
  const rankDelta = (enhancement.rank ?? DEFAULT_UNIT_RANK) - DEFAULT_UNIT_RANK;
  const growth = definition.levelGrowth;
  const rankGrowth = definition.rankGrowth;

  /**
   * R-ENH-08: モジュールの固定加算・割合補正は、リクエストの`module`が上書きした
   * 項目だけ差し替え、指定が無い項目は既定値（`MODULE_FIXED_ADDITION`/
   * `MODULE_RATIO`）のまま使う。
   */
  const moduleFixed = {
    hp: enhancement.module?.hp?.fixed ?? MODULE_FIXED_ADDITION.hp,
    attack: enhancement.module?.attack?.fixed ?? MODULE_FIXED_ADDITION.attack,
    defense: enhancement.module?.defense?.fixed ?? MODULE_FIXED_ADDITION.defense,
  };
  const moduleRatio = {
    hp: enhancement.module?.hp?.ratio ?? MODULE_RATIO,
    attack: enhancement.module?.attack?.ratio ?? MODULE_RATIO,
    defense: enhancement.module?.defense?.ratio ?? MODULE_RATIO,
  };

  /**
   * R-ENH-06: HP・攻撃力・防御力の共通式。固定加算をすべて足したあとに
   * モジュールの割合補正とギア合計割合を掛ける。
   */
  function equippedStat(parts: {
    readonly baseValue: number;
    readonly academyAddition: number;
    readonly typeEquipment: number;
    readonly moduleFixed: number;
    readonly moduleRatio: number;
    readonly growthPerLevel: number;
    readonly growthPerRank: number;
    readonly gearRatio: number;
  }): number {
    const additive =
      parts.baseValue +
      parts.academyAddition +
      parts.typeEquipment +
      parts.moduleFixed +
      levelDelta * parts.growthPerLevel +
      rankDelta * parts.growthPerRank;
    return additive * (1 + parts.moduleRatio + parts.gearRatio);
  }

  return {
    maximumHp: clampAtLeast(
      equippedStat({
        baseValue: baseStats.maximumHp,
        academyAddition: academy.hp,
        typeEquipment: TYPE_EQUIPMENT_ADDITION.hp,
        moduleFixed: moduleFixed.hp,
        moduleRatio: moduleRatio.hp,
        growthPerLevel: growth?.hp ?? 0,
        growthPerRank: rankGrowth?.hp ?? 0,
        gearRatio: gearRatios.MAXIMUM_HP,
      }),
      1,
    ),
    attack: clampAtLeast(
      equippedStat({
        baseValue: baseStats.attack,
        academyAddition: academy.attack,
        typeEquipment: TYPE_EQUIPMENT_ADDITION.attack,
        moduleFixed: moduleFixed.attack,
        moduleRatio: moduleRatio.attack,
        growthPerLevel: growth?.attack ?? 0,
        growthPerRank: rankGrowth?.attack ?? 0,
        gearRatio: gearRatios.ATTACK,
      }),
      0,
    ),
    defense: clampAtLeast(
      equippedStat({
        baseValue: baseStats.defense,
        academyAddition: academy.defense,
        typeEquipment: TYPE_EQUIPMENT_ADDITION.defense,
        moduleFixed: moduleFixed.defense,
        moduleRatio: moduleRatio.defense,
        growthPerLevel: growth?.defense ?? 0,
        growthPerRank: rankGrowth?.defense ?? 0,
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
    // R-ENH-06/07: 会心率・会心ダメージボーナス・属性相性ボーナスはギア合計割合の
    // 単純加算のみ（既に内部表現の小数なので割合補正としては掛けない）。
    // 会心率だけはランク上昇量も同じ加算項へ合流する（R-ENH-07 #2）。
    criticalRate: clampAtLeast(
      baseStats.criticalRate +
        rankDelta * (rankGrowth?.criticalRate ?? 0) +
        gearRatios.CRITICAL_RATE,
      0,
    ),
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
