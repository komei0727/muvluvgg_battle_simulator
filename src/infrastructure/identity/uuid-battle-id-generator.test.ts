import { describe, expect, it } from "vitest";
import { UuidBattleIdGenerator } from "./uuid-battle-id-generator.js";

describe("UuidBattleIdGenerator", () => {
  it("UT-BATTLEID-001: next() returns a non-empty BattleId", () => {
    const generator = new UuidBattleIdGenerator();
    expect(generator.next().length).toBeGreaterThan(0);
  });

  it("UT-BATTLEID-002: successive calls return distinct ids", () => {
    const generator = new UuidBattleIdGenerator();
    const first = generator.next();
    const second = generator.next();
    expect(first).not.toBe(second);
  });
});
