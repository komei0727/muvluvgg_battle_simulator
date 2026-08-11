import { describe, expect, it } from "vitest";
import {
  PERSISTENCE_SCHEMA_VERSION,
  createEmptyPlayerData,
  isEmptyPlayerData,
  mergePlayerDataFromDraft,
  parsePlayerData,
  parseStoredDraft,
  prefillUnitEnhancement,
  prunePlayerData,
  selectUnknownDefinitionSlotKeys,
  toStoredDraft,
  toStoredPlayerData,
} from "./persistence.js";
import {
  DEFAULT_UNIT_LEVEL,
  createInitialDraft,
  createInitialUnitEnhancement,
  slotKeyOf,
} from "./types.js";
import type { BattleDraft, GearInput, UnitEnhancementInput } from "./types.js";
import type { UiViolation } from "./draft-validation.js";

const GEAR: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };

function gearsWith(gear: GearInput, index: number): readonly (GearInput | undefined)[] {
  return createInitialUnitEnhancement().gears.map((_, i) => (i === index ? gear : undefined));
}

function withAllySlot(
  draft: BattleDraft,
  slotKey: string,
  unitDefinitionId: string,
  enhancement?: UnitEnhancementInput,
): BattleDraft {
  return {
    ...draft,
    allySlots: draft.allySlots.map((slot) =>
      slot.slotKey === slotKey
        ? { ...slot, unitDefinitionId, ...(enhancement === undefined ? {} : { enhancement }) }
        : slot,
    ),
  };
}

describe("parseStoredDraft", () => {
  // UI-UT-PST-004
  it("restores a draft round-tripped through JSON, including empty slots and gears", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...withAllySlot(base, slotKeyOf("ally", "REAR", 2), "UNIT_A", {
        level: 150,
        gears: gearsWith(GEAR, 4),
      }),
      enemySlots: base.enemySlots.map((slot, index) =>
        index === 0 ? { ...slot, unitDefinitionId: "UNIT_B" } : slot,
      ),
      allyMemoryDefinitionIds: ["MEM_A", undefined, undefined, "MEM_B", undefined, undefined],
      turnLimit: 42,
      logLevel: "DIAGNOSTIC",
      allyEnhancement: {
        enabled: true,
        academyLevels: {
          unitTypes: { PHYSICAL: 5, ENERGY: 1, AGILE: "" },
          attributes: {
            AGGRESSIVE: 2,
            SHY: 1,
            CUTE: 1,
            SMART: 1,
            COMICAL: 1,
            CLEVER: 9,
          },
        },
      },
    };

    const restored = parseStoredDraft(
      JSON.parse(JSON.stringify(toStoredDraft(draft, "catalog-1"))) as unknown,
    );

    expect(restored).toStrictEqual(draft);
  });

  // UI-UT-PST-003
  it.each([
    ["not a record", 42],
    ["missing envelope fields", {}],
    ["a different schemaVersion", { schemaVersion: PERSISTENCE_SCHEMA_VERSION + 1, draft: {} }],
    [
      "an unknown slotKey",
      {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        draft: { ...createInitialDraft(), allySlots: [{ slotKey: "ally:MIDDLE:0" }] },
      },
    ],
    [
      "an unknown logLevel",
      {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        draft: { ...createInitialDraft(), logLevel: "TRACE" },
      },
    ],
    [
      "a non-numeric turnLimit",
      {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        draft: { ...createInitialDraft(), turnLimit: "ten" },
      },
    ],
    [
      "a gear with an unknown grade",
      {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        draft: {
          ...createInitialDraft(),
          allySlots: createInitialDraft().allySlots.map((slot, index) =>
            index === 0
              ? {
                  ...slot,
                  enhancement: { level: 1, gears: [{ stat: "ATTACK", tier: "III", grade: "Z" }] },
                }
              : slot,
          ),
        },
      },
    ],
  ])("discards stored data with %s", (_label, stored) => {
    expect(parseStoredDraft(stored)).toBeUndefined();
  });

  it("keeps a slot that only holds a unit id", () => {
    const stored = toStoredDraft(
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 1), "UNIT_A"),
    );

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.allySlots[1]).toStrictEqual({
      slotKey: slotKeyOf("ally", "FRONT", 1),
      side: "ally",
      row: "FRONT",
      column: 1,
      unitDefinitionId: "UNIT_A",
    });
  });
});

