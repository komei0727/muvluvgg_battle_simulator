import { describe, expect, it } from "vitest";
import { toSimulateBattleCommand } from "./simulate-battle-request-mapper.js";
import type { BattleSimulationRequestBody } from "../contracts/simulation.js";

function requestBody(
  overrides: Partial<BattleSimulationRequestBody> = {},
): BattleSimulationRequestBody {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "unit-001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "unit-101", position: { column: 1, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 10,
    ...overrides,
  };
}

describe("toSimulateBattleCommand", () => {
  it("API-SIM-001: maps allyFormation/enemyFormation slots, positions, memoryDefinitionIds, and turnLimit straight through", () => {
    const command = toSimulateBattleCommand(requestBody());

    expect(command.allyFormation.slots).toEqual([
      { unitDefinitionId: "unit-001", position: { column: 0, row: "FRONT" } },
    ]);
    expect(command.enemyFormation.slots).toEqual([
      { unitDefinitionId: "unit-101", position: { column: 1, row: "FRONT" } },
    ]);
    expect(command.turnLimit).toBe(10);
  });

  it("API-SIM-002: defaults logLevel to DETAILED when options is omitted", () => {
    const command = toSimulateBattleCommand(requestBody());

    expect(command.logLevel).toBe("DETAILED");
  });

  it("API-SIM-003: defaults logLevel to DETAILED when options.logLevel is omitted", () => {
    const command = toSimulateBattleCommand(requestBody({ options: {} }));

    expect(command.logLevel).toBe("DETAILED");
  });

  it("API-SIM-004: passes through an explicit options.logLevel", () => {
    const command = toSimulateBattleCommand(requestBody({ options: { logLevel: "SUMMARY" } }));

    expect(command.logLevel).toBe("SUMMARY");
  });

  it("API-SIM-005: passes through memoryDefinitionIds without validating format (existence is a Preflight concern)", () => {
    const command = toSimulateBattleCommand(
      requestBody({
        allyFormation: {
          units: [{ unitDefinitionId: "unit-001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: ["memory-001"],
        },
      }),
    );

    expect(command.allyFormation.memoryDefinitionIds).toEqual(["memory-001"]);
  });

  it("API-SIM-006: does not throw for a definition ID that does not match the Catalog's UNIT_/MEM_ prefix convention — unknown-format IDs are left for Preflight's DEFINITION_NOT_FOUND check, not rejected here as a format error", () => {
    // Domain's `createUnitDefinitionId` would throw for a non-"UNIT_"-prefixed
    // value; the Inbound Adapter must not perform that check, since the API
    // contract documents unitDefinitionId as an opaque string with no format
    // constraint (10_API設計.md's own request example uses "unit-001").
    expect(() => toSimulateBattleCommand(requestBody())).not.toThrow();
  });
});
