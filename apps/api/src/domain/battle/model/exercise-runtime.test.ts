import { describe, expect, it } from "vitest";
import { ExerciseRuntime } from "./exercise-runtime.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";

describe("ExerciseRuntime (R-TEX-02 スコア定義)", () => {
  it("UT-R-TEX-02-001: accumulates the accountable amount and reports the cumulative score before and after", () => {
    const exercise = new ExerciseRuntime();

    expect(exercise.snapshot()).toEqual({ totalScore: 0, breakCount: 0 });
    expect(exercise.accumulateScore(30)).toEqual({ amount: 30, before: 0, after: 30 });
    expect(exercise.accumulateScore(12)).toEqual({ amount: 12, before: 30, after: 42 });
    expect(exercise.snapshot()).toEqual({ totalScore: 42, breakCount: 0 });
  });

  it("UT-R-TEX-02-002: does not accumulate a zero or negative amount, so no ExerciseScoreAccumulated is emitted for it", () => {
    const exercise = new ExerciseRuntime();
    exercise.accumulateScore(10);

    expect(exercise.accumulateScore(0)).toBeUndefined();
    // R-TEX-02 #5「スコアは単調増加とし、減算しない」。
    expect(exercise.accumulateScore(-5)).toBeUndefined();
    expect(exercise.totalScore).toBe(10);
  });

  it("UT-R-TEX-02-003: keeps the cumulative score an integer by truncating the fractional part (R-NUM-02)", () => {
    const exercise = new ExerciseRuntime();

    expect(exercise.accumulateScore(10.9)).toEqual({ amount: 10, before: 0, after: 10 });
    // 1未満の計上量は切り捨てで0になり、加算そのものが発生しない。
    expect(exercise.accumulateScore(0.9)).toBeUndefined();
    expect(exercise.totalScore).toBe(10);
  });

  it("PROP-TEX-001: the cumulative score never decreases and always equals the sum of the accountable amounts", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 40 }), (amounts) => {
        const exercise = new ExerciseRuntime();
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
