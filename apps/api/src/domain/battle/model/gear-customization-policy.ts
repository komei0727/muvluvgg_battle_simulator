import { STAT_KINDS, type StatKind } from "../../catalog/definitions/catalog-enums.js";
import { createPercentage, type Percentage } from "../../shared/percentage.js";

/** R-ENH-04 #2: ギアの種別（ギアⅡ／ギアⅢ）。 */
export const GEAR_TIERS = ["II", "III"] as const;
export type GearTier = (typeof GEAR_TIERS)[number];

/** R-ENH-04 #2: ギアのランク。 */
export const GEAR_GRADES = ["D", "C", "B", "A", "S"] as const;
export type GearGrade = (typeof GEAR_GRADES)[number];

/** R-ENH-04 #1: 1ユニットへ指定できるギアの上限。 */
export const MAX_GEARS_PER_UNIT = 9;

/** ユニット単位で指定する1個のギア（R-ENH-01 #1）。対象は強化対象7ステータス。 */
export interface GearSpecification {
  readonly stat: StatKind;
  readonly tier: GearTier;
  readonly grade: GearGrade;
}

/** ステータスごとのギア合計割合（R-NUM-01の内部表現。100% = 1.0）。 */
export type GearRatios = Readonly<Record<StatKind, Percentage>>;

/**
 * R-ENH-04 #3: ギア効果表。値は**パーセントポイント**であり、内部表現へは
 * `/100` で変換する（R-ENH-04 #5）。表記のまま保持して変換を1か所に閉じることで、
 * 設計書の表とコードを字面で突き合わせられるようにする。
 */
export const GEAR_EFFECT_PERCENTAGE_POINTS: Readonly<
  Record<StatKind, Readonly<Record<GearTier, Readonly<Record<GearGrade, number>>>>>
> = {
  MAXIMUM_HP: {
    II: { D: 0.75, C: 1.18, B: 1.62, A: 2.06, S: 2.49 },
    III: { D: 1, C: 1.58, B: 2.16, A: 2.75, S: 3.33 },
  },
  ATTACK: {
    II: { D: 0.75, C: 1.18, B: 1.62, A: 2.06, S: 2.49 },
    III: { D: 1, C: 1.58, B: 2.16, A: 2.75, S: 3.33 },
  },
  DEFENSE: {
    II: { D: 0.75, C: 1.18, B: 1.62, A: 2.06, S: 2.49 },
    III: { D: 1, C: 1.58, B: 2.16, A: 2.75, S: 3.33 },
  },
  ACTION_SPEED: {
    II: { D: 1.5, C: 2.62, B: 3.37, A: 4.49, S: 5.4 },
    III: { D: 2, C: 3.5, B: 4.5, A: 6, S: 7.19 },
  },
  CRITICAL_RATE: {
    II: { D: 1.5, C: 2.62, B: 3.59, A: 4.49, S: 5.25 },
    III: { D: 2, C: 3.5, B: 4.8, A: 6, S: 7 },
  },
  CRITICAL_DAMAGE_BONUS: {
    II: { D: 3.75, C: 6.37, B: 8.62, A: 10.5, S: 12.37 },
    // Q-ENH-05: ギアⅢ・ランクCの会心ダメージ増加は8.5で確定。
    III: { D: 5, C: 8.5, B: 11.5, A: 14, S: 16.5 },
  },
  AFFINITY_BONUS: {
    II: { D: 3.75, C: 4.87, B: 5.43, A: 6, S: 6.37 },
    III: { D: 5, C: 6.5, B: 7.25, A: 8, S: 8.5 },
  },
};

/** R-ENH-06: 同じパーセント値でも、ステータスによって適用のされ方が異なる。 */
export const GEAR_STAT_APPLICATION_KINDS = ["RATIO", "POINT"] as const;
export type GearStatApplication = (typeof GEAR_STAT_APPLICATION_KINDS)[number];

/**
 * R-ENH-06: ギア合計割合の適用種別。HP・攻撃力・防御力・行動速度は基本値へ
 * 掛かる割合補正（`RATIO`）、会心率・会心ダメージボーナス・属性相性ボーナスは
 * 基本値（既に内部表現の割合）への単純加算（`POINT`）。
 *
 * 算出は`enhanced-base-stats-calculator.ts`が式として持ち、この表はその意味を
 * 表示側へ公開するための分類である。両者が離れないことは
 * `UT-R-ENH-06-009`が振る舞いから機械検証する。
 */
export const GEAR_STAT_APPLICATIONS: Readonly<Record<StatKind, GearStatApplication>> = {
  MAXIMUM_HP: "RATIO",
  ATTACK: "RATIO",
  DEFENSE: "RATIO",
  ACTION_SPEED: "RATIO",
  CRITICAL_RATE: "POINT",
  CRITICAL_DAMAGE_BONUS: "POINT",
  AFFINITY_BONUS: "POINT",
};

/**
 * R-ENH-04 #4/#5: 同一ステータスのギアは単純加算し、合計パーセント値を100で割って
 * 内部表現の小数へ変換する。加算をパーセント値のまま行ってから1度だけ割ることで、
 * ギア個数ぶんの `/100` による丸め差を持ち込まない。
 */
export function calculateGearRatios(gears: readonly GearSpecification[] | undefined): GearRatios {
  const totals = new Map<StatKind, number>();
  for (const gear of gears ?? []) {
    const points = GEAR_EFFECT_PERCENTAGE_POINTS[gear.stat][gear.tier][gear.grade];
    totals.set(gear.stat, (totals.get(gear.stat) ?? 0) + points);
  }
  return Object.fromEntries(
    STAT_KINDS.map((stat) => [stat, createPercentage((totals.get(stat) ?? 0) / 100)]),
  ) as GearRatios;
}
