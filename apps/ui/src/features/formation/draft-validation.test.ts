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

function catalogUnit(
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
  const catalog = catalogWith([catalogUnit("UNIT_A")]);

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
  const catalog = catalogWith([catalogUnit("UNIT_A")]);

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
  const catalog = catalogWith([catalogUnit("UNIT_A")]);

  it.each([1, 99])("accepts turnLimit %i", (turnLimit) => {
    const draft: BattleDraft = { ...draftWithAllyCount(1), turnLimit };
    expect(validateDraft(draft, catalog).filter((v) => v.path === "/turnLimit")).toEqual([]);
  });

  it.each([0, 100, 1.5, ""])("rejects turnLimit %s", (turnLimit) => {
    const draft: BattleDraft = { ...draftWithAllyCount(1), turnLimit: turnLimit as number | "" };
    expect(validateDraft(draft, catalog).filter((v) => v.path === "/turnLimit")).not.toEqual([]);
  });
});

describe("validateDraft — unknown definition (UI-UT-VAL-006)", () => {
  it("rejects a unit definition id that is missing from the catalog entirely", () => {
    const catalog = catalogWith([]);
    const draft = draftWithAllyCount(1, "UNKNOWN_UNIT");

    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_DEFINITION", severity: "error" }),
    );
  });

  it("rejects a memory definition id that is missing from the catalog entirely", () => {
    const catalog = catalogWith([catalogUnit("UNIT_A")]);
    const draft: BattleDraft = {
      ...draftWithAllyCount(1, "UNIT_A"),
      allyMemoryDefinitionIds: [
        "UNKNOWN_MEM",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    };

    const violations = validateDraft(draft, catalog);
    expect(violations).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_DEFINITION",
        severity: "error",
        path: "/allyFormation/memoryDefinitionIds/0",
      }),
    );
  });
});

// R-TEX-11 #3: 通常戦闘は両陣営とも`PLAYABLE`のみを受理する。
describe("validateDraft — unit pool (UI-UT-VAL-011)", () => {
  const catalog = catalogWith([
    catalogUnit("UNIT_A"),
    catalogUnit("UNIT_EX", { category: "EXERCISE_ENEMY", exerciseActive: true }),
  ]);

  it.each(["ally", "enemy"] as const)("rejects an exercise enemy in a %s slot", (side) => {
    const base = createInitialDraft();
    const slotKey = slotKeyOf(side, "FRONT", 0);
    const draft: BattleDraft = {
      ...draftWithAllyCount(1, "UNIT_A"),
      ...(side === "ally"
        ? {
            allySlots: base.allySlots.map((slot) =>
              slot.slotKey === slotKey ? { ...slot, unitDefinitionId: "UNIT_EX" } : slot,
            ),
          }
        : {
            enemySlots: base.enemySlots.map((slot) =>
              slot.slotKey === slotKey ? { ...slot, unitDefinitionId: "UNIT_EX" } : slot,
            ),
          }),
    };

    const violations = validateDraft(draft, catalog);

    expect(violations).toContainEqual(
      expect.objectContaining({ code: "UNIT_POOL_MISMATCH", severity: "error", slotKey }),
    );
    expect(selectCanSubmit(violations)).toBe(false);
  });

  it("accepts playable units on both sides, including definitions without a category", () => {
    const legacyCatalog = catalogWith([catalogUnit("UNIT_A"), catalogUnit("UNIT_B")]);
    const draft = draftWithAllyCount(1, "UNIT_A");

    const violations = validateDraft(draft, legacyCatalog);

    expect(violations.some((v) => v.code === "UNIT_POOL_MISMATCH")).toBe(false);
  });

  // Catalogに無い定義はUNKNOWN_DEFINITIONが指す。カテゴリ不明の枠へ重ねて
  // プール違反を出すと、選び直しを促す表示が二重になる。
  it("does not add a pool violation for a definition missing from the catalog", () => {
    const draft = draftWithAllyCount(1, "UNIT_GONE");

    const violations = validateDraft(draft, catalog);

    expect(violations.some((v) => v.code === "UNIT_POOL_MISMATCH")).toBe(false);
  });
});

