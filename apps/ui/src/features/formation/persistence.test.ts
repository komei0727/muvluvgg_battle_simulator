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
import type { BattleDraft, GearInput, UnitEnhancementInput } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";

const GEAR: GearInput = { stat: "ATTACK", tier: "III", grade: "S" };

function gearsWith(gear: GearInput, index: number): readonly (GearInput | undefined)[] {
  return createInitialUnitEnhancement().gears.map((_, i) => (i === index ? gear : undefined));
}

function emptyGears(): readonly (GearInput | undefined)[] {
  return createInitialUnitEnhancement().gears;
}

/** 既存テストの強化入力リテラル。レベルリンクの新項目は既定のまま使う。 */
function enhancementOf(
  level: number | "",
  gears: readonly (GearInput | undefined)[],
): UnitEnhancementInput {
  return { ...createInitialUnitEnhancement(), level, gears };
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
      ...withAllySlot(
        base,
        slotKeyOf("ally", "REAR", 2),
        "UNIT_A",
        enhancementOf(150, gearsWith(GEAR, 4)),
      ),
      enemySlots: base.enemySlots.map((slot, index) =>
        index === 0 ? { ...slot, unitDefinitionId: "UNIT_B" } : slot,
      ),
      allyMemoryDefinitionIds: ["MEM_A", undefined, undefined, "MEM_B", undefined, undefined],
      turnLimit: 42,
      logLevel: "DETAILED",
      allyEnhancement: {
        enabled: true,
        levelLink: { enabled: true, level: 260 },
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

  // UI-UT-PST-010: ログ方針刷新2/3（Issue #464）。`DIAGNOSTIC`はUIの選択肢から
  // 外れたが、以前のセッションで保存されたドラフトには残っている。破棄すると編成
  // 全体を入力し直させることになり、そのまま送ると3/3のAPIが422で拒否する。
  // 同一挙動になった`DETAILED`へ読み替えるのが、値の意味を変えない唯一の移行である。
  it("UI-UT-PST-010: restores a stored DIAGNOSTIC logLevel as DETAILED instead of discarding the whole draft", () => {
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      draft: { ...createInitialDraft(), logLevel: "DIAGNOSTIC" },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored).toBeDefined();
    expect(restored?.logLevel).toBe("DETAILED");
  });

  it("restores a draft whose unit exceeds the three-gears-per-stat limit instead of discarding it", () => {
    // 上限（`MAX_GEARS_PER_STAT`）はUI入力が持つ制約であり、保存データの契約ではない。
    // 版を上げずに読み捨てると、上限導入前に入力した手持ちデータとドラフトが
    // 利用者から黙って消える（違反はクライアント検証が警告として示す）。
    const overLimit = createInitialUnitEnhancement().gears.map((_, index) =>
      index < 4 ? GEAR : undefined,
    );
    const stored = toStoredDraft(
      withAllySlot(
        createInitialDraft(),
        slotKeyOf("ally", "FRONT", 0),
        "UNIT_A",
        enhancementOf(200, overLimit),
      ),
    );

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.allySlots[0]?.enhancement?.gears).toStrictEqual(overLimit);
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
      withAllySlot(
        createInitialDraft(),
        slotKeyOf("ally", "FRONT", 0),
        "UNIT_A",
        enhancementOf(120, gearsWith(GEAR, 8)),
      ),
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
    const draft = withAllySlot(
      createInitialDraft(),
      slotKeyOf("ally", "FRONT", 0),
      "UNIT_A",
      enhancementOf(180, gearsWith(GEAR, 0)),
    );

    const merged = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draft,
      slotKeyOf("ally", "FRONT", 0),
    );

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(180, gearsWith(GEAR, 0)));
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
      withAllySlot(
        createInitialDraft(),
        slotKeyOf("ally", "FRONT", 0),
        "UNIT_A",
        enhancementOf(180, gearsWith(GEAR, 0)),
      ),
      slotKeyOf("ally", "FRONT", 0),
    );
    const draft = withAllySlot(
      createInitialDraft(),
      slotKeyOf("ally", "FRONT", 0),
      "UNIT_A",
      enhancementOf("", gearsWith(GEAR, 1)),
    );

    const merged = mergePlayerDataFromDraft(previous, draft, slotKeyOf("ally", "FRONT", 0));

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(180, gearsWith(GEAR, 1)));
  });

  // UI-UT-PST-005
  it("ignores enemy slots and enemy academy levels", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...base,
      enemySlots: base.enemySlots.map((slot, index) =>
        index === 0
          ? { ...slot, unitDefinitionId: "UNIT_E", enhancement: enhancementOf(99, []) }
          : slot,
      ),
      enemyEnhancement: {
        ...base.enemyEnhancement,
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
    const draft = withAllySlot(
      createInitialDraft(),
      slotKeyOf("ally", "FRONT", 0),
      "UNIT_A",
      enhancementOf(180, gearsWith(GEAR, 0)),
    );
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const first = mergePlayerDataFromDraft(createEmptyPlayerData(), draft, slotKey);

    expect(mergePlayerDataFromDraft(first, draft, slotKey)).toBe(first);
  });
});

