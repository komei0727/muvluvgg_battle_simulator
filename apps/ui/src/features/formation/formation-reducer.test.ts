import { describe, expect, it } from "vitest";
import {
  createInitialFormationState,
  formationReducer,
  MAX_UNITS_PER_SIDE,
} from "./formation-reducer.js";
import { createInitialDraft, memorySlotKeyOf, slotKeyOf } from "./types.js";
import type { FormationState } from "./formation-reducer.js";

function fillAllySlots(state: FormationState, count: number): FormationState {
  let next = state;
  for (let index = 0; index < count; index++) {
    const slot = next.draft.allySlots[index]!;
    next = formationReducer(next, {
      type: "unitSelected",
      slotKey: slot.slotKey,
      unitDefinitionId: `UNIT_${index}`,
    });
  }
  return next;
}

describe("formationReducer — unitSelected", () => {
  it("sets the unitDefinitionId on the targeted slot and closes the dialog", () => {
    const state = createInitialFormationState();
    const slotKey = slotKeyOf("ally", "FRONT", 0);

    const next = formationReducer(state, {
      type: "unitSelected",
      slotKey,
      unitDefinitionId: "UNIT_A",
    });

    const slot = next.draft.allySlots.find((s) => s.slotKey === slotKey);
    expect(slot?.unitDefinitionId).toBe("UNIT_A");
  });

  it("does not affect other slots", () => {
    const state = createInitialFormationState();
    const next = formationReducer(state, {
      type: "unitSelected",
      slotKey: slotKeyOf("ally", "FRONT", 0),
      unitDefinitionId: "UNIT_A",
    });

    expect(next.draft.allySlots.filter((s) => s.unitDefinitionId !== undefined)).toHaveLength(1);
    expect(next.draft.enemySlots.every((s) => s.unitDefinitionId === undefined)).toBe(true);
  });

  it("rejects selecting into a 6th slot for a side already at capacity, leaving state unchanged", () => {
    const state = fillAllySlots(createInitialFormationState(), MAX_UNITS_PER_SIDE);
    expect(state.draft.allySlots.filter((s) => s.unitDefinitionId !== undefined)).toHaveLength(
      MAX_UNITS_PER_SIDE,
    );

    const sixthSlotKey = state.draft.allySlots[MAX_UNITS_PER_SIDE]!.slotKey;
    const next = formationReducer(state, {
      type: "unitSelected",
      slotKey: sixthSlotKey,
      unitDefinitionId: "UNIT_SIXTH",
    });

    expect(next).toBe(state);
  });

  it("allows swapping an already-filled slot's unit even when the side is at capacity", () => {
    const state = fillAllySlots(createInitialFormationState(), MAX_UNITS_PER_SIDE);
    const firstSlotKey = state.draft.allySlots[0]!.slotKey;

    const next = formationReducer(state, {
      type: "unitSelected",
      slotKey: firstSlotKey,
      unitDefinitionId: "UNIT_REPLACED",
    });

    const slot = next.draft.allySlots.find((s) => s.slotKey === firstSlotKey);
    expect(slot?.unitDefinitionId).toBe("UNIT_REPLACED");
    expect(next.draft.allySlots.filter((s) => s.unitDefinitionId !== undefined)).toHaveLength(
      MAX_UNITS_PER_SIDE,
    );
  });

  it("ignores an unknown slotKey", () => {
    const state = createInitialFormationState();
    const next = formationReducer(state, {
      type: "unitSelected",
      slotKey: "not-a-real-slot",
      unitDefinitionId: "UNIT_A",
    });
    expect(next).toBe(state);
  });

  // R-TEX-01 #3 / UI-AC-019: 演習の敵は1体だけ。空き枠を選んだら移し替える。
  describe("exclusiveForSide", () => {
    function placeEnemyExclusively(
      state: FormationState,
      slotKey: string,
      unitDefinitionId: string,
    ): FormationState {
      return formationReducer(state, {
        type: "unitSelected",
        slotKey,
        unitDefinitionId,
        exclusiveForSide: true,
      });
    }

    it("empties the previously filled slot of that side instead of adding a second unit", () => {
      const front = slotKeyOf("enemy", "FRONT", 0);
      const rear = slotKeyOf("enemy", "REAR", 2);
      const placed = placeEnemyExclusively(createInitialFormationState(), front, "UNIT_EX");

      const moved = placeEnemyExclusively(placed, rear, "UNIT_EX");

      expect(moved.draft.enemySlots.filter((s) => s.unitDefinitionId !== undefined)).toEqual([
        expect.objectContaining({ slotKey: rear, unitDefinitionId: "UNIT_EX" }),
      ]);
      expect(moved.draft.enemySlots.find((s) => s.slotKey === front)).not.toHaveProperty(
        "unitDefinitionId",
      );
    });

    it("leaves the other side untouched", () => {
      const state = fillAllySlots(createInitialFormationState(), 2);

      const next = placeEnemyExclusively(state, slotKeyOf("enemy", "REAR", 1), "UNIT_EX");

      expect(next.draft.allySlots.filter((s) => s.unitDefinitionId !== undefined)).toHaveLength(2);
    });

    it("replaces the unit in place when the same slot is chosen again", () => {
      const slotKey = slotKeyOf("enemy", "FRONT", 1);
      const placed = placeEnemyExclusively(createInitialFormationState(), slotKey, "UNIT_EX");

      const next = placeEnemyExclusively(placed, slotKey, "UNIT_EX_CLOSED");

      expect(next.draft.enemySlots.filter((s) => s.unitDefinitionId !== undefined)).toEqual([
        expect.objectContaining({ slotKey, unitDefinitionId: "UNIT_EX_CLOSED" }),
      ]);
    });
  });
});

