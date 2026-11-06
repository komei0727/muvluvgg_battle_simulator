import { describe, expect, it } from "vitest";
import { formationHeadingAt, isTotalWarRosterEntry, selectRosterOf } from "./roster.js";
import type { RosterEntry, TotalWarRosterEntry } from "./roster.js";

function totalWar(battleUnitId: string, formationNumber: number): TotalWarRosterEntry {
  return {
    battleUnitId,
    unitDefinitionId: "UNIT_A",
    side: "ALLY",
    displayName: "アルファ",
    formationNumber,
    reappearance: false,
    deployed: true,
  };
}

const plain: RosterEntry = {
  battleUnitId: "ally:1",
  unitDefinitionId: "UNIT_A",
  side: "ALLY",
  displayName: "アルファ",
};

describe("selectRosterOf (UI-UT-TWR-015)", () => {
  it("builds the Roster from any unit list in its order, falling back to the definition ID", () => {
    const roster = selectRosterOf(
      [
        { battleUnitId: "ally:2", unitDefinitionId: "UNIT_A", side: "ALLY" },
        { battleUnitId: "ally:1", unitDefinitionId: "UNIT_X", side: "ALLY" },
      ],
      { units: [{ unitDefinitionId: "UNIT_A", displayName: "アルファ" }] },
    );

    expect(roster.map((entry) => [entry.battleUnitId, entry.displayName])).toEqual([
      ["ally:2", "アルファ"],
      ["ally:1", "UNIT_X"],
    ]);
  });
});

describe("isTotalWarRosterEntry", () => {
  it("tells total war entries from regular ones", () => {
    expect(isTotalWarRosterEntry(totalWar("ally:1", 1))).toBe(true);
    expect(isTotalWarRosterEntry(plain)).toBe(false);
  });
});

describe("formationHeadingAt", () => {
  const entries = [totalWar("ally:1", 1), totalWar("ally:2", 1), totalWar("ally:3", 2)];

  it("returns the formation number where the formation changes", () => {
    expect(entries.map((_, index) => formationHeadingAt(entries, index))).toEqual([
      1,
      undefined,
      2,
    ]);
  });

  it("returns nothing for regular entries and out-of-range indices", () => {
    expect(formationHeadingAt([plain], 0)).toBeUndefined();
    expect(formationHeadingAt(entries, 3)).toBeUndefined();
  });

  it("starts a heading after a regular entry", () => {
    expect(formationHeadingAt([plain, totalWar("ally:2", 1)], 1)).toBe(1);
  });
});
