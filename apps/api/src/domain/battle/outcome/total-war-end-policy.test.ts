import { describe, expect, it } from "vitest";
import { resolveTotalWarEnd } from "./total-war-end-policy.js";

describe("TotalWarEndPolicy (R-TWR-06)", () => {
  it("UT-R-TWR-06-001: both sides running out of formations is a draw by SIMULTANEOUS_DEFEAT", () => {
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: true,
        enemyOutOfFormations: true,
        turnLimitReached: false,
      }),
    ).toEqual({ outcome: "DRAW", completionReason: "SIMULTANEOUS_DEFEAT" });
  });

  it("UT-R-TWR-06-002: only the enemy running out of formations is an ally win by ENEMY_DEFEATED", () => {
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: false,
        enemyOutOfFormations: true,
        turnLimitReached: false,
      }),
    ).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
  });

  it("UT-R-TWR-06-003: only the ally running out of formations is an ally loss by ALLY_DEFEATED", () => {
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: true,
        enemyOutOfFormations: false,
        turnLimitReached: false,
      }),
    ).toEqual({ outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED" });
  });

  it("UT-R-TWR-06-004: the end of the final turn with both sides still holding a formation is a draw by TURN_LIMIT_REACHED", () => {
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: false,
        enemyOutOfFormations: false,
        turnLimitReached: true,
      }),
    ).toEqual({ outcome: "DRAW", completionReason: "TURN_LIMIT_REACHED" });
  });

  it("UT-R-TWR-06-005: a side running out of formations at the final turn's end is decided by the wipe, not by the turn limit", () => {
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: false,
        enemyOutOfFormations: true,
        turnLimitReached: true,
      }),
    ).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: true,
        enemyOutOfFormations: true,
        turnLimitReached: true,
      }),
    ).toEqual({ outcome: "DRAW", completionReason: "SIMULTANEOUS_DEFEAT" });
  });

  it("UT-R-TWR-06-006: both sides still holding a formation before the final turn's end continues the battle", () => {
    expect(
      resolveTotalWarEnd({
        allyOutOfFormations: false,
        enemyOutOfFormations: false,
        turnLimitReached: false,
      }),
    ).toBeUndefined();
  });
});
