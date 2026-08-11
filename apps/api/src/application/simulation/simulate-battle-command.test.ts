import { describe, expect, it } from "vitest";
import { validateCommandShape, type SimulateBattleCommand } from "./simulate-battle-command.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

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

  it("UT-CMD-012 (09_アプリケーション設計.md「columnが0～2」): rejects a column outside 0..2", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [
            {
              unitDefinitionId: createUnitDefinitionId("UNIT_001"),
              // @ts-expect-error deliberately invalid for the test
              position: { column: 3, row: "FRONT" },
            },
          ],
          memoryDefinitionIds: [],
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].position.column" }),
    );
  });

  it("UT-CMD-013 (09_アプリケーション設計.md「rowがFRONTまたはREAR」): rejects a row that is neither FRONT nor REAR", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [
            {
              unitDefinitionId: createUnitDefinitionId("UNIT_001"),
              // @ts-expect-error deliberately invalid for the test
              position: { column: 0, row: "SIDE" },
            },
          ],
          memoryDefinitionIds: [],
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].position.row" }),
    );
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

  it("UT-CMD-014 (R-ENH-01/02/04): accepts a fully specified enhancement", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [
            {
              ...slot(0),
              enhancement: {
                level: 220,
                gears: [{ stat: "ATTACK", tier: "III", grade: "S" }],
              },
            },
          ],
          memoryDefinitionIds: [],
          enhancement: {
            academyLevels: { unitTypes: { PHYSICAL: 50 }, attributes: { AGGRESSIVE: 50 } },
          },
        },
      }),
    );
    expect(violations).toEqual([]);
  });

  it("UT-CMD-015 (R-ENH-01 #4): accepts the defaults spelled out explicitly", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [{ ...slot(0), enhancement: { level: 200, gears: [] } }],
          memoryDefinitionIds: [],
          enhancement: { academyLevels: { unitTypes: { PHYSICAL: 1 }, attributes: {} } },
        },
      }),
    );
    expect(violations).toEqual([]);
  });

  it("UT-CMD-016 (R-ENH-02 #1): rejects an academy level below 1 or non-integer", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [slot(0)],
          memoryDefinitionIds: [],
          enhancement: {
            academyLevels: { unitTypes: { PHYSICAL: 0 }, attributes: { CLEVER: 2.5 } },
          },
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "allyFormation.enhancement.academyLevels.unitTypes.PHYSICAL",
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "allyFormation.enhancement.academyLevels.attributes.CLEVER",
      }),
    );
  });

  it("UT-CMD-017 (R-ENH-05 #4): rejects a unit level below 1 or non-integer", () => {
    const violations = validateCommandShape(
      validCommand({
        enemyFormation: {
          slots: [{ ...slot(1), enhancement: { level: 0 } }],
          memoryDefinitionIds: [],
          enhancement: {},
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "enemyFormation.slots[0].enhancement.level" }),
    );
  });

  it("UT-CMD-018 (R-ENH-04 #1): rejects more than 9 gears on one unit", () => {
    const gears = Array.from({ length: 10 }, () => ({
      stat: "MAXIMUM_HP" as const,
      tier: "II" as const,
      grade: "D" as const,
    }));
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [{ ...slot(0), enhancement: { gears } }],
          memoryDefinitionIds: [],
          enhancement: {},
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].enhancement.gears" }),
    );
  });

  it("UT-CMD-019 (R-ENH-04 #2): rejects a gear whose stat, tier or grade is not a defined enum value", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [
            {
              ...slot(0),
              enhancement: {
                gears: [
                  // @ts-expect-error deliberately invalid for the test
                  { stat: "MAXIMUM_AP", tier: "II", grade: "D" },
                  // @ts-expect-error deliberately invalid for the test
                  { stat: "ATTACK", tier: "IV", grade: "D" },
                  // @ts-expect-error deliberately invalid for the test
                  { stat: "ATTACK", tier: "II", grade: "SS" },
                ],
              },
            },
          ],
          memoryDefinitionIds: [],
          enhancement: {},
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].enhancement.gears[0].stat" }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].enhancement.gears[1].tier" }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].enhancement.gears[2].grade" }),
    );
  });

  it("UT-CMD-020 (R-ENH-01 #3): rejects a unit enhancement when its own side has no formation enhancement", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [{ ...slot(0), enhancement: { level: 220 } }],
          memoryDefinitionIds: [],
        },
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "allyFormation.slots[0].enhancement" }),
    );
  });

  it("UT-CMD-021 (R-ENH-01 #6): the two sides' enhancement specifications are independent", () => {
    const violations = validateCommandShape(
      validCommand({
        allyFormation: {
          slots: [slot(0)],
          memoryDefinitionIds: [],
          enhancement: { academyLevels: { unitTypes: { PHYSICAL: 50 } } },
        },
        enemyFormation: { slots: [slot(1)], memoryDefinitionIds: [] },
      }),
    );
    expect(violations).toEqual([]);
  });
});