describe("validateDraft — aptitude mismatch is a warning (UI-UT-VAL-007)", () => {
  it("does not block submission for an off-aptitude placement", () => {
    const catalog = catalogWith([catalogUnit("UNIT_A", { positionAptitudes: ["FRONT"] })]);
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
    const catalog = catalogWith([catalogUnit("UNIT_A")]);
    const draft = draftWithAllyCount(3, "UNIT_A");

    const violations = validateDraft(draft, catalog);
    expect(violations.some((v) => v.code === "DUPLICATE_POSITION")).toBe(false);
  });

  // The fixed 6-slot draft model normally makes duplicate coordinates
  // structurally impossible (each slotKey maps to one row/column), but the
  // validator still guards against a malformed draft reaching this point.
  it("flags a second slot that shares another filled slot's row/column", () => {
    const catalog = catalogWith([catalogUnit("UNIT_A")]);
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

describe("validateDraft — 強化入力 (M11, UI-AC-024)", () => {
  const catalog = catalogWith([catalogUnit("UNIT_A")]);

  function enabledAllyDraft(overrides: Partial<BattleDraft> = {}): BattleDraft {
    const base = draftWithAllyCount(1);
    return {
      ...base,
      allyEnhancement: { ...base.allyEnhancement, enabled: true },
      ...overrides,
    };
  }

  it("accepts an enabled side whose nine academy levels are all at the default", () => {
    expect(validateDraft(enabledAllyDraft(), catalog)).toEqual([]);
  });

  it("rejects a blank, zero or fractional academy level with the field's own path", () => {
    const base = enabledAllyDraft();
    const draft: BattleDraft = {
      ...base,
      allyEnhancement: {
        ...base.allyEnhancement,
        academyLevels: {
          unitTypes: { PHYSICAL: 0, ENERGY: "", AGILE: 1 },
          attributes: { ...base.allyEnhancement.academyLevels.attributes, CLEVER: 2.5 },
        },
      },
    };

    const violations = validateDraft(draft, catalog);

    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/allyFormation/enhancement/academyLevels/unitTypes/PHYSICAL",
        message: "学園レベルは1以上の整数で入力してください。",
        severity: "error",
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/allyFormation/enhancement/academyLevels/unitTypes/ENERGY",
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/allyFormation/enhancement/academyLevels/attributes/CLEVER",
      }),
    );
    expect(violations.filter((violation) => violation.path.includes("academyLevels"))).toHaveLength(
      3,
    );
  });

  it("ignores academy levels of a side whose toggle is off (values are kept, not sent)", () => {
    const base = draftWithAllyCount(1);
    const draft: BattleDraft = {
      ...base,
      allyEnhancement: {
        enabled: false,
        academyLevels: {
          ...base.allyEnhancement.academyLevels,
          unitTypes: { PHYSICAL: 0, ENERGY: "", AGILE: 1 },
        },
      },
    };

    expect(validateDraft(draft, catalog)).toEqual([]);
  });

  it("rejects a blank or non-positive unit level on the slot that carries it", () => {
    const base = enabledAllyDraft();
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const draft: BattleDraft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === slotKey
          ? { ...slot, enhancement: { level: 0, gears: Array(9).fill(undefined) } }
          : slot,
      ),
    };

    const violations = validateDraft(draft, catalog);

    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/allyFormation/units/enhancement/level",
        slotKey,
        message: "ユニットレベルは1以上の整数で入力してください。",
        severity: "error",
      }),
    );
  });

  it("rejects more than nine gears on one unit", () => {
    const base = enabledAllyDraft();
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const gear = { stat: "ATTACK", tier: "III", grade: "S" } as const;
    const draft: BattleDraft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === slotKey
          ? { ...slot, enhancement: { level: 200, gears: Array(10).fill(gear) } }
          : slot,
      ),
    };

    const violations = validateDraft(draft, catalog);

    expect(violations).toContainEqual(
      expect.objectContaining({
        path: "/allyFormation/units/enhancement/gears",
        slotKey,
        message: "ギアは9枠まで設定できます。",
        severity: "error",
      }),
    );
  });

  it("UI-CMP-014: keeps a submit valid after the toggle goes back off, even though the edited unit enhancement is still in the draft", () => {
    // トグルOFFへ戻しても入力値はdraftへ保持し、送信対象からだけ外す
    // （request-mapperがOFF側のユニット強化を出力しない）。保持しているだけの
    // 値で送信を止めてはならない。
    const base = draftWithAllyCount(1);
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const draft: BattleDraft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === slotKey
          ? { ...slot, enhancement: { level: 220, gears: Array<undefined>(9).fill(undefined) } }
          : slot,
      ),
    };

    expect(validateDraft(draft, catalog)).toEqual([]);
  });

  it("UI-CMP-014: does not validate a retained unit level that is blank while the side's toggle is off", () => {
    const base = draftWithAllyCount(1);
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const draft: BattleDraft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === slotKey
          ? { ...slot, enhancement: { level: "", gears: Array<undefined>(9).fill(undefined) } }
          : slot,
      ),
    };

    expect(validateDraft(draft, catalog)).toEqual([]);
  });
});