describe("formationReducer — unitRemoved", () => {
  it("clears the unitDefinitionId on the targeted slot", () => {
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const filled = formationReducer(createInitialFormationState(), {
      type: "unitSelected",
      slotKey,
      unitDefinitionId: "UNIT_A",
    });

    const next = formationReducer(filled, { type: "unitRemoved", slotKey });

    const slot = next.draft.allySlots.find((s) => s.slotKey === slotKey);
    expect(slot?.unitDefinitionId).toBeUndefined();
  });
});

describe("formationReducer — memorySelected / memoryRemoved", () => {
  it("sets and clears a memory slot for the given side and index", () => {
    const selected = formationReducer(createInitialFormationState(), {
      type: "memorySelected",
      side: "enemy",
      index: 2,
      memoryDefinitionId: "MEM_A",
    });
    expect(selected.draft.enemyMemoryDefinitionIds[2]).toBe("MEM_A");
    expect(selected.draft.allyMemoryDefinitionIds.every((id) => id === undefined)).toBe(true);

    const removed = formationReducer(selected, { type: "memoryRemoved", side: "enemy", index: 2 });
    expect(removed.draft.enemyMemoryDefinitionIds[2]).toBeUndefined();
  });
});

describe("formationReducer — parameters", () => {
  it("updates turnLimit and logLevel independently", () => {
    const withTurn = formationReducer(createInitialFormationState(), {
      type: "turnLimitChanged",
      value: 42,
    });
    expect(withTurn.draft.turnLimit).toBe(42);

    const withLevel = formationReducer(withTurn, { type: "logLevelChanged", value: "DETAILED" });
    expect(withLevel.draft.logLevel).toBe("DETAILED");
    expect(withLevel.draft.turnLimit).toBe(42);
  });

  it("accepts the empty-input sentinel for turnLimit", () => {
    const next = formationReducer(createInitialFormationState(), {
      type: "turnLimitChanged",
      value: "",
    });
    expect(next.draft.turnLimit).toBe("");
  });

  // Issue #539: モードを往復しても統計実行のパラメータを入力し直させない。
  it("updates the exercise execution mode, run count, and seed independently", () => {
    const withMode = formationReducer(createInitialFormationState(), {
      type: "exerciseExecutionModeChanged",
      value: "STATISTICS",
    });
    expect(withMode.draft.exerciseExecution.mode).toBe("STATISTICS");
    expect(withMode.draft.exerciseExecution.runCount).toBe(100);

    const withRuns = formationReducer(withMode, {
      type: "exerciseRunCountChanged",
      value: 500,
    });
    const withSeed = formationReducer(withRuns, { type: "exerciseSeedChanged", value: "abc123" });
    expect(withSeed.draft.exerciseExecution).toEqual({
      mode: "STATISTICS",
      runCount: 500,
      seed: "abc123",
    });

    const backToSingle = formationReducer(withSeed, {
      type: "exerciseExecutionModeChanged",
      value: "SINGLE",
    });
    expect(backToSingle.draft.exerciseExecution).toEqual({
      mode: "SINGLE",
      runCount: 500,
      seed: "abc123",
    });
  });

  it("accepts the empty-input sentinel for the run count", () => {
    const next = formationReducer(createInitialFormationState(), {
      type: "exerciseRunCountChanged",
      value: "",
    });
    expect(next.draft.exerciseExecution.runCount).toBe("");
  });
});

