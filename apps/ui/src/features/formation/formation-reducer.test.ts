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
