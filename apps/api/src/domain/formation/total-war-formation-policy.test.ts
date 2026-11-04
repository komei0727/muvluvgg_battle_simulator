import { describe, expect, it } from "vitest";
import {
  REAPPEARANCE_BASE_STAT_MULTIPLIER,
  resolveReappearanceMultipliers,
  validateTotalWarFormations,
} from "./total-war-formation-policy.js";
import type { FormationInput, FormationSlotInput } from "../battle/model/formation-input.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
  type MemoryDefinitionId,
} from "../catalog/definitions/catalog-ids.js";
import type { PositionColumn, PositionRow } from "../catalog/definitions/catalog-enums.js";
import { DomainValidationError } from "../shared/errors.js";

const MEMORY_A = createMemoryDefinitionId("MEM_A");
const MEMORY_B = createMemoryDefinitionId("MEM_B");
const KNOWN_MEMORIES: ReadonlySet<MemoryDefinitionId> = new Set([MEMORY_A, MEMORY_B]);

const POSITIONS: readonly (readonly [PositionColumn, PositionRow])[] = [
  ["LEFT", "FRONT"],
  ["CENTER", "FRONT"],
  ["RIGHT", "FRONT"],
  ["LEFT", "BACK"],
  ["CENTER", "BACK"],
];

function formation(
  unitIds: readonly string[],
  memoryDefinitionIds: readonly MemoryDefinitionId[] = [],
): FormationInput {
  const slots: FormationSlotInput[] = unitIds.map((id, index) => {
    const [column, row] = POSITIONS[index]!;
    return { unitDefinitionId: createUnitDefinitionId(id), position: { column, row } };
  });
  return { slots, memoryDefinitionIds };
}

function captureError(run: () => void): DomainValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a DomainValidationError");
}

describe("validateTotalWarFormations (R-TWR-01)", () => {
  it("UT-R-TWR-01-001: accepts one to three formations, each holding distinct units and memories", () => {
    for (const count of [1, 2, 3]) {
      const formations = Array.from({ length: count }, () =>
        formation(["UNIT_A", "UNIT_B"], [MEMORY_A, MEMORY_B]),
      );
      expect(() =>
        validateTotalWarFormations(formations, KNOWN_MEMORIES, "allyFormations"),
      ).not.toThrow();
    }
  });

  it("UT-R-TWR-01-002: rejects zero formations and a fourth formation", () => {
    expect(
      captureError(() => validateTotalWarFormations([], KNOWN_MEMORIES, "allyFormations")).path,
    ).toBe("allyFormations");
    const four = Array.from({ length: 4 }, () => formation(["UNIT_A"]));
    expect(
      captureError(() => validateTotalWarFormations(four, KNOWN_MEMORIES, "enemyFormations")).path,
    ).toBe("enemyFormations");
  });

  it("UT-R-TWR-01-003: rejects the same unitDefinitionId twice within one formation, pointing at the later slot", () => {
    const formations = [formation(["UNIT_A"]), formation(["UNIT_A", "UNIT_B", "UNIT_C", "UNIT_B"])];
    const error = captureError(() =>
      validateTotalWarFormations(formations, KNOWN_MEMORIES, "allyFormations"),
    );
    expect(error.path).toBe("allyFormations[1].slots[3].unitDefinitionId");
  });

  it("UT-R-TWR-01-004: accepts another costume of the same character within one formation", () => {
    // 衣装違いは別の UnitDefinitionId を持つ。キャラクター単位では判定しない。
    const formations = [formation(["UNIT_SAYA", "UNIT_SAYA_BUNNY"])];
    expect(() =>
      validateTotalWarFormations(formations, KNOWN_MEMORIES, "allyFormations"),
    ).not.toThrow();
  });

  it("UT-R-TWR-01-005: rejects the same memory twice within one formation, pointing at the later entry", () => {
    const formations = [
      formation(["UNIT_A"]),
      formation(["UNIT_B"], [MEMORY_A, MEMORY_B, MEMORY_A]),
    ];
    const error = captureError(() =>
      validateTotalWarFormations(formations, KNOWN_MEMORIES, "enemyFormations"),
    );
    expect(error.path).toBe("enemyFormations[1].memoryDefinitionIds[2]");
  });

  it("UT-R-TWR-01-006: accepts the same unit and the same memory across different formations", () => {
    const formations = [
      formation(["UNIT_A", "UNIT_B"], [MEMORY_A]),
      formation(["UNIT_A", "UNIT_B"], [MEMORY_A]),
      formation(["UNIT_A"], [MEMORY_A]),
    ];
    expect(() =>
      validateTotalWarFormations(formations, KNOWN_MEMORIES, "allyFormations"),
    ).not.toThrow();
  });

  it("UT-R-TWR-01-007: applies the per-formation R-FRM checks with the formation index in the path", () => {
    const empty: FormationInput = { slots: [], memoryDefinitionIds: [] };
    const error = captureError(() =>
      validateTotalWarFormations([formation(["UNIT_A"]), empty], KNOWN_MEMORIES, "allyFormations"),
    );
    expect(error.path).toBe("allyFormations[1].slots");
  });
});

describe("resolveReappearanceMultipliers (R-TWR-02)", () => {
  it("UT-R-TWR-02-001: the first appearance keeps the base stats and every later appearance takes the same 0.01", () => {
    const multipliers = resolveReappearanceMultipliers([
      formation(["UNIT_A", "UNIT_B"]),
      formation(["UNIT_C", "UNIT_A"]),
      formation(["UNIT_A", "UNIT_B", "UNIT_C"]),
    ]);
    expect(REAPPEARANCE_BASE_STAT_MULTIPLIER).toBe(0.01);
    expect(multipliers).toEqual([
      [1, 1],
      [1, 0.01],
      [0.01, 0.01, 0.01],
    ]);
  });

  it("UT-R-TWR-02-002: a different unit definition of the same character is not a reappearance", () => {
    const multipliers = resolveReappearanceMultipliers([
      formation(["UNIT_SAYA"]),
      formation(["UNIT_SAYA_BUNNY"]),
    ]);
    expect(multipliers).toEqual([[1], [1]]);
  });

  it("UT-R-TWR-02-003: the opposing side's formations are not counted", () => {
    // 陣営ごとに別々に呼ぶ契約。相手陣営に同じユニットがいても味方の1回目は補正しない。
    const ally = resolveReappearanceMultipliers([formation(["UNIT_A"])]);
    const enemy = resolveReappearanceMultipliers([formation(["UNIT_A"]), formation(["UNIT_A"])]);
    expect(ally).toEqual([[1]]);
    expect(enemy).toEqual([[1], [0.01]]);
  });
});
