import { describe, expect, it } from "vitest";
import { applyEffectConsumptionAndExpiration } from "./effect-reactive-lifecycle.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";

const BATTLE_ID = createBattleId("battle-1");
const ATTACKER = createBattleUnitId("ally:1");
const DEFENDER = createBattleUnitId("enemy:1");
const KIND = "ACT_EVASION" as EffectKindKey;

function consumableEffect(overrides: {
  readonly id: string;
  readonly consumptionKind: ConsumptionKind;
  readonly remaining: number;
  readonly sourceId?: ReturnType<typeof createBattleUnitId>;
  readonly targetId?: ReturnType<typeof createBattleUnitId>;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: overrides.sourceId ?? DEFENDER,
    targetId: overrides.targetId ?? DEFENDER,
    magnitude: 1,
    duration: {
      definition: {
        consumption: { kind: overrides.consumptionKind, maxCount: overrides.remaining },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      consumptionRemaining: overrides.remaining,
    },
    active: true,
    appliedTurnNumber: 1,
  };
}

function expiringEffect(overrides: {
  readonly id: string;
  readonly conditions: readonly ConditionDefinition[];
  readonly targetId: ReturnType<typeof createBattleUnitId>;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: overrides.targetId,
    targetId: overrides.targetId,
    magnitude: 1,
    duration: {
      definition: {
        expiration: { conditions: overrides.conditions },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
    active: true,
    appliedTurnNumber: 1,
  };
}

function unit(
  id: ReturnType<typeof createBattleUnitId>,
  appliedEffects: readonly AppliedEffect[] = [],
): BattleUnit {
  return {
    battleUnitId: id,
    unitDefinitionId: "UNIT_X" as never,
    attribute: "CUTE",
    side: id === ATTACKER ? "ALLY" : "ENEMY",
    position: { column: "LEFT", row: "FRONT" } as never,
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {} as never,
    currentHp: 100,
    currentAp: 0,
    currentPp: 0,
    currentExtraGauge: 0,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
    cooldowns: {},
    appliedEffects,
    markers: [],
  };
}

function makeContext(recorder: EventRecorder) {
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const root = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    rootEventId: root.eventId,
    root,
  };
}

function damageAppliedEvent(
  recorder: EventRecorder,
  resolutionScopeId: ReturnType<EventRecorder["nextResolutionScopeId"]>,
  rootEventId: ReturnType<EventRecorder["record"]>["eventId"],
) {
  return recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    parentEventId: rootEventId,
    rootEventId,
    sourceUnitId: ATTACKER,
    targetUnitIds: [DEFENDER],
    payload: {
      effectActionDefinitionId: "ACT_TEST" as never,
      hitIndex: 1,
      targetUnitId: DEFENDER,
      calculatedDamage: 10,
      hitPointDamage: 10,
      hpBefore: 100,
      hpAfter: 90,
      defeated: false,
    },
  });
}

