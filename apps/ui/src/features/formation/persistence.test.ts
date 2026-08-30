import { describe, expect, it } from "vitest";
import {
  PERSISTENCE_SCHEMA_VERSION,
  createEmptyPlayerData,
  isEmptyPlayerData,
  mergeForPersistence,
  parsePlayerData,
  parseStoredDraft,
  prunePlayerData,
  selectUnknownDefinitionSlotKeys,
  toStoredDraft,
  toStoredPlayerData,
} from "./persistence.js";
import type { StoredPlayerData } from "./persistence.js";
import { createInitialDraft, createInitialUnitEnhancement, slotKeyOf } from "./types.js";
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

/** `mergeForPersistence`のテスト用に、1ユニット分の記録を持つStoredPlayerDataを作る。 */
function withUnit(
  data: StoredPlayerData,
  unitDefinitionId: string,
  enhancement: UnitEnhancementInput,
): StoredPlayerData {
  return { ...data, units: { ...data.units, [unitDefinitionId]: enhancement } };
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
    const data = withUnit(
      createEmptyPlayerData(),
      "UNIT_A",
      enhancementOf(120, gearsWith(GEAR, 8)),
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

describe("mergeForPersistence", () => {
  // UI-UT-PST-005
  it("records a unit's level and gears", () => {
    const next = withUnit(
      createEmptyPlayerData(),
      "UNIT_A",
      enhancementOf(180, gearsWith(GEAR, 0)),
    );

    const merged = mergeForPersistence(createEmptyPlayerData(), next);

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(180, gearsWith(GEAR, 0)));
  });

  // UI-UT-PST-005
  it("records academy levels and skips blank inputs", () => {
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
    const next: StoredPlayerData = {
      ...previous,
      academyLevels: {
        unitTypes: { PHYSICAL: 3, ENERGY: "", AGILE: 1 },
        attributes: previous.academyLevels.attributes,
      },
    };

    const merged = mergeForPersistence(previous, next);

    expect(merged.academyLevels.unitTypes).toStrictEqual({ PHYSICAL: 3, ENERGY: 7, AGILE: 1 });
  });

  // UI-UT-PST-005
  it("keeps the previously recorded level while the level input is blank, but still updates gears", () => {
    const previous = withUnit(
      createEmptyPlayerData(),
      "UNIT_A",
      enhancementOf(180, gearsWith(GEAR, 0)),
    );
    const next = withUnit(createEmptyPlayerData(), "UNIT_A", enhancementOf("", gearsWith(GEAR, 1)));

    const merged = mergeForPersistence(previous, next);

    expect(merged.units["UNIT_A"]).toStrictEqual(enhancementOf(180, gearsWith(GEAR, 1)));
  });

  // UI-UT-PST-006
  it("returns the same reference when nothing changed", () => {
    const next = withUnit(
      createEmptyPlayerData(),
      "UNIT_A",
      enhancementOf(180, gearsWith(GEAR, 0)),
    );
    const first = mergeForPersistence(createEmptyPlayerData(), next);

    expect(mergeForPersistence(first, next)).toBe(first);
  });

  it("drops a unit entry the live state no longer has (e.g. after clearing)", () => {
    const previous = withUnit(
      createEmptyPlayerData(),
      "UNIT_A",
      enhancementOf(180, gearsWith(GEAR, 0)),
    );

    const merged = mergeForPersistence(previous, createEmptyPlayerData());

    expect(merged.units).toStrictEqual({});
  });
});

describe("prunePlayerData", () => {
  // UI-UT-PST-009
  it("drops only the entries missing from the catalog", () => {
    const data = withUnit(
      withUnit(createEmptyPlayerData(), "UNIT_A", enhancementOf(10, gearsWith(GEAR, 0))),
      "UNIT_GONE",
      enhancementOf(20, gearsWith(GEAR, 1)),
    );

    const pruned = prunePlayerData(data, ["UNIT_A"]);

    expect(Object.keys(pruned.units)).toStrictEqual(["UNIT_A"]);
    expect(pruned.academyLevels).toStrictEqual(data.academyLevels);
  });

  // UI-UT-PST-006
  it("returns the same reference when every entry is known", () => {
    const data = withUnit(createEmptyPlayerData(), "UNIT_A", enhancementOf(10, gearsWith(GEAR, 0)));

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
      rank: 5,
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
  it("writes the level link back to the player data", () => {
    const next: StoredPlayerData = {
      ...createEmptyPlayerData(),
      levelLink: { enabled: true, level: 260 },
    };

    const merged = mergeForPersistence(createEmptyPlayerData(), next);

    expect(merged.levelLink).toEqual({ enabled: true, level: 260 });
  });

  it("keeps the recorded link level while the input is empty", () => {
    const recorded = mergeForPersistence(createEmptyPlayerData(), {
      ...createEmptyPlayerData(),
      levelLink: { enabled: true, level: 260 },
    });

    const merged = mergeForPersistence(recorded, {
      ...createEmptyPlayerData(),
      levelLink: { enabled: true, level: "" },
    });

    expect(merged.levelLink).toEqual({ enabled: true, level: 260 });
  });

  it("records a change of linkExcluded alone", () => {
    const next = withUnit(createEmptyPlayerData(), "UNIT_A", {
      ...createInitialUnitEnhancement(),
      linkExcluded: true,
    });

    const merged = mergeForPersistence(createEmptyPlayerData(), next);

    expect(merged.units["UNIT_A"]?.linkExcluded).toBe(true);
  });

  // リンクだけを設定した状態でキーごと消すと、リロードでリンクが失われる。
  it("is not empty once the level link differs from the default", () => {
    const data = mergeForPersistence(createEmptyPlayerData(), {
      ...createEmptyPlayerData(),
      levelLink: { enabled: true, level: 200 },
    });

    expect(isEmptyPlayerData(data)).toBe(false);
  });
});

// UI-UT-PST-014〜016: Issue #638。`rank`も`levelLink`・`linkExcluded`と同じ理由
// （PERSISTENCE_SCHEMA_VERSIONを上げると全利用者の手持ちデータが破棄される）で
// 版を上げずに足す新項目。欠落は既定値LR+5（内部値5）として読む。
describe("ユニットランクの保存 (UI-UT-PST-014〜016)", () => {
  const firstSlotKey = slotKeyOf("ally", "FRONT", 0);

  it("UI-UT-PST-014: restores a v1 draft that predates rank with the default LR+5", () => {
    const base = createInitialDraft();
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      draft: {
        ...base,
        allySlots: base.allySlots.map((slot) =>
          slot.slotKey === firstSlotKey
            ? {
                ...slot,
                unitDefinitionId: "UNIT_A",
                enhancement: { level: 240, linkExcluded: false, gears: emptyGears() },
              }
            : slot,
        ),
      },
    };

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.allySlots.find((slot) => slot.slotKey === firstSlotKey)?.enhancement).toEqual({
      level: 240,
      rank: 5,
      linkExcluded: false,
      gears: emptyGears(),
    });
  });

  it("UI-UT-PST-015: restores v1 player data that predates rank with the default LR+5", () => {
    const stored = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      academyLevels: createInitialDraft().allyEnhancement.academyLevels,
      units: { UNIT_A: { level: 240, linkExcluded: false, gears: emptyGears() } },
    };

    const restored = parsePlayerData(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(restored?.units["UNIT_A"]?.rank).toBe(5);
  });

  it("UI-UT-PST-016: round-trips a non-default rank", () => {
    const base = createInitialDraft();
    const draft: BattleDraft = withAllySlot(base, firstSlotKey, "UNIT_A", {
      ...createInitialUnitEnhancement(),
      rank: 2,
    });

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(toStoredDraft(draft))) as unknown);

    expect(restored).toStrictEqual(draft);
  });

  // UI-UT-PST-017: R-ENH-07はランクを0〜5の整数に限定する。localStorageの不正値を
  // そのまま復元すると、次の送信が422で拒否され実行不能になる（レビュー指摘）。
  it.each([[-1], [6], [2.5]])(
    "UI-UT-PST-017: discards the whole draft when a slot's stored rank is %p (out of 0-5 integer range)",
    (rank) => {
      const base = createInitialDraft();
      const stored = {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        draft: {
          ...base,
          allySlots: base.allySlots.map((slot) =>
            slot.slotKey === firstSlotKey
              ? {
                  ...slot,
                  unitDefinitionId: "UNIT_A",
                  enhancement: { level: 200, rank, linkExcluded: false, gears: emptyGears() },
                }
              : slot,
          ),
        },
      };

      expect(parseStoredDraft(JSON.parse(JSON.stringify(stored)) as unknown)).toBeUndefined();
    },
  );

  it.each([[-1], [6], [2.5]])(
    "UI-UT-PST-018: discards the whole player data when a unit's stored rank is %p (out of 0-5 integer range)",
    (rank) => {
      const stored = {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        academyLevels: createInitialDraft().allyEnhancement.academyLevels,
        units: { UNIT_A: { level: 200, rank, linkExcluded: false, gears: emptyGears() } },
      };

      expect(parsePlayerData(JSON.parse(JSON.stringify(stored)) as unknown)).toBeUndefined();
    },
  );

  it.each([[0], [5]])("UI-UT-PST-019: restores the boundary rank %p", (rank) => {
    const base = createInitialDraft();
    const draft: BattleDraft = withAllySlot(base, firstSlotKey, "UNIT_A", {
      ...createInitialUnitEnhancement(),
      rank,
    });

    const restored = parseStoredDraft(JSON.parse(JSON.stringify(toStoredDraft(draft))) as unknown);

    expect(
      restored?.allySlots.find((slot) => slot.slotKey === firstSlotKey)?.enhancement?.rank,
    ).toBe(rank);
  });
});

describe("isEmptyPlayerData", () => {
  it("treats default academy levels with no unit entries as empty", () => {
    expect(isEmptyPlayerData(createEmptyPlayerData())).toBe(true);
  });

  it("is not empty once a unit is recorded", () => {
    const data = withUnit(createEmptyPlayerData(), "UNIT_A", enhancementOf(10, gearsWith(GEAR, 0)));

    expect(isEmptyPlayerData(data)).toBe(false);
  });

  it("is not empty once an academy level differs from the default", () => {
    const base = createEmptyPlayerData();
    const data: StoredPlayerData = {
      ...base,
      academyLevels: {
        ...base.academyLevels,
        unitTypes: { ...base.academyLevels.unitTypes, PHYSICAL: 4 },
      },
    };

    expect(isEmptyPlayerData(data)).toBe(false);
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
