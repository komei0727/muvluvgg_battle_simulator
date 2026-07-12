import { describe, expect, it } from "vitest";
import { resolveVictory } from "./victory-policy.js";

describe("resolveVictory", () => {
  it("UT-R-END-02-001: both sides annihilated resolves ALLY_WIN with SIMULTANEOUS_DEFEAT (priority 1)", () => {
    const result = resolveVictory({
      allAlliesDefeated: true,
      allEnemiesDefeated: true,
      turnLimitReached: false,
    });

    expect(result).toEqual({ outcome: "ALLY_WIN", completionReason: "SIMULTANEOUS_DEFEAT" });
  });

  it("UT-R-END-02-002: only the enemy is annihilated resolves ALLY_WIN with ENEMY_DEFEATED (priority 2)", () => {
    const result = resolveVictory({
      allAlliesDefeated: false,
      allEnemiesDefeated: true,
      turnLimitReached: false,
    });

    expect(result).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
  });

  it("UT-R-END-02-003: only allies are annihilated resolves ALLY_LOSE with ALLY_DEFEATED (priority 3)", () => {
    const result = resolveVictory({
      allAlliesDefeated: true,
      allEnemiesDefeated: false,
      turnLimitReached: false,
    });

    expect(result).toEqual({ outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED" });
  });

  it("UT-R-END-02-004: the turn limit is reached with the enemy surviving resolves ALLY_LOSE with TURN_LIMIT_REACHED (priority 4)", () => {
    const result = resolveVictory({
      allAlliesDefeated: false,
      allEnemiesDefeated: false,
      turnLimitReached: true,
    });

    expect(result).toEqual({ outcome: "ALLY_LOSE", completionReason: "TURN_LIMIT_REACHED" });
  });

  it("UT-R-END-02-005: neither side is annihilated and the turn limit is not reached continues the battle", () => {
    const result = resolveVictory({
      allAlliesDefeated: false,
      allEnemiesDefeated: false,
      turnLimitReached: false,
    });

    expect(result).toBeUndefined();
  });

  it("UT-R-END-02-006: mutual defeat outranks the turn limit reason (priority 1 before priority 4)", () => {
    const result = resolveVictory({
      allAlliesDefeated: true,
      allEnemiesDefeated: true,
      turnLimitReached: true,
    });

    expect(result).toEqual({ outcome: "ALLY_WIN", completionReason: "SIMULTANEOUS_DEFEAT" });
  });

  it("UT-R-END-02-007: enemy defeat outranks the turn limit reason even when the limit is also reached (priority 2 before priority 4)", () => {
    const result = resolveVictory({
      allAlliesDefeated: false,
      allEnemiesDefeated: true,
      turnLimitReached: true,
    });

    expect(result).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
  });
});
