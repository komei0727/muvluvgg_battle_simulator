import { describe, expect, it } from "vitest";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import { selectCanSubmit, validateDraft } from "./draft-validation.js";
import { createInitialDraft, slotKeyOf } from "./types.js";
import type { BattleDraft, FormationSlotInput } from "./types.js";

function catalogWith(
  units: BattleSimulationCatalogResponse["units"] = [],
  memories: BattleSimulationCatalogResponse["memories"] = [],
): BattleSimulationCatalogResponse {
  return { schemaVersion: 1, catalogRevision: "rev-1", units, memories };
}

function selectableUnit(
  unitDefinitionId: string,
  overrides: Partial<BattleSimulationCatalogResponse["units"][number]> = {},
): BattleSimulationCatalogResponse["units"][number] {
  return {
    unitDefinitionId,
    displayName: unitDefinitionId,
    characterName: unitDefinitionId,
    attribute: "CUTE",
    unitType: "ATTACKER",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    selectable: true,
    unavailableCapabilities: [],
    ...overrides,
  };
}

function selectableMemory(
  memoryDefinitionId: string,
  overrides: Partial<BattleSimulationCatalogResponse["memories"][number]> = {},
): BattleSimulationCatalogResponse["memories"][number] {
  return {
    memoryDefinitionId,
    displayName: memoryDefinitionId,
    selectable: true,
    unavailableCapabilities: [],
    ...overrides,
  };
}

function fillSlots(
  slots: readonly FormationSlotInput[],
  count: number,
  unitDefinitionId = "UNIT_A",
): readonly FormationSlotInput[] {
  return slots.map((slot, index) => (index < count ? { ...slot, unitDefinitionId } : slot));
}

function draftWithAllyCount(count: number, catalogUnitId = "UNIT_A"): BattleDraft {
  const base = createInitialDraft();
  return {
    ...base,
    allySlots: fillSlots(base.allySlots, count, catalogUnitId),
    enemySlots: fillSlots(base.enemySlots, 1, catalogUnitId),
  };
}

describe("validateDraft — unit count (UI-UT-VAL-001/002/003)", () => {
  const catalog = catalogWith([selectableUnit("UNIT_A")]);

  it("rejects 0 ally units", () => {
    const draft = draftWithAllyCount(0);
    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "/allyFormation/units", severity: "error" }),
    );
  });

  it("rejects 0 enemy units", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...base,
      allySlots: fillSlots(base.allySlots, 1, "UNIT_A"),
      enemySlots: fillSlots(base.enemySlots, 0, "UNIT_A"),
    };
    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "/enemyFormation/units", severity: "error" }),
    );
  });

  it("accepts 1 and 5 ally units, rejects 6", () => {
    expect(
      validateDraft(draftWithAllyCount(1), catalog).filter(
        (v) => v.path === "/allyFormation/units",
      ),
    ).toEqual([]);
    expect(
      validateDraft(draftWithAllyCount(5), catalog).filter(
        (v) => v.path === "/allyFormation/units",
      ),
    ).toEqual([]);
    expect(
      validateDraft(draftWithAllyCount(6), catalog).filter(
        (v) => v.path === "/allyFormation/units",
      ),
    ).not.toEqual([]);
  });
});

describe("validateDraft — memory count (UI-UT-VAL-004)", () => {
  const catalog = catalogWith([selectableUnit("UNIT_A")]);

  it("accepts 0 and 6 memories, rejects 7", () => {
    const base = draftWithAllyCount(1);

    const zero: BattleDraft = { ...base, allyMemoryDefinitionIds: [] };
    expect(
      validateDraft(zero, catalog).filter((v) => v.path === "/allyFormation/memoryDefinitionIds"),
    ).toEqual([]);

    const six: BattleDraft = {
      ...base,
      allyMemoryDefinitionIds: ["M1", "M2", "M3", "M4", "M5", "M6"],
    };
    expect(
      validateDraft(six, catalog).filter((v) => v.path === "/allyFormation/memoryDefinitionIds"),
    ).toEqual([]);

    const seven: BattleDraft = {
      ...base,
      allyMemoryDefinitionIds: ["M1", "M2", "M3", "M4", "M5", "M6", "M7"],
    };
    expect(
      validateDraft(seven, catalog).filter((v) => v.path === "/allyFormation/memoryDefinitionIds"),
    ).not.toEqual([]);
  });
});

