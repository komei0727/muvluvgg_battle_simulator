import { describe, expect, it } from "vitest";
import {
  composeResourceCapacity,
  computeResourceCapacities,
  recalculateResourceCapacities,
} from "./resource-capacity-recalculation-service.js";
import { resolveBreakSteps } from "./break-resolution-service.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId } from "../../shared/ids.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ResourceKind } from "../../catalog/definitions/catalog-enums.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";

const BASE_COMBAT_STATS: CombatStats = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function unit(overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("BU_1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: BASE_COMBAT_STATS,
  };
  const base = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...base, ...overrides };
}

let instanceCounter = 0;
function instanceId(): EffectInstanceId {
  instanceCounter += 1;
  return `EFFECT_INSTANCE_${instanceCounter}` as EffectInstanceId;
}

function capacityDefinition(
  id: string,
  resource: ResourceKind,
  operation: "ADD" | "SET",
): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "MODIFY_RESOURCE_CAPACITY",
    payload: {
      resource,
      operation,
      // 実際の変更量は付与時点で評価済みの`AppliedEffect.magnitude`が持つため、
      // この純粋関数の入力としてFormula自体は使わない（`statModDefinition`と同じ規約）。
      formula: { kind: "CONSTANT", value: 0 },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    metadata: { tags: [] },
  };
}

