import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BattleSummarySection } from "./BattleSummarySection.js";
import { OutcomeStrip } from "./OutcomeStrip.js";
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
  it("renders the caller-supplied header and both ally/enemy summary tables", () => {
    render(
      <BattleSummarySection
        response={response}
        catalog={catalog}
        header={
          <OutcomeStrip
            result={response.result}
            turnLimit={10}
            battleId="b"
            catalogRevision="rev-1"
          />
        }
      />,
    );

    expect(screen.getByText("ALLY WIN / 味方勝利")).toBeInTheDocument();
    expect(screen.getByText("ALLY UNIT SUMMARY")).toBeInTheDocument();
    expect(screen.getByText("ENEMY UNIT SUMMARY")).toBeInTheDocument();
  });

  it("forwards imageMap to both ally and enemy unit summary tables", () => {
    const responseWithBothSides: BattleSimulationResponse = {
      ...response,
      initialState: {
        units: [
          ...response.initialState.units,
          {
            battleUnitId: "enemy:1",
            unitDefinitionId: "UNIT_A",
            side: "ENEMY",
            combatStatus: "ACTIVE",
            hp: { current: 100, maximum: 100 },
          },
        ],
      },
      finalState: {
        units: [
          ...response.finalState.units,
          {
            battleUnitId: "enemy:1",
            unitDefinitionId: "UNIT_A",
            side: "ENEMY",
            combatStatus: "ACTIVE",
            hp: { current: 100, maximum: 100 },
          },
        ],
      },
    };

    render(
      <BattleSummarySection
        response={responseWithBothSides}
        catalog={catalog}
        header={null}
        imageMap={{ UNIT_A: "/assets/unit-a.webp" }}
      />,
    );

    const images = screen.getAllByRole("img", { name: "エーユニット" });
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.tagName).toBe("IMG");
      expect(image.getAttribute("src")).toBe("/assets/unit-a.webp");
    }
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
        header={null}
      />,
    );

    expect(screen.getByText("一部イベントを集計できませんでした。")).toBeInTheDocument();
  });
});
