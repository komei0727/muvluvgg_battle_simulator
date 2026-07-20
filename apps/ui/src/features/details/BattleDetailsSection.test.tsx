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
  it("switches between events, transitions, JSON, unit state, and the causality tree within a single page (UI-AC-010)", async () => {
    const user = userEvent.setup();
    render(<BattleDetailsSection response={response} logLevel="DETAILED" />);

    expect(screen.getByRole("button", { name: /BATTLE_STARTED/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "状態遷移" }));
    expect(screen.getByRole("columnheader", { name: "CAUSED BY" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "レスポンスJSON" }));
    expect(screen.getByText(/"battleId": "battle-1"/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "ユニット状態" }));
    expect(screen.getByText("ALLY ACTION STATE")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "因果ツリー" }));
    expect(screen.getByRole("button", { name: /BATTLE_STARTED/ })).toBeInTheDocument();
  });

  it("jumps from an event's state transition link to the transitions tab", async () => {
    const user = userEvent.setup();
    render(<BattleDetailsSection response={response} logLevel="DETAILED" />);

    await user.click(screen.getByRole("button", { name: /BATTLE_STARTED/ }));
    await user.click(screen.getByRole("button", { name: /状態遷移 #1/ }));

    expect(screen.getByRole("tab", { name: "状態遷移" })).toHaveAttribute("aria-selected", "true");
  });

  // M4.5 regression fixture (apps/ui/e2e/fixtures/battle-success.ts): units
  // without resources/cooldowns/charge, and an unrecognized future event type.
  // The M5 "ユニット状態" tab and the M5 event formatters must not assume
  // these fields exist (issue #100 acceptance criterion: M4.5 fixtureを引き
  // 続き表示できる).
  it("renders an M4.5-shaped fixture (no resources/cooldowns/charge, unknown event type) without crashing", async () => {
    const legacyResponse: BattleSimulationResponse = {
      schemaVersion: 1,
      battleId: "battle-e2e-001",
      catalogRevision: "rev-1",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 2 },
      initialState: {
        units: [
          {
            battleUnitId: "bu-ally-1",
            unitDefinitionId: "UNIT_ALLY_A",
            side: "ALLY",
            combatStatus: "ACTIVE",
            hp: { current: 100, maximum: 100 },
          },
          {
            battleUnitId: "bu-enemy-1",
            unitDefinitionId: "UNIT_ENEMY_A",
            side: "ENEMY",
            combatStatus: "ACTIVE",
            hp: { current: 80, maximum: 80 },
          },
        ],
      },
      finalState: {
        units: [
          {
            battleUnitId: "bu-ally-1",
            unitDefinitionId: "UNIT_ALLY_A",
            side: "ALLY",
            combatStatus: "ACTIVE",
            hp: { current: 100, maximum: 100 },
          },
          {
            battleUnitId: "bu-enemy-1",
            unitDefinitionId: "UNIT_ENEMY_A",
            side: "ENEMY",
            combatStatus: "DEFEATED",
            hp: { current: 0, maximum: 80 },
          },
        ],
      },
      events: [
        {
          sequence: 0,
          type: "TURN_STARTED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 0,
          targetUnitIds: [],
          details: { turnNumber: 1 },
          stateVersionBefore: 0,
          stateVersionAfter: 1,
        },
        {
          sequence: 1,
          type: "DAMAGE_APPLIED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 1,
          sourceUnitId: "bu-ally-1",
          targetUnitIds: ["bu-enemy-1"],
          details: {
            targetUnitId: "bu-enemy-1",
            calculatedDamage: 80,
            hitPointDamage: 80,
            hpBefore: 80,
            hpAfter: 0,
          },
          stateVersionBefore: 1,
          stateVersionAfter: 2,
          stateTransitionIndex: 0,
        },
        {
          sequence: 2,
          type: "MYSTERIOUS_FUTURE_EVENT",
          category: "FACT",
          turnNumber: 2,
          cycleNumber: 1,
          rootSequence: 2,
          sourceUnitId: "bu-ally-1",
          targetUnitIds: ["bu-enemy-1"],
          details: { note: "not yet contracted by any milestone" },
          stateVersionBefore: 2,
          stateVersionAfter: 2,
        },
      ],
      stateTransitions: [
        {
          causedBySequence: 1,
          stateVersionBefore: 1,
          stateVersionAfter: 2,
          delta: { units: { "bu-enemy-1": { hp: { current: 0 }, combatStatus: "DEFEATED" } } },
        },
      ],
    };

    const user = userEvent.setup();
    render(<BattleDetailsSection response={legacyResponse} logLevel="DETAILED" />);

    expect(screen.getByRole("button", { name: /MYSTERIOUS_FUTURE_EVENT/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "ユニット状態" }));

    expect(screen.getAllByText("AP -")).toHaveLength(2);
    expect(screen.getAllByText("クールタイムなし")).toHaveLength(2);
  });
});
