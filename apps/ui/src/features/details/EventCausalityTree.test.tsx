import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EventCausalityTree } from "./EventCausalityTree.js";
import { buildRosterIndex } from "./event-formatters.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
];
const rosterIndex = buildRosterIndex(roster);

function baseEvent(
  overrides: Partial<BattleLogEventResponse> & { sequence: number; type: string },
): BattleLogEventResponse {
  return {
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.parentSequence !== undefined ? 1 : overrides.sequence,
    targetUnitIds: [],
    details: {},
    stateVersionBefore: 0,
    stateVersionAfter: 0,
    ...overrides,
  } satisfies BattleLogEventResponse;
}

describe("EventCausalityTree", () => {
  it("nests a PS activation event beneath its causing action, indented under the parent row", () => {
    const events = [
      baseEvent({
        sequence: 1,
        type: "ACTION_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          reservedActionType: "AS",
          effectiveActionType: "AS",
          apBefore: 3,
          apAfter: 2,
          exBefore: 0,
          exAfter: 0,
        },
      }),
      baseEvent({
        sequence: 2,
        type: "PASSIVE_ACTIVATED",
        parentSequence: 1,
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKL_PS_1",
          ppBefore: 5,
          ppAfter: 3,
          exBefore: 0,
          exAfter: 2,
          triggerEventId: "evt-1",
        },
      }),
    ];

    render(<EventCausalityTree events={events} roster={rosterIndex} />);

    const parentRow = screen.getByRole("button", { name: /ACTION_STARTED/ }).closest("li")!;
    expect(
      within(parentRow).getByRole("button", { name: /PASSIVE_ACTIVATED/ }),
    ).toBeInTheDocument();
  });

  it("keeps a DIAGNOSTIC node's descendants collapsed by default without dropping them, and reveals them on expand", async () => {
    const user = userEvent.setup();
    const events = [
      baseEvent({ sequence: 1, type: "ACTION_STARTED" }),
      baseEvent({
        sequence: 2,
        type: "EXTRA_GAUGE_OVERFLOW_DISCARDED",
        category: "DIAGNOSTIC",
        parentSequence: 1,
        details: {
          battleUnitId: "ally:1",
          requestedAmount: 15,
          actualAmount: 10,
          discardedAmount: 5,
        },
      }),
      baseEvent({ sequence: 3, type: "RESOURCE_CHANGED", parentSequence: 2 }),
    ];

    render(<EventCausalityTree events={events} roster={rosterIndex} />);

    expect(
      screen.getByRole("button", { name: /EXTRA_GAUGE_OVERFLOW_DISCARDED/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /RESOURCE_CHANGED/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /DIAGNOSTIC配下.*1件/ }));

    expect(screen.getByRole("button", { name: /RESOURCE_CHANGED/ })).toBeInTheDocument();
  });

  it("renders every root and descendant event without dropping any (詳細ログを黙って削除しない)", () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      baseEvent({ sequence: index + 1, type: "TURN_STARTED", details: { turnNumber: 1 } }),
    );

    render(<EventCausalityTree events={events} roster={rosterIndex} />);

    expect(screen.getAllByRole("button", { name: /TURN_STARTED/ })).toHaveLength(60);
  });

  it("renders an unknown future event type without crashing (UI-AC-011)", () => {
    const events = [baseEvent({ sequence: 1, type: "SOME_FUTURE_EVENT", details: { odd: true } })];

    render(<EventCausalityTree events={events} roster={rosterIndex} />);

    expect(screen.getByRole("button", { name: /SOME_FUTURE_EVENT/ })).toBeInTheDocument();
  });
});
