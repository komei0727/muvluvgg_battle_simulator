import { describe, expect, it } from "vitest";
import { resolveHit } from "./hit-policy.js";

describe("resolveHit", () => {
  it("UT-R-HIT-01-001: always hits (no evasion/darkness system yet — R-HIT-02/03 are M7 scope)", () => {
    expect(resolveHit()).toBe(true);
  });

  it("UT-R-HIT-01-002: still hits when called repeatedly (no hidden state or RNG consumption)", () => {
    expect(resolveHit()).toBe(true);
    expect(resolveHit()).toBe(true);
  });
});
