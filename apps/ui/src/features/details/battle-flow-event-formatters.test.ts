import { describe, expect, it } from "vitest";
import { battleFlowEventFormatters } from "./battle-flow-event-formatters.js";
import { buildRosterIndex } from "./event-presentation.js";
import type { RosterEntry } from "../../entities/roster.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
];

const rosterIndex = buildRosterIndex(roster);

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

// details shapes below mirror apps/ui/src/test/fixtures/success-unknown-event.json
// (REF-053) rather than being invented ad hoc.
describe("BATTLE_STARTED", () => {
  it("resolves the turn limit", () => {
    const presentation = battleFlowEventFormatters["BATTLE_STARTED"]?.(
      event({
        type: "BATTLE_STARTED",
        details: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("3");
  });

  it("returns undefined when turnLimit is missing", () => {
    const presentation = battleFlowEventFormatters["BATTLE_STARTED"]?.(
      event({ type: "BATTLE_STARTED", details: { allySlotCount: 1 } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("TURN_STARTED", () => {
  it("resolves the turn number", () => {
    const presentation = battleFlowEventFormatters["TURN_STARTED"]?.(
      event({ type: "TURN_STARTED", details: { turnNumber: 1 } }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("ターン1");
  });

  it("returns undefined when turnNumber is missing", () => {
    const presentation = battleFlowEventFormatters["TURN_STARTED"]?.(
      event({ type: "TURN_STARTED", details: {} }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("ACTION_QUEUE_CREATED", () => {
  it("resolves the cycle number and reservation count", () => {
    const presentation = battleFlowEventFormatters["ACTION_QUEUE_CREATED"]?.(
      event({
        type: "ACTION_QUEUE_CREATED",
        details: {
          cycleNumber: 1,
          reservations: [
            { battleUnitId: "ally:1", reservedActionKind: "AS", actionSpeed: 10 },
            { battleUnitId: "enemy:1", reservedActionKind: "AS", actionSpeed: 10 },
          ],
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("周回1");
    expect(presentation?.summary).toContain("2件");
  });

  it("returns undefined when reservations is not an array", () => {
    const presentation = battleFlowEventFormatters["ACTION_QUEUE_CREATED"]?.(
      event({ type: "ACTION_QUEUE_CREATED", details: { cycleNumber: 1 } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });

  it("returns undefined when details itself is missing", () => {
    const presentation = battleFlowEventFormatters["ACTION_QUEUE_CREATED"]?.(
      event({ type: "ACTION_QUEUE_CREATED", details: undefined }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("ACTION_QUEUE_REORDERED", () => {
  it("resolves the reordered count", () => {
    const presentation = battleFlowEventFormatters["ACTION_QUEUE_REORDERED"]?.(
      event({
        type: "ACTION_QUEUE_REORDERED",
        details: { before: ["ally:1"], after: ["enemy:1", "ally:1"] },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("2件");
  });

  it("returns undefined when after is not an array", () => {
    const presentation = battleFlowEventFormatters["ACTION_QUEUE_REORDERED"]?.(
      event({ type: "ACTION_QUEUE_REORDERED", details: { before: ["ally:1"] } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("ACTION_RESERVATION_REMOVED", () => {
  it("resolves the removal reason", () => {
    const presentation = battleFlowEventFormatters["ACTION_RESERVATION_REMOVED"]?.(
      event({
        type: "ACTION_RESERVATION_REMOVED",
        details: { battleUnitId: "enemy:1", reason: "DEFEATED" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("ビー");
    expect(presentation?.summary).toContain("DEFEATED");
  });

  it("returns undefined when reason is missing", () => {
    const presentation = battleFlowEventFormatters["ACTION_RESERVATION_REMOVED"]?.(
      event({ type: "ACTION_RESERVATION_REMOVED", details: { battleUnitId: "enemy:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("ACTION_WAITED", () => {
  it("resolves the wait reason and consumed resource", () => {
    const presentation = battleFlowEventFormatters["ACTION_WAITED"]?.(
      event({
        type: "ACTION_WAITED",
        details: {
          actorUnitId: "ally:1",
          waitReason: "INSUFFICIENT_AP",
          consumedResource: "AP",
          consumedAmount: 1,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("INSUFFICIENT_AP");
    expect(presentation?.summary).toContain("AP 1");
  });

  it("returns undefined when consumedAmount is missing", () => {
    const presentation = battleFlowEventFormatters["ACTION_WAITED"]?.(
      event({
        type: "ACTION_WAITED",
        details: { actorUnitId: "ally:1", waitReason: "INSUFFICIENT_AP", consumedResource: "AP" },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

// formatEvent経由の間接テストが無く、UNIT_DEFEATEDは本モジュールでしか駆動されない。
describe("UNIT_DEFEATED", () => {
  it("resolves the defeated unit as a negative event", () => {
    const presentation = battleFlowEventFormatters["UNIT_DEFEATED"]?.(
      event({
        type: "UNIT_DEFEATED",
        targetUnitIds: ["enemy:1"],
        details: { unitId: "enemy:1", causeEventId: "evt:23" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("ビー");
    expect(presentation?.severity).toBe("negative");
  });

  it("returns undefined when unitId is missing", () => {
    const presentation = battleFlowEventFormatters["UNIT_DEFEATED"]?.(
      event({ type: "UNIT_DEFEATED", details: { causeEventId: "evt:23" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("BATTLE_COMPLETED", () => {
  it("resolves the outcome and completion reason", () => {
    const presentation = battleFlowEventFormatters["BATTLE_COMPLETED"]?.(
      event({
        type: "BATTLE_COMPLETED",
        details: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("ALLY_WIN");
    expect(presentation?.summary).toContain("ENEMY_DEFEATED");
  });

  it("returns undefined when completionReason is missing", () => {
    const presentation = battleFlowEventFormatters["BATTLE_COMPLETED"]?.(
      event({ type: "BATTLE_COMPLETED", details: { outcome: "ALLY_WIN" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});