describe("formationReducer — 強化入力 (M11)", () => {
  it("toggles a side's enhancement independently of the other side", () => {
    const state = formationReducer(createInitialFormationState(), {
      type: "enhancementToggled",
      side: "ally",
      enabled: true,
    });

    expect(state.draft.allyEnhancement.enabled).toBe(true);
    expect(state.draft.enemyEnhancement.enabled).toBe(false);
  });

  it("changes one academy level without touching the other systems", () => {
    const state = formationReducer(createInitialFormationState(), {
      type: "academyLevelChanged",
      side: "enemy",
      group: "unitTypes",
      key: "PHYSICAL",
      value: 50,
    });

    expect(state.draft.enemyEnhancement.academyLevels.unitTypes.PHYSICAL).toBe(50);
    expect(state.draft.enemyEnhancement.academyLevels.unitTypes.ENERGY).toBe(1);
    expect(state.draft.enemyEnhancement.academyLevels.attributes.AGGRESSIVE).toBe(1);
  });

  it("UI-CMP-014: keeps the enhancement inputs when the toggle goes back off", () => {
    let state = formationReducer(createInitialFormationState(), {
      type: "enhancementToggled",
      side: "ally",
      enabled: true,
    });
    state = formationReducer(state, {
      type: "academyLevelChanged",
      side: "ally",
      group: "attributes",
      key: "CLEVER",
      value: 30,
    });
    state = formationReducer(state, { type: "enhancementToggled", side: "ally", enabled: false });

    expect(state.draft.allyEnhancement.enabled).toBe(false);
    expect(state.draft.allyEnhancement.academyLevels.attributes.CLEVER).toBe(30);
  });

  it("starts a slot's unit enhancement from the defaults on the first edit", () => {
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const state = formationReducer(createInitialFormationState(), {
      type: "unitEnhancementLevelChanged",
      slotKey,
      value: 220,
    });

    const slot = state.draft.allySlots.find((s) => s.slotKey === slotKey);
    expect(slot?.enhancement?.level).toBe(220);
    expect(slot?.enhancement?.gears).toHaveLength(9);
  });

  it("sets and clears a single gear slot, leaving the others empty", () => {
    const slotKey = slotKeyOf("enemy", "REAR", 2);
    let state = formationReducer(createInitialFormationState(), {
      type: "unitEnhancementGearChanged",
      slotKey,
      gearIndex: 3,
      gear: { stat: "ATTACK", tier: "III", grade: "S" },
    });
    let slot = state.draft.enemySlots.find((s) => s.slotKey === slotKey);
    expect(slot?.enhancement?.gears[3]).toEqual({ stat: "ATTACK", tier: "III", grade: "S" });
    expect(slot?.enhancement?.gears.filter((gear) => gear !== undefined)).toHaveLength(1);

    state = formationReducer(state, {
      type: "unitEnhancementGearChanged",
      slotKey,
      gearIndex: 3,
    });
    slot = state.draft.enemySlots.find((s) => s.slotKey === slotKey);
    expect(slot?.enhancement?.gears[3]).toBeUndefined();
  });

  it("ignores an edit addressed to an unknown slotKey", () => {
    const initial = createInitialFormationState();

    expect(
      formationReducer(initial, {
        type: "unitEnhancementLevelChanged",
        slotKey: "ally:FRONT:9",
        value: 5,
      }),
    ).toBe(initial);
  });
});

