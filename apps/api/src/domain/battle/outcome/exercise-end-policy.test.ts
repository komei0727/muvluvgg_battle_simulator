import { describe, expect, it } from "vitest";
import { resolveExerciseEnd } from "./exercise-end-policy.js";

describe("ExerciseEndPolicy (R-TEX-09)", () => {
  it("UT-R-TEX-09-001: an ally wipe ends the exercise with ALLY_DEFEATED", () => {
    expect(resolveExerciseEnd({ allAlliesDefeated: true, turnLimitReached: false })).toEqual({
      completionReason: "ALLY_DEFEATED",
    });
  });

  it("UT-R-TEX-09-002: the end of the fifth turn ends the exercise with TURN_LIMIT_REACHED", () => {
    expect(resolveExerciseEnd({ allAlliesDefeated: false, turnLimitReached: true })).toEqual({
      completionReason: "TURN_LIMIT_REACHED",
    });
  });

  it("UT-R-TEX-09-003: an ally wipe at the final turn's ending checkpoint reports ALLY_DEFEATED, the first of the two conditions", () => {
    expect(resolveExerciseEnd({ allAlliesDefeated: true, turnLimitReached: true })).toEqual({
      completionReason: "ALLY_DEFEATED",
    });
  });

  it("UT-R-TEX-09-004: neither condition holding continues the exercise", () => {
    expect(
      resolveExerciseEnd({ allAlliesDefeated: false, turnLimitReached: false }),
    ).toBeUndefined();
  });
});
