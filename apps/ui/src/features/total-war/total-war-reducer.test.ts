import { describe, expect, it } from "vitest";
import { createInitialTotalWarState, totalWarReducer } from "./total-war-reducer.js";
import type { TotalWarAction, TotalWarState } from "./total-war-reducer.js";
import type { FormationIndex } from "./total-war-draft.js";
import { createInitialDraft, memorySlotKeyOf, slotKeyOf } from "../formation/types.js";
import type { BattleDraft, Side } from "../../entities/battle-draft.js";

const ALLY_FRONT_0 = slotKeyOf("ally", "FRONT", 0);
const ALLY_FRONT_1 = slotKeyOf("ally", "FRONT", 1);
const ENEMY_FRONT_0 = slotKeyOf("enemy", "FRONT", 0);

function apply(state: TotalWarState, ...actions: readonly TotalWarAction[]): TotalWarState {
  return actions.reduce(totalWarReducer, state);
}

function unitAt(draft: BattleDraft, slotKey: string): string | undefined {
  return [...draft.allySlots, ...draft.enemySlots].find((slot) => slot.slotKey === slotKey)
    ?.unitDefinitionId;
}

function formation(state: TotalWarState, index: FormationIndex): BattleDraft {
  return state.draft.formations[index];
}

function select(slotKey: string, unitDefinitionId: string): TotalWarAction {
  return { type: "unitSelected", slotKey, unitDefinitionId };
}

function add(side: Side): TotalWarAction {
  return { type: "formationAdded", side };
}

function activate(side: Side, index: FormationIndex): TotalWarAction {
  return { type: "formationActivated", side, index };
}

describe("totalWarReducer — routing (UI-UT-TWR-001)", () => {
  it("sends unit actions only to the active formation of the slotKey's side", () => {
    const state = apply(
      createInitialTotalWarState(),
      add("ally"),
      select(ALLY_FRONT_0, "UNIT_A"),
      select(ENEMY_FRONT_0, "UNIT_E"),
    );

    // 味方は編成2（index 1）を、敵は編成1（index 0）を開いている。
    expect(unitAt(formation(state, 1), ALLY_FRONT_0)).toBe("UNIT_A");
    expect(unitAt(formation(state, 0), ALLY_FRONT_0)).toBeUndefined();
    expect(unitAt(formation(state, 0), ENEMY_FRONT_0)).toBe("UNIT_E");
    expect(unitAt(formation(state, 1), ENEMY_FRONT_0)).toBeUndefined();
  });

  it("routes unitRemoved and unitMoved within the active formation only", () => {
    const state = apply(
      createInitialTotalWarState(),
      select(ALLY_FRONT_0, "UNIT_A"),
      add("ally"),
      select(ALLY_FRONT_0, "UNIT_B"),
      { type: "unitMoved", fromSlotKey: ALLY_FRONT_0, toSlotKey: ALLY_FRONT_1 },
    );
    expect(unitAt(formation(state, 1), ALLY_FRONT_1)).toBe("UNIT_B");
    expect(unitAt(formation(state, 0), ALLY_FRONT_0)).toBe("UNIT_A");

    const removed = apply(state, activate("ally", 0), {
      type: "unitRemoved",
      slotKey: ALLY_FRONT_0,
    });
    expect(unitAt(formation(removed, 0), ALLY_FRONT_0)).toBeUndefined();
    expect(unitAt(formation(removed, 1), ALLY_FRONT_1)).toBe("UNIT_B");
  });

  it("sends memory actions to the active formation of the action's side", () => {
    const state = apply(
      createInitialTotalWarState(),
      add("enemy"),
      { type: "memorySelected", side: "enemy", index: 2, memoryDefinitionId: "MEM_X" },
      { type: "memorySelected", side: "ally", index: 0, memoryDefinitionId: "MEM_Y" },
    );
    expect(formation(state, 1).enemyMemoryDefinitionIds[2]).toBe("MEM_X");
    expect(formation(state, 0).enemyMemoryDefinitionIds[2]).toBeUndefined();
    expect(formation(state, 0).allyMemoryDefinitionIds[0]).toBe("MEM_Y");

    const removed = apply(state, { type: "memoryRemoved", side: "enemy", index: 2 });
    expect(formation(removed, 1).enemyMemoryDefinitionIds[2]).toBeUndefined();
  });

  it("sends enemy unit enhancement edits to the active enemy formation only", () => {
    const state = apply(
      createInitialTotalWarState(),
      select(ENEMY_FRONT_0, "UNIT_E"),
      add("enemy"),
      select(ENEMY_FRONT_0, "UNIT_E"),
      { type: "unitEnhancementLevelChanged", slotKey: ENEMY_FRONT_0, value: 150 },
    );
    const slotOf = (index: FormationIndex) =>
      formation(state, index).enemySlots.find((slot) => slot.slotKey === ENEMY_FRONT_0);
    expect(slotOf(1)?.enhancement?.level).toBe(150);
    expect(slotOf(0)?.enhancement).toBeUndefined();
  });

  it("ignores slotKeys that do not name a side", () => {
    const state = createInitialTotalWarState();
    expect(totalWarReducer(state, select("unknown:FRONT:0", "UNIT_A"))).toBe(state);
  });
});