describe("prefillUnitEnhancement", () => {
  // UI-UT-PST-007
  it("returns the recorded enhancement for a known unit", () => {
    const enhancement: UnitEnhancementInput = enhancementOf(88, gearsWith(GEAR, 2));
    const data = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(createInitialDraft(), slotKeyOf("ally", "FRONT", 0), "UNIT_A", enhancement),
      slotKeyOf("ally", "FRONT", 0),
    );

    expect(prefillUnitEnhancement(data, "UNIT_A")).toStrictEqual(enhancement);
  });

  // UI-UT-PST-007
  it("falls back to the default enhancement for an unrecorded unit", () => {
    expect(prefillUnitEnhancement(createEmptyPlayerData(), "UNIT_X")).toStrictEqual(
      enhancementOf(DEFAULT_UNIT_LEVEL, createInitialUnitEnhancement().gears),
    );
  });
});

describe("prunePlayerData", () => {
  // UI-UT-PST-009
  it("drops only the entries missing from the catalog", () => {
    const draft = withAllySlot(
      withAllySlot(
        createInitialDraft(),
        slotKeyOf("ally", "FRONT", 0),
        "UNIT_A",
        enhancementOf(10, gearsWith(GEAR, 0)),
      ),
      slotKeyOf("ally", "FRONT", 1),
      "UNIT_GONE",
      enhancementOf(20, gearsWith(GEAR, 1)),
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
      withAllySlot(
        createInitialDraft(),
        slotKeyOf("ally", "FRONT", 0),
        "UNIT_A",
        enhancementOf(10, gearsWith(GEAR, 0)),
      ),
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

// UI-UT-PST-013: Issue #539。演習の実行モードは`logLevel`の選択を置き換えたが、
// 以前のセッションで保存されたdraftは`exerciseExecution`を持たない。版を上げずに
// 項目を足すため、欠落は既定（単一実行）として読み、保存済みの`logLevel`は
// そのまま残す（通常戦闘のdraftはこれまでどおりその値で実行する）。
describe("演習の実行指定の保存 (UI-UT-PST-013)", () => {
  it("restores a draft that predates the exercise execution input with the single-run defaults", () => {
    const { exerciseExecution: _dropped, ...withoutExecution } = createInitialDraft();
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      draft: { ...withoutExecution, logLevel: "SUMMARY" },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.exerciseExecution).toEqual({ mode: "SINGLE", runCount: 100, seed: "" });
    expect(restored?.logLevel).toBe("SUMMARY");
  });

  it("round-trips the execution mode, run count, and seed", () => {
    const draft: BattleDraft = {
      ...createInitialDraft(),
      exerciseExecution: { mode: "STATISTICS", runCount: 2000, seed: "abc123" },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(toStoredDraft(draft))) as unknown);

    expect(restored).toStrictEqual(draft);
  });

  it("keeps the empty-input sentinel for the run count", () => {
    const draft: BattleDraft = {
      ...createInitialDraft(),
      exerciseExecution: { mode: "STATISTICS", runCount: "", seed: "" },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(toStoredDraft(draft))) as unknown);

    expect(restored?.exerciseExecution.runCount).toBe("");
  });

  it("discards stored data whose execution mode is not a known mode", () => {
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      draft: {
        ...createInitialDraft(),
        exerciseExecution: { mode: "BULK", runCount: 100, seed: "" },
      },
    };

    expect(parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown)).toBeUndefined();
  });
});