describe("applyEffectConsumptionAndExpiration (R-EFF-07/08)", () => {
  it("PR #155 re-review [P1]: decrements OUTGOING_HIT for the attacker on DamageApplied and expires it at 0", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const attacker = unit(ATTACKER, [
      consumableEffect({
        id: "e1",
        consumptionKind: "OUTGOING_HIT",
        remaining: 1,
        sourceId: ATTACKER,
        targetId: ATTACKER,
      }),
    ]);
    const defender = unit(DEFENDER);
    const hit = damageAppliedEvent(recorder, ctx.resolutionScopeId, ctx.rootEventId);

    const result = applyEffectConsumptionAndExpiration(ctx, [attacker, defender], hit, hit.eventId);

    const attackerAfter = result.units.find((u) => u.battleUnitId === ATTACKER)!;
    expect(attackerAfter.appliedEffects).toEqual([]);
    const events = recorder.getEvents();
    const changedIndex = events.findIndex((e) => e.eventType === "EffectConsumptionChanged");
    const expiredIndex = events.findIndex((e) => e.eventType === "EffectExpired");
    expect(events[changedIndex]?.payload).toMatchObject({
      effectInstanceId: "e1",
      consumptionKind: "OUTGOING_HIT",
      before: 1,
      after: 0,
    });
    expect(events[expiredIndex]?.payload).toMatchObject({
      effectInstanceId: "e1",
      reason: "CONSUMPTION",
    });
    expect(changedIndex).toBeGreaterThanOrEqual(0);
    expect(expiredIndex).toBeGreaterThan(changedIndex);
  });

  it("PR #155 re-review round 2 [P1]: decrements NEXT_OUTGOING_ATTACK for the attacker on DamageApplied (MISS does not exist yet, so reaching hit-judgment and a confirmed hit are the same instant)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const attacker = unit(ATTACKER, [
      consumableEffect({
        id: "e1",
        consumptionKind: "NEXT_OUTGOING_ATTACK",
        remaining: 1,
        sourceId: ATTACKER,
        targetId: ATTACKER,
      }),
    ]);
    const defender = unit(DEFENDER);
    const hit = damageAppliedEvent(recorder, ctx.resolutionScopeId, ctx.rootEventId);

    const result = applyEffectConsumptionAndExpiration(ctx, [attacker, defender], hit, hit.eventId);

    const attackerAfter = result.units.find((u) => u.battleUnitId === ATTACKER)!;
    expect(attackerAfter.appliedEffects).toEqual([]);
    const expired = recorder.getEvents().find((e) => e.eventType === "EffectExpired");
    expect(expired?.payload).toMatchObject({ effectInstanceId: "e1", reason: "CONSUMPTION" });
  });

  it("PR #155 re-review [P1]: decrements INCOMING_HIT for the defender on DamageApplied", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const attacker = unit(ATTACKER);
    const defender = unit(DEFENDER, [
      consumableEffect({
        id: "e1",
        consumptionKind: "INCOMING_HIT",
        remaining: 2,
        sourceId: DEFENDER,
        targetId: DEFENDER,
      }),
    ]);
    const hit = damageAppliedEvent(recorder, ctx.resolutionScopeId, ctx.rootEventId);

    const result = applyEffectConsumptionAndExpiration(ctx, [attacker, defender], hit, hit.eventId);

    const defenderAfter = result.units.find((u) => u.battleUnitId === DEFENDER)!;
    expect(defenderAfter.appliedEffects[0]?.duration.consumptionRemaining).toBe(1);
    const changed = recorder.getEvents().find((e) => e.eventType === "EffectConsumptionChanged");
    expect(changed?.payload).toMatchObject({
      effectInstanceId: "e1",
      consumptionKind: "INCOMING_HIT",
      before: 2,
      after: 1,
    });
  });

  it("PR #155 re-review [P1]: expires an effect whose expiration.conditions are satisfied by the event", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const defender = unit(DEFENDER, [
      expiringEffect({
        id: "e1",
        targetId: DEFENDER,
        conditions: [{ kind: "EVENT_PAYLOAD", field: "hitIndex", op: "EQ", value: 1 }],
      }),
    ]);
    const attacker = unit(ATTACKER);
    const hit = damageAppliedEvent(recorder, ctx.resolutionScopeId, ctx.rootEventId);

    const result = applyEffectConsumptionAndExpiration(ctx, [attacker, defender], hit, hit.eventId);

    const defenderAfter = result.units.find((u) => u.battleUnitId === DEFENDER)!;
    expect(defenderAfter.appliedEffects).toEqual([]);
    const expired = recorder.getEvents().find((e) => e.eventType === "EffectExpired");
    expect(expired?.payload).toMatchObject({ effectInstanceId: "e1", reason: "SPECIAL_CONDITION" });
  });

  it("PR #155 re-review round 2 [P2]: expires an effect whose expiration.conditions use TARGET_STATE (real Catalog data: UNIT_HARRIET_SAGE/effects.json's continuous heal expires when its owner (SELF) is no longer alive) instead of throwing", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const defeatedDefender = {
      ...unit(DEFENDER, [
        expiringEffect({
          id: "e1",
          targetId: DEFENDER,
          conditions: [
            {
              kind: "TARGET_STATE",
              target: { kind: "SELF" },
              field: "IS_ALIVE",
              op: "EQ",
              value: false,
            },
          ],
        }),
      ]),
      currentHp: 0,
    };
    const attacker = unit(ATTACKER);
    const hit = damageAppliedEvent(recorder, ctx.resolutionScopeId, ctx.rootEventId);

    const result = applyEffectConsumptionAndExpiration(
      ctx,
      [attacker, defeatedDefender],
      hit,
      hit.eventId,
    );

    const defenderAfter = result.units.find((u) => u.battleUnitId === DEFENDER)!;
    expect(defenderAfter.appliedEffects).toEqual([]);
    const expired = recorder.getEvents().find((e) => e.eventType === "EffectExpired");
    expect(expired?.payload).toMatchObject({ effectInstanceId: "e1", reason: "SPECIAL_CONDITION" });
  });

  it("does nothing (no events, same units) for an event with no matching consumption or expiration", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const attacker = unit(ATTACKER);
    const defender = unit(DEFENDER);
    const hit = damageAppliedEvent(recorder, ctx.resolutionScopeId, ctx.rootEventId);

    const before = recorder.getEvents().length;
    const result = applyEffectConsumptionAndExpiration(ctx, [attacker, defender], hit, hit.eventId);

    expect(result.units).toEqual([attacker, defender]);
    expect(recorder.getEvents().length).toBe(before);
  });
});
