import { describe, expect, it } from "vitest";
import { ExerciseRuntime } from "./exercise-runtime.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";
import type { CombatStats } from "./starting-combat-stats.js";

/** R-TEX-04の原基準値スナップショット。スコア計上の検証では値自体は使わない。 */
const ENEMY_BASE_STATS: CombatStats = {
  maximumHp: 100,
  attack: 30,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

describe("ExerciseRuntime (R-TEX-02 スコア定義)", () => {
  it("UT-R-TEX-02-001: accumulates the accountable amount and reports the cumulative score before and after", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);

    expect(exercise.snapshot()).toEqual({ totalScore: 0, breakCount: 0 });
    expect(exercise.accumulateScore(30)).toEqual({ amount: 30, before: 0, after: 30 });
    expect(exercise.accumulateScore(12)).toEqual({ amount: 12, before: 30, after: 42 });
    expect(exercise.snapshot()).toEqual({ totalScore: 42, breakCount: 0 });
  });

  it("UT-R-TEX-02-002: does not accumulate a zero or negative amount, so no ExerciseScoreAccumulated is emitted for it", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(10);

    expect(exercise.accumulateScore(0)).toBeUndefined();
    // 減算は`deductScore`だけが行う（R-TEX-02 #5）。加算側へ負の量を渡しても減らない。
    expect(exercise.accumulateScore(-5)).toBeUndefined();
    expect(exercise.totalScore).toBe(10);
  });

  it("UT-R-TEX-02-003: keeps the cumulative score an integer by truncating the fractional part (R-NUM-02)", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);

    expect(exercise.accumulateScore(10.9)).toEqual({ amount: 10, before: 0, after: 10 });
    // 1未満の計上量は切り捨てで0になり、加算そのものが発生しない。
    expect(exercise.accumulateScore(0.9)).toBeUndefined();
    expect(exercise.totalScore).toBe(10);
  });

  it("UT-R-TEX-02-025: deducts the enemy's actual HP gain from the cumulative score", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(100);

    expect(exercise.deductScore(30)).toEqual({ amount: 30, before: 100, after: 70 });
    expect(exercise.deductScore(20)).toEqual({ amount: 20, before: 70, after: 50 });
    expect(exercise.snapshot()).toEqual({ totalScore: 50, breakCount: 0 });
  });

  it("UT-R-TEX-02-026: clamps the cumulative score at 0, deducting only the amount that is actually there", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(40);

    // R-TEX-02 #6: 減算イベントは「実際に減った量」を運ぶ。累計を上回る回復でも0で止まる。
    expect(exercise.deductScore(100)).toEqual({ amount: 40, before: 40, after: 0 });
    expect(exercise.totalScore).toBe(0);
  });

  it("UT-R-TEX-02-027: does not deduct when the actual decrease is zero, so no ExerciseScoreDeducted is emitted for it", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);

    // 累計0からは減らせない。
    expect(exercise.deductScore(50)).toBeUndefined();
    exercise.accumulateScore(10);
    expect(exercise.deductScore(0)).toBeUndefined();
    expect(exercise.deductScore(-5)).toBeUndefined();
    expect(exercise.totalScore).toBe(10);
  });

  it("UT-R-TEX-02-028: keeps the deducted amount an integer by truncating the fractional part (R-NUM-02)", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(20);

    expect(exercise.deductScore(10.9)).toEqual({ amount: 10, before: 20, after: 10 });
    // 1未満の減算量は切り捨てで0になり、減算そのものが発生しない。
    expect(exercise.deductScore(0.9)).toBeUndefined();
    expect(exercise.totalScore).toBe(10);
  });

  it("UT-R-TEX-03-001: counts each break, reporting the 1-based break number with the surrounding count delta", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);

    expect(exercise.recordBreak()).toEqual({ breakNumber: 1, before: 0, after: 1 });
    expect(exercise.recordBreak()).toEqual({ breakNumber: 2, before: 1, after: 2 });
    expect(exercise.snapshot()).toEqual({ totalScore: 0, breakCount: 2 });
  });

  it("PROP-TEX-006: the cumulative score stays within [0, sum of the accumulated amounts] under any interleaving of accumulation and deduction", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            deduct: fc.boolean(),
            amount: fc.integer({ min: -20, max: 60 }),
          }),
          { maxLength: 40 },
        ),
        (operations) => {
          const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
          let accumulated = 0;
          for (const operation of operations) {
            if (operation.deduct) {
              const deduction = exercise.deductScore(operation.amount);
              // 減算イベントに載る量は、常に実際に減った量である。
              if (deduction !== undefined) {
                expect(deduction.before - deduction.after).toBe(deduction.amount);
              }
            } else {
              accumulated += Math.max(0, operation.amount);
              exercise.accumulateScore(operation.amount);
            }
            expect(exercise.totalScore).toBeGreaterThanOrEqual(0);
            expect(exercise.totalScore).toBeLessThanOrEqual(accumulated);
          }
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-TEX-001: accumulation alone never decreases the cumulative score and always equals the sum of the accountable amounts", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 40 }), (amounts) => {
        const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
        let expected = 0;
        let previous = 0;
        for (const amount of amounts) {
          const accumulation = exercise.accumulateScore(amount);
          if (amount > 0) {
            expected += amount;
          }
          expect(accumulation?.after ?? exercise.totalScore).toBe(expected);
          expect(exercise.totalScore).toBeGreaterThanOrEqual(previous);
          previous = exercise.totalScore;
        }
        expect(exercise.totalScore).toBe(expected);
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
