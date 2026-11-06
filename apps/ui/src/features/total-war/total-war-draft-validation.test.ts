import { describe, expect, it } from "vitest";
import { validateTotalWarDraft } from "./total-war-draft-validation.js";
import type { TotalWarDraft } from "./total-war-draft.js";
import { createInitialTotalWarState, totalWarReducer } from "./total-war-reducer.js";
import type { TotalWarAction } from "./total-war-reducer.js";
import { memorySlotKeyOf, slotKeyOf } from "../formation/types.js";
import type { Side, UiColumn, UiRow } from "../../entities/battle-draft.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";

function catalogUnit(unitDefinitionId: string): BattleSimulationCatalogResponse["units"][number] {
  return {
    unitDefinitionId,
    displayName: unitDefinitionId,
    characterName: unitDefinitionId,
    attribute: "CUTE",
    unitType: "ATTACKER",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
  };
}

const UNIT_IDS = ["UNIT_A", "UNIT_A_ALT", "UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E", "UNIT_F"];
const CATALOG: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: UNIT_IDS.map(catalogUnit),
  memories: ["MEM_1", "MEM_2"].map((memoryDefinitionId) => ({
    memoryDefinitionId,
    displayName: memoryDefinitionId,
  })),
};

function place(side: Side, row: UiRow, column: UiColumn, unitDefinitionId: string): TotalWarAction {
  return { type: "unitSelected", slotKey: slotKeyOf(side, row, column), unitDefinitionId };
}

function memory(side: Side, index: number, memoryDefinitionId: string): TotalWarAction {
  return { type: "memorySelected", side, index, memoryDefinitionId };
}

function build(...actions: readonly TotalWarAction[]): TotalWarDraft {
  return actions.reduce(totalWarReducer, createInitialTotalWarState()).draft;
}

/** 両陣営1編成ずつ、各1体の妥当な盤面。 */
const VALID_BASE: readonly TotalWarAction[] = [
  place("ally", "FRONT", 0, "UNIT_A"),
  place("enemy", "FRONT", 0, "UNIT_B"),
];

describe("validateTotalWarDraft — per-formation rules (UI-UT-TWR-006)", () => {
  it("accepts a valid draft without errors", () => {
    const violations = validateTotalWarDraft(build(...VALID_BASE), CATALOG);
    expect(violations.filter((violation) => violation.severity === "error")).toEqual([]);
  });

  it("validates each used formation and rewrites the path with the formation index", () => {
    // 味方の編成2を空のまま追加する。
    const violations = validateTotalWarDraft(
      build(...VALID_BASE, { type: "formationAdded", side: "ally" }),
      CATALOG,
    );
    expect(violations).toEqual([
      expect.objectContaining({
        path: "/allyFormations/1/units",
        code: "UNIT_COUNT_OUT_OF_RANGE",
        formationIndex: 1,
        severity: "error",
      }),
    ]);
  });

  it("checks memory counts and unknown definitions per formation", () => {
    const draft = build(
      ...VALID_BASE,
      { type: "formationAdded", side: "enemy" },
      place("enemy", "FRONT", 0, "UNIT_GONE"),
      memory("enemy", 4, "MEM_GONE"),
    );
    const violations = validateTotalWarDraft(draft, CATALOG);
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/enemyFormations/1/units",
        slotKey: slotKeyOf("enemy", "FRONT", 0),
        code: "UNKNOWN_DEFINITION",
        formationIndex: 1,
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/enemyFormations/1/memoryDefinitionIds/4",
        slotKey: memorySlotKeyOf("enemy", 4),
        code: "UNKNOWN_DEFINITION",
        formationIndex: 1,
      }),
    );
  });

  it("does not validate formations beyond the count of each side", () => {
    // 敵だけ2編成。組1の味方側は未使用（空）なので「0体」として報告されてはならない。
    const draft = build(
      ...VALID_BASE,
      { type: "formationAdded", side: "enemy" },
      place("enemy", "FRONT", 0, "UNIT_C"),
    );
    const violations = validateTotalWarDraft(draft, CATALOG);
    expect(violations.filter((violation) => violation.severity === "error")).toEqual([]);
  });

  it("does not validate the turn limit", () => {
    const draft = build(...VALID_BASE, { type: "turnLimitChanged", value: "" });
    const formations = draft.formations.map((formation) => ({
      ...formation,
      turnLimit: "" as const,
    }));
    const violations = validateTotalWarDraft(
      { ...draft, formations: [formations[0]!, formations[1]!, formations[2]!] },
      CATALOG,
    );
    expect(violations.some((violation) => violation.path.includes("turnLimit"))).toBe(false);
  });

  it("rewrites enhancement paths and keeps the formation index on every violation", () => {
    const draft = build(
      ...VALID_BASE,
      { type: "enhancementToggled", side: "enemy", enabled: true },
      {
        type: "academyLevelChanged",
        side: "enemy",
        group: "attributes",
        key: "CUTE",
        value: "",
      },
    );
    const violations = validateTotalWarDraft(draft, CATALOG);
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/enemyFormations/0/enhancement/academyLevels/attributes/CUTE",
        code: "ACADEMY_LEVEL_INVALID",
        formationIndex: 0,
      }),
    );
    expect(violations.every((violation) => violation.formationIndex !== undefined)).toBe(true);
  });
});