describe("parsePlayerData", () => {
  // UI-UT-PST-004
  it("restores player data round-tripped through JSON", () => {
    const data = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
        level: 120,
        gears: gearsWith(GEAR, 8),
      }),
      slotKeyOf("ally", "FRONT", 0),
    );

    const restored = parsePlayerData(
      JSON.parse(JSON.stringify(toStoredPlayerData(data))) as unknown,
    );

    expect(restored).toStrictEqual(data);
  });

  // UI-UT-PST-003
  it.each([
    ["not a record", "player"],
    ["a different schemaVersion", { schemaVersion: 999, academyLevels: {}, units: {} }],
    [
      "a missing academy level key",
      {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        academyLevels: { unitTypes: { PHYSICAL: 1 }, attributes: {} },
        units: {},
      },
    ],
    [
      "a unit entry that is not an enhancement",
      {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        academyLevels: createEmptyPlayerData().academyLevels,
        units: { UNIT_A: { level: 1 } },
      },
    ],
  ])("discards stored player data with %s", (_label, stored) => {
    expect(parsePlayerData(stored)).toBeUndefined();
  });
});

describe("mergePlayerDataFromDraft", () => {
  // UI-UT-PST-005
  it("records ally unit level and gears", () => {
    const draft = withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
      level: 180,
      gears: gearsWith(GEAR, 0),
    });

    const merged = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draft,
      slotKeyOf("ally", "FRONT", 0),
    );

    expect(merged.units["UNIT_A"]).toStrictEqual({ level: 180, gears: gearsWith(GEAR, 0) });
  });

  // UI-UT-PST-005
  it("records ally academy levels and skips blank inputs", () => {
    const base = createInitialDraft();
    const previous = {
      ...createEmptyPlayerData(),
      academyLevels: {
        unitTypes: { PHYSICAL: 7, ENERGY: 7, AGILE: 7 },
        attributes: {
          AGGRESSIVE: 7,
          SHY: 7,
          CUTE: 7,
          SMART: 7,
          COMICAL: 7,
          CLEVER: 7,
        },
      },
    } as const;
    const draft: BattleDraft = {
      ...base,
      allyEnhancement: {
        ...base.allyEnhancement,
        academyLevels: {
          unitTypes: { PHYSICAL: 3, ENERGY: "", AGILE: 1 },
          attributes: base.allyEnhancement.academyLevels.attributes,
        },
      },
    };

    const merged = mergePlayerDataFromDraft(previous, draft);

    expect(merged.academyLevels.unitTypes).toStrictEqual({ PHYSICAL: 3, ENERGY: 7, AGILE: 1 });
  });

  // UI-UT-PST-005
  it("keeps the previously recorded level while the level input is blank", () => {
    const previous = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
        level: 180,
        gears: gearsWith(GEAR, 0),
      }),
      slotKeyOf("ally", "FRONT", 0),
    );
    const draft = withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
      level: "",
      gears: gearsWith(GEAR, 1),
    });

    const merged = mergePlayerDataFromDraft(previous, draft, slotKeyOf("ally", "FRONT", 0));

    expect(merged.units["UNIT_A"]).toStrictEqual({ level: 180, gears: gearsWith(GEAR, 1) });
  });

  // UI-UT-PST-005
  it("ignores enemy slots and enemy academy levels", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...base,
      enemySlots: base.enemySlots.map((slot, index) =>
        index === 0
          ? { ...slot, unitDefinitionId: "UNIT_E", enhancement: { level: 99, gears: [] } }
          : slot,
      ),
      enemyEnhancement: {
        enabled: true,
        academyLevels: {
          unitTypes: { PHYSICAL: 8, ENERGY: 8, AGILE: 8 },
          attributes: {
            AGGRESSIVE: 8,
            SHY: 8,
            CUTE: 8,
            SMART: 8,
            COMICAL: 8,
            CLEVER: 8,
          },
        },
      },
    };

    const merged = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draft,
      base.enemySlots[0]!.slotKey,
    );

    expect(merged).toStrictEqual(createEmptyPlayerData());
  });

  // UI-UT-PST-006
  it("returns the same reference when nothing changed", () => {
    const draft = withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
      level: 180,
      gears: gearsWith(GEAR, 0),
    });
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const first = mergePlayerDataFromDraft(createEmptyPlayerData(), draft, slotKey);

    expect(mergePlayerDataFromDraft(first, draft, slotKey)).toBe(first);
  });
});

