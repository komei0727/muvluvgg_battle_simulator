import { describe, expect, it } from "vitest";
import { resolveCompletionAt } from "./completion-checkpoint.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";

const ENEMY_BASE_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function exercise(): ExerciseRuntime {
  return new ExerciseRuntime(ENEMY_BASE_STATS);
}

describe("completion checkpoint dispatch (R-TEX-09 #1)", () => {
  it("UT-R-TEX-09-005: a normal battle keeps using the R-END-02 priority order at the shared checkpoint", () => {
    expect(
      resolveCompletionAt(undefined, {
        allAlliesDefeated: false,
        allEnemiesDefeated: true,
        turnLimitReached: false,
      }),
    ).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
  });

  it("UT-R-TEX-09-006: an exercise ignores an all-enemies-defeated observation instead of resolving a victory (R-TEX-09 #2)", () => {
    expect(
      resolveCompletionAt(exercise(), {
        allAlliesDefeated: false,
        allEnemiesDefeated: true,
        turnLimitReached: false,
      }),
    ).toBeUndefined();
  });

  it("UT-R-TEX-09-007: an exercise ally wipe ends without an outcome, where a normal battle would resolve a defeat", () => {
    const input = {
      allAlliesDefeated: true,
      allEnemiesDefeated: false,
      turnLimitReached: false,
    };

    expect(resolveCompletionAt(exercise(), input)).toEqual({
      completionReason: "ALLY_DEFEATED",
    });
    expect(resolveCompletionAt(undefined, input)).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "ALLY_DEFEATED",
    });
  });

  it("UT-R-TEX-09-008: an exercise reaching the turn limit while both sides live ends with TURN_LIMIT_REACHED and no outcome", () => {
    expect(
      resolveCompletionAt(exercise(), {
        allAlliesDefeated: false,
        allEnemiesDefeated: false,
        turnLimitReached: true,
      }),
    ).toEqual({ completionReason: "TURN_LIMIT_REACHED" });
  });
});
