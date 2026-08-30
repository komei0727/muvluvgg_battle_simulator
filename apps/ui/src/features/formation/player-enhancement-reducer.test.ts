import { describe, expect, it } from "vitest";
import {
  createInitialPlayerEnhancementState,
  playerEnhancementReducer,
} from "./player-enhancement-reducer.js";
import { createEmptyPlayerData } from "./persistence.js";
import type { StoredPlayerData } from "./persistence.js";

describe("createInitialPlayerEnhancementState", () => {
  it("starts empty when no stored data is given", () => {
    expect(createInitialPlayerEnhancementState()).toStrictEqual(createEmptyPlayerData());
  });

  it("restores a supplied StoredPlayerData as the initial state", () => {
    const restored: StoredPlayerData = {
      ...createEmptyPlayerData(),
      academyLevels: {
        ...createEmptyPlayerData().academyLevels,
        unitTypes: { PHYSICAL: 5, ENERGY: 1, AGILE: 1 },
      },
    };

    expect(createInitialPlayerEnhancementState(restored)).toStrictEqual(restored);
  });
});

describe("playerEnhancementReducer — academyLevelChanged", () => {
  it("changes one academy level without touching the others", () => {
    const state = createInitialPlayerEnhancementState();

    const next = playerEnhancementReducer(state, {
      type: "academyLevelChanged",
      group: "unitTypes",
      key: "PHYSICAL",
      value: 42,
    });

    expect(next.academyLevels.unitTypes["PHYSICAL"]).toBe(42);
    expect(next.academyLevels.unitTypes["ENERGY"]).toBe(1);
    expect(next.academyLevels.attributes).toStrictEqual(state.academyLevels.attributes);
    expect(next.levelLink).toStrictEqual(state.levelLink);
    expect(next.units).toStrictEqual(state.units);
  });

  it("accepts the empty-input sentinel while the field is being retyped", () => {
    const state = createInitialPlayerEnhancementState();

    const next = playerEnhancementReducer(state, {
      type: "academyLevelChanged",
      group: "attributes",
      key: "CUTE",
      value: "",
    });

    expect(next.academyLevels.attributes["CUTE"]).toBe("");
  });
});

describe("playerEnhancementReducer — レベルリンク (UI-AC-035/036)", () => {
  it("toggles the link independently of the link level", () => {
    const state = createInitialPlayerEnhancementState();

    const next = playerEnhancementReducer(state, { type: "levelLinkToggled", enabled: true });

    expect(next.levelLink).toStrictEqual({ enabled: true, level: 200 });
  });

  it("changes the link level without touching the toggle", () => {
    const linked = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "levelLinkToggled",
      enabled: true,
    });

    const next = playerEnhancementReducer(linked, {
      type: "levelLinkLevelChanged",
      value: 260,
    });

    expect(next.levelLink).toStrictEqual({ enabled: true, level: 260 });
  });
});

