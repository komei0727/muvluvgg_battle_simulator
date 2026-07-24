import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import type { LastDamageResultRegistry } from "../skill/formula-evaluator.js";
import {
  createBattleUnit,
  isDefeated,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { consumeEffectDurations } from "../model/applied-effect-duration.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffects,
} from "../effects/duration-expiry-service.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { Attribute, CriticalMode } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  overrides: {
    attack?: number;
    defense?: number;
    maximumHp?: number;
    criticalRate?: number;
    criticalDamageBonus?: number;
    affinityBonus?: number;
    attribute?: Attribute;
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: overrides.attribute ?? "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 30,
      defense: overrides.defense ?? 10,
      criticalRate: overrides.criticalRate ?? 0,
      actionSpeed: 10,
      criticalDamageBonus: overrides.criticalDamageBonus ?? 0.5,
      affinityBonus: overrides.affinityBonus ?? 0,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

function defeated(target: BattleUnit): BattleUnit {
  return { ...target, currentHp: createHitPoint(0, target.combatStats.maximumHp) };
}

function damageAction(
  criticalMode: CriticalMode = "PREVENTED",
): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: criticalMode },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function hit(targetId: string, hitIndex: number): ResolvedEffectApplication {
  return {
    targetBattleUnitId: createBattleUnitId(targetId),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
    hitIndex,
  };
}

/** `applyDamageAction`は通常`ActionStarted`スコープ内、`SkillUseStarted`直後に呼ばれる。単体テストではその前提イベントを最小限再現する。 */
function damageEventContext(): DamageEventContext {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const actionId = recorder.nextActionId();
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const actionStarted = recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId,
    payload: {
      actorUnitId: createBattleUnitId("ATTACKER"),
      reservedActionType: "AS",
      effectiveActionType: "AS",
      apBefore: 1,
      apAfter: 0,
      exBefore: 0,
      exAfter: 0,
    },
  });
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId: recorder.nextSkillUseId(),
    resolutionScopeId,
    rootEventId: actionStarted.eventId,
    parentEventId: actionStarted.eventId,
    skillDefinitionId: createSkillDefinitionId("SKL_ATTACK"),
  };
}

const STAT_MOD_DEFINITION_ID = createEffectActionDefinitionId("ACT_ATK_UP");

