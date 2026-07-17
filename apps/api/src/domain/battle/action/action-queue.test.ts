import { describe, expect, it } from "vitest";
import { createActionQueue, reorderRemainingQueue } from "./action-queue.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createActionId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";

const CHARGE_SKILL: SkillDefinition = {
  skillDefinitionId: createSkillDefinitionId("SKL_CHARGE"),
  skillType: "AS",
  cost: { resource: "AP", amount: 1 },
  activationCondition: { kind: "TRUE" },
  triggers: [],
  resolution: {
    kind: "CHARGE",
    targetBindings: [],
    steps: [],
    chargeRelease: { targetBindings: [], steps: [] },
  },
  cooldown: { unit: "ACTION", count: 0 },
  traits: {
    priorityAttack: false,
    simultaneousActivationLimited: false,
    exclusiveActivationGroupId: null,
    accuracy: { guaranteedHit: false },
    piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
  },
  requiredCapabilities: [],
  metadata: { displayName: "Charge", tags: [] },
};

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
    attribute: "AGGRESSIVE",
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

  it("UT-ACTION-QUEUE-007 (R-ORD-01 #3 部分実装: 気絶・凍結による阻害は対象外): a unit with 0 AP and a non-full EX gauge is still queue-eligible (as AS) while a charge is pending release", () => {
    const charging = unit("CHARGING", "ALLY", 10, {
      currentAp: 0,
      currentExtraGauge: 0,
      charge: { skill: CHARGE_SKILL, startedActionId: createActionId("B_1:action:1") },
    });

    const queue = createActionQueue([charging]);

    expect(queue.entries).toEqual([
      { battleUnitId: createBattleUnitId("CHARGING"), reservedActionKind: "AS" },
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

describe("reorderRemainingQueue", () => {
  it("UT-ACTION-QUEUE-008 (R-ORD-04 土台 / SCN-BTL-003): re-sorts entries by each unit's current action speed, preserving reservedActionKind", () => {
    const wasSlow = unit("WAS_SLOW", "ALLY", 5, { currentAp: 3 });
    const wasFast = unit("WAS_FAST", "ALLY", 20, { currentAp: 3, currentExtraGauge: 100 });
    const entries = createActionQueue([wasSlow, wasFast]).entries;
    expect(entries.map((e) => e.battleUnitId)).toEqual([
      createBattleUnitId("WAS_FAST"),
      createBattleUnitId("WAS_SLOW"),
    ]);

    // Speed changed after queue creation: WAS_SLOW is now faster.
    const nowFast = { ...wasSlow, combatStats: { ...wasSlow.combatStats, actionSpeed: 30 } };
    const nowSlow = { ...wasFast, combatStats: { ...wasFast.combatStats, actionSpeed: 1 } };

    const reordered = reorderRemainingQueue(entries, [nowFast, nowSlow]);

    expect(reordered.map((e) => e.battleUnitId)).toEqual([
      createBattleUnitId("WAS_SLOW"),
      createBattleUnitId("WAS_FAST"),
    ]);
    // R-ORD-03: reservedActionKind is untouched by reordering (WAS_FAST kept its EX reservation).
    expect(reordered.map((e) => e.reservedActionKind)).toEqual(["AS", "EX"]);
  });

  it("UT-ACTION-QUEUE-009 (R-ORD-04): reorders only the given (unacted/remaining) entries, ignoring units absent from the entry list even if present in `units`", () => {
    const remaining = unit("REMAINING", "ALLY", 5, { currentAp: 3 });
    const alreadyActed = unit("ALREADY_ACTED", "ALLY", 20, { currentAp: 3 });
    const entries = createActionQueue([remaining]).entries;

    // `alreadyActed` is in the current unit roster (e.g. it already took its
    // action this cycle) but must not be reintroduced by reordering.
    const reordered = reorderRemainingQueue(entries, [remaining, alreadyActed]);

    expect(reordered.map((e) => e.battleUnitId)).toEqual([createBattleUnitId("REMAINING")]);
  });

  it("UT-ACTION-QUEUE-010: an empty entry list reorders to itself", () => {
    expect(reorderRemainingQueue([], [])).toEqual([]);
  });
});