describe("prefillUnitEnhancement", () => {
  // UI-UT-PST-007
  it("returns the recorded enhancement for a known unit", () => {
    const enhancement: UnitEnhancementInput = { level: 88, gears: gearsWith(GEAR, 2) };
    const data = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", enhancement),
      slotKeyOf("ally", "FRONT", 0),
    );

    expect(prefillUnitEnhancement(data, "UNIT_A")).toStrictEqual(enhancement);
  });

  // UI-UT-PST-007
  it("falls back to the default enhancement for an unrecorded unit", () => {
    expect(prefillUnitEnhancement(createEmptyPlayerData(), "UNIT_X")).toStrictEqual({
      level: DEFAULT_UNIT_LEVEL,
      gears: createInitialUnitEnhancement().gears,
    });
  });
});

describe("prunePlayerData", () => {
  // UI-UT-PST-009
  it("drops only the entries missing from the catalog", () => {
    const draft = withAllySlot(
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
        level: 10,
        gears: gearsWith(GEAR, 0),
      }),
      slotKeyOf("ally", "FRONT", 1),
      "UNIT_GONE",
      { level: 20, gears: gearsWith(GEAR, 1) },
    );
    const data = mergePlayerDataFromDraft(
      mergePlayerDataFromDraft(createEmptyPlayerData(), draft, slotKeyOf("ally", "FRONT", 0)),
      draft,
      slotKeyOf("ally", "FRONT", 1),
    );

    const pruned = prunePlayerData(data, ["UNIT_A"]);

    expect(Object.keys(pruned.units)).toStrictEqual(["UNIT_A"]);
    expect(pruned.academyLevels).toStrictEqual(data.academyLevels);
  });

  // UI-UT-PST-006
  it("returns the same reference when every entry is known", () => {
    const data = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
        level: 10,
        gears: gearsWith(GEAR, 0),
      }),
      slotKeyOf("ally", "FRONT", 0),
    );

    expect(prunePlayerData(data, ["UNIT_A", "UNIT_B"])).toBe(data);
  });
});

describe("selectUnknownDefinitionSlotKeys", () => {
  // UI-UT-PST-008
  it("collects only slot-scoped UNKNOWN_DEFINITION violations", () => {
    const violations: readonly UiViolation[] = [
      {
        path: "/allyFormation/units",
        slotKey: "ally:FRONT:0",
        code: "UNKNOWN_DEFINITION",
        message: "x",
        severity: "error",
      },
      {
        path: "/allyFormation/memoryDefinitionIds/2",
        slotKey: "ally:memory:2",
        code: "UNKNOWN_DEFINITION",
        message: "x",
        severity: "error",
      },
      {
        path: "/allyFormation/units",
        slotKey: "ally:REAR:0",
        code: "APTITUDE_MISMATCH",
        message: "x",
        severity: "warning",
      },
      { path: "/turnLimit", code: "UNKNOWN_DEFINITION", message: "x", severity: "error" },
    ];

    expect(selectUnknownDefinitionSlotKeys(violations)).toStrictEqual([
      "ally:FRONT:0",
      "ally:memory:2",
    ]);
  });
});

describe("isEmptyPlayerData", () => {
  it("treats default academy levels with no unit entries as empty", () => {
    expect(isEmptyPlayerData(createEmptyPlayerData())).toBe(true);
  });

  it("is not empty once a unit is recorded", () => {
    const data = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", {
        level: 10,
        gears: gearsWith(GEAR, 0),
      }),
      slotKeyOf("ally", "FRONT", 0),
    );

    expect(isEmptyPlayerData(data)).toBe(false);
  });

  it("is not empty once an academy level differs from the default", () => {
    const base = createInitialDraft();
    const data = mergePlayerDataFromDraft(createEmptyPlayerData(), {
      ...base,
      allyEnhancement: {
        ...base.allyEnhancement,
        academyLevels: {
          ...base.allyEnhancement.academyLevels,
          unitTypes: { ...base.allyEnhancement.academyLevels.unitTypes, PHYSICAL: 4 },
        },
      },
    });

    expect(isEmptyPlayerData(data)).toBe(false);
  });
});

