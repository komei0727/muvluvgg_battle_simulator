import { describe, expect, it } from "vitest";
import { attributeAdvantageOf, hasAttributeAdvantage } from "./attribute-advantage.js";

describe("attribute advantage (R-ATR-01/03/05)", () => {
  it("UT-R-ATR-05-001: the attacker's main attribute wins first", () => {
    expect(attributeAdvantageOf({ attribute: "SHY", subAttribute: "SMART" }, "CUTE")).toBe("MAIN");
  });

  it("UT-R-ATR-05-002: the attacker's sub attribute is re-checked only when the main attribute is not favorable", () => {
    expect(attributeAdvantageOf({ attribute: "SHY", subAttribute: "SMART" }, "AGGRESSIVE")).toBe(
      "SUB",
    );
  });

  it("UT-R-ATR-05-003: neither attribute favorable is no advantage", () => {
    expect(attributeAdvantageOf({ attribute: "SHY", subAttribute: "SMART" }, "SHY")).toBeNull();
    expect(attributeAdvantageOf({ attribute: "SHY" }, "AGGRESSIVE")).toBeNull();
    expect(hasAttributeAdvantage({ attribute: "SHY" }, "AGGRESSIVE")).toBe(false);
    expect(hasAttributeAdvantage({ attribute: "SHY" }, "CUTE")).toBe(true);
  });
});