function statModDefinition(): EffectActionDefinition {
  return {
    effectActionDefinitionId: STAT_MOD_DEFINITION_ID,
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE" },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function consumptionEffect(
  id: string,
  ownerId: ReturnType<typeof createBattleUnitId>,
  kind: "NEXT_OUTGOING_ATTACK" | "NEXT_INCOMING_ATTACK" | "OUTGOING_HIT" | "INCOMING_HIT",
  consumptionRemaining: number,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: STAT_MOD_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(STAT_MOD_DEFINITION_ID),
    duplicate: true,
    sourceId: ownerId,
    targetId: ownerId,
    magnitude: 0.2,
    duration: {
      definition: {
        consumption: { kind, maxCount: consumptionRemaining },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      consumptionRemaining,
    },
    appliedTurnNumber: 1,
  };
}

/**
 * `DamageEventContext.consumeEffectDuration`は`combat/`が`effects/`へ依存
 * できないため呼び出し側が注入する（`effect-action-group-resolver.ts`の
 * `buildConsumeEffectDuration`と同じ役割）。テストファイルはDomain層の
 * module境界の対象外のため、ここでは`effects/`の実装をそのまま使う。
 */
function testConsumeEffectDuration(
  recorder: EventRecorder,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): NonNullable<DamageEventContext["consumeEffectDuration"]> {
  return (ownerUnitId, kind, units, parentEventId) => {
    const consumption = consumeEffectDurations(units, ownerUnitId, kind);
    if (consumption.changes.length === 0) {
      return { units, lastEventId: parentEventId };
    }
    const eventContext = {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId: parentEventId,
    };
    let lastEventId = emitEffectConsumptionChangedEvents(
      eventContext,
      consumption.units,
      consumption.changes,
      parentEventId,
    );
    const seeds = consumption.changes
      .filter((change) => change.after === 0)
      .map((change) => ({
        battleUnitId: change.battleUnitId,
        effectInstanceId: change.effectInstanceId,
        reason: "CONSUMPTION" as const,
      }));
    let resultUnits = consumption.units;
    if (seeds.length > 0) {
      const expiry = expireEffects(
        eventContext,
        consumption.units,
        seeds,
        effectActions,
        lastEventId,
      );
      resultUnits = expiry.units;
      lastEventId = expiry.lastEventId;
    }
    return { units: resultUnits, lastEventId };
  };
}

describe("applyDamageAction", () => {
  it("UT-DAMAGE-APPLICATION-001: a single hit reduces HP by the calculated damage (attack - defense, PREVENTED critical)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits).toEqual([
      {
        targetBattleUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: true,
        isCritical: false,
        damage: 20,
      },
    ]);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(80);
  });

  it("UT-HP-REDUCED-001 (RES-005, Issue #172): a hit records a HitPointReduced FACT between DamageCalculated and DamageApplied, carrying the HP StateDelta (not duplicated onto DamageApplied)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    const events = context.recorder.getEvents();
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated")!;
    const hitPointReduced = events.find((e) => e.eventType === "HitPointReduced")!;
    const damageApplied = events.find((e) => e.eventType === "DamageApplied")!;

    expect(hitPointReduced.parentEventId).toBe(damageCalculated.eventId);
    expect(damageApplied.parentEventId).toBe(hitPointReduced.eventId);
    expect(hitPointReduced.payload).toEqual({
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
      hitPointDamage: 20,
      hpBefore: 100,
      hpAfter: 80,
    });
    expect(hitPointReduced.stateDelta).toEqual({
      units: { [createBattleUnitId("TARGET")]: { hp: { before: 100, after: 80 } } },
    });
    expect(damageApplied.stateDelta).toBeUndefined();
  });

  it("UT-DAMAGE-APPLICATION-002: overkill damage clamps HP at 0 and defeats the target", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
    expect(isDefeated(updatedTarget)).toBe(true);
  });

  it("UT-DAMAGE-APPLICATION-003 (R-SKL-03/R-ACTN-01): remaining hits on an already-defeated target are skipped, not applied", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits.map((h) => h.applied)).toEqual([true, false, false]);
    expect(result.hits[1]!.damage).toBe(0);
    expect(result.hits[2]!.damage).toBe(0);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
  });

  it("UT-DAMAGE-APPLICATION-015 (R-ACTN-01 #2, PR #215 re-review finding [P2]): context.includeDefeated: true still applies hits against an already-defeated target, instead of skipping them", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 });
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = { ...damageEventContext(), includeDefeated: true };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits.map((h) => h.applied)).toEqual([true, true, true]);
    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.filter((t) => t === "DamageApplied")).toHaveLength(3);
    // The target was alive before hit 1 (it dies from hit 1's overkill damage),
    // so only that hit's HP transition (>0 -> 0) may emit UnitDefeated. Hits 2
    // and 3 keep applying damage to an already-defeated target and must not
    // re-emit it (08_ドメインイベント.md「HPが0になった直後」、レビュー再々指摘[P2] PR #215).
    expect(eventTypes.filter((t) => t === "UnitDefeated")).toHaveLength(1);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
  });

  it("UT-DAMAGE-APPLICATION-016 (R-ACTN-01 #2, PR #215 re-review finding [P2]): hits against a target that was already defeated BEFORE this EffectAction started never emit UnitDefeated, even with context.includeDefeated: true", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = defeated(unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 }));
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = { ...damageEventContext(), includeDefeated: true };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits.map((h) => h.applied)).toEqual([true, true]);
    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.filter((t) => t === "DamageApplied")).toHaveLength(2);
    expect(eventTypes.filter((t) => t === "UnitDefeated")).toHaveLength(0);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
  });

  it("UT-DAMAGE-APPLICATION-004: hits against independent targets do not affect each other's HP", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const targetA = unit("TARGET_A", "ENEMY", { defense: 10, maximumHp: 100 });
    const targetB = unit("TARGET_B", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET_A", 1), hit("TARGET_B", 1)],
      damageAction("PREVENTED"),
      [attacker, targetA, targetB],
      random,
      damageEventContext(),
    );

    const updatedA = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET_A"))!;
    const updatedB = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET_B"))!;
    expect(updatedA.currentHp).toBe(80);
    expect(updatedB.currentHp).toBe(80);
  });

  it("UT-DAMAGE-APPLICATION-005: GUARANTEED critical mode applies the critical multiplier without consuming the RandomSource", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, criticalDamageBonus: 0.5 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    random.assertFullyConsumed();
    expect(result.hits[0]!.isCritical).toBe(true);
    // base damage 20 * (1.5 + 0.5 criticalDamageBonus) = 40
    expect(result.hits[0]!.damage).toBe(40);
  });

  it("UT-DAMAGE-APPLICATION-006: throws when a hit references a BattleUnitId absent from the given units (defensive)", () => {
    const attacker = unit("ATTACKER", "ALLY", {});
    const random = new SequenceRandomSource([]);

    expect(() =>
      applyDamageAction(
        attacker,
        [hit("MISSING_TARGET", 1)],
        damageAction("PREVENTED"),
        [attacker],
        random,
        damageEventContext(),
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-007 (R-SKL-01/R-SKL-03): once the attacker itself becomes defeated mid-sequence, remaining hits (even against other targets) are interrupted", () => {
    // A lethal SELF-targeting hit comes first, then a hit against an unrelated target.
    const attacker = unit("ATTACKER", "ALLY", { attack: 999, defense: 0, maximumHp: 10 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("ATTACKER", 1), hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[1]).toEqual({
      targetBattleUnitId: createBattleUnitId("TARGET"),
      hitIndex: 1,
      applied: false,
      isCritical: false,
      damage: 0,
    });
    const updatedAttacker = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("ATTACKER"),
    )!;
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(isDefeated(updatedAttacker)).toBe(true);
    expect(updatedTarget.currentHp).toBe(100);
  });

  it("UT-DAMAGE-APPLICATION-008 (R-SKL-01/R-SKL-03): an already-defeated attacker cannot apply any hit", () => {
    const attacker = defeated(unit("ATTACKER", "ALLY", { attack: 999 }));
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 10 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.applied).toBe(false);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(10);
  });

  it("UT-DAMAGE-APPLICATION-009 (会心・ダメージイベントのpayload監査可能性): the recorded CriticalCheckResolved/DamageCalculated events carry the correct, non-swapped calculation values — not just calculateDamage()/resolveCritical()'s own return values", () => {
    // criticalRate above 100% so baseCriticalRate (1.5) and effectiveCriticalRate
    // (clamped to 1) are guaranteed to differ, catching a "stored baseRate into
    // effectiveRate" bug. attributeMultiplier (1.35, favorable attribute +
    // affinityBonus) and actionDamageMultiplier (1.2, from damageModifiers) are
    // chosen to differ from each other and from 1, catching a field swap.
    const attacker = unit("ATTACKER", "ALLY", {
      attack: 50,
      criticalRate: 1.5,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.1,
      attribute: "AGGRESSIVE",
    });
    const target = unit("TARGET", "ENEMY", {
      defense: 20,
      maximumHp: 1000,
      attribute: "SHY", // AGGRESSIVE is favorable against SHY (R-ATR-01/02).
    });
    const richDamageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        hitCount: 1,
        critical: { mode: "GUARANTEED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [{ kind: "CONSTANT", value: 0.2 }],
        link: { enabled: false },
      },
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      richDamageAction,
      [attacker, target],
      random,
      context,
    );

    const events = context.recorder.getEvents();
    const criticalCheckResolved = events.find((e) => e.eventType === "CriticalCheckResolved");
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated");
    expect(criticalCheckResolved).toBeDefined();
    expect(damageCalculated).toBeDefined();

    expect(criticalCheckResolved!.payload).toEqual({
      mode: "GUARANTEED",
      baseCriticalRate: 1.5,
      effectiveCriticalRate: 1,
      result: true,
    });

    const damageDetails = damageCalculated!.payload as Record<string, unknown>;
    expect(damageDetails).toMatchObject({
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
      attackerAttack: 50,
      defenderDefense: 20,
      effectiveDefense: 20,
      defenseIgnoreRate: 0,
      skillPower: 1,
      criticalMultiplier: 2,
      // 30 base damage * 1 * 1.35 * 2 * 1.2 = 97.2 -> floor -> 97.
      finalDamage: 97,
      damageType: "PHYSICAL",
    });
    expect(damageDetails.attributeMultiplier).toBeCloseTo(1.35);
    expect(damageDetails.actionDamageMultiplier).toBeCloseTo(1.2);
    expect(damageDetails.preTruncationDamage).toBeCloseTo(97.2);
  });

  it("PR #141 review [P1]: a lethal hit still passes DamageApplied (not just the resulting UnitDefeated) to onFactEventForPassiveChain, in event order", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 100 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 10 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const seenEventTypes: string[] = [];
    const contextWithHook: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        seenEventTypes.push(event.eventType);
        return units;
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHook,
    );

    expect(
      isDefeated(result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!),
    ).toBe(true);
    // All facts from this one lethal hit must reach the hook, in causal
    // order, so a third party's DamageApplied-triggered PS (e.g. "when an
    // ally is damaged") is not silently skipped just because the hit also
    // happened to be lethal. `UnitBeingAttacked` (R-EFF-07, EFF-003) also
    // reaches the hook, ahead of all three — the target was determined
    // attackable before hit judgment, damage calculation, or defeat.
    // `HitPointReduced` (RES-005, Issue #172) reaches the hook right before
    // `DamageApplied` — it's the fact of the HP change itself.
    expect(seenEventTypes).toEqual([
      "UnitBeingAttacked",
      "HitPointReduced",
      "DamageApplied",
      "UnitDefeated",
    ]);
  });

  it("UT-R-EFF-07-007 (R-EFF-07 NEXT_OUTGOING_ATTACK/OUTGOING_HIT): consumes the attacker's matching effects when a hit reaches judgment and is confirmed (not MISS)", () => {
    const nextAttackEffect = consumptionEffect(
      "eff-next-outgoing",
      createBattleUnitId("ATTACKER"),
      "NEXT_OUTGOING_ATTACK",
      1,
    );
    const outgoingHitEffect = consumptionEffect(
      "eff-outgoing-hit",
      createBattleUnitId("ATTACKER"),
      "OUTGOING_HIT",
      2,
    );
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [nextAttackEffect, outgoingHitEffect],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const updatedAttacker = result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!;
    expect(updatedAttacker.appliedEffects).toHaveLength(1);
    expect(updatedAttacker.appliedEffects[0]!.effectInstanceId).toBe(
      outgoingHitEffect.effectInstanceId,
    );
    expect(updatedAttacker.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
  });

  it("UT-R-EFF-07-008 (R-EFF-07 NEXT_INCOMING_ATTACK/INCOMING_HIT): consumes the target's matching effects when it is attacked and the hit is confirmed", () => {
    const nextIncomingEffect = consumptionEffect(
      "eff-next-incoming",
      createBattleUnitId("TARGET"),
      "NEXT_INCOMING_ATTACK",
      1,
    );
    const incomingHitEffect = consumptionEffect(
      "eff-incoming-hit",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [nextIncomingEffect, incomingHitEffect],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.effectInstanceId).toBe(
      incomingHitEffect.effectInstanceId,
    );
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
  });

  it("UT-R-EFF-07-010 (レビュー修正 PR #209、R-EFF-07/08_ドメインイベント.md UnitBeingAttacked): records a real UnitBeingAttacked event when the target is determined attackable, and consumes NEXT_INCOMING_ATTACK causally after it (not merely before hit judgment)", () => {
    const nextIncomingEffect = consumptionEffect(
      "eff-next-incoming",
      createBattleUnitId("TARGET"),
      "NEXT_INCOMING_ATTACK",
      1,
    );
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [nextIncomingEffect],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const events = baseContext.recorder.getEvents();
    const unitBeingAttacked = events.find((e) => e.eventType === "UnitBeingAttacked");
    const consumptionChanged = events.find((e) => e.eventType === "EffectConsumptionChanged");
    expect(unitBeingAttacked).toBeDefined();
    expect(unitBeingAttacked!.payload).toMatchObject({
      targetUnitId: createBattleUnitId("TARGET"),
      hitIndex: 1,
    });
    expect(unitBeingAttacked!.sourceUnitId).toBe(createBattleUnitId("ATTACKER"));
    expect(consumptionChanged).toBeDefined();
    expect(consumptionChanged!.parentEventId).toBe(unitBeingAttacked!.eventId);
  });

  it("UT-R-EFF-07-011: does not record UnitBeingAttacked for a hit skipped because the target is already defeated", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = defeated(unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }));
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(context.recorder.getEvents().some((e) => e.eventType === "UnitBeingAttacked")).toBe(
      false,
    );
  });

  it("UT-R-EFF-07-009 (R-EFF-07 boundary/expiry): a NEXT_OUTGOING_ATTACK effect at maxCount 1 expires (EffectConsumptionChanged then EffectExpired) after being consumed", () => {
    const nextAttackEffect = consumptionEffect(
      "eff-next-outgoing",
      createBattleUnitId("ATTACKER"),
      "NEXT_OUTGOING_ATTACK",
      1,
    );
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [nextAttackEffect],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();
    const context: DamageEventContext = {
      ...baseContext,
      consumeEffectDuration: testConsumeEffectDuration(
        baseContext.recorder,
        new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
      ),
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    const updatedAttacker = result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!;
    expect(updatedAttacker.appliedEffects).toHaveLength(0);

    const types = context.recorder.getEvents().map((e) => e.eventType);
    expect(types).toContain("EffectConsumptionChanged");
    expect(types).toContain("EffectExpired");
    expect(types.indexOf("EffectConsumptionChanged")).toBeLessThan(types.indexOf("EffectExpired"));
  });

  it("UT-R-EFF-07-012 (レビュー修正 PR #209 続き — hpBefore/hpAfter staleness): an HP change made by a PS reacting to UnitBeingAttacked (before hit judgment) is reflected as the damage baseline, not silently discarded", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();
    // Simulate a PS that heals the target by 5 HP the instant it becomes an
    // attack target (reacting to UnitBeingAttacked, before hit judgment).
    const contextWithHeal: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) =>
        event.eventType === "UnitBeingAttacked"
          ? units.map((u) =>
              u.battleUnitId === target.battleUnitId ? { ...u, currentHp: u.currentHp + 5 } : u,
            )
          : units,
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHeal,
    );

    // attack(30) - defense(10) = 20 damage. Baseline must be the healed HP
    // (100 + 5 = 105), not the stale pre-heal snapshot (100).
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(85);
    const damageApplied = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageApplied")!;
    expect(damageApplied.payload).toMatchObject({ hpBefore: 105, hpAfter: 85 });
  });

  it("UT-DAMAGE-APPLICATION-010 (R-SKL-08, レビュー再指摘[P1] PR #214): an applied hit records lastDamageDealt/lastDamageReceived into the caller-supplied resolution-scope registry, not onto BattleUnit", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const lastDamageResults: LastDamageResultRegistry = new Map();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      { ...damageEventContext(), lastDamageResults },
    );

    expect(lastDamageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(lastDamageResults.get(target.battleUnitId)?.lastDamageReceived).toBe(20);
    expect(lastDamageResults.get(attacker.battleUnitId)?.lastDamageReceived).toBeUndefined();
    expect(lastDamageResults.get(target.battleUnitId)?.lastDamageDealt).toBeUndefined();
  });

  it("UT-DAMAGE-APPLICATION-011 (R-SKL-08, レビュー再指摘[P1] PR #214, mirrors production ACT_AOI_GUARDIAN_PS2_COUNTER): a DAMAGE_RECEIVED_RATIO formula reads the actor's own lastDamageReceived from an earlier hit in the SAME resolution scope (shared registry)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    // One registry instance shared across both calls, standing in for the
    // single resolution scope (one action) that both the triggering hit and
    // the counter it provokes belong to (`PassiveActivationRuntime` threads
    // the same instance through nested PS chains in production).
    const lastDamageResults: LastDamageResultRegistry = new Map();

    // First hit: ATTACKER deals 20 to DEFENDER (attack 30 - defense 10).
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), lastDamageResults },
    );
    const defenderAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === defender.battleUnitId,
    )!;
    expect(lastDamageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);

    // Second hit: DEFENDER counters using DAMAGE_RECEIVED_RATIO(LAST_DAMAGE_RECEIVED, ratio: 1),
    // which should equal the 20 it just received, independent of its own attack stat.
    const counterAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_COUNTER"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
    const attackerAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    const counterHit = applyDamageAction(
      defenderAfterFirstHit,
      [
        {
          targetBattleUnitId: attacker.battleUnitId,
          effectActionDefinitionId: counterAction.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      counterAction,
      firstHit.units,
      random,
      { ...damageEventContext(), lastDamageResults },
    );

    expect(counterHit.hits[0]!.damage).toBe(20);
    const attackerAfterCounter = counterHit.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    expect(attackerAfterCounter.currentHp).toBe(attackerAfterFirstHit.currentHp - 20);
  });

  it("UT-DAMAGE-APPLICATION-012 (R-NUM-04): a DAMAGE_RECEIVED_RATIO formula throws when the registry has no recorded lastDamageReceived yet", () => {
    const attacker = unit("ATTACKER", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const random = new SequenceRandomSource([]);
    const counterAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_COUNTER"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };

    expect(() =>
      applyDamageAction(
        attacker,
        [hit("TARGET", 1)],
        counterAction,
        [attacker, target],
        random,
        damageEventContext(),
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-013 (R-SKL-08, レビュー再指摘[P1] PR #214): a DAMAGE_RECEIVED_RATIO formula in a NEW resolution scope (a fresh registry) does not see a value recorded in an earlier, unrelated resolution scope", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);

    // Scope 1 (e.g. an earlier, unrelated action): records DEFENDER's
    // lastDamageReceived into its own registry.
    const scope1Registry: LastDamageResultRegistry = new Map();
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), lastDamageResults: scope1Registry },
    );
    const defenderAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === defender.battleUnitId,
    )!;
    expect(scope1Registry.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);

    // Scope 2 (a brand-new resolution scope, e.g. a later, independent
    // action): a fresh, empty registry — must NOT see scope 1's value even
    // though it's evaluating a formula for the very same BattleUnit.
    const scope2Registry: LastDamageResultRegistry = new Map();
    const counterAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_COUNTER"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };

    expect(() =>
      applyDamageAction(
        defenderAfterFirstHit,
        [
          {
            targetBattleUnitId: attacker.battleUnitId,
            effectActionDefinitionId: counterAction.effectActionDefinitionId,
            hitIndex: 1,
          },
        ],
        counterAction,
        firstHit.units,
        random,
        { ...damageEventContext(), lastDamageResults: scope2Registry },
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-014 (R-SKL-08, レビュー再々々指摘[P1] PR #214): a successful DAMAGE followed by a not-applied one (target already defeated) in the SAME resolution scope records lastDamageDealt/lastDamageReceived as 0, instead of leaving the earlier success value visible or making later Formula references throw", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    const lastDamageResults: LastDamageResultRegistry = new Map();

    // Hit 1 (success): ATTACKER deals 20 to DEFENDER, recorded in the shared
    // registry for this resolution scope.
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), lastDamageResults },
    );
    expect(lastDamageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(lastDamageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);
    const attackerAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    const defeatedDefender = defeated(
      firstHit.units.find((u) => u.battleUnitId === defender.battleUnitId)!,
    );

    // Hit 2 (not applied — target already defeated), same attacker/target
    // pair, same shared registry: R-SKL-08 treats this not-applied result as
    // a regular "last result" for this scope (not a Catalog-definition
    // error), so it must overwrite hit 1's success value with 0 rather than
    // leaving it visible or erasing it entirely.
    applyDamageAction(
      attackerAfterFirstHit,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attackerAfterFirstHit, defeatedDefender],
      random,
      { ...damageEventContext(), lastDamageResults },
    );
    expect(lastDamageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(0);
    expect(lastDamageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(0);

    // A later Formula referencing LAST_DAMAGE_DEALT in this same scope must
    // now evaluate to 0 — not the stale 20, and not a thrown error (MISS/
    // no-target is a normal runtime outcome under a valid Catalog
    // definition, not the "reference doesn't exist" case R-NUM-04 reserves
    // for Catalog/preflight rejection).
    const referencingAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_REFERENCING"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_DEALT_RATIO", sourceResult: "LAST_DAMAGE_DEALT", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
    const otherTarget = unit("OTHER_TARGET", "ENEMY");

    const referencingResult = applyDamageAction(
      attackerAfterFirstHit,
      [hit("OTHER_TARGET", 1)],
      referencingAction,
      [attackerAfterFirstHit, otherTarget],
      random,
      { ...damageEventContext(), lastDamageResults },
    );
    // baseDamage = LAST_DAMAGE_DEALT(0) * ratio(1) = 0; R-DMG-02's minimum-1
    // still applies since this is a DAMAGE-kind effect.
    expect(referencingResult.hits[0]!.damage).toBe(1);
  });
});
