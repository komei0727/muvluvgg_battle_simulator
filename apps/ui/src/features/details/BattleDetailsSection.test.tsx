import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BattleDetailsSection } from "./BattleDetailsSection.js";
import type { BattleSimulationResponse } from "../simulation/api-contract.js";

const response: BattleSimulationResponse = {
  schemaVersion: 1,
  battleId: "battle-1",
  catalogRevision: "rev-1",
  result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
  initialState: { units: [] },
  finalState: { units: [] },
  events: [
    {
      sequence: 1,
      type: "BATTLE_STARTED",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: [],
      details: { turnLimit: 10 },
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      stateTransitionIndex: 0,
    },
  ],
  stateTransitions: [
    {
      causedBySequence: 1,
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      delta: { battle: { battleStatus: { before: "READY", after: "RUNNING" } } },
    },
  ],
};

describe("BattleDetailsSection", () => {
  it("switches between events, transitions, and JSON within a single page (UI-AC-010)", async () => {
    const user = userEvent.setup();
    render(<BattleDetailsSection response={response} />);

    expect(screen.getByRole("button", { name: /BATTLE_STARTED/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "状態遷移" }));
    expect(screen.getByRole("columnheader", { name: "CAUSED BY" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "レスポンスJSON" }));
    expect(screen.getByText(/"battleId": "battle-1"/)).toBeInTheDocument();
  });

  it("jumps from an event's state transition link to the transitions tab", async () => {
    const user = userEvent.setup();
    render(<BattleDetailsSection response={response} />);

    await user.click(screen.getByRole("button", { name: /BATTLE_STARTED/ }));
    await user.click(screen.getByRole("button", { name: /状態遷移 #1/ }));

    expect(screen.getByRole("tab", { name: "状態遷移" })).toHaveAttribute("aria-selected", "true");
  });
});