describe("formationReducer — unitMoved (UI-AC-032)", () => {
  function stateWithAllyUnit(slotKey: string, unitDefinitionId: string): FormationState {
    return formationReducer(createInitialFormationState(), {
      type: "unitSelected",
      slotKey,
      unitDefinitionId,
    });
  }

  it("moves a unit and its enhancement to an empty same-side slot, emptying the source", () => {
    const fromKey = slotKeyOf("ally", "FRONT", 0);
    const toKey = slotKeyOf("ally", "REAR", 1);
    let state = stateWithAllyUnit(fromKey, "UNIT_A");
    state = formationReducer(state, {
      type: "unitEnhancementLevelChanged",
      slotKey: fromKey,
      value: 220,
    });

    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: fromKey,
      toSlotKey: toKey,
    });

    const from = next.draft.allySlots.find((s) => s.slotKey === fromKey)!;
    const to = next.draft.allySlots.find((s) => s.slotKey === toKey)!;
    expect(to.unitDefinitionId).toBe("UNIT_A");
    expect(to.enhancement?.level).toBe(220);
    expect("unitDefinitionId" in from).toBe(false);
    expect("enhancement" in from).toBe(false);
  });

  it("swaps two filled slots including asymmetric enhancements", () => {
    const frontKey = slotKeyOf("ally", "FRONT", 0);
    const rearKey = slotKeyOf("ally", "REAR", 2);
    let state = stateWithAllyUnit(frontKey, "UNIT_A");
    state = formationReducer(state, {
      type: "unitSelected",
      slotKey: rearKey,
      unitDefinitionId: "UNIT_B",
    });
    state = formationReducer(state, {
      type: "unitEnhancementGearChanged",
      slotKey: frontKey,
      gearIndex: 0,
      gear: { stat: "ATTACK", tier: "III", grade: "S" },
    });

    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: frontKey,
      toSlotKey: rearKey,
    });

    const front = next.draft.allySlots.find((s) => s.slotKey === frontKey)!;
    const rear = next.draft.allySlots.find((s) => s.slotKey === rearKey)!;
    expect(front.unitDefinitionId).toBe("UNIT_B");
    expect(rear.unitDefinitionId).toBe("UNIT_A");
    expect(rear.enhancement?.gears[0]).toEqual({ stat: "ATTACK", tier: "III", grade: "S" });
    expect("enhancement" in front).toBe(false);
  });

  it("ignores a move whose source slot is empty", () => {
    const state = stateWithAllyUnit(slotKeyOf("ally", "FRONT", 0), "UNIT_A");
    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: slotKeyOf("ally", "REAR", 0),
      toSlotKey: slotKeyOf("ally", "REAR", 1),
    });
    expect(next).toBe(state);
  });

  it("ignores a move onto the same slot", () => {
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const state = stateWithAllyUnit(slotKey, "UNIT_A");
    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: slotKey,
      toSlotKey: slotKey,
    });
    expect(next).toBe(state);
  });

  it("ignores unknown slot keys on either end", () => {
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const state = stateWithAllyUnit(slotKey, "UNIT_A");

    expect(
      formationReducer(state, {
        type: "unitMoved",
        fromSlotKey: "not-a-slot",
        toSlotKey: slotKey,
      }),
    ).toBe(state);
    expect(
      formationReducer(state, {
        type: "unitMoved",
        fromSlotKey: slotKey,
        toSlotKey: "not-a-slot",
      }),
    ).toBe(state);
  });

  it("ignores a cross-side move", () => {
    const state = stateWithAllyUnit(slotKeyOf("ally", "FRONT", 0), "UNIT_A");
    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: slotKeyOf("ally", "FRONT", 0),
      toSlotKey: slotKeyOf("enemy", "FRONT", 0),
    });
    expect(next).toBe(state);
  });

  it("does not touch memories, other slots, or the other side", () => {
    const fromKey = slotKeyOf("ally", "FRONT", 0);
    let state = stateWithAllyUnit(fromKey, "UNIT_A");
    state = formationReducer(state, {
      type: "unitSelected",
      slotKey: slotKeyOf("ally", "FRONT", 1),
      unitDefinitionId: "UNIT_KEEP",
    });
    state = formationReducer(state, {
      type: "memorySelected",
      side: "ally",
      index: 0,
      memoryDefinitionId: "MEM_A",
    });

    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: fromKey,
      toSlotKey: slotKeyOf("ally", "REAR", 0),
    });

    expect(next.draft.allyMemoryDefinitionIds).toEqual(state.draft.allyMemoryDefinitionIds);
    expect(
      next.draft.allySlots.find((s) => s.slotKey === slotKeyOf("ally", "FRONT", 1))
        ?.unitDefinitionId,
    ).toBe("UNIT_KEEP");
    expect(next.draft.enemySlots).toBe(state.draft.enemySlots);
  });

  it("swaps freely while the side is at the 5-unit capacity", () => {
    const state = fillAllySlots(createInitialFormationState(), MAX_UNITS_PER_SIDE);
    const firstKey = state.draft.allySlots[0]!.slotKey;
    const secondKey = state.draft.allySlots[1]!.slotKey;

    const next = formationReducer(state, {
      type: "unitMoved",
      fromSlotKey: firstKey,
      toSlotKey: secondKey,
    });

    expect(next.draft.allySlots.find((s) => s.slotKey === firstKey)?.unitDefinitionId).toBe(
      "UNIT_1",
    );
    expect(next.draft.allySlots.find((s) => s.slotKey === secondKey)?.unitDefinitionId).toBe(
      "UNIT_0",
    );
    expect(next.draft.allySlots.filter((s) => s.unitDefinitionId !== undefined)).toHaveLength(
      MAX_UNITS_PER_SIDE,
    );
  });
});

