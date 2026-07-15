import { describe, expect, it } from "vitest";
import { DomainValidationError } from "./errors.js";
import { createBattleId, createBattleUnitId } from "./ids.js";

describe("Shared branded IDs", () => {
  it("UT-SHARED-ID-001: creates a BattleId from a non-empty string", () => {
    expect(createBattleId("battle-1")).toBe("battle-1");
  });

  it("UT-SHARED-ID-002: rejects an empty BattleId", () => {
    expect(() => createBattleId("")).toThrow(DomainValidationError);
  });

  it("UT-SHARED-ID-003: creates a BattleUnitId from a non-empty string", () => {
    expect(createBattleUnitId("slot-1")).toBe("slot-1");
  });

  it("UT-SHARED-ID-004: rejects an empty BattleUnitId", () => {
    expect(() => createBattleUnitId("")).toThrow(DomainValidationError);
  });
});
