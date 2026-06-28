import { describe, expect, it } from "vitest";
import { ManualClock } from "./manual-clock.js";

describe("ManualClock", () => {
  it("UT-CLOCK-001: defaults to time 0 when no initial value given", () => {
    const clock = new ManualClock();
    expect(clock.now()).toBe(0);
  });

  it("UT-CLOCK-002: starts at the given initial time", () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it("UT-CLOCK-003: advance() adds ms to current time", () => {
    const clock = new ManualClock(500);
    clock.advance(200);
    expect(clock.now()).toBe(700);
  });

  it("UT-CLOCK-004: repeated advance() calls accumulate", () => {
    const clock = new ManualClock(0);
    clock.advance(100);
    clock.advance(50);
    clock.advance(25);
    expect(clock.now()).toBe(175);
  });

  it("UT-CLOCK-005: set() replaces current time regardless of previous value", () => {
    const clock = new ManualClock(9999);
    clock.set(100);
    expect(clock.now()).toBe(100);
  });

  it("UT-CLOCK-006: set() then advance() works from the set value", () => {
    const clock = new ManualClock(0);
    clock.set(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
  });
});