describe("totalWarReducer — side enhancement (UI-UT-TWR-002)", () => {
  it("applies side enhancement actions to all three formations of that side only", () => {
    const state = apply(
      createInitialTotalWarState(),
      add("enemy"),
      { type: "enhancementToggled", side: "enemy", enabled: true },
      {
        type: "academyLevelChanged",
        side: "enemy",
        group: "unitTypes",
        key: "PHYSICAL",
        value: 7,
      },
      { type: "levelLinkToggled", side: "enemy", enabled: true },
      { type: "levelLinkLevelChanged", side: "enemy", value: 300 },
    );
    const [first, ...rest] = state.draft.formations.map((draft) => draft.enemyEnhancement);
    expect(first?.enabled).toBe(true);
    expect(first?.academyLevels.unitTypes.PHYSICAL).toBe(7);
    expect(first?.levelLink).toEqual({ enabled: true, level: 300 });
    for (const enhancement of rest) {
      expect(enhancement).toEqual(first);
    }
    for (const draft of state.draft.formations) {
      expect(draft.allyEnhancement).toEqual(createInitialDraft().allyEnhancement);
    }
  });
});

describe("totalWarReducer — adding formations (UI-UT-TWR-003)", () => {
  it("appends an empty formation, activates it, and keeps side enhancement equal", () => {
    const state = apply(
      createInitialTotalWarState(),
      { type: "enhancementToggled", side: "enemy", enabled: true },
      select(ENEMY_FRONT_0, "UNIT_E"),
      add("enemy"),
    );
    expect(state.draft.formationCounts).toEqual({ ally: 1, enemy: 2 });
    expect(state.activeFormation).toEqual({ ally: 0, enemy: 1 });
    expect(unitAt(formation(state, 1), ENEMY_FRONT_0)).toBeUndefined();
    expect(formation(state, 1).enemyEnhancement).toEqual(formation(state, 0).enemyEnhancement);
  });

  it("ignores adding beyond three formations", () => {
    const full = apply(createInitialTotalWarState(), add("ally"), add("ally"));
    expect(full.draft.formationCounts.ally).toBe(3);
    expect(totalWarReducer(full, add("ally"))).toBe(full);
  });
});

