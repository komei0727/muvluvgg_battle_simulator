import { describe, expect, it } from "vitest";
import { SystemClock } from "./system-clock.js";

describe("SystemClock", () => {
  it("UT-SYSTEMCLOCK-001: now() returns the current wall-clock time as epoch milliseconds", () => {
    const before = Date.now();
    const observed = new SystemClock().now();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});
