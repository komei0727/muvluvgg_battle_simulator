import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BattleSummarySection } from "./BattleSummarySection.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";

const catalog: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: [
    {
      unitDefinitionId: "UNIT_A",
      displayName: "エーユニット",
      characterName: "エーユニット",
      attribute: "CUTE",
      unitType: "HUMANOID",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT"],
      selectable: true,
      unavailableCapabilities: [],
    },
  ],
  memories: [],
};

const response: BattleSimulationResponse = {
  schemaVersion: 1,
  battleId: "battle-1",
  catalogRevision: "rev-1",
  result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
  initialState: {
    units: [
      {
        battleUnitId: "ally:1",
        unitDefinitionId: "UNIT_A",
        side: "ALLY",
        combatStatus: "ACTIVE",
        hp: { current: 100, maximum: 100 },
      },
    ],
  },
  finalState: {
    units: [
      {
        battleUnitId: "ally:1",
        unitDefinitionId: "UNIT_A",
        side: "ALLY",
        combatStatus: "ACTIVE",
        hp: { current: 100, maximum: 100 },
      },
    ],
  },
  events: [],
  stateTransitions: [],
};

describe("BattleSummarySection", () => {
  it("renders the outcome strip and both ally/enemy summary tables", () => {
    render(<BattleSummarySection response={response} catalog={catalog} turnLimit={10} />);

    expect(screen.getByText("ALLY WIN / 味方勝利")).toBeInTheDocument();
    expect(screen.getByText("ALLY UNIT SUMMARY")).toBeInTheDocument();
    expect(screen.getByText("ENEMY UNIT SUMMARY")).toBeInTheDocument();
  });

  it("shows a contract-mismatch error instead of a fabricated summary when finalState is missing a roster unit", () => {
    const responseMissingFinalUnit: BattleSimulationResponse = {
      ...response,
      finalState: { units: [] },
    };

    render(
      <BattleSummarySection response={responseMissingFinalUnit} catalog={catalog} turnLimit={10} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("レスポンスの形式が想定と異なります。");
    expect(screen.queryByText("ALLY UNIT SUMMARY")).not.toBeInTheDocument();
    // OutcomeStrip data doesn't depend on the roster/finalState correspondence.
    expect(screen.getByText("ALLY WIN / 味方勝利")).toBeInTheDocument();
  });

  it("shows a projection warning banner when a DAMAGE_APPLIED event could not be aggregated", () => {
    const responseWithMalformedEvent: BattleSimulationResponse = {
      ...response,
      events: [{ sequence: 1, type: "DAMAGE_APPLIED", details: {} }],
    };

    render(
      <BattleSummarySection
        response={responseWithMalformedEvent}
        catalog={catalog}
        turnLimit={10}
      />,
    );

    expect(screen.getByText("一部イベントを集計できませんでした。")).toBeInTheDocument();
  });
});
