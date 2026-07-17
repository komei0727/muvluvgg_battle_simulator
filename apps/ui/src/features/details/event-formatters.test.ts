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

  it("resolves ACTION_STARTED with AP/EX resource change and no wait reason", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          reservedActionType: "AS",
          effectiveActionType: "AS",
          apBefore: 3,
          apAfter: 2,
          exBefore: 10,
          exAfter: 20,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("ACTION_STARTED");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("AP 3 → 2");
    expect(presentation.summary).toContain("EX 10 → 20");
    expect(presentation.summary).not.toContain("待機理由");
  });

  it("resolves ACTION_STARTED with a wait reason when effectiveActionType is WAIT", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          reservedActionType: "AS",
          effectiveActionType: "WAIT",
          apBefore: 0,
          apAfter: 0,
          exBefore: 100,
          exAfter: 100,
          waitReason: "AP_EXHAUSTED",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("待機理由: AP_EXHAUSTED");
  });

  it("resolves ACTION_QUEUE_CREATED into a Japanese summary with reservation count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_QUEUE_CREATED",
        details: {
          cycleNumber: 2,
          reservations: [
            { battleUnitId: "ally:1", reservedActionKind: "AS", actionSpeed: 120 },
            { battleUnitId: "enemy:1", reservedActionKind: "EX", actionSpeed: 95 },
          ],
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("ACTION_QUEUE_CREATED");
    expect(presentation.summary).toContain("2");
    expect(presentation.summary).toContain("2件");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves ACTION_QUEUE_REORDERED into a Japanese summary", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_QUEUE_REORDERED",
        details: {
          before: [{ battleUnitId: "ally:1", actionSpeed: 90 }],
          after: [{ battleUnitId: "enemy:1", actionSpeed: 110 }],
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("ACTION_QUEUE_REORDERED");
    expect(presentation.summary).toContain("1件");
  });

  it("resolves ACTION_RESERVATION_REMOVED with the removal reason", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_RESERVATION_REMOVED",
        sourceUnitId: "enemy:1",
        details: { battleUnitId: "enemy:1", reason: "DEFEATED" },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("DEFEATED");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves ACTION_WAITED with wait reason and consumed resource", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_WAITED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          waitReason: "NO_VALID_ACTION",
          consumedResource: "AP",
          consumedAmount: 1,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("NO_VALID_ACTION");
    expect(presentation.summary).toContain("AP");
    expect(presentation.summary).toContain("1");
  });

  it("resolves COOLDOWN_STARTED with the skill id and initial remaining count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "COOLDOWN_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          unit: "TURN",
          initialRemaining: 3,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_1");
    expect(presentation.summary).toContain("3");
  });

  it("resolves COOLDOWN_REDUCED with the before/after remaining count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "COOLDOWN_REDUCED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          unit: "TURN",
          before: 3,
          after: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("3 → 2");
  });

  it("resolves COOLDOWN_COMPLETED with the skill id", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "COOLDOWN_COMPLETED",
        sourceUnitId: "ally:1",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKILL_1", unit: "TURN" },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_1");
  });

  it("resolves CHARGE_STARTED with the skill id", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "CHARGE_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_2",
          startedActionId: "action-1",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_2");
  });

  it("resolves CHARGE_RELEASED with the skill id", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "CHARGE_RELEASED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_2",
          chargeStartActionId: "action-1",
          releaseActionId: "action-3",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_2");
  });
});
