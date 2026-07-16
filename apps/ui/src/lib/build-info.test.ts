import { describe, expect, it } from "vitest";
import { resolveBuildRevision } from "./build-info.js";

describe("resolveBuildRevision", () => {
  it("returns the trimmed value when set", () => {
    expect(resolveBuildRevision("abc1234")).toBe("abc1234");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveBuildRevision("  abc1234  ")).toBe("abc1234");
  });

  it("falls back to 'dev' when unset", () => {
    expect(resolveBuildRevision(undefined)).toBe("dev");
  });

  it("falls back to 'dev' when empty or whitespace-only", () => {
    expect(resolveBuildRevision("   ")).toBe("dev");
  });
});
