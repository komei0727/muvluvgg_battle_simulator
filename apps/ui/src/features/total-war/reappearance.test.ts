import { describe, expect, it } from "vitest";
import { reappearanceSlotId, selectReappearanceSlots } from "./reappearance.js";
import type { TotalWarDraft } from "./total-war-draft.js";
import { createInitialTotalWarState, totalWarReducer } from "./total-war-reducer.js";
import type { TotalWarAction } from "./total-war-reducer.js";
import { slotKeyOf } from "../formation/types.js";
import type { Side, UiColumn, UiRow } from "../../entities/battle-draft.js";

function place(side: Side, row: UiRow, column: UiColumn, unitDefinitionId: string): TotalWarAction {
  return { type: "unitSelected", slotKey: slotKeyOf(side, row, column), unitDefinitionId };
}

function build(...actions: readonly TotalWarAction[]): TotalWarDraft {
  return actions.reduce(totalWarReducer, createInitialTotalWarState()).draft;
}

describe("selectReappearanceSlots (UI-UT-TWR-010)", () => {
  it("marks slots whose unit appears in an earlier formation of the same side", () => {
    const draft = build(
      place("ally", "FRONT", 0, "UNIT_A"),
      place("ally", "FRONT", 1, "UNIT_A"),
      place("enemy", "FRONT", 0, "UNIT_B"),
      { type: "formationAdded", side: "ally" },
      place("ally", "REAR", 1, "UNIT_A"),
      place("ally", "REAR", 2, "UNIT_B"),
      { type: "formationAdded", side: "ally" },
      place("ally", "FRONT", 2, "UNIT_A"),
    );
    expect([...selectReappearanceSlots(draft)].toSorted()).toEqual(
      [
        reappearanceSlotId(1, slotKeyOf("ally", "REAR", 1)),
        reappearanceSlotId(2, slotKeyOf("ally", "FRONT", 2)),
      ].toSorted(),
    );
  });

  it("does not count the opposing side or formations beyond the count", () => {
    const draft = build(
      place("enemy", "FRONT", 0, "UNIT_A"),
      { type: "formationAdded", side: "ally" },
      place("ally", "FRONT", 0, "UNIT_A"),
    );
    expect(selectReappearanceSlots(draft).size).toBe(0);
  });
});
