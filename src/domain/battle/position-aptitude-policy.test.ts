import { describe, expect, it } from "vitest";
import { resolveAptitudePenalty } from "./position-aptitude-policy.js";

describe("resolveAptitudePenalty — R-STA-01 配置適性補正", () => {
  it("UT-R-STA-01-001: matching row grants no penalty for MAXIMUM_HP", () => {
    expect(resolveAptitudePenalty(["FRONT"], "FRONT", "MAXIMUM_HP")).toBeCloseTo(0);
  });

  it("UT-R-STA-01-002: mismatched row applies a 0.05 penalty for MAXIMUM_HP", () => {
    expect(resolveAptitudePenalty(["FRONT"], "BACK", "MAXIMUM_HP")).toBeCloseTo(0.05);
  });

  it("UT-R-STA-01-003: mismatched row applies a 0.05 penalty for ATTACK", () => {
    expect(resolveAptitudePenalty(["BACK"], "FRONT", "ATTACK")).toBeCloseTo(0.05);
  });

  it("UT-R-STA-01-004: mismatched row applies a 0.05 penalty for DEFENSE", () => {
    expect(resolveAptitudePenalty(["BACK"], "FRONT", "DEFENSE")).toBeCloseTo(0.05);
  });

  it("UT-R-STA-01-005: a unit with aptitude for both rows never incurs a penalty", () => {
    expect(resolveAptitudePenalty(["FRONT", "BACK"], "FRONT", "MAXIMUM_HP")).toBeCloseTo(0);
    expect(resolveAptitudePenalty(["FRONT", "BACK"], "BACK", "MAXIMUM_HP")).toBeCloseTo(0);
  });

  it("UT-R-STA-01-006: stats unaffected by position aptitude always get a zero penalty, even when mismatched", () => {
    expect(resolveAptitudePenalty(["FRONT"], "BACK", "CRITICAL_RATE")).toBeCloseTo(0);
    expect(resolveAptitudePenalty(["FRONT"], "BACK", "ACTION_SPEED")).toBeCloseTo(0);
    expect(resolveAptitudePenalty(["FRONT"], "BACK", "CRITICAL_DAMAGE_BONUS")).toBeCloseTo(0);
  });
});
