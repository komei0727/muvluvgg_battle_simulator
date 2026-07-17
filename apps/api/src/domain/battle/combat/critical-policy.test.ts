import { describe, expect, it } from "vitest";
import { resolveCritical } from "./critical-policy.js";
import { createPercentage } from "../../shared/percentage.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

describe("resolveCritical", () => {
  it("UT-R-CRT-01-001: NORMAL mode with 0% criticalRate never crits, even with the lowest possible roll", () => {
    const random = new SequenceRandomSource([0]);

    const result = resolveCritical("NORMAL", createPercentage(0), 0.5, random);

    expect(result.isCritical).toBe(false);
    expect(result.multiplier).toBe(1);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-002: NORMAL mode with 100% criticalRate always crits, even with the highest possible roll", () => {
    const random = new SequenceRandomSource([0.999999]);

    const result = resolveCritical("NORMAL", createPercentage(1), 0.5, random);

    expect(result.isCritical).toBe(true);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-003: NORMAL mode clamps a criticalRate above 100% down to 100% (R-CRT-01)", () => {
    const random = new SequenceRandomSource([0.999999]);

    const result = resolveCritical("NORMAL", createPercentage(1.5), 0.5, random);

    expect(result.isCritical).toBe(true);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-004: NORMAL mode clamps a negative criticalRate up to 0% (R-CRT-01)", () => {
    const random = new SequenceRandomSource([0]);

    const result = resolveCritical("NORMAL", createPercentage(-0.5), 0.5, random);

    expect(result.isCritical).toBe(false);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-008 (会心・ダメージイベントの監査可能性): exposes both baseRate (元会心率) and effectiveRate (実効会心率, R-CRT-01のclamp後) on the result", () => {
    const random = new SequenceRandomSource([0.999999]);

    const result = resolveCritical("NORMAL", createPercentage(1.5), 0.5, random);

    expect(result.baseRate).toBe(1.5);
    expect(result.effectiveRate).toBe(1);
  });

  it("UT-R-CRT-01-009: effectiveRate clamps a negative baseRate up to 0", () => {
    const random = new SequenceRandomSource([0]);

    const result = resolveCritical("NORMAL", createPercentage(-0.5), 0.5, random);

    expect(result.baseRate).toBe(-0.5);
    expect(result.effectiveRate).toBe(0);
  });

  it("UT-R-CRT-01-010: GUARANTEED/PREVENTED modes still report baseRate/effectiveRate for auditability, even though the mode alone determines the outcome", () => {
    const random = new SequenceRandomSource([]);

    const guaranteed = resolveCritical("GUARANTEED", createPercentage(0.3), 0.5, random);
    const prevented = resolveCritical("PREVENTED", createPercentage(0.3), 0.5, random);

    expect(guaranteed.baseRate).toBe(0.3);
    expect(guaranteed.effectiveRate).toBe(0.3);
    expect(prevented.baseRate).toBe(0.3);
    expect(prevented.effectiveRate).toBe(0.3);
  });

  it("UT-R-CRT-01-005: NORMAL mode rolls against RandomSource for a mid-range criticalRate", () => {
    const belowRate = new SequenceRandomSource([0.29]);
    const atRate = new SequenceRandomSource([0.3]);

    expect(resolveCritical("NORMAL", createPercentage(0.3), 0.5, belowRate).isCritical).toBe(true);
    expect(resolveCritical("NORMAL", createPercentage(0.3), 0.5, atRate).isCritical).toBe(false);
  });

  it("UT-R-CRT-01-006: GUARANTEED mode always crits without consuming the RandomSource", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 0.5, random);

    expect(result.isCritical).toBe(true);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-007: PREVENTED mode never crits without consuming the RandomSource", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("PREVENTED", createPercentage(1), 0.5, random);

    expect(result.isCritical).toBe(false);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-02-001: a critical hit multiplies by 150% plus the criticalDamageBonus", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 0.25, random);

    expect(result.multiplier).toBeCloseTo(1.75);
  });

  it("UT-R-CRT-02-002: a non-critical hit always multiplies by 100%, regardless of criticalDamageBonus", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("PREVENTED", createPercentage(1), 0.9, random);

    expect(result.multiplier).toBe(1);
  });
});
