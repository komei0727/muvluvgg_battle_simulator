import { describe, expect, it } from "vitest";
import { buildRosterIndex, formatEvent } from "./event-formatters.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
];

function event(
  overrides: Partial<BattleLogEventResponse> & { type: string },
): BattleLogEventResponse {
  return {
    sequence: 1,
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    details: {},
    stateVersionBefore: 0,
    stateVersionAfter: 0,
    ...overrides,
  };
}

describe("formatEvent", () => {
  it("resolves DAMAGE_APPLIED into a Japanese summary using roster names", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "EFFECT_1",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 250,
          hitPointDamage: 200,
          hpBefore: 1000,
          hpAfter: 800,
          defeated: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("DAMAGE_APPLIED");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("200");
    expect(presentation.severity).toBe("negative");
  });

  it("falls back to a generic presentation for an unknown event type without crashing (UI-AC-011)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "SOME_FUTURE_EVENT_TYPE",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: { anything: "goes", nested: { value: 1 } },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("SOME_FUTURE_EVENT_TYPE");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.severity).toBe("neutral");
    expect(presentation.details).toEqual({ anything: "goes", nested: { value: 1 } });
  });

  it("falls back to a generic presentation when a known type's details don't match the expected shape", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: { unexpected: true },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("DAMAGE_APPLIED");
    expect(presentation.severity).toBe("neutral");
  });

  it("falls back to the raw battleUnitId when the roster has no matching entry", () => {
    const rosterIndex = buildRosterIndex([]);
    const presentation = formatEvent(
      event({ type: "UNKNOWN_TYPE", sourceUnitId: "ally:99", targetUnitIds: ["enemy:99"] }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ally:99");
    expect(presentation.summary).toContain("enemy:99");
  });

  it("shows no targets as a dash rather than an empty string", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({ type: "BATTLE_STARTED", targetUnitIds: [], details: { turnLimit: 10 } }),
      rosterIndex,
    );

    expect(presentation.summary).not.toBe("");
  });
});
