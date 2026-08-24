import { describe, expect, it } from "vitest";
import { resourceEventFormatters } from "./resource-event-formatters.js";
import { buildRosterIndex } from "./event-presentation.js";
import type { RosterEntry } from "../../entities/roster.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
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

// details shape mirrors apps/ui/src/test/fixtures/success-unknown-event.json (REF-053)
// rather than being invented ad hoc.
describe("RESOURCE_CHANGED", () => {
  it("resolves the resource kind, before/after, and reason", () => {
    const presentation = resourceEventFormatters["RESOURCE_CHANGED"]?.(
      event({
        type: "RESOURCE_CHANGED",
        details: {
          battleUnitId: "ally:1",
          resource: "AP",
          before: 0,
          after: 3,
          delta: 3,
          baseDelta: 3,
          reason: "TURN_RECOVERY",
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("エー");
    expect(presentation?.summary).toContain("AP");
    expect(presentation?.summary).toContain("0 → 3");
    expect(presentation?.summary).toContain("TURN_RECOVERY");
  });

  it("returns undefined when reason is missing", () => {
    const presentation = resourceEventFormatters["RESOURCE_CHANGED"]?.(
      event({
        type: "RESOURCE_CHANGED",
        details: { battleUnitId: "ally:1", resource: "AP", before: 0, after: 3 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EXTRA_GAUGE_INCREASED", () => {
  it("resolves the cause resource and increased amount (R-ACT-03)", () => {
    const presentation = resourceEventFormatters["EXTRA_GAUGE_INCREASED"]?.(
      event({
        type: "EXTRA_GAUGE_INCREASED",
        details: {
          battleUnitId: "ally:1",
          causeResource: "AP",
          before: 10,
          after: 15,
          increasedAmount: 5,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("10 → 15");
    expect(presentation?.summary).toContain("AP消費起因");
    expect(presentation?.summary).toContain("+5");
  });

  it("returns undefined when increasedAmount is missing", () => {
    const presentation = resourceEventFormatters["EXTRA_GAUGE_INCREASED"]?.(
      event({
        type: "EXTRA_GAUGE_INCREASED",
        details: { battleUnitId: "ally:1", causeResource: "AP", before: 10, after: 15 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EXTRA_GAUGE_OVERFLOW_DISCARDED", () => {
  it("resolves the discarded amount", () => {
    const presentation = resourceEventFormatters["EXTRA_GAUGE_OVERFLOW_DISCARDED"]?.(
      event({
        type: "EXTRA_GAUGE_OVERFLOW_DISCARDED",
        details: {
          battleUnitId: "ally:1",
          requestedAmount: 20,
          actualAmount: 15,
          discardedAmount: 5,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("要求20");
    expect(presentation?.summary).toContain("実際15");
    expect(presentation?.summary).toContain("5を切り捨てました");
  });

  it("returns undefined when discardedAmount is missing", () => {
    const presentation = resourceEventFormatters["EXTRA_GAUGE_OVERFLOW_DISCARDED"]?.(
      event({
        type: "EXTRA_GAUGE_OVERFLOW_DISCARDED",
        details: { battleUnitId: "ally:1", requestedAmount: 20, actualAmount: 15 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});
