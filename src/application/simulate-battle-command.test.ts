import { describe, expect, it } from "vitest";
import { validateCommandShape, type SimulateBattleCommand } from "./simulate-battle-command.js";
import { createMemoryDefinitionId, createUnitDefinitionId } from "../domain/catalog/catalog-ids.js";

function slot(column: 0 | 1 | 2, row: "FRONT" | "REAR" = "FRONT") {
  return { unitDefinitionId: createUnitDefinitionId("UNIT_001"), position: { column, row } };
}

function validCommand(overrides: Partial<SimulateBattleCommand> = {}): SimulateBattleCommand {
  return {
    allyFormation: { slots: [slot(0)], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot(1)], memoryDefinitionIds: [] },
    turnLimit: 30,
    logLevel: "DETAILED",
    ...overrides,
  };
}

describe("validateCommandShape", () => {
  it("UT-CMD-001: returns no violations for a valid command", () => {
    expect(validateCommandShape(validCommand())).toEqual([]);
  });

  it("UT-CMD-002: rejects a turnLimit below 1", () => {
    const violations = validateCommandShape(validCommand({ turnLimit: 0 }));
    expect(violations).toContainEqual(expect.objectContaining({ path: "turnLimit" }));
  });

  it("UT-CMD-003: rejects a turnLimit above 99", () => {
    const violations = validateCommandShape(validCommand({ turnLimit: 100 }));
    expect(violations).toContainEqual(expect.objectContaining({ path: "turnLimit" }));
  });

  it("UT-CMD-004: rejects a non-integer turnLimit", () => {
    const violations = validateCommandShape(validCommand({ turnLimit: 1.5 }));
    expect(violations).toContainEqual(expect.objectContaining({ path: "turnLimit" }));
  });

  it("UT-CMD-005: rejects an allyFormation with no slots", () => {
    const violations = validateCommandShape(
      validCommand({ allyFormation: { slots: [], memoryDefinitionIds: [] } }),
    );
    expect(violations).toContainEqual(expect.objectContaining({ path: "allyFormation.slots" }));
  });

  it("UT-CMD-006: rejects an enemyFormation with more than 5 slots", () => {
    const violations = validateCommandShape(
      validCommand({
        enemyFormation: {
          slots: [slot(0), slot(1), slot(2), slot(0, "REAR"), slot(1, "REAR"), slot(2, "REAR")],
          memoryDefinitionIds: [],
        },
      }),
    );
    expect(violations).toContainEqual(expect.objectContaining({ path: "enemyFormation.slots" }));
  });

  it("UT-CMD-007: rejects duplicate positions within the same formation", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: { slots: [slot(0), slot(0)], memoryDefinitionIds: [] },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[1].position" }),
    );
  });

  it("UT-CMD-008: allows the same position across different formations (separate boards)", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: { slots: [slot(0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [slot(0)], memoryDefinitionIds: [] },
      }),
    );
    expect(violations).toEqual([]);
  });

  it("UT-CMD-009: rejects more than 6 memoryDefinitionIds", () => {
    const memoryDefinitionIds = Array.from({ length: 7 }, (_, i) =>
      createMemoryDefinitionId(`MEM_${i}`),
    );
    const violations = validateCommandShape(
      validCommand({ allyFormation: { slots: [slot(0)], memoryDefinitionIds } }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.memoryDefinitionIds" }),
    );
  });

  it("UT-CMD-010: rejects an invalid logLevel", () => {
    const violations = validateCommandShape(
      // @ts-expect-error deliberately invalid for the test
      validCommand({ logLevel: "VERBOSE" }),
    );
    expect(violations).toContainEqual(expect.objectContaining({ path: "logLevel" }));
  });

  it("UT-CMD-011: collects every violation in a single call rather than failing on the first (09_アプリケーション設計.md)", () => {
    const violations = validateCommandShape(
      validCommand({
        turnLimit: 0,
        allyFormation: { slots: [], memoryDefinitionIds: [] },
      }),
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});