describe("totalWarReducer — removing formations (UI-UT-TWR-004)", () => {
  function threeAllyFormations(): TotalWarState {
    return apply(
      createInitialTotalWarState(),
      select(ALLY_FRONT_0, "UNIT_1"),
      { type: "memorySelected", side: "ally", index: 0, memoryDefinitionId: "MEM_1" },
      select(ENEMY_FRONT_0, "UNIT_E1"),
      add("ally"),
      select(ALLY_FRONT_0, "UNIT_2"),
      { type: "memorySelected", side: "ally", index: 0, memoryDefinitionId: "MEM_2" },
      add("ally"),
      select(ALLY_FRONT_0, "UNIT_3"),
    );
  }

  it("shifts later formations of the same side forward and empties the last", () => {
    const state = apply(threeAllyFormations(), activate("ally", 0), {
      type: "formationRemoved",
      side: "ally",
    });

    expect(state.draft.formationCounts.ally).toBe(2);
    expect(unitAt(formation(state, 0), ALLY_FRONT_0)).toBe("UNIT_2");
    expect(formation(state, 0).allyMemoryDefinitionIds[0]).toBe("MEM_2");
    expect(unitAt(formation(state, 1), ALLY_FRONT_0)).toBe("UNIT_3");
    expect(formation(state, 1).allyMemoryDefinitionIds[0]).toBeUndefined();
    expect(unitAt(formation(state, 2), ALLY_FRONT_0)).toBeUndefined();
    // 相手陣営の側は動かない。
    expect(unitAt(formation(state, 0), ENEMY_FRONT_0)).toBe("UNIT_E1");
    expect(state.activeFormation.ally).toBe(0);
  });

  it("moves the active formation back by one when the last one is removed", () => {
    const state = apply(threeAllyFormations(), { type: "formationRemoved", side: "ally" });
    expect(state.draft.formationCounts.ally).toBe(2);
    expect(state.activeFormation.ally).toBe(1);
    expect(unitAt(formation(state, 1), ALLY_FRONT_0)).toBe("UNIT_2");
    expect(unitAt(formation(state, 2), ALLY_FRONT_0)).toBeUndefined();
  });

  it("ignores removing the only formation", () => {
    const state = createInitialTotalWarState();
    expect(totalWarReducer(state, { type: "formationRemoved", side: "enemy" })).toBe(state);
  });
});

describe("totalWarReducer — ignored actions and reset (UI-UT-TWR-005)", () => {
  it("ignores activating a formation beyond the count", () => {
    const state = apply(createInitialTotalWarState(), add("ally"));
    expect(totalWarReducer(state, activate("ally", 2))).toBe(state);
    expect(totalWarReducer(state, activate("enemy", 1))).toBe(state);
    expect(totalWarReducer(state, activate("ally", 0)).activeFormation.ally).toBe(0);
  });

  it("ignores turn limit and exercise actions", () => {
    const state = createInitialTotalWarState();
    const ignored: readonly TotalWarAction[] = [
      { type: "turnLimitChanged", value: 3 },
      { type: "exerciseExecutionModeChanged", value: "STATISTICS" },
      { type: "exerciseRunCountChanged", value: 5 },
      { type: "exerciseSeedChanged", value: "seed" },
    ];
    for (const action of ignored) {
      expect(totalWarReducer(state, action)).toBe(state);
    }
  });

  it("writes logLevelChanged to the total war draft only", () => {
    const state = totalWarReducer(createInitialTotalWarState(), {
      type: "logLevelChanged",
      value: "DETAILED",
    });
    expect(state.draft.logLevel).toBe("DETAILED");
    for (const draft of state.draft.formations) {
      expect(draft.logLevel).toBe("SUMMARY");
    }
  });

  it("resets to one formation per side with every formation empty", () => {
    const state = apply(
      createInitialTotalWarState(),
      add("ally"),
      select(ALLY_FRONT_0, "UNIT_A"),
      add("enemy"),
      { type: "logLevelChanged", value: "DETAILED" },
      { type: "draftReset" },
    );
    expect(state).toEqual(createInitialTotalWarState());
  });
});

describe("totalWarReducer — orphan clearing per formation (UI-UT-TWR-013)", () => {
  it("clears only the slots listed for each formation index", () => {
    const state = apply(
      createInitialTotalWarState(),
      select(ALLY_FRONT_0, "UNIT_GONE"),
      add("ally"),
      select(ALLY_FRONT_0, "UNIT_KEPT"),
      { type: "memorySelected", side: "ally", index: 1, memoryDefinitionId: "MEM_GONE" },
      {
        type: "unknownDefinitionsClearedByFormation",
        slotKeys: { 0: [ALLY_FRONT_0], 1: [memorySlotKeyOf("ally", 1)], 2: [] },
      },
    );
    expect(unitAt(formation(state, 0), ALLY_FRONT_0)).toBeUndefined();
    expect(unitAt(formation(state, 1), ALLY_FRONT_0)).toBe("UNIT_KEPT");
    expect(formation(state, 1).allyMemoryDefinitionIds[1]).toBeUndefined();
  });

  it("ignores the formation-agnostic unknownDefinitionsCleared", () => {
    const state = apply(createInitialTotalWarState(), select(ALLY_FRONT_0, "UNIT_A"));
    expect(
      totalWarReducer(state, { type: "unknownDefinitionsCleared", slotKeys: [ALLY_FRONT_0] }),
    ).toBe(state);
  });
});