describe("validateTotalWarDraft — duplicate units in a formation (UI-UT-TWR-007)", () => {
  it("reports the second and later copies in display order only", () => {
    const draft = build(
      place("ally", "REAR", 0, "UNIT_A"),
      place("ally", "FRONT", 2, "UNIT_A"),
      place("ally", "REAR", 2, "UNIT_A"),
      place("enemy", "FRONT", 0, "UNIT_B"),
    );
    const duplicates = validateTotalWarDraft(draft, CATALOG).filter(
      (violation) => violation.code === "DUPLICATE_UNIT_IN_FORMATION",
    );
    // 表示順は前衛column 0〜2、後衛column 0〜2。前衛2列目が1体目になる。
    expect(duplicates).toEqual([
      {
        path: "/allyFormations/0/units",
        slotKey: slotKeyOf("ally", "REAR", 0),
        formationIndex: 0,
        code: "DUPLICATE_UNIT_IN_FORMATION",
        message: "1つの編成に同じユニットは1体までです。別の編成へ移してください。",
        severity: "error",
      },
      expect.objectContaining({ slotKey: slotKeyOf("ally", "REAR", 2) }),
    ]);
  });

  it("allows costume variants and the same unit across formations", () => {
    const draft = build(
      place("ally", "FRONT", 0, "UNIT_A"),
      place("ally", "FRONT", 1, "UNIT_A_ALT"),
      place("enemy", "FRONT", 0, "UNIT_A"),
      { type: "formationAdded", side: "ally" },
      place("ally", "FRONT", 0, "UNIT_A"),
    );
    const codes = validateTotalWarDraft(draft, CATALOG).map((violation) => violation.code);
    expect(codes).not.toContain("DUPLICATE_UNIT_IN_FORMATION");
  });
});

describe("validateTotalWarDraft — duplicate memories in a formation (UI-UT-TWR-008)", () => {
  it("reports the second and later memory slots only", () => {
    const draft = build(
      ...VALID_BASE,
      memory("enemy", 1, "MEM_1"),
      memory("enemy", 3, "MEM_1"),
      memory("enemy", 5, "MEM_2"),
    );
    const duplicates = validateTotalWarDraft(draft, CATALOG).filter(
      (violation) => violation.code === "DUPLICATE_MEMORY_IN_FORMATION",
    );
    expect(duplicates).toEqual([
      {
        path: "/enemyFormations/0/memoryDefinitionIds",
        slotKey: memorySlotKeyOf("enemy", 3),
        formationIndex: 0,
        code: "DUPLICATE_MEMORY_IN_FORMATION",
        message: "1つの編成に同じメモリーは1件までです。",
        severity: "error",
      },
    ]);
  });

  it("allows the same memory in different formations", () => {
    const draft = build(
      ...VALID_BASE,
      memory("ally", 0, "MEM_1"),
      { type: "formationAdded", side: "ally" },
      place("ally", "FRONT", 0, "UNIT_C"),
      memory("ally", 0, "MEM_1"),
    );
    const codes = validateTotalWarDraft(draft, CATALOG).map((violation) => violation.code);
    expect(codes).not.toContain("DUPLICATE_MEMORY_IN_FORMATION");
  });
});
