import { describe, expect, it } from "vitest";
import { buildRosterIndex, formatEvent } from "./event-formatters.js";
import type { RosterIndex } from "./event-presentation.js";

const roster: RosterIndex = buildRosterIndex([
  { battleUnitId: "enemy:2", unitDefinitionId: "UNIT_E", displayName: "エネミー", side: "ENEMY" },
  { battleUnitId: "enemy:3", unitDefinitionId: "UNIT_F", displayName: "エフ", side: "ENEMY" },
]);

// UI-UT-TWR-017（03_API・データ連携設計.md §12.3）。
describe("total war event formatters (UI-UT-TWR-017)", () => {
  it("summarizes FORMATION_DEPLOYED with the side, formation number and unit names", () => {
    const presentation = formatEvent(
      {
        type: "FORMATION_DEPLOYED",
        details: {
          side: "ENEMY",
          formationNumber: 2,
          turnNumber: 2,
          battleUnitIds: ["enemy:2", "enemy:3", "enemy:9"],
        },
      },
      roster,
    );

    expect(presentation.title).toBe("FORMATION_DEPLOYED");
    expect(presentation.summary).toBe("敵の編成2が出撃: エネミー, エフ, enemy:9");
    expect(presentation.severity).toBe("neutral");
  });

  it.each([
    ["ENEMY", "敵の編成1が全滅（控え残り1）", "positive"],
    ["ALLY", "味方の編成1が全滅（控え残り1）", "negative"],
  ])(
    "summarizes FORMATION_DEFEATED of %s with the remaining reserves",
    (side, summary, severity) => {
      const presentation = formatEvent(
        {
          type: "FORMATION_DEFEATED",
          details: { side, formationNumber: 1, turnNumber: 1, remainingReserveCount: 1 },
        },
        roster,
      );

      expect(presentation.title).toBe("FORMATION_DEFEATED");
      expect(presentation.summary).toBe(summary);
      expect(presentation.severity).toBe(severity);
    },
  );

  it.each([
    ["FORMATION_DEPLOYED", { side: "ENEMY", formationNumber: 2, battleUnitIds: "enemy:2" }],
    ["FORMATION_DEFEATED", { side: "ENEMY", formationNumber: "1", remainingReserveCount: 0 }],
  ])(
    "falls back to the generic presentation when %s details have an unexpected shape",
    (type, details) => {
      const presentation = formatEvent({ type, details }, roster);

      expect(presentation.title).toBe(type);
      expect(presentation.summary).toBe("- → -");
      expect(presentation.details).toEqual(details);
    },
  );
});