describe("mergePlayerDataFromDraft — duplicate placement", () => {
  const firstSlotKey = slotKeyOf("ally", "FRONT", 0);
  const secondSlotKey = slotKeyOf("ally", "REAR", 2);

  /** 同じユニットを2枠へ置き、後方の枠だけ既定値のまま残した状態。 */
  function draftWithDuplicate(editedLevel: number): BattleDraft {
    return withAllySlot(
      withAllySlot(createInitialDraft(), firstSlotKey, "UNIT_A", {
        level: editedLevel,
        gears: gearsWith(GEAR, 0),
      }),
      secondSlotKey,
      "UNIT_A",
      createInitialUnitEnhancement(),
    );
  }

  // 同じ定義を複数枠へ配置できる（01_UI要求・画面設計.md §5.1）ため、
  // 編集した枠の値が未編集の同一ユニット枠に上書きされてはならない。
  it("records the edited slot even when a later slot holds the same unit", () => {
    const merged = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draftWithDuplicate(220),
      firstSlotKey,
    );

    expect(merged.units["UNIT_A"]).toStrictEqual({ level: 220, gears: gearsWith(GEAR, 0) });
  });

  it("keeps the recorded value stable across unrelated draft changes", () => {
    const recorded = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draftWithDuplicate(220),
      firstSlotKey,
    );

    const next = mergePlayerDataFromDraft(
      recorded,
      { ...draftWithDuplicate(220), turnLimit: 7 },
      firstSlotKey,
    );

    expect(next).toBe(recorded);
  });

  it("lets the most recently edited slot win", () => {
    const first = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draftWithDuplicate(220),
      firstSlotKey,
    );
    const edited = withAllySlot(draftWithDuplicate(220), secondSlotKey, "UNIT_A", {
      level: 150,
      gears: gearsWith(GEAR, 3),
    });

    const merged = mergePlayerDataFromDraft(first, edited, secondSlotKey);

    expect(merged.units["UNIT_A"]).toStrictEqual({ level: 150, gears: gearsWith(GEAR, 3) });
  });

  it("records nothing for a slot key that no longer holds a unit", () => {
    const recorded = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draftWithDuplicate(220),
      firstSlotKey,
    );

    const merged = mergePlayerDataFromDraft(recorded, createInitialDraft(), firstSlotKey);

    expect(merged.units["UNIT_A"]).toStrictEqual({ level: 220, gears: gearsWith(GEAR, 0) });
  });

  it("ignores an edited slot on the enemy side", () => {
    const base = createInitialDraft();
    const enemySlotKey = base.enemySlots[0]!.slotKey;
    const draft: BattleDraft = {
      ...base,
      enemySlots: base.enemySlots.map((slot, index) =>
        index === 0
          ? {
              ...slot,
              unitDefinitionId: "UNIT_A",
              enhancement: { level: 333, gears: gearsWith(GEAR, 0) },
            }
          : slot,
      ),
    };

    expect(mergePlayerDataFromDraft(createEmptyPlayerData(), draft, enemySlotKey)).toStrictEqual(
      createEmptyPlayerData(),
    );
  });
});

describe("parseStoredDraft — fixed-length arrays", () => {
  function storedDraftWith(overrides: Record<string, unknown>): unknown {
    const stored = toStoredDraft(createInitialDraft()) as { draft: Record<string, unknown> };
    return { ...stored, draft: { ...stored.draft, ...overrides } };
  }

  // 「1項目でも契約から外れれば保存データ全体を破棄する」方針に合わせ、
  // 固定長の配列は長さも契約として扱う。
  it("rejects a gears array shorter than the fixed slot count", () => {
    const base = createInitialDraft();
    const stored = storedDraftWith({
      allySlots: base.allySlots.map((slot, index) =>
        index === 0 ? { ...slot, enhancement: { level: 1, gears: [] } } : slot,
      ),
    });

    expect(parseStoredDraft(stored)).toBeUndefined();
  });

  it("rejects a memory array shorter than the fixed slot count", () => {
    expect(parseStoredDraft(storedDraftWith({ allyMemoryDefinitionIds: [] }))).toBeUndefined();
  });

  it("rejects a slot array that does not cover every slot", () => {
    const base = createInitialDraft();
    expect(
      parseStoredDraft(storedDraftWith({ allySlots: base.allySlots.slice(1) })),
    ).toBeUndefined();
  });
});