describe("レベルリンクの保存 (UI-UT-PST-011/012)", () => {
  const firstSlotKey = slotKeyOf("ally", "FRONT", 0);

  // UI-UT-PST-011: 版を上げずに項目を足すため、欠落は既定値として読む。
  // 版を上げると`envelopeOf`の完全一致判定で全利用者の保存データが破棄される。
  it("restores a v1 draft that predates the level link with the defaults", () => {
    const base = createInitialDraft();
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      draft: {
        ...base,
        allyEnhancement: { enabled: true, academyLevels: base.allyEnhancement.academyLevels },
        allySlots: base.allySlots.map((slot, index) =>
          index === 0
            ? {
                ...slot,
                unitDefinitionId: "UNIT_A",
                enhancement: enhancementOf(240, emptyGears()),
              }
            : slot,
        ),
      },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.allyEnhancement.levelLink).toEqual({ enabled: false, level: 200 });
    expect(restored?.allySlots[0]?.enhancement).toEqual({
      level: 240,
      linkExcluded: false,
      gears: emptyGears(),
    });
  });

  it("restores v1 player data that predates the level link with the defaults", () => {
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      academyLevels: createInitialDraft().allyEnhancement.academyLevels,
      units: { UNIT_A: enhancementOf(240, emptyGears()) },
    };

    const restored = parsePlayerData(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.levelLink).toEqual({ enabled: false, level: 200 });
    expect(restored?.units["UNIT_A"]?.linkExcluded).toBe(false);
  });

  it("discards stored data whose levelLink is not a level link", () => {
    const base = createInitialDraft();
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      draft: {
        ...base,
        allyEnhancement: { ...base.allyEnhancement, levelLink: { enabled: "yes", level: 1 } },
      },
    };

    expect(parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown)).toBeUndefined();
  });

  it("round-trips the level link and the per-slot exclusion", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...withAllySlot(base, firstSlotKey, "UNIT_A", {
        ...createInitialUnitEnhancement(),
        level: 180,
        linkExcluded: true,
      }),
      allyEnhancement: {
        ...base.allyEnhancement,
        enabled: true,
        levelLink: { enabled: true, level: 260 },
      },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(toStoredDraft(draft))) as unknown);

    expect(restored).toStrictEqual(draft);
  });

  // UI-UT-PST-012
  it("writes the ally level link back to the player data", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = {
      ...base,
      allyEnhancement: {
        ...base.allyEnhancement,
        levelLink: { enabled: true, level: 260 },
      },
    };

    const merged = mergePlayerDataFromDraft(createEmptyPlayerData(), draft);

    expect(merged.levelLink).toEqual({ enabled: true, level: 260 });
  });

  it("keeps the recorded link level while the input is empty", () => {
    const base = createInitialDraft();
    const recorded = mergePlayerDataFromDraft(createEmptyPlayerData(), {
      ...base,
      allyEnhancement: { ...base.allyEnhancement, levelLink: { enabled: true, level: 260 } },
    });

    const merged = mergePlayerDataFromDraft(recorded, {
      ...base,
      allyEnhancement: { ...base.allyEnhancement, levelLink: { enabled: true, level: "" } },
    });

    expect(merged.levelLink).toEqual({ enabled: true, level: 260 });
  });

  it("ignores the enemy level link", () => {
    const base = createInitialDraft();
    const merged = mergePlayerDataFromDraft(createEmptyPlayerData(), {
      ...base,
      enemyEnhancement: {
        ...base.enemyEnhancement,
        levelLink: { enabled: true, level: 260 },
      },
    });

    expect(merged.levelLink).toEqual({ enabled: false, level: 200 });
  });

  it("records a change of linkExcluded alone", () => {
    const draft = withAllySlot(createInitialDraft(), firstSlotKey, "UNIT_A", {
      ...createInitialUnitEnhancement(),
      linkExcluded: true,
    });

    const merged = mergePlayerDataFromDraft(createEmptyPlayerData(), draft, firstSlotKey);

    expect(merged.units["UNIT_A"]?.linkExcluded).toBe(true);
  });

  it("prefills the exclusion flag from the player data", () => {
    const draft = withAllySlot(createInitialDraft(), firstSlotKey, "UNIT_A", {
      ...createInitialUnitEnhancement(),
      linkExcluded: true,
    });
    const data = mergePlayerDataFromDraft(createEmptyPlayerData(), draft, firstSlotKey);

    expect(prefillUnitEnhancement(data, "UNIT_A").linkExcluded).toBe(true);
    expect(prefillUnitEnhancement(data, "UNIT_UNKNOWN").linkExcluded).toBe(false);
  });

  // リンクだけを設定した状態でキーごと消すと、リロードでリンクが失われる。
  it("is not empty once the level link differs from the default", () => {
    const base = createInitialDraft();
    const data = mergePlayerDataFromDraft(createEmptyPlayerData(), {
      ...base,
      allyEnhancement: { ...base.allyEnhancement, levelLink: { enabled: true, level: 200 } },
    });

    expect(isEmptyPlayerData(data)).toBe(false);
  });
});

describe("isEmptyPlayerData", () => {
  it("treats default academy levels with no unit entries as empty", () => {
    expect(isEmptyPlayerData(createEmptyPlayerData())).toBe(true);
  });

  it("is not empty once a unit is recorded", () => {
    const data = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      withAllySlot(
        createInitialDraft(),
        slotKeyOf("ally", "FRONT", 0),
        "UNIT_A",
        enhancementOf(10, gearsWith(GEAR, 0)),
      ),
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
      withAllySlot(
        createInitialDraft(),
        firstSlotKey,
        "UNIT_A",
        enhancementOf(editedLevel, gearsWith(GEAR, 0)),
      ),
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

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(220, gearsWith(GEAR, 0)));
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
    const edited = withAllySlot(
      draftWithDuplicate(220),
      secondSlotKey,
      "UNIT_A",
      enhancementOf(150, gearsWith(GEAR, 3)),
    );

    const merged = mergePlayerDataFromDraft(first, edited, secondSlotKey);

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(150, gearsWith(GEAR, 3)));
  });

  it("records nothing for a slot key that no longer holds a unit", () => {
    const recorded = mergePlayerDataFromDraft(
      createEmptyPlayerData(),
      draftWithDuplicate(220),
      firstSlotKey,
    );

    const merged = mergePlayerDataFromDraft(recorded, createInitialDraft(), firstSlotKey);

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(220, gearsWith(GEAR, 0)));
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
              enhancement: enhancementOf(333, gearsWith(GEAR, 0)),
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
        index === 0 ? { ...slot, enhancement: enhancementOf(1, []) } : slot,
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