describe("formationReducer — レベルリンク (UI-AC-035/036)", () => {
  const allySlotKey = slotKeyOf("ally", "FRONT", 0);

  function linkedState(level: number | "" = 260): FormationState {
    const placed = formationReducer(createInitialFormationState(), {
      type: "unitSelected",
      slotKey: allySlotKey,
      unitDefinitionId: "UNIT_A",
    });
    const enabled = formationReducer(placed, {
      type: "enhancementToggled",
      side: "ally",
      enabled: true,
    });
    const toggled = formationReducer(enabled, {
      type: "levelLinkToggled",
      side: "ally",
      enabled: true,
    });
    return formationReducer(toggled, { type: "levelLinkLevelChanged", side: "ally", value: level });
  }

  it("toggles the link and edits the link level on the requested side only", () => {
    const next = linkedState();

    expect(next.draft.allyEnhancement.levelLink).toStrictEqual({ enabled: true, level: 260 });
    expect(next.draft.enemyEnhancement.levelLink).toStrictEqual({ enabled: false, level: 200 });
  });

  it("never rewrites a slot level when the link is toggled or edited", () => {
    // 参照時解決なので、リンクのON/OFFで枠の値を書き換えない（UI-CMP-023）。
    const edited = formationReducer(linkedState(), {
      type: "unitEnhancementLevelChanged",
      slotKey: allySlotKey,
      value: 180,
    });

    const off = formationReducer(edited, {
      type: "levelLinkToggled",
      side: "ally",
      enabled: false,
    });

    expect(off.draft.allySlots[0]?.enhancement?.level).toBe(180);
  });

  it("UI-AC-036: seeds the slot level with the link level when the slot is excluded", () => {
    const next = formationReducer(linkedState(), {
      type: "unitLinkExclusionChanged",
      slotKey: allySlotKey,
      excluded: true,
    });

    expect(next.draft.allySlots[0]?.enhancement).toMatchObject({
      level: 260,
      linkExcluded: true,
    });
  });

  it("seeds a slot whose enhancement was never opened", () => {
    const state = linkedState();
    expect(state.draft.allySlots[0]?.enhancement).toBeUndefined();

    const next = formationReducer(state, {
      type: "unitLinkExclusionChanged",
      slotKey: allySlotKey,
      excluded: true,
    });

    expect(next.draft.allySlots[0]?.enhancement?.level).toBe(260);
  });

  it("leaves the slot level untouched when the slot returns to the link", () => {
    const excluded = formationReducer(linkedState(), {
      type: "unitLinkExclusionChanged",
      slotKey: allySlotKey,
      excluded: true,
    });
    const edited = formationReducer(excluded, {
      type: "unitEnhancementLevelChanged",
      slotKey: allySlotKey,
      value: 180,
    });

    const back = formationReducer(edited, {
      type: "unitLinkExclusionChanged",
      slotKey: allySlotKey,
      excluded: false,
    });

    expect(back.draft.allySlots[0]?.enhancement).toMatchObject({
      level: 180,
      linkExcluded: false,
    });
  });

  it("does not seed a slot that the link was not applying to", () => {
    // リンクOFFの陣営で除外だけを立てても、枠の値は書き換えない。
    const placed = formationReducer(createInitialFormationState(), {
      type: "unitSelected",
      slotKey: allySlotKey,
      unitDefinitionId: "UNIT_A",
    });
    const edited = formationReducer(placed, {
      type: "unitEnhancementLevelChanged",
      slotKey: allySlotKey,
      value: 180,
    });

    const next = formationReducer(edited, {
      type: "unitLinkExclusionChanged",
      slotKey: allySlotKey,
      excluded: true,
    });

    expect(next.draft.allySlots[0]?.enhancement).toMatchObject({
      level: 180,
      linkExcluded: true,
    });
  });

  it("ignores an unknown slot key", () => {
    const state = linkedState();

    expect(
      formationReducer(state, {
        type: "unitLinkExclusionChanged",
        slotKey: "ally:FRONT:9",
        excluded: true,
      }),
    ).toBe(state);
  });
});