describe("playerEnhancementReducer — ユニット強化", () => {
  it("starts a unit's enhancement from the defaults on the first edit", () => {
    const state = createInitialPlayerEnhancementState();

    const next = playerEnhancementReducer(state, {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_A",
      value: 220,
    });

    expect(next.units["UNIT_A"]).toStrictEqual({
      level: 220,
      rank: 5,
      linkExcluded: false,
      gears: Array.from({ length: 9 }, () => undefined),
    });
  });

  it("sets and clears a single gear slot, leaving the others empty", () => {
    const withLevel = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_A",
      value: 220,
    });

    const withGear = playerEnhancementReducer(withLevel, {
      type: "unitEnhancementGearChanged",
      unitDefinitionId: "UNIT_A",
      gearIndex: 2,
      gear: { stat: "ATTACK", tier: "III", grade: "S" },
    });
    expect(withGear.units["UNIT_A"]?.gears[2]).toStrictEqual({
      stat: "ATTACK",
      tier: "III",
      grade: "S",
    });
    expect(withGear.units["UNIT_A"]?.level).toBe(220);

    const cleared = playerEnhancementReducer(withGear, {
      type: "unitEnhancementGearChanged",
      unitDefinitionId: "UNIT_A",
      gearIndex: 2,
    });
    expect(cleared.units["UNIT_A"]?.gears[2]).toBeUndefined();
  });

  // Issue #638: ユニットランク選択。手持ちデータ単位の任意入力で、レベルと同じ規約。
  it("starts a unit's enhancement rank from the default LR+5 on the first edit", () => {
    const state = createInitialPlayerEnhancementState();

    const next = playerEnhancementReducer(state, {
      type: "unitEnhancementRankChanged",
      unitDefinitionId: "UNIT_A",
      value: 3,
    });

    expect(next.units["UNIT_A"]?.rank).toBe(3);
    expect(next.units["UNIT_A"]?.level).toBe(200);
  });

  it("does not affect a different unit's recorded rank", () => {
    const withA = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "unitEnhancementRankChanged",
      unitDefinitionId: "UNIT_A",
      value: 2,
    });

    const withB = playerEnhancementReducer(withA, {
      type: "unitEnhancementRankChanged",
      unitDefinitionId: "UNIT_B",
      value: 4,
    });

    expect(withB.units["UNIT_A"]?.rank).toBe(2);
    expect(withB.units["UNIT_B"]?.rank).toBe(4);
  });

  it("does not affect a different unit's recorded enhancement", () => {
    const withA = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_A",
      value: 220,
    });

    const withB = playerEnhancementReducer(withA, {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_B",
      value: 150,
    });

    expect(withB.units["UNIT_A"]?.level).toBe(220);
    expect(withB.units["UNIT_B"]?.level).toBe(150);
  });

  // 外した瞬間のシードは呼び出し側（`app/SelectionDialogs.tsx`）が`seedLevel`として
  // 載せる（UI-AC-036、下の別テストで検証）。ここでは`linkExcluded`だけを変える
  // 呼び出しがlevelに影響しないことを確認する。
  it("records the link-exclusion flag independently of the level when seedLevel is absent", () => {
    const withLevel = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_A",
      value: 260,
    });

    const excluded = playerEnhancementReducer(withLevel, {
      type: "unitLinkExclusionChanged",
      unitDefinitionId: "UNIT_A",
      excluded: true,
    });

    expect(excluded.units["UNIT_A"]).toStrictEqual({
      level: 260,
      rank: 5,
      linkExcluded: true,
      gears: Array.from({ length: 9 }, () => undefined),
    });
  });

  // UI-AC-036の枠側の判定（isSlotLevelLinked）は`app/SelectionDialogs.tsx`が持ち、
  // 外した瞬間のリンクレベルを`seedLevel`として載せる。ここではreducerが
  // `seedLevel`をどう適用するかだけを検証する。
  it("applies seedLevel to the unit's level when excluding, alongside linkExcluded", () => {
    const withLevel = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_A",
      value: 180,
    });

    const excluded = playerEnhancementReducer(withLevel, {
      type: "unitLinkExclusionChanged",
      unitDefinitionId: "UNIT_A",
      excluded: true,
      seedLevel: 260,
    });

    expect(excluded.units["UNIT_A"]?.level).toBe(260);
    expect(excluded.units["UNIT_A"]?.linkExcluded).toBe(true);
  });

  it("leaves the level untouched when no seedLevel is given (returning to the link)", () => {
    const withLevel = playerEnhancementReducer(createInitialPlayerEnhancementState(), {
      type: "unitEnhancementLevelChanged",
      unitDefinitionId: "UNIT_A",
      value: 180,
    });

    const next = playerEnhancementReducer(withLevel, {
      type: "unitLinkExclusionChanged",
      unitDefinitionId: "UNIT_A",
      excluded: false,
    });

    expect(next.units["UNIT_A"]?.level).toBe(180);
    expect(next.units["UNIT_A"]?.linkExcluded).toBe(false);
  });
});

describe("playerEnhancementReducer — cleared", () => {
  it("resets academy levels, the level link, and every unit's growth data to defaults", () => {
    const edited = playerEnhancementReducer(
      playerEnhancementReducer(createInitialPlayerEnhancementState(), {
        type: "academyLevelChanged",
        group: "unitTypes",
        key: "PHYSICAL",
        value: 9,
      }),
      { type: "unitEnhancementLevelChanged", unitDefinitionId: "UNIT_A", value: 220 },
    );
    const linked = playerEnhancementReducer(edited, { type: "levelLinkToggled", enabled: true });

    const next = playerEnhancementReducer(linked, { type: "cleared" });

    expect(next).toStrictEqual(createEmptyPlayerData());
  });
});

describe("playerEnhancementReducer — pruned", () => {
  it("drops entries for unit definitions no longer known to the catalog", () => {
    const withUnits = playerEnhancementReducer(
      playerEnhancementReducer(createInitialPlayerEnhancementState(), {
        type: "unitEnhancementLevelChanged",
        unitDefinitionId: "UNIT_KEPT",
        value: 220,
      }),
      { type: "unitEnhancementLevelChanged", unitDefinitionId: "UNIT_GONE", value: 150 },
    );

    const next = playerEnhancementReducer(withUnits, {
      type: "pruned",
      knownUnitDefinitionIds: ["UNIT_KEPT"],
    });

    expect(Object.keys(next.units)).toStrictEqual(["UNIT_KEPT"]);
    // 学園レベル・レベルリンクはユニット定義に依存しないため残す。
    expect(next.academyLevels).toStrictEqual(withUnits.academyLevels);
  });

  it("returns the same reference when nothing needed pruning", () => {
    const state = createInitialPlayerEnhancementState();

    expect(playerEnhancementReducer(state, { type: "pruned", knownUnitDefinitionIds: [] })).toBe(
      state,
    );
  });
});
