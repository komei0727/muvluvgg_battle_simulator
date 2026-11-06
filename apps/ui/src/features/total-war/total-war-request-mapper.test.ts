import { describe, expect, it } from "vitest";
import { buildTotalWarRequest } from "./total-war-request-mapper.js";
import type { TotalWarDraft } from "./total-war-draft.js";
import { createInitialTotalWarState, totalWarReducer } from "./total-war-reducer.js";
import type { TotalWarAction } from "./total-war-reducer.js";
import { buildFormation } from "../formation/request-mapper.js";
import { memorySlotKeyOf, slotKeyOf } from "../formation/types.js";

function build(...actions: readonly TotalWarAction[]): TotalWarDraft {
  return actions.reduce(totalWarReducer, createInitialTotalWarState()).draft;
}

const ENEMY_REAR_1 = slotKeyOf("enemy", "REAR", 1);

/** 味方2編成・敵1編成。敵は強化ONでギア付き、味方の編成2はメモリーを空枠の後ろに置く。 */
function twoAllyOneEnemy(): TotalWarDraft {
  return build(
    { type: "unitSelected", slotKey: slotKeyOf("ally", "REAR", 0), unitDefinitionId: "UNIT_A2" },
    { type: "unitSelected", slotKey: slotKeyOf("ally", "FRONT", 2), unitDefinitionId: "UNIT_A1" },
    { type: "enhancementToggled", side: "enemy", enabled: true },
    { type: "unitSelected", slotKey: ENEMY_REAR_1, unitDefinitionId: "UNIT_E" },
    {
      type: "unitEnhancementGearChanged",
      slotKey: ENEMY_REAR_1,
      gearIndex: 4,
      gear: { stat: "ATTACK", tier: "III", grade: "S" },
    },
    { type: "formationAdded", side: "ally" },
    { type: "unitSelected", slotKey: slotKeyOf("ally", "FRONT", 0), unitDefinitionId: "UNIT_B" },
    { type: "memorySelected", side: "ally", index: 3, memoryDefinitionId: "MEM_B" },
    { type: "logLevelChanged", value: "DETAILED" },
  );
}

describe("buildTotalWarRequest (UI-UT-TWR-009)", () => {
  it("lists one FormationRequest per used formation in deployment order", () => {
    const result = buildTotalWarRequest(twoAllyOneEnemy());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.request.allyFormations).toEqual([
      {
        units: [
          { unitDefinitionId: "UNIT_A1", position: { column: 2, row: "FRONT" } },
          { unitDefinitionId: "UNIT_A2", position: { column: 0, row: "REAR" } },
        ],
        memoryDefinitionIds: [],
      },
      {
        units: [{ unitDefinitionId: "UNIT_B", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: ["MEM_B"],
      },
    ]);
    expect(result.request.enemyFormations).toHaveLength(1);
  });

  it("builds each element with the existing single-formation conversion", () => {
    const draft = twoAllyOneEnemy();
    const result = buildTotalWarRequest(draft);
    if (!result.ok) throw new Error("expected ok");

    const enemy = draft.formations[0];
    expect(result.request.enemyFormations[0]).toEqual(
      buildFormation(
        "enemy",
        enemy.enemySlots,
        enemy.enemyMemoryDefinitionIds,
        enemy.enemyEnhancement,
      )?.formation,
    );
    expect(result.request.enemyFormations[0]?.units[0]?.enhancement?.gears).toEqual([
      { stat: "ATTACK", tier: "III", grade: "S" },
    ]);
  });

  it("omits turnLimit and always sends options.logLevel", () => {
    const result = buildTotalWarRequest(twoAllyOneEnemy());
    if (!result.ok) throw new Error("expected ok");
    expect(Object.keys(result.request).toSorted()).toEqual(
      ["allyFormations", "enemyFormations", "options"].toSorted(),
    );
    expect(result.request.options).toEqual({ logLevel: "DETAILED" });

    const defaults = buildTotalWarRequest(build());
    if (!defaults.ok) throw new Error("expected ok");
    expect(defaults.request.options).toEqual({ logLevel: "SUMMARY" });
  });

  it("returns per-formation slot, memory slot and gear slot maps", () => {
    const result = buildTotalWarRequest(twoAllyOneEnemy());
    if (!result.ok) throw new Error("expected ok");

    expect(result.formationSlotMaps.ally).toEqual([
      {
        unitSlotKeys: [slotKeyOf("ally", "FRONT", 2), slotKeyOf("ally", "REAR", 0)],
        memorySlotKeys: [],
        gearSlotIndices: [[], []],
      },
      {
        unitSlotKeys: [slotKeyOf("ally", "FRONT", 0)],
        memorySlotKeys: [memorySlotKeyOf("ally", 3)],
        gearSlotIndices: [[]],
      },
    ]);
    expect(result.formationSlotMaps.enemy).toEqual([
      { unitSlotKeys: [ENEMY_REAR_1], memorySlotKeys: [], gearSlotIndices: [[4]] },
    ]);
  });

  it("fails when any used formation cannot be built", () => {
    const draft = build(
      { type: "formationAdded", side: "enemy" },
      { type: "enhancementToggled", side: "enemy", enabled: true },
      {
        type: "academyLevelChanged",
        side: "enemy",
        group: "unitTypes",
        key: "AGILE",
        value: "",
      },
    );
    expect(buildTotalWarRequest(draft)).toEqual({ ok: false });
  });
});
