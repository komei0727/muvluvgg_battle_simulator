import { describe, expect, it } from "vitest";
import {
  checkEffectRuntimeCounterDepth,
  checkEffectsResolvedCount,
  checkPassiveDepth,
} from "./passive-chain-limits.js";

const LIMITS = { maxPassiveDepth: 3, maxEffectsPerScope: 5, maxEffectRuntimeCounterDepth: 3 };

describe("checkPassiveDepth", () => {
  it("UT-GUARD-001: depth at or below the limit is ok", () => {
    expect(checkPassiveDepth(3, LIMITS)).toEqual({ ok: true });
  });

  it("UT-GUARD-002: depth beyond the limit is a structured MAX_PASSIVE_DEPTH_EXCEEDED violation", () => {
    expect(checkPassiveDepth(4, LIMITS)).toEqual({
      ok: false,
      reason: "MAX_PASSIVE_DEPTH_EXCEEDED",
    });
  });
});

describe("checkEffectsResolvedCount", () => {
  it("UT-GUARD-003: a count at or below the limit is ok", () => {
    expect(checkEffectsResolvedCount(5, LIMITS)).toEqual({ ok: true });
  });

  it("UT-GUARD-004: a count beyond the limit is a structured MAX_EFFECTS_PER_SCOPE_EXCEEDED violation", () => {
    expect(checkEffectsResolvedCount(6, LIMITS)).toEqual({
      ok: false,
      reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED",
    });
  });
});

describe("checkEffectRuntimeCounterDepth (PR #211 review [P1])", () => {
  it("UT-GUARD-005: a depth at or below the limit is ok", () => {
    expect(checkEffectRuntimeCounterDepth(3, LIMITS)).toEqual({ ok: true });
  });

  it("UT-GUARD-006: a depth beyond the limit is a structured MAX_EFFECT_RUNTIME_COUNTER_DEPTH_EXCEEDED violation", () => {
    expect(checkEffectRuntimeCounterDepth(4, LIMITS)).toEqual({
      ok: false,
      reason: "MAX_EFFECT_RUNTIME_COUNTER_DEPTH_EXCEEDED",
    });
  });
});