function capacityEffect(
  definitionId: EffectActionDefinitionId,
  magnitude: number,
  duplicate = true,
): AppliedEffect {
  return {
    effectInstanceId: instanceId(),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    categories: ["BUFF"],
    duplicate,
    sourceUnitId: createBattleUnitId("BU_1"),
    targetUnitId: createBattleUnitId("BU_1"),
    magnitude,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function definitions(
  ...defs: readonly EffectActionDefinition[]
): ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> {
  return new Map(defs.map((definition) => [definition.effectActionDefinitionId, definition]));
}

describe("computeResourceCapacities — G-09 MODIFY_RESOURCE_CAPACITYの上限再計算", () => {
  it("UT-R-ACTN-03-001: with no MODIFY_RESOURCE_CAPACITY effect, every capacity stays at the immutable base", () => {
    const result = computeResourceCapacities(unit(), definitions());

    expect(result.maximumAp).toBe(3);
    expect(result.maximumPp).toBe(3);
    expect(result.maximumExtraGauge).toBe(10);
    expect(result.changedCapacities).toEqual([]);
  });

  it("UT-R-ACTN-03-002: an ADD instance raises only its own resource's capacity above the base", () => {
    const def = capacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const target = unit({ appliedEffects: [capacityEffect(def.effectActionDefinitionId, 1)] });

    const result = computeResourceCapacities(target, definitions(def));

    expect(result.maximumAp).toBe(4);
    expect(result.maximumPp).toBe(3);
    expect(result.maximumExtraGauge).toBe(10);
    expect(result.changedCapacities).toEqual([{ resource: "AP", before: 3, after: 4 }]);
  });

  it("UT-R-ACTN-03-003: multiple ADD instances are summed onto the base regardless of grant order", () => {
    const def = capacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const other = capacityDefinition("ACT_MAX_AP_UP_2", "AP", "ADD");
    const forward = unit({
      appliedEffects: [
        capacityEffect(def.effectActionDefinitionId, 1),
        capacityEffect(other.effectActionDefinitionId, 2),
      ],
    });
    const reversed = unit({
      appliedEffects: [
        capacityEffect(other.effectActionDefinitionId, 2),
        capacityEffect(def.effectActionDefinitionId, 1),
      ],
    });

    expect(computeResourceCapacities(forward, definitions(def, other)).maximumAp).toBe(6);
    expect(computeResourceCapacities(reversed, definitions(def, other)).maximumAp).toBe(6);
  });

  it("UT-R-ACTN-03-004: a SET instance replaces the base, and later-granted SET instances win over earlier ones", () => {
    const set = capacityDefinition("ACT_MAX_AP_SET", "AP", "SET");
    const add = capacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const target = unit({
      appliedEffects: [
        capacityEffect(set.effectActionDefinitionId, 5),
        capacityEffect(set.effectActionDefinitionId, 8),
        capacityEffect(add.effectActionDefinitionId, 1),
      ],
    });

    // 付与順で後のSET(8)が基準になり、そこへADD(+1)を重ねる。
    expect(computeResourceCapacities(target, definitions(set, add)).maximumAp).toBe(9);
  });

  it("UT-R-ACTN-03-005: a non-effective NON_STACKABLE instance (R-EFF-05) does not contribute", () => {
    const def = capacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const target = unit({
      appliedEffects: [
        capacityEffect(def.effectActionDefinitionId, 1, false),
        capacityEffect(def.effectActionDefinitionId, 3, false),
      ],
    });

    // 同じ`EffectKindKey`の重複なし2件のうち、絶対値が最大の1件だけが有効。
    expect(computeResourceCapacities(target, definitions(def)).maximumAp).toBe(6);
  });

  it("UT-R-ACTN-03-006: a capacity below zero is clamped to zero and fractional results are truncated (R-NUM-02)", () => {
    const drop = capacityDefinition("ACT_MAX_AP_DOWN", "AP", "ADD");
    const partial = capacityDefinition("ACT_MAX_PP_PARTIAL", "PP", "ADD");
    const target = unit({
      appliedEffects: [
        capacityEffect(drop.effectActionDefinitionId, -10),
        capacityEffect(partial.effectActionDefinitionId, 1.9),
      ],
    });

    const result = computeResourceCapacities(target, definitions(drop, partial));

    expect(result.maximumAp).toBe(0);
    expect(result.maximumPp).toBe(4);
  });

  it("UT-R-ACTN-03-007: HP capacity is not part of the gauge capacities — it is composed onto the MAXIMUM_HP CombatStat instead", () => {
    const def = capacityDefinition("ACT_MAX_HP_UP", "HP", "ADD");
    const target = unit({ appliedEffects: [capacityEffect(def.effectActionDefinitionId, 500)] });

    const result = computeResourceCapacities(target, definitions(def));

    expect(result.changedCapacities).toEqual([]);
    // HPは`combatStats.maximumHp`が上限であるため、`composeResourceCapacity`を
    // `computeCombatStats`のMAXIMUM_HP合成の最後段として使う（R-NUM-01の全精度保持）。
    expect(composeResourceCapacity(1000.5, target, "HP", definitions(def))).toBe(1500.5);
  });
});

describe("recalculateResourceCapacities defeat detection (R-TEX-03)", () => {
  function enemy(currentHp: number, maximumHp: number): BattleUnit {
    const position: FormationPosition = { column: "LEFT", row: "FRONT" };
    const stats: CombatStats = { ...BASE_COMBAT_STATS, maximumHp };
    const member: BattlePartyMember = {
      battleUnitId: createBattleUnitId("BU_ENEMY"),
      unitDefinitionId: createUnitDefinitionId("UNIT_A"),
      attribute: "AGGRESSIVE",
      position,
      globalCoordinate: toGlobalCoordinate("ENEMY", position),
      combatStats: stats,
    };
    const base = createBattleUnit(member, "ENEMY", {
      maximumAp: 3,
      maximumPp: 3,
      maximumExtraGauge: 10,
    });
    return { ...base, currentHp: createHitPoint(currentHp, maximumHp) };
  }

  it("UT-R-TEX-03-008: clamping the exercise enemy's HP to 0 after a MAXIMUM_HP capacity drop resolves as a break, not a defeat", () => {
    // 上限が0へ落ちて現在値が可動域外になる状況を、`combatStats.maximumHp`を0にした
    // ユニットで直接作る（`recalculateCombatStats`が既に合成を終えた後の状態）。
    const target = enemy(100, 100);
    const broken: BattleUnit = { ...target, combatStats: { ...target.combatStats, maximumHp: 0 } };
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const exercise = new ExerciseRuntime(target.baseCombatStats);
    const base = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId: seed.eventId,
    };

    recalculateResourceCapacities(
      {
        ...base,
        exercise,
        resolveBreak: (targetUnitId, units, causeEventId) =>
          resolveBreakSteps({ ...base, exercise }, units, targetUnitId, new Map(), causeEventId),
      },
      [broken],
      broken.battleUnitId,
      new Map(),
      seed.eventId,
      "EFFECT_APPLIED",
    );

    const types = recorder.getEvents().map((event) => event.eventType);
    expect(types).toContain("UnitBroken");
    expect(types).not.toContain("UnitDefeated");
    expect(exercise.breakCount).toBe(1);
  });

  it("UT-R-TEX-03-009: the same clamp in a normal battle still emits UnitDefeated", () => {
    const target = enemy(100, 100);
    const broken: BattleUnit = { ...target, combatStats: { ...target.combatStats, maximumHp: 0 } };
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });

    recalculateResourceCapacities(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
      },
      [broken],
      broken.battleUnitId,
      new Map(),
      seed.eventId,
      "EFFECT_APPLIED",
    );

    const types = recorder.getEvents().map((event) => event.eventType);
    expect(types).toContain("UnitDefeated");
    expect(types).not.toContain("UnitBroken");
  });
});
