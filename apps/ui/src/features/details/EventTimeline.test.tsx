import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EventTimeline } from "./EventTimeline.js";
import { buildRosterIndex } from "./event-formatters.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
];
const rosterIndex = buildRosterIndex(roster);

function baseEvent(
  overrides: Partial<BattleLogEventResponse> & { sequence: number; type: string },
) {
  return {
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    targetUnitIds: [],
    details: {},
    stateVersionBefore: 0,
    stateVersionAfter: 0,
    ...overrides,
  } satisfies BattleLogEventResponse;
}

describe("EventTimeline", () => {
  it("displays events sorted by sequence ascending regardless of input order (§8.1)", () => {
    const events = [
      baseEvent({
        sequence: 5,
        type: "BATTLE_COMPLETED",
        details: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" },
      }),
      baseEvent({ sequence: 1, type: "BATTLE_STARTED", details: { turnLimit: 10 } }),
    ];

    render(<EventTimeline events={events} roster={rosterIndex} />);

    const rows = screen.getAllByRole("button", { name: /BATTLE_/ });
    expect(rows[0]).toHaveTextContent("BATTLE_STARTED");
    expect(rows[1]).toHaveTextContent("BATTLE_COMPLETED");
  });

  it("shows a concise one-line row and expands details on click", async () => {
    const user = userEvent.setup();
    const events = [
      baseEvent({
        sequence: 1,
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "EFFECT_1",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 200,
          hitPointDamage: 200,
          hpBefore: 1000,
          hpAfter: 800,
          defeated: false,
        },
      }),
    ];

    render(<EventTimeline events={events} roster={rosterIndex} />);

    expect(screen.queryByText(/"hitPointDamage": 200/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /DAMAGE_APPLIED/ }));

    expect(screen.getByText(/"hitPointDamage": 200/)).toBeInTheDocument();
  });

  it("renders an unknown event type as a generic row without crashing (UI-CT-014)", () => {
    const events = [baseEvent({ sequence: 1, type: "SOME_FUTURE_EVENT", details: { odd: true } })];

    render(<EventTimeline events={events} roster={rosterIndex} />);

    expect(screen.getByRole("button", { name: /SOME_FUTURE_EVENT/ })).toBeInTheDocument();
  });

  it("shows only the first 50 events initially and reveals more without silently truncating (UI-CMP-006)", async () => {
    const user = userEvent.setup();
    const events = Array.from({ length: 55 }, (_, index) =>
      baseEvent({ sequence: index + 1, type: "TURN_STARTED", details: { turnNumber: 1 } }),
    );

    render(<EventTimeline events={events} roster={rosterIndex} />);

    expect(screen.getAllByRole("button", { name: /TURN_STARTED/ })).toHaveLength(50);
    expect(screen.getByText(/55件中50件を表示/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "さらに表示" }));

    expect(screen.getAllByRole("button", { name: /TURN_STARTED/ })).toHaveLength(55);
  });

  it("offers a jump action to the owning state transition when stateTransitionIndex is present", async () => {
    const user = userEvent.setup();
    const onJumpToTransition = vi.fn();
    const events = [
      baseEvent({
        sequence: 1,
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        stateTransitionIndex: 3,
        details: {
          targetUnitId: "enemy:1",
          calculatedDamage: 10,
          hitPointDamage: 10,
          hpBefore: 100,
          hpAfter: 90,
        },
      }),
    ];

    render(
      <EventTimeline
        events={events}
        roster={rosterIndex}
        onJumpToTransition={onJumpToTransition}
      />,
    );
    await user.click(screen.getByRole("button", { name: /DAMAGE_APPLIED/ }));
    const row = screen.getByRole("button", { name: /DAMAGE_APPLIED/ }).closest("li")!;
    await user.click(within(row).getByRole("button", { name: /状態遷移 #4/ }));

    expect(onJumpToTransition).toHaveBeenCalledWith(3);
  });
});
