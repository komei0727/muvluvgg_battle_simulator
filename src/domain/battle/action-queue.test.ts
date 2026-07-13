import { describe, expect, it } from "vitest";
import { createActionQueue } from "./action-queue.js";
import { createBattleUnit, type BattleUnit, type BattleUnitResourceLimits } from "./battle-unit.js";
import type { BattlePartyMember } from "./battle-party.js";
import { createBattleUnitId } from "../shared/ids.js";
import { createUnitDefinitionId } from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  actionSpeed: number,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

describe("createActionQueue", () => {
  it("UT-ACTION-QUEUE-001: excludes a defeated unit even with AP available", () => {
    const defeated = unit("DEFEATED", "ALLY", 10, { currentHp: 0, currentAp: 3 });

    const queue = createActionQueue([defeated]);

    expect(queue.entries).toEqual([]);
  });

  it("UT-ACTION-QUEUE-002: excludes a unit with no AP and an EX gauge that is not full", () => {
    const idle = unit("IDLE", "ALLY", 10, { currentAp: 0, currentExtraGauge: 50 });

    const queue = createActionQueue([idle]);

    expect(queue.entries).toEqual([]);
  });

  it("UT-ACTION-QUEUE-003: reserves EX for a unit whose EX gauge is full, even with 0 AP", () => {
    const exReady = unit("EX_READY", "ALLY", 10, { currentAp: 0, currentExtraGauge: 100 });

    const queue = createActionQueue([exReady]);

    expect(queue.entries).toEqual([
      { battleUnitId: createBattleUnitId("EX_READY"), reservedActionKind: "EX" },
    ]);
  });

  it("UT-ACTION-QUEUE-004: reserves AS for a unit with AP available and an EX gauge that is not full", () => {
    const asReady = unit("AS_READY", "ALLY", 10, { currentAp: 3, currentExtraGauge: 0 });

    const queue = createActionQueue([asReady]);

    expect(queue.entries).toEqual([
      { battleUnitId: createBattleUnitId("AS_READY"), reservedActionKind: "AS" },
    ]);
  });

  it("UT-ACTION-QUEUE-005: orders entries by ActionOrderPolicy (R-ORD-02)", () => {
    const slow = unit("SLOW", "ALLY", 5, { currentAp: 3 });
    const fast = unit("FAST", "ALLY", 20, { currentAp: 3 });

    const queue = createActionQueue([slow, fast]);

    expect(queue.entries.map((e) => e.battleUnitId)).toEqual([
      createBattleUnitId("FAST"),
      createBattleUnitId("SLOW"),
    ]);
  });

  it("UT-ACTION-QUEUE-006: registers each eligible unit exactly once", () => {
    const a = unit("A", "ALLY", 10, { currentAp: 3 });
    const b = unit("B", "ENEMY", 10, { currentAp: 3 });
    const defeated = unit("C", "ALLY", 10, { currentHp: 0, currentAp: 3 });

    const queue = createActionQueue([a, b, defeated]);

    expect(queue.entries).toHaveLength(2);
    expect(new Set(queue.entries.map((e) => e.battleUnitId)).size).toBe(2);
  });
});
