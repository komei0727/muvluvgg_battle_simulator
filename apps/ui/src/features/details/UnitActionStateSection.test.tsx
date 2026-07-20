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
  it("shows AP/PP/EX for each battleUnitId in the ally and enemy groups (UI-UT-ACT-010)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          resources: {
            ap: { current: 2, maximum: 3 },
            pp: { current: 5, maximum: 8 },
            extraGauge: { current: 40, maximum: 100 },
          },
        },
        {
          battleUnitId: "enemy:1",
          unitDefinitionId: "UNIT_B",
          side: "ENEMY",
          resources: {
            ap: { current: 1, maximum: 3 },
            pp: { current: 0, maximum: 8 },
            extraGauge: { current: 0, maximum: 100 },
          },
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("AP 2 / 3")).toBeInTheDocument();
    expect(screen.getByText("PP 5 / 8")).toBeInTheDocument();
    expect(screen.getByText("EX 40 / 100")).toBeInTheDocument();
    expect(screen.getByText("AP 1 / 3")).toBeInTheDocument();
    expect(screen.getByText("PP 0 / 8")).toBeInTheDocument();
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

    render(<UnitActionStateSection response={response} catalog={catalog} logLevel="DETAILED" />);

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

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

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

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/チャージ中/)).toBeInTheDocument();
    expect(screen.getByText(/SKILL_2/)).toBeInTheDocument();
  });

  it("shows a dash for AP/PP/EX and no cooldown row for an M4 fixture unit without resources/events (back-compat)", () => {
    const response = responseWith({
      units: [{ battleUnitId: "bu-ally-1", unitDefinitionId: "UNIT_ALLY_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("AP -")).toBeInTheDocument();
    expect(screen.getByText("PP -")).toBeInTheDocument();
    expect(screen.getByText("EX -")).toBeInTheDocument();
    expect(screen.getByText("クールタイムなし")).toBeInTheDocument();
  });

  // PR #131 review: SUMMARYレベルではCOOLDOWN_*/CHARGE_*イベントが公開ログから
  // 除外されるため、実際は残っていても「クールタイムなし」と断定してはいけない。
  it("shows an unknown state instead of asserting no cooldown when logLevel is SUMMARY", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="SUMMARY" />);

    expect(screen.queryByText("クールタイムなし")).not.toBeInTheDocument();
    expect(screen.getByText(/SUMMARYログ/)).toBeInTheDocument();
  });

  it("shows the known cooldown/charge state as usual when logLevel is DETAILED or DIAGNOSTIC", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="DIAGNOSTIC" />);

    expect(screen.getByText("クールタイムなし")).toBeInTheDocument();
    expect(screen.queryByText(/SUMMARYログ/)).not.toBeInTheDocument();
  });
});