describe("validateDraft — turn limit (UI-UT-VAL-005)", () => {
  const catalog = catalogWith([selectableUnit("UNIT_A")]);

  it.each([1, 99])("accepts turnLimit %i", (turnLimit) => {
    const draft: BattleDraft = { ...draftWithAllyCount(1), turnLimit };
    expect(validateDraft(draft, catalog).filter((v) => v.path === "/turnLimit")).toEqual([]);
  });

  it.each([0, 100, 1.5, ""])("rejects turnLimit %s", (turnLimit) => {
    const draft: BattleDraft = { ...draftWithAllyCount(1), turnLimit: turnLimit as number | "" };
    expect(validateDraft(draft, catalog).filter((v) => v.path === "/turnLimit")).not.toEqual([]);
  });
});

describe("validateDraft — unsupported capability (UI-UT-VAL-006)", () => {
  it("rejects a unit definition that is not selectable", () => {
    const catalog = catalogWith([
      selectableUnit("UNIT_A", { selectable: false, unavailableCapabilities: ["CAP_X"] }),
    ]);
    const draft = draftWithAllyCount(1, "UNIT_A");

    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_DEFINITION", severity: "error" }),
    );
  });

  it("rejects a memory definition that is not selectable", () => {
    const catalog = catalogWith(
      [selectableUnit("UNIT_A")],
      [selectableMemory("MEM_A", { selectable: false, unavailableCapabilities: ["CAP_Y"] })],
    );
    const draft: BattleDraft = {
      ...draftWithAllyCount(1),
      allyMemoryDefinitionIds: ["MEM_A", undefined, undefined, undefined, undefined, undefined],
    };

    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_DEFINITION", severity: "error" }),
    );
  });

  it("rejects a unit definition id that is missing from the catalog entirely", () => {
    const catalog = catalogWith([]);
    const draft = draftWithAllyCount(1, "UNKNOWN_UNIT");

    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_DEFINITION", severity: "error" }),
    );
  });
});

describe("validateDraft — aptitude mismatch is a warning (UI-UT-VAL-007)", () => {
  it("does not block submission for an off-aptitude placement", () => {
    const catalog = catalogWith([selectableUnit("UNIT_A", { positionAptitudes: ["FRONT"] })]);
    const base = createInitialDraft();
    const rearSlotKey = slotKeyOf("ally", "REAR", 0);
    const draft: BattleDraft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === rearSlotKey ? { ...slot, unitDefinitionId: "UNIT_A" } : slot,
      ),
      enemySlots: fillSlots(base.enemySlots, 1, "UNIT_A"),
    };

    const violations = validateDraft(draft, catalog);
    const aptitudeViolation = violations.find((v) => v.code === "APTITUDE_MISMATCH");
    expect(aptitudeViolation).toMatchObject({ severity: "warning", slotKey: rearSlotKey });
    expect(selectCanSubmit(violations)).toBe(true);
  });
});

describe("validateDraft — duplicate position", () => {
  it("does not flag the normal case where every slot has a distinct coordinate", () => {
    const catalog = catalogWith([selectableUnit("UNIT_A")]);
    const draft = draftWithAllyCount(3, "UNIT_A");

    const violations = validateDraft(draft, catalog);
    expect(violations.some((v) => v.code === "DUPLICATE_POSITION")).toBe(false);
  });

  // The fixed 6-slot draft model normally makes duplicate coordinates
  // structurally impossible (each slotKey maps to one row/column), but the
  // validator still guards against a malformed draft reaching this point.
  it("flags a second slot that shares another filled slot's row/column", () => {
    const catalog = catalogWith([selectableUnit("UNIT_A")]);
    const base = draftWithAllyCount(1, "UNIT_A");
    const [firstSlot] = base.allySlots;
    const malformedSlots: readonly FormationSlotInput[] = [
      ...base.allySlots,
      { ...firstSlot!, slotKey: "ally:FRONT:0:duplicate", unitDefinitionId: "UNIT_A" },
    ];
    const draft: BattleDraft = { ...base, allySlots: malformedSlots };

    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_POSITION", severity: "error" }),
    );
  });
});

describe("selectCanSubmit", () => {
  it("is false when any error-severity violation exists", () => {
    expect(
      selectCanSubmit([{ path: "/turnLimit", code: "X", message: "m", severity: "error" }]),
    ).toBe(false);
  });

  it("is true when only warnings exist", () => {
    expect(
      selectCanSubmit([
        { path: "/allyFormation/units", code: "X", message: "m", severity: "warning" },
      ]),
    ).toBe(true);
  });

  it("is true when there are no violations", () => {
    expect(selectCanSubmit([])).toBe(true);
  });
});
