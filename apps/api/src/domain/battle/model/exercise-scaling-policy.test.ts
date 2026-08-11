import { describe, expect, it } from "vitest";
import {
  applyExerciseScaling,
  exerciseScalingFactors,
  EXERCISE_SCALING_ATTACK_DEFENSE_CAP_BREAK_COUNT,
} from "./exercise-scaling-policy.js";
import { calculateStartingCombatStats, type CombatStats } from "./starting-combat-stats.js";
import { calculateEnhancedBaseStats } from "./enhanced-base-stats-calculator.js";
import { createPercentage } from "../../shared/percentage.js";
import { DomainValidationError } from "../../shared/errors.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";

/** R-TEX-04 #1「増分 `inc(n) = 20（n≤3）、17+n（n≥4）` パーセントポイント」そのままの定義。 */
function increment(breakNumber: number): number {
  return breakNumber <= 3 ? 20 : 17 + breakNumber;
}

/** R-TEX-04 #2の累計をルールの字義どおり総和で求める、閉形式実装の照合用オラクル。 */
function cumulativeIncrement(breakCount: number): number {
  let total = 0;
  for (let n = 1; n <= breakCount; n++) {
    total += increment(n);
  }
  return total;
}

/**
 * doubleが保持する厳密な値を `numerator / denominator` で表す、production実装とは
 * 独立した導出（IEEE754のビット列から直接組み立てる）。
 */
function exactRationalOf(value: number): { numerator: bigint; denominator: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = (bits >> 63n) & 1n;
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  const mantissa = biasedExponent === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biasedExponent === 0 ? 1 : biasedExponent) - 1075;
  const numerator = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa;
  const denominator = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
  return { numerator: negative === 1n ? -numerator : numerator, denominator };
}

/** R-NUM-02: 原基準値（doubleの厳密値）へppを掛けて100で割り、0方向へ切り捨てた値。 */
function exactScaledStat(baseValue: number, points: number): number {
  const { numerator, denominator } = exactRationalOf(baseValue);
  return Number((numerator * BigInt(points)) / (100n * denominator));
}

