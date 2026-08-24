import { describe, expect, it } from "vitest";
import { skillEventFormatters } from "./skill-event-formatters.js";
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

describe("COOLDOWN_STARTED", () => {
  it("resolves the skill id and initial remaining count", () => {
    const presentation = skillEventFormatters["COOLDOWN_STARTED"]?.(
      event({
        type: "COOLDOWN_STARTED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_1", initialRemaining: 3 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("エー");
    expect(presentation?.summary).toContain("3");
    expect(presentation?.severity).toBe("neutral");
  });

  it("returns undefined when initialRemaining is missing", () => {
    const presentation = skillEventFormatters["COOLDOWN_STARTED"]?.(
      event({
        type: "COOLDOWN_STARTED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_1" },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("COOLDOWN_REDUCED", () => {
  it("resolves the before/after remaining count", () => {
    const presentation = skillEventFormatters["COOLDOWN_REDUCED"]?.(
      event({
        type: "COOLDOWN_REDUCED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_1", before: 3, after: 2 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("3 → 2");
  });

  it("returns undefined when after is missing", () => {
    const presentation = skillEventFormatters["COOLDOWN_REDUCED"]?.(
      event({
        type: "COOLDOWN_REDUCED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_1", before: 3 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("COOLDOWN_COMPLETED", () => {
  it("resolves the skill id", () => {
    const presentation = skillEventFormatters["COOLDOWN_COMPLETED"]?.(
      event({
        type: "COOLDOWN_COMPLETED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_1" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("SKL_1");
  });

  it("returns undefined when skillDefinitionId is missing", () => {
    const presentation = skillEventFormatters["COOLDOWN_COMPLETED"]?.(
      event({ type: "COOLDOWN_COMPLETED", details: { actorUnitId: "ally:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("CHARGE_STARTED", () => {
  it("resolves the skill id", () => {
    const presentation = skillEventFormatters["CHARGE_STARTED"]?.(
      event({
        type: "CHARGE_STARTED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_2" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("SKL_2");
  });

  it("returns undefined when skillDefinitionId is missing", () => {
    const presentation = skillEventFormatters["CHARGE_STARTED"]?.(
      event({ type: "CHARGE_STARTED", details: { actorUnitId: "ally:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("CHARGE_RELEASED", () => {
  it("resolves the skill id", () => {
    const presentation = skillEventFormatters["CHARGE_RELEASED"]?.(
      event({
        type: "CHARGE_RELEASED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_2" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("SKL_2");
  });

  it("returns undefined when skillDefinitionId is missing", () => {
    const presentation = skillEventFormatters["CHARGE_RELEASED"]?.(
      event({ type: "CHARGE_RELEASED", details: { actorUnitId: "ally:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

// R-SKL-05/R-STS-03（Issue #180）: 凍結・気絶とチャージの相互作用。formatEvent経由の
// 間接テストが無く、CHARGE_CANCELLED/CHARGE_HELD_BY_FREEZEは本モジュールでしか駆動されない。
describe("CHARGE_CANCELLED", () => {
  it("resolves the skill id and cancellation reason as a negative event", () => {
    const presentation = skillEventFormatters["CHARGE_CANCELLED"]?.(
      event({
        type: "CHARGE_CANCELLED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_2", reason: "STUNNED" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("SKL_2");
    expect(presentation?.summary).toContain("STUNNED");
    expect(presentation?.severity).toBe("negative");
  });

  it("returns undefined when reason is missing", () => {
    const presentation = skillEventFormatters["CHARGE_CANCELLED"]?.(
      event({
        type: "CHARGE_CANCELLED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_2" },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("CHARGE_HELD_BY_FREEZE", () => {
  it("resolves the skill id as a neutral wait event", () => {
    const presentation = skillEventFormatters["CHARGE_HELD_BY_FREEZE"]?.(
      event({
        type: "CHARGE_HELD_BY_FREEZE",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_2" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("エー");
    expect(presentation?.summary).toContain("SKL_2");
    expect(presentation?.severity).toBe("neutral");
  });

  it("returns undefined when skillDefinitionId is missing", () => {
    const presentation = skillEventFormatters["CHARGE_HELD_BY_FREEZE"]?.(
      event({ type: "CHARGE_HELD_BY_FREEZE", details: { actorUnitId: "ally:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("PASSIVE_ACTIVATED", () => {
  it("resolves the skill id and PP/EX change (R-PS-05)", () => {
    const presentation = skillEventFormatters["PASSIVE_ACTIVATED"]?.(
      event({
        type: "PASSIVE_ACTIVATED",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "PS_1",
          ppBefore: 0,
          ppAfter: 1,
          exBefore: 0,
          exAfter: 0,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("PP 0 → 1");
  });

  it("returns undefined when exAfter is missing", () => {
    const presentation = skillEventFormatters["PASSIVE_ACTIVATED"]?.(
      event({
        type: "PASSIVE_ACTIVATED",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "PS_1",
          ppBefore: 0,
          ppAfter: 1,
          exBefore: 0,
        },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("PASSIVE_RESOLVED", () => {
  it("resolves the resolved step count", () => {
    const presentation = skillEventFormatters["PASSIVE_RESOLVED"]?.(
      event({
        type: "PASSIVE_RESOLVED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "PS_1", resolvedStepCount: 2 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("2step");
  });

  it("returns undefined when resolvedStepCount is missing", () => {
    const presentation = skillEventFormatters["PASSIVE_RESOLVED"]?.(
      event({
        type: "PASSIVE_RESOLVED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "PS_1" },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("PASSIVE_INTERRUPTED", () => {
  it("resolves the reason and unresolved effect count as negative severity (R-PS-05 #6)", () => {
    const presentation = skillEventFormatters["PASSIVE_INTERRUPTED"]?.(
      event({
        type: "PASSIVE_INTERRUPTED",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "PS_1",
          reason: "DEFEATED",
          unresolvedEffectCount: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.severity).toBe("negative");
  });

  it("returns undefined when unresolvedEffectCount is missing", () => {
    const presentation = skillEventFormatters["PASSIVE_INTERRUPTED"]?.(
      event({
        type: "PASSIVE_INTERRUPTED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "PS_1", reason: "DEFEATED" },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("PASSIVE_POINT_CONSUMED", () => {
  it("resolves the before/after PP and consumed amount (R-PS-05 #2)", () => {
    const presentation = skillEventFormatters["PASSIVE_POINT_CONSUMED"]?.(
      event({
        type: "PASSIVE_POINT_CONSUMED",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "PS_1",
          before: 3,
          after: 1,
          consumedAmount: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("消費2");
  });

  it("returns undefined when consumedAmount is missing", () => {
    const presentation = skillEventFormatters["PASSIVE_POINT_CONSUMED"]?.(
      event({
        type: "PASSIVE_POINT_CONSUMED",
        details: { actorUnitId: "ally:1", skillDefinitionId: "PS_1", before: 3, after: 1 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});