describe("formationReducer — persistence actions", () => {
  const allySlotKey = slotKeyOf("ally", "FRONT", 0);
  const enemySlotKey = slotKeyOf("enemy", "FRONT", 0);

  function stateWithAllyEnhancement(): FormationState {
    const placed = formationReducer(createInitialFormationState(), {
      type: "unitSelected",
      slotKey: allySlotKey,
      unitDefinitionId: "UNIT_A",
    });
    return formationReducer(placed, {
      type: "unitEnhancementLevelChanged",
      slotKey: allySlotKey,
      value: 42,
    });
  }

  it("keeps the slot enhancement when the unit placed in a slot is replaced", () => {
    const placed = formationReducer(createInitialFormationState(), {
      type: "unitSelected",
      slotKey: enemySlotKey,
      unitDefinitionId: "UNIT_A",
    });
    const edited = formationReducer(placed, {
      type: "unitEnhancementLevelChanged",
      slotKey: enemySlotKey,
      value: 42,
    });

    const next = formationReducer(edited, {
      type: "unitSelected",
      slotKey: enemySlotKey,
      unitDefinitionId: "UNIT_B",
    });

    expect(next.draft.enemySlots[0]?.enhancement?.level).toBe(42);
  });

  it("resets the draft to its initial defaults, without touching the ally growth data slice", () => {
    const previous = formationReducer(stateWithAllyEnhancement(), {
      type: "turnLimitChanged",
      value: 33,
    });

    const next = formationReducer(previous, { type: "draftReset" });

    expect(next.draft).toStrictEqual(createInitialDraft());
  });

  it("clears only the slots named by unknownDefinitionsCleared", () => {
    const placed = formationReducer(stateWithAllyEnhancement(), {
      type: "memorySelected",
      side: "ally",
      index: 2,
      memoryDefinitionId: "MEM_GONE",
    });
    const kept = formationReducer(placed, {
      type: "memorySelected",
      side: "ally",
      index: 3,
      memoryDefinitionId: "MEM_KEPT",
    });

    const next = formationReducer(kept, {
      type: "unknownDefinitionsCleared",
      slotKeys: [allySlotKey, memorySlotKeyOf("ally", 2), "ally:FRONT:9"],
    });

    expect(next.draft.allySlots[0]?.unitDefinitionId).toBeUndefined();
    expect(next.draft.allySlots[0]?.enhancement).toBeUndefined();
    expect(next.draft.allyMemoryDefinitionIds[2]).toBeUndefined();
    expect(next.draft.allyMemoryDefinitionIds[3]).toBe("MEM_KEPT");
  });

  it("returns the same state when no named slot exists", () => {
    const previous = stateWithAllyEnhancement();

    expect(formationReducer(previous, { type: "unknownDefinitionsCleared", slotKeys: [] })).toBe(
      previous,
    );
  });

  it("restores a supplied draft as the initial state", () => {
    const restored = { ...createInitialDraft(), turnLimit: 21 } as const;

    expect(createInitialFormationState(restored).draft).toStrictEqual(restored);
  });
});