const ORIGINAL: CombatStats = {
  maximumHp: 10_000,
  attack: 2_000,
  defense: 1_000,
  criticalRate: 0.15,
  actionSpeed: 200,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

describe("ExerciseScalingPolicy (R-TEX-04 ブレイク時ステータス強化)", () => {
  it("UT-R-TEX-04-001: no break leaves every factor at identity, so the enhanced stats equal the original base", () => {
    expect(exerciseScalingFactors(0)).toEqual({
      hpMultiplier: 1,
      attackDefenseMultiplier: 1,
      actionSpeedMultiplier: 1,
      criticalRateAddition: 0,
    });
    expect(applyExerciseScaling(ORIGINAL, 0)).toEqual(ORIGINAL);
  });

  it("UT-R-TEX-04-002: the increment switches from 20pp to 17+n at the third and fourth break", () => {
    // 3回目まで 20pp/回 → 累計60pp。4回目は21pp → 累計81pp。
    expect(exerciseScalingFactors(3).hpMultiplier).toBe(1.6);
    expect(exerciseScalingFactors(4).hpMultiplier).toBe(1.81);
    expect(exerciseScalingFactors(3).attackDefenseMultiplier).toBe(1.6);
    expect(exerciseScalingFactors(4).attackDefenseMultiplier).toBe(1.81);
  });

  it("UT-R-TEX-04-003: attack and defense stop growing after the twentieth break and stay at the 653% cap, while HP keeps growing", () => {
    expect(EXERCISE_SCALING_ATTACK_DEFENSE_CAP_BREAK_COUNT).toBe(20);
    // Σ(k=1..20) inc(k) = 553pp。
    expect(exerciseScalingFactors(20).attackDefenseMultiplier).toBe(6.53);
    expect(exerciseScalingFactors(21).attackDefenseMultiplier).toBe(6.53);
    expect(exerciseScalingFactors(100).attackDefenseMultiplier).toBe(6.53);
    // HPは同じ21回目で 553 + 38 = 591pp まで伸びる。
    expect(exerciseScalingFactors(20).hpMultiplier).toBe(6.53);
    expect(exerciseScalingFactors(21).hpMultiplier).toBe(6.91);
  });

  it("UT-R-TEX-04-004: HP and action speed extrapolate with the same formula beyond the fiftieth break", () => {
    // Σ(k=1..50) = 2128pp、51回目は +68pp。
    expect(exerciseScalingFactors(50).hpMultiplier).toBe(22.28);
    expect(exerciseScalingFactors(51).hpMultiplier).toBe(22.96);
    // 行動速度は +5pp/回で上限なし。
    expect(exerciseScalingFactors(50).actionSpeedMultiplier).toBe(3.5);
    expect(exerciseScalingFactors(51).actionSpeedMultiplier).toBe(3.55);
  });

  it("UT-R-TEX-04-005: the critical rate gains one percentage point per break as an absolute addition to the original value", () => {
    expect(exerciseScalingFactors(1).criticalRateAddition).toBe(0.01);
    expect(exerciseScalingFactors(7).criticalRateAddition).toBe(0.07);
    // 絶対値加算であり、原基準値の倍率ではない。
    expect(applyExerciseScaling(ORIGINAL, 7).criticalRate).toBe(0.22);
    expect(applyExerciseScaling({ ...ORIGINAL, criticalRate: 0 }, 7).criticalRate).toBe(0.07);
  });

  it("UT-R-TEX-04-006: the critical damage bonus and the affinity bonus are never scaled", () => {
    for (const breakCount of [0, 1, 4, 20, 21, 60]) {
      const enhanced = applyExerciseScaling(ORIGINAL, breakCount);
      expect(enhanced.criticalDamageBonus).toBe(ORIGINAL.criticalDamageBonus);
      expect(enhanced.affinityBonus).toBe(ORIGINAL.affinityBonus);
    }
  });

  it("UT-R-TEX-04-007: the enhanced quantity stats are recomputed from the original base every time (never compounded) and truncated per R-NUM-02", () => {
    // 4回目: HP・攻撃・防御は ×1.81、行動速度は ×1.20。
    expect(applyExerciseScaling(ORIGINAL, 4)).toEqual({
      maximumHp: 18_100,
      attack: 3_620,
      defense: 1_810,
      criticalRate: 0.19,
      actionSpeed: 240,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    });
    // 非複利: 4回目の結果を入力に3回目を求めても、原基準値から求めた3回目と一致する。
    const compounded = applyExerciseScaling(applyExerciseScaling(ORIGINAL, 4), 3);
    expect(compounded.attack).not.toBe(applyExerciseScaling(ORIGINAL, 3).attack);
    expect(applyExerciseScaling(ORIGINAL, 3).attack).toBe(3_200);
  });

  it("UT-R-TEX-04-008: a fractional enhanced quantity stat drops its fractional part (R-NUM-02), while the critical rate stays a ratio", () => {
    const odd: CombatStats = { ...ORIGINAL, attack: 1_111, criticalRate: 0.155 };

    // 1111 × 1.81 = 2010.91 → 2010。
    expect(applyExerciseScaling(odd, 4).attack).toBe(2_010);
    // 会心率は割合であり整数化しない（R-NUM-01「ステータス計算値も途中で丸めず保持する」）。
    expect(applyExerciseScaling(odd, 4).criticalRate).toBeCloseTo(0.195, 10);
  });

  it("UT-R-TEX-04-010: an enhanced quantity stat that is mathematically an integer is not dropped by one through floating-point drift", () => {
    // 45 × 1.40 は数学上ちょうど63。倍率を経由して掛けると 62.99999999999999 になり、
    // 切り捨てが62へ落ちる。原基準値の厳密値とppの整数で計算して防ぐ。
    const enhanced = applyExerciseScaling(
      { ...ORIGINAL, maximumHp: 45, attack: 45, defense: 45, actionSpeed: 45 },
      2,
    );

    expect(enhanced.maximumHp).toBe(63);
    expect(enhanced.attack).toBe(63);
    expect(enhanced.defense).toBe(63);
    // 行動速度は ×1.10 で 49.5 → 49（こちらは数学上も端数を持つ）。
    expect(enhanced.actionSpeed).toBe(49);
  });

  it("PROP-TEX-004: for integer base stats every enhanced quantity stat equals the exactly-truncated rational value computed in integer arithmetic", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 60 }),
        (base, breakCount) => {
          const enhanced = applyExerciseScaling(
            { ...ORIGINAL, maximumHp: base, attack: base, defense: base, actionSpeed: base },
            breakCount,
          );
          const exact = (points: number): number => exactScaledStat(base, 100 + points);

          expect(enhanced.maximumHp).toBe(exact(cumulativeIncrement(breakCount)));
          expect(enhanced.attack).toBe(exact(cumulativeIncrement(Math.min(breakCount, 20))));
          expect(enhanced.defense).toBe(exact(cumulativeIncrement(Math.min(breakCount, 20))));
          expect(enhanced.actionSpeed).toBe(exact(5 * breakCount));
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("UT-R-TEX-04-011: a fractional original base produced by the real starting-stats path is not dropped by one either", () => {
    // R-STA-01の実経路: 基本値136へ適性ペナルティ5%を適用した原基準値は129.2（全精度で保持）。
    const original = calculateStartingCombatStats({
      baseStats: {
        maximumHp: 136,
        attack: 136,
        defense: 136,
        criticalRate: 0,
        actionSpeed: 136,
        criticalDamageBonus: 0.5,
        affinityBonus: 0,
        maximumAp: 3,
        maximumPp: 3,
      },
      positionAptitudes: ["FRONT"],
      row: "BACK",
      formationBonus: {
        attackBonus: createPercentage(0),
        hpBonus: createPercentage(0),
        defenseBonus: createPercentage(0),
        criticalRateBonus: createPercentage(0),
      },
    });
    expect(original.attack).toBe(129.2);

    // 7ブレイクは累計150pp（×2.50）。10進の129.2なら積はちょうど323だが、原基準値が
    // 保持しているdoubleは129.2をわずかに下回る値であり、その厳密な積は323未満になる。
    // R-NUM-02はBattleが保持している値を切り捨てる規則であり、10進の意図を復元しない。
    const enhanced = applyExerciseScaling(original, 7);
    expect(enhanced.maximumHp).toBe(322);
    expect(enhanced.attack).toBe(322);
    expect(enhanced.defense).toBe(322);
    // 同じ理由で、HPゲージ境界（`createHitPoint`）が同じ原基準値を整数化した場合とも一致する。
    expect(enhanced.attack).toBe(Math.trunc(exactScaledStat(original.attack, 250)));
  });

  it("UT-R-TEX-04-016: a large enhanced base keeps its meaningful fraction truncated, with no significant digits rounded away first", () => {
    // 加算前基準値9,000,198,031 = 9,000,180,970 + タイプ装備14,340 + モジュール固定2,721。
    // ギアII・Sの攻撃は+2.49pp。編成+10%・適性−5%で原基準値は10536036823.999995 相当。
    const enhancedBase = calculateEnhancedBaseStats(
      {
        attribute: "AGGRESSIVE",
        unitType: "PHYSICAL",
        baseStats: {
          maximumHp: 1,
          attack: 9_000_180_970,
          defense: 0,
          criticalRate: 0,
          actionSpeed: 0,
          criticalDamageBonus: 0,
          affinityBonus: 0,
          maximumAp: 3,
          maximumPp: 3,
        },
      },
      { gears: [{ stat: "ATTACK", tier: "II", grade: "S" }] },
    );
    const original = calculateStartingCombatStats({
      baseStats: enhancedBase,
      positionAptitudes: ["FRONT"],
      row: "BACK",
      formationBonus: {
        attackBonus: createPercentage(0.1),
        hpBonus: createPercentage(0),
        defenseBonus: createPercentage(0),
        criticalRateBonus: createPercentage(0),
      },
    });

    // 有効桁で丸め直す実装は、切り捨てる前にこの端数を消して10536036824を返していた。
    expect(applyExerciseScaling(original, 0).attack).toBe(10_536_036_823);
  });

  it("UT-R-TEX-04-013: a meaningful fraction produced by the enhanced-base-stats path is truncated, not rounded up (R-NUM-02)", () => {
    // R-ENH-06 → R-STA-01 → R-TEX-04 の実経路。ギア強化値は小数第2位のパーセント
    // ポイント（ギアII・C の攻撃は+1.18pp）を持つため、強化後の積は小数第6位より
    // 細かい端数を持ちうる。誤差ではない端数まで整数へ吸着させてはならない。
    const enhancedBase = calculateEnhancedBaseStats(
      {
        attribute: "AGGRESSIVE",
        unitType: "PHYSICAL",
        // 加算前基準値57283 = 40222 + タイプ装備14340 + モジュール固定2721。
        baseStats: {
          maximumHp: 1,
          attack: 40_222,
          defense: 0,
          criticalRate: 0,
          actionSpeed: 0,
          criticalDamageBonus: 0,
          affinityBonus: 0,
          maximumAp: 3,
          maximumPp: 3,
        },
      },
      { gears: [{ stat: "ATTACK", tier: "II", grade: "C" }] },
    );
    const original = calculateStartingCombatStats({
      baseStats: enhancedBase,
      positionAptitudes: ["FRONT"],
      row: "BACK",
      formationBonus: {
        attackBonus: createPercentage(0.1),
        hpBonus: createPercentage(0),
        defenseBonus: createPercentage(0),
        criticalRateBonus: createPercentage(0),
      },
    });

    // 57283 × (1 + 9% + 1.18%) × (1 + 10% − 5%) × 385% = 255139.9999995。
    // 端数0.9999995は誤差ではなく実際の値であり、R-NUM-02の切り捨てで255139になる。
    expect(applyExerciseScaling(original, 12).attack).toBe(255_139);
  });

  it("UT-R-TEX-04-014: a meaningful fraction is truncated at a large magnitude too, where a relative (ULP-scaled) tolerance would have swallowed it", () => {
    // 基本値・現在レベル・学園レベルに仕様上の上限が無いため、大きな原基準値も
    // 入力領域に含まれる。許容幅を値の大きさへ比例させると、この領域で実端数を
    // 吸着してしまう。
    const enhancedBase = calculateEnhancedBaseStats(
      {
        attribute: "AGGRESSIVE",
        unitType: "PHYSICAL",
        // 加算前基準値200,057,283 = 200,040,222 + タイプ装備14,340 + モジュール固定2,721。
        baseStats: {
          maximumHp: 1,
          attack: 200_040_222,
          defense: 0,
          criticalRate: 0,
          actionSpeed: 0,
          criticalDamageBonus: 0,
          affinityBonus: 0,
          maximumAp: 3,
          maximumPp: 3,
        },
      },
      { gears: [{ stat: "ATTACK", tier: "II", grade: "C" }] },
    );
    const original = calculateStartingCombatStats({
      baseStats: enhancedBase,
      positionAptitudes: ["FRONT"],
      row: "BACK",
      formationBonus: {
        attackBonus: createPercentage(0.1),
        hpBonus: createPercentage(0),
        defenseBonus: createPercentage(0),
        criticalRateBonus: createPercentage(0),
      },
    });

    // 200,057,283 × 110.18% × 105% × 385% = 891060439.9999995。
    expect(applyExerciseScaling(original, 12).attack).toBe(891_060_439);
  });

  it("UT-R-TEX-04-012: every aptitude-penalised base and break count in a dense grid matches the exact truncation of the stored value, so a one-off drift cannot slip through", () => {
    // 誤差で1小さくなる組み合わせは全体の0.06%程度しかなく、乱択200件では取りこぼす。
    // 実データが取りうる範囲を決定的に総当たりして、この欠陥種別を確実に捕まえる。
    const mismatches: string[] = [];
    for (let baseStatValue = 1; baseStatValue <= 1_200; baseStatValue++) {
      const penalised = baseStatValue * (1 - 0.05);
      for (let breakCount = 0; breakCount <= 40; breakCount++) {
        const enhanced = applyExerciseScaling(
          { ...ORIGINAL, attack: penalised, defense: penalised },
          breakCount,
        );
        const points = 100 + cumulativeIncrement(Math.min(breakCount, 20));
        const exact = exactScaledStat(penalised, points);
        if (enhanced.attack !== exact) {
          mismatches.push(
            `base=${baseStatValue} breaks=${breakCount}: ${enhanced.attack}≠${exact}`,
          );
        }
      }
    }

    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("PROP-TEX-005: a fractional original base (aptitude-penalised) still yields the exact truncation of the stored value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 60 }),
        (baseStatValue, breakCount) => {
          // 適性ペナルティ5%後の原基準値は `baseStatValue × 95 / 100`（小数第2位まで）。
          const penalised = baseStatValue * (1 - 0.05);
          const enhanced = applyExerciseScaling(
            {
              ...ORIGINAL,
              maximumHp: penalised,
              attack: penalised,
              defense: penalised,
              actionSpeed: penalised,
            },
            breakCount,
          );
          const exact = (points: number): number => exactScaledStat(penalised, 100 + points);

          expect(enhanced.maximumHp).toBe(exact(cumulativeIncrement(breakCount)));
          expect(enhanced.attack).toBe(exact(cumulativeIncrement(Math.min(breakCount, 20))));
          expect(enhanced.actionSpeed).toBe(exact(5 * breakCount));
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("UT-R-TEX-04-015: extreme magnitudes are scaled without losing the truncation contract", () => {
    // 2の冪へ寄せる厳密演算が、非正規化に近い微小値と2^53を超える巨大値でも成立することを固定する。
    const tiny = applyExerciseScaling({ ...ORIGINAL, attack: 1e-7 }, 2);
    expect(tiny.attack).toBe(0);

    const huge = applyExerciseScaling({ ...ORIGINAL, attack: 1e21 }, 2);
    expect(huge.attack).toBe(1.4e21);
  });

  it("UT-R-TEX-04-009: a negative or non-integer break count is rejected instead of producing a silent factor", () => {
    expect(() => exerciseScalingFactors(-1)).toThrow(DomainValidationError);
    expect(() => exerciseScalingFactors(1.5)).toThrow(DomainValidationError);
    expect(() => applyExerciseScaling(ORIGINAL, -1)).toThrow(DomainValidationError);
  });

  it("PROP-TEX-002: every multiplier matches the literal cumulative-increment definition of R-TEX-04", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (breakCount) => {
        const factors = exerciseScalingFactors(breakCount);

        expect(factors.hpMultiplier).toBeCloseTo(1 + cumulativeIncrement(breakCount) / 100, 10);
        expect(factors.attackDefenseMultiplier).toBeCloseTo(
          1 + cumulativeIncrement(Math.min(breakCount, 20)) / 100,
          10,
        );
        expect(factors.actionSpeedMultiplier).toBeCloseTo(1 + 0.05 * breakCount, 10);
        expect(factors.criticalRateAddition).toBeCloseTo(breakCount / 100, 10);
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-TEX-003: multipliers never decrease as breaks accumulate, and attack/defense is constant once capped", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (breakCount) => {
        const current = exerciseScalingFactors(breakCount);
        const next = exerciseScalingFactors(breakCount + 1);

        expect(next.hpMultiplier).toBeGreaterThan(current.hpMultiplier);
        expect(next.actionSpeedMultiplier).toBeGreaterThan(current.actionSpeedMultiplier);
        expect(next.criticalRateAddition).toBeGreaterThan(current.criticalRateAddition);
        expect(next.attackDefenseMultiplier).toBeGreaterThanOrEqual(
          current.attackDefenseMultiplier,
        );
        if (breakCount >= EXERCISE_SCALING_ATTACK_DEFENSE_CAP_BREAK_COUNT) {
          expect(next.attackDefenseMultiplier).toBe(current.attackDefenseMultiplier);
        }
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
