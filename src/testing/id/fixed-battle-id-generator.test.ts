import { describe, expect, it } from "vitest";
import { FixedBattleIdGenerator } from "./fixed-battle-id-generator.js";
import { createBattleId } from "../../domain/shared/ids.js";

describe("FixedBattleIdGenerator", () => {
  it("UT-TESTING-BATTLE-ID-001: returns preset BattleIds in order", () => {
    const generator = new FixedBattleIdGenerator(["B_1", "B_2"]);

    expect(generator.next()).toBe(createBattleId("B_1"));
    expect(generator.next()).toBe(createBattleId("B_2"));
  });

  it("UT-TESTING-BATTLE-ID-002: throws once every preset value has been consumed", () => {
    const generator = new FixedBattleIdGenerator(["B_1"]);
    generator.next();

    expect(() => generator.next()).toThrow(/exhausted/);
  });
});
