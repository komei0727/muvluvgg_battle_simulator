import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnitActionStateSection } from "./UnitActionStateSection.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";

function catalogWith(
  units: BattleSimulationCatalogResponse["units"],
): BattleSimulationCatalogResponse {
  return { schemaVersion: 1, catalogRevision: "rev-1", units, memories: [] };
}

function responseWith(overrides: {
  units: readonly Record<string, unknown>[];
  events?: BattleSimulationResponse["events"];
}): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: overrides.units as never },
    finalState: { units: overrides.units as never },
    events: overrides.events ?? [],
    stateTransitions: [],
  };
}

describe("UnitActionStateSection", () => {
  it("shows AP/EX for each battleUnitId in the ally and enemy groups (UI-UT-ACT-010)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          resources: { ap: { current: 2, maximum: 3 }, extraGauge: { current: 40, maximum: 100 } },
        },
        {
          battleUnitId: "enemy:1",
          unitDefinitionId: "UNIT_B",
          side: "ENEMY",
          resources: { ap: { current: 1, maximum: 3 }, extraGauge: { current: 0, maximum: 100 } },
        },
      ],
    });

    render(<UnitActionStateSection response={response} />);

    expect(screen.getByText("AP 2 / 3")).toBeInTheDocument();
    expect(screen.getByText("EX 40 / 100")).toBeInTheDocument();
    expect(screen.getByText("AP 1 / 3")).toBeInTheDocument();
    expect(screen.getByText("EX 0 / 100")).toBeInTheDocument();
  });

  it("resolves displayName from the catalog", () => {
    const catalog = catalogWith([
      {
        unitDefinitionId: "UNIT_A",
        displayName: "エー",
        characterName: "エー",
        attribute: "CUTE",
        unitType: "HUMANOID",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
        selectable: true,
        unavailableCapabilities: [],
      },
    ]);
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} catalog={catalog} />);

    expect(screen.getByText("エー")).toBeInTheDocument();
  });

  it("shows a cooldown derived from COOLDOWN_STARTED with the skill id and remaining count", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
      events: [
        {
          sequence: 1,
          type: "COOLDOWN_STARTED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: [],
          details: {
            actorUnitId: "ally:1",
            skillDefinitionId: "SKILL_1",
            unit: "TURN",
            initialRemaining: 3,
          },
          stateVersionBefore: 0,
          stateVersionAfter: 0,
        },
      ],
    });

    render(<UnitActionStateSection response={response} />);

    expect(screen.getByText(/SKILL_1/)).toBeInTheDocument();
    expect(screen.getByText(/残り3/)).toBeInTheDocument();
  });

  it("shows a charging skill id when CHARGE_STARTED has no matching CHARGE_RELEASED", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
      events: [
        {
          sequence: 1,
          type: "CHARGE_STARTED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: [],
          details: {
            actorUnitId: "ally:1",
            skillDefinitionId: "SKILL_2",
            startedActionId: "action-1",
          },
          stateVersionBefore: 0,
          stateVersionAfter: 0,
        },
      ],
    });

    render(<UnitActionStateSection response={response} />);

    expect(screen.getByText(/チャージ中/)).toBeInTheDocument();
    expect(screen.getByText(/SKILL_2/)).toBeInTheDocument();
  });

  it("shows a dash for AP/EX and no cooldown row for an M4 fixture unit without resources/events (back-compat)", () => {
    const response = responseWith({
      units: [{ battleUnitId: "bu-ally-1", unitDefinitionId: "UNIT_ALLY_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} />);

    expect(screen.getByText("AP -")).toBeInTheDocument();
    expect(screen.getByText("EX -")).toBeInTheDocument();
    expect(screen.getByText("クールタイムなし")).toBeInTheDocument();
  });
});
