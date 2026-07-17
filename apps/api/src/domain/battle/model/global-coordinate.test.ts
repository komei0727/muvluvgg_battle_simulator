import { describe, expect, it } from "vitest";
import { createGlobalCoordinate, toGlobalCoordinate } from "./global-coordinate.js";
import type { FormationPosition } from "./formation-input.js";
import { DomainValidationError } from "../../shared/errors.js";

function position(
  column: FormationPosition["column"],
  row: FormationPosition["row"],
): FormationPosition {
  return { column, row };
}

describe("toGlobalCoordinate — R-POS-01 共通座標への変換", () => {
  it.each([
    ["UT-R-POS-01-001", "ALLY", "LEFT", "FRONT", 0, 2],
    ["UT-R-POS-01-002", "ALLY", "CENTER", "FRONT", 1, 2],
    ["UT-R-POS-01-003", "ALLY", "RIGHT", "FRONT", 2, 2],
    ["UT-R-POS-01-004", "ALLY", "LEFT", "BACK", 0, 3],
    ["UT-R-POS-01-005", "ALLY", "CENTER", "BACK", 1, 3],
    ["UT-R-POS-01-006", "ALLY", "RIGHT", "BACK", 2, 3],
    ["UT-R-POS-01-007", "ENEMY", "LEFT", "FRONT", 0, 1],
    ["UT-R-POS-01-008", "ENEMY", "CENTER", "FRONT", 1, 1],
    ["UT-R-POS-01-009", "ENEMY", "RIGHT", "FRONT", 2, 1],
    ["UT-R-POS-01-010", "ENEMY", "LEFT", "BACK", 0, 0],
    ["UT-R-POS-01-011", "ENEMY", "CENTER", "BACK", 1, 0],
    ["UT-R-POS-01-012", "ENEMY", "RIGHT", "BACK", 2, 0],
  ] as const)("%s: %s %s %s -> (x=%i, y=%i)", (testCaseId, side, column, row, x, y) => {
    expect(toGlobalCoordinate(side, position(column, row))).toEqual({ x, y });
  });

  it("UT-R-POS-01-013: all 12 combinations map to distinct common coordinates covering the full 3x4 board", () => {
    const sides = ["ALLY", "ENEMY"] as const;
    const columns = ["LEFT", "CENTER", "RIGHT"] as const;
    const rows = ["FRONT", "BACK"] as const;

    const keys = new Set<string>();
    for (const side of sides) {
      for (const column of columns) {
        for (const row of rows) {
          const coordinate = toGlobalCoordinate(side, position(column, row));
          keys.add(`${coordinate.x}:${coordinate.y}`);
        }
      }
    }

    expect(keys.size).toBe(12);
  });
});

describe("createGlobalCoordinate — R-POS-01 共通座標の範囲", () => {
  it("UT-R-POS-01-014: accepts the lower bounds x=0, y=0", () => {
    expect(createGlobalCoordinate(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("UT-R-POS-01-015: accepts the upper bounds x=2, y=3", () => {
    expect(createGlobalCoordinate(2, 3)).toEqual({ x: 2, y: 3 });
  });

  it("UT-R-POS-01-016: rejects x below 0", () => {
    expect(() => createGlobalCoordinate(-1, 0)).toThrow(DomainValidationError);
  });

  it("UT-R-POS-01-017: rejects x above 2", () => {
    expect(() => createGlobalCoordinate(3, 0)).toThrow(DomainValidationError);
  });

  it("UT-R-POS-01-018: rejects y below 0", () => {
    expect(() => createGlobalCoordinate(0, -1)).toThrow(DomainValidationError);
  });

  it("UT-R-POS-01-019: rejects y above 3", () => {
    expect(() => createGlobalCoordinate(0, 4)).toThrow(DomainValidationError);
  });
});

describe("toGlobalCoordinate — R-POS-02 絶対左列", () => {
  it("UT-R-POS-02-001: LEFT always maps to x=0 regardless of side", () => {
    expect(toGlobalCoordinate("ALLY", position("LEFT", "FRONT")).x).toBe(0);
    expect(toGlobalCoordinate("ENEMY", position("LEFT", "FRONT")).x).toBe(0);
  });

  it("UT-R-POS-02-002: RIGHT always maps to x=2 regardless of side", () => {
    expect(toGlobalCoordinate("ALLY", position("RIGHT", "FRONT")).x).toBe(2);
    expect(toGlobalCoordinate("ENEMY", position("RIGHT", "FRONT")).x).toBe(2);
  });
});
