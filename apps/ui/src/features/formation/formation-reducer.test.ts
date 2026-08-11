import { describe, expect, it } from "vitest";
import {
  createInitialFormationState,
  formationReducer,
  MAX_UNITS_PER_SIDE,
} from "./formation-reducer.js";
import { slotKeyOf } from "./types.js";
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
    expect(next.selectionDialog).toEqual({ kind: "closed" });
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

    const withLevel = formationReducer(withTurn, { type: "logLevelChanged", value: "DIAGNOSTIC" });
    expect(withLevel.draft.logLevel).toBe("DIAGNOSTIC");
    expect(withLevel.draft.turnLimit).toBe(42);
  });

  it("accepts the empty-input sentinel for turnLimit", () => {
    const next = formationReducer(createInitialFormationState(), {
      type: "turnLimitChanged",
      value: "",
    });
    expect(next.draft.turnLimit).toBe("");
  });
});

describe("formationReducer — selection dialog", () => {
  it("opens a unit selection and later closes it", () => {
    const opened = formationReducer(createInitialFormationState(), {
      type: "selectionOpened",
      selection: { kind: "unit", slotKey: slotKeyOf("ally", "FRONT", 0) },
    });
    expect(opened.selectionDialog).toEqual({
      kind: "unit",
      slotKey: slotKeyOf("ally", "FRONT", 0),
    });

    const closed = formationReducer(opened, { type: "selectionClosed" });
    expect(closed.selectionDialog).toEqual({ kind: "closed" });
  });

  it("opens a memory selection for a given side and index", () => {
    const opened = formationReducer(createInitialFormationState(), {
      type: "selectionOpened",
      selection: { kind: "memory", side: "ally", index: 3 },
    });
    expect(opened.selectionDialog).toEqual({ kind: "memory", side: "ally", index: 3 });
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

  it("keeps the enhancement inputs when the toggle goes back off (UI-CMP-014)", () => {
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

  it("ignores opening the unit enhancement dialog while that side's toggle is off (UI-CMP-015)", () => {
    const initial = createInitialFormationState();
    const blocked = formationReducer(initial, {
      type: "selectionOpened",
      selection: { kind: "unitEnhancement", slotKey: slotKeyOf("ally", "FRONT", 0) },
    });
    expect(blocked.selectionDialog).toEqual({ kind: "closed" });

    const enabled = formationReducer(initial, {
      type: "enhancementToggled",
      side: "ally",
      enabled: true,
    });
    const opened = formationReducer(enabled, {
      type: "selectionOpened",
      selection: { kind: "unitEnhancement", slotKey: slotKeyOf("ally", "FRONT", 0) },
    });
    expect(opened.selectionDialog).toEqual({
      kind: "unitEnhancement",
      slotKey: "ally:FRONT:0",
    });
  });
});
