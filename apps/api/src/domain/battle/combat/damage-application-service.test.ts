import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import {
  createBattleUnit,
  isDefeated,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type StatusEffectDetails,
} from "../model/applied-effect.js";
import { consumeEffectDurations } from "../model/applied-effect-duration.js";
import type { MarkerState } from "../model/marker-state.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffectsSteps,
} from "../effects/duration-expiry-service.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
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

function immunityEffect(
  id: string,
  targetId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_IMMUNITY"),
    kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_IMMUNITY")),
    duplicate: true,
    sourceId: createBattleUnitId(targetId),
    targetId: createBattleUnitId(targetId),
    magnitude: 0,
    statusKind: "DAMAGE_IMMUNITY",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function attackDamageBonusEffect(id: string, holderId: string, magnitude: number): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
    kindKey: effectKindKeyFromDefinitionId(
      createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
    ),
    duplicate: true,
    sourceId: createBattleUnitId(holderId),
    targetId: createBattleUnitId(holderId),
    magnitude,
    isAttackDamageBonus: true,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function freezeEffect(
  id: string,
  targetId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
    kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
    duplicate: true,
    sourceId: createBattleUnitId(targetId),
    targetId: createBattleUnitId(targetId),
    magnitude: 0,
    statusKind: "FREEZE",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function evasionEffect(
  id: string,
  targetId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_EVASION"),
    kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_EVASION")),
    duplicate: true,
    sourceId: createBattleUnitId(targetId),
    targetId: createBattleUnitId(targetId),
    magnitude: 0,
    statusKind: "EVASION",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/**
 * R-HIT-04（M7-018、Issue #272）: production定義（`ACT_ANIS_TROUBLEMAKER_PS1_EVASION`の
 * `EVASION`、`ACT_FLUTE_VAMPIRE_PS2_EVASION`の`HIT_EVASION`）と同じ形の、被ヒット
 * 消費（`INCOMING_HIT`）付き回避効果。
 */
function hitCountEvasionEffect(
  id: string,
  targetId: string,
  statusKind: "EVASION" | "HIT_EVASION",
  consumptionRemaining: number,
): AppliedEffect {
  return {
    ...evasionEffect(id, targetId, { probability: 1 }),
    statusKind,
    duration: {
      definition: {
        consumption: { kind: "INCOMING_HIT", maxCount: consumptionRemaining },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      consumptionRemaining,
    },
  };
}

function evasionDefinition(): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_EVASION"),
    kind: "APPLY_STATUS",
    payload: {
      status: "EVASION",
      probability: 1,
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function guaranteedHitEffect(id: string, attackerId: string): AppliedEffect {
  return { ...evasionEffect(id, attackerId, {}), statusKind: "GUARANTEED_HIT" };
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
      stacking: { mode: "STACKABLE", max: null },
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
  return function* (ownerUnitId, kind, units, parentEventId, effectInstanceId) {
    const consumption = consumeEffectDurations(units, ownerUnitId, kind, effectInstanceId);
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
      const expiry = yield* expireEffectsSteps(
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
    // `DamageWillBeApplied` (R-DMG-05 #4, DMG-001/Issue #195) reaches the hook
    // between them: it is a TIMING event whose chain may still cancel or
    // re-shape this hit, so it must be delivered before damage is calculated.
    expect(seenEventTypes).toEqual([
      "UnitBeingAttacked",
      "DamageWillBeApplied",
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

  it("UT-R-EFF-09-022 (R-EFF-09 cross-type 通知順序, PR #280 再レビュー[P1]): a PARENT effect expiring from an INCOMING_HIT consumption notifies each cascade step in order, so a watcher of the CHILD's EffectExpired still observes the PARENT and its Marker", () => {
    const parentId = createBattleUnitId("TARGET");
    // 消費で0になるPARENT効果と、同じグループのCHILD効果／CHILD Marker。
    const parentEffect: AppliedEffect = {
      ...consumptionEffect("eff-parent", parentId, "INCOMING_HIT", 1),
      duration: {
        definition: {
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "PARENT",
        },
        consumptionRemaining: 1,
      },
    };
    const childEffect: AppliedEffect = {
      ...consumptionEffect("eff-child", parentId, "OUTGOING_HIT", 5),
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const childMarker: MarkerState = {
      markerInstanceId: createMarkerInstanceId("marker-child"),
      markerId: createMarkerId("MARKER_CHILD"),
      sourceId: parentId,
      targetId: parentId,
      stackCount: 1,
      stackMax: null,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [parentEffect, childEffect],
      markerStates: [childMarker],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const observations: {
      eventType: string;
      parentEffectPresent: boolean;
      childMarkerPresent: boolean;
    }[] = [];

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
        onFactEventForPassiveChain: (event, units) => {
          const holder = units.find((u) => u.battleUnitId === parentId);
          observations.push({
            eventType: event.eventType,
            parentEffectPresent:
              holder?.appliedEffects.some(
                (effect) => effect.effectInstanceId === parentEffect.effectInstanceId,
              ) ?? false,
            childMarkerPresent:
              holder?.markerStates.some(
                (marker) => marker.markerInstanceId === childMarker.markerInstanceId,
              ) ?? false,
          });
          return units;
        },
      },
    );

    const updatedTarget = result.units.find((u) => u.battleUnitId === parentId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(0);
    expect(updatedTarget.markerStates).toHaveLength(0);

    const cascadeObservations = observations.filter(
      (o) => o.eventType === "EffectExpired" || o.eventType === "MarkerRemoved",
    );
    // R-EFF-09: 子`AppliedEffect` → 子`MarkerState` → 親（消費で失効）の順。
    expect(cascadeObservations.map((o) => o.eventType)).toEqual([
      "EffectExpired",
      "MarkerRemoved",
      "EffectExpired",
    ]);
    // 子の`EffectExpired`を観測する時点では、親効果も子Markerもまだ残っている。
    expect(cascadeObservations[0]).toMatchObject({
      parentEffectPresent: true,
      childMarkerPresent: true,
    });
    // 子Markerの`MarkerRemoved`時点では親効果だけが残っている。
    expect(cascadeObservations[1]).toMatchObject({
      parentEffectPresent: true,
      childMarkerPresent: false,
    });
    // 親の`EffectExpired`時点で全て除去済み。
    expect(cascadeObservations[2]).toMatchObject({
      parentEffectPresent: false,
      childMarkerPresent: false,
    });
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
    const damageResults: DamageResultRegistry = new Map();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      { ...damageEventContext(), damageResults },
    );

    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(damageResults.get(target.battleUnitId)?.lastDamageReceived).toBe(20);
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageReceived).toBeUndefined();
    expect(damageResults.get(target.battleUnitId)?.lastDamageDealt).toBeUndefined();
  });

  it("UT-DAMAGE-APPLICATION-011 (R-SKL-08, レビュー再指摘[P1] PR #214, mirrors production ACT_AOI_GUARDIAN_PS2_COUNTER): a DAMAGE_RECEIVED_RATIO formula reads the actor's own lastDamageReceived from an earlier hit in the SAME resolution scope (shared registry)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    // One registry instance shared across both calls, standing in for the
    // single resolution scope (one action) that both the triggering hit and
    // the counter it provokes belong to (`PassiveActivationRuntime` threads
    // the same instance through nested PS chains in production).
    const damageResults: DamageResultRegistry = new Map();

    // First hit: ATTACKER deals 20 to DEFENDER (attack 30 - defense 10).
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), damageResults },
    );
    const defenderAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === defender.battleUnitId,
    )!;
    expect(damageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);

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
      { ...damageEventContext(), damageResults },
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
    const scope1Registry: DamageResultRegistry = new Map();
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), damageResults: scope1Registry },
    );
    const defenderAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === defender.battleUnitId,
    )!;
    expect(scope1Registry.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);

    // Scope 2 (a brand-new resolution scope, e.g. a later, independent
    // action): a fresh, empty registry — must NOT see scope 1's value even
    // though it's evaluating a formula for the very same BattleUnit.
    const scope2Registry: DamageResultRegistry = new Map();
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
        { ...damageEventContext(), damageResults: scope2Registry },
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-014 (R-SKL-08, レビュー再々々指摘[P1] PR #214): a successful DAMAGE followed by a not-applied one (target already defeated) in the SAME resolution scope records lastDamageDealt/lastDamageReceived as 0, instead of leaving the earlier success value visible or making later Formula references throw", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    const damageResults: DamageResultRegistry = new Map();

    // Hit 1 (success): ATTACKER deals 20 to DEFENDER, recorded in the shared
    // registry for this resolution scope.
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), damageResults },
    );
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(damageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);
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
      { ...damageEventContext(), damageResults },
    );
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(0);
    expect(damageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(0);

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
      { ...damageEventContext(), damageResults },
    );
    // baseDamage = LAST_DAMAGE_DEALT(0) * ratio(1) = 0; R-DMG-02's minimum-1
    // still applies since this is a DAMAGE-kind effect.
    expect(referencingResult.hits[0]!.damage).toBe(1);
  });

  it("UT-R-HIT-02-009 (R-HIT-02, Issue #183): a target with an active EVASION effect evades a DAMAGE hit, skipping DamageApplied and emitting EvasionActivated instead of HitConfirmed", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits).toEqual([
      {
        targetBattleUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: false,
        isCritical: false,
        damage: 0,
      },
    ]);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(100);

    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("EvasionActivated");
    expect(eventTypes).not.toContain("HitConfirmed");
    expect(eventTypes).not.toContain("DamageApplied");

    const evasionActivated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "EvasionActivated")!;
    expect(evasionActivated.payload).toEqual({
      effectActionDefinitionId: evasion.effectActionDefinitionId,
      effectInstanceId: evasion.effectInstanceId,
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
    });
  });

  it("UT-R-HIT-02-010 (R-HIT-02 #2, Issue #183): a GUARANTEED-hit attack ignores the target's EVASION effect and applies damage normally", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const guaranteedAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      ...damageAction("PREVENTED"),
      payload: { ...damageAction("PREVENTED").payload, accuracy: { mode: "GUARANTEED" } },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      guaranteedAction,
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[0]!.damage).toBe(20);
  });

  it("UT-R-HIT-02-012 (レビュー指摘[P1], Issue #183): EvasionActivated reaches onFactEventForPassiveChain, so a PS/Memory triggered by it is not silently skipped", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
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

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHook,
    );

    expect(seenEventTypes).toContain("EvasionActivated");
  });

  it("UT-R-HIT-04-006 (R-HIT-04, M7-018/Issue #272): the hit an evasion effect evades consumes that instance's own INCOMING_HIT count, so a 2-hit evasion buff evades exactly two hits and the third lands", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "EVASION", 2);
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits.map((outcome) => outcome.applied)).toEqual([false, false, true]);
    expect(result.hits[2]!.damage).toBe(20);

    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toEqual([]);

    const eventTypes = baseContext.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.filter((type) => type === "EvasionActivated")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "EffectConsumptionChanged")).toHaveLength(2);
    expect(eventTypes).toContain("EffectExpired");
  });

  it("UT-R-HIT-04-007 (R-HIT-04, M7-018/Issue #272): an evaded hit consumes only the evading instance — other INCOMING_HIT-consumption effects on the same target keep their count (R-EFF-07 still requires a confirmed hit for them)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const bystander = consumptionEffect(
      "eff-incoming-hit",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion, bystander],
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
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(false);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.effectInstanceId).toBe(bystander.effectInstanceId);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(2);
  });

  it("UT-R-HIT-04-008 (R-HIT-04, M7-018/Issue #272): a HIT_EVASION buff shaped like ACT_FLUTE_VAMPIRE_PS2_EVASION evades exactly one hit and expires, so the next hit lands", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits.map((outcome) => outcome.applied)).toEqual([false, true]);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toEqual([]);
    expect(updatedTarget.currentHp).toBe(80);
  });

  it("UT-R-HIT-05-006 (R-HIT-05 #2, M7-018/Issue #272): an attacker holding a GUARANTEED_HIT effect lands a NORMAL-accuracy hit through the target's evasion, leaving the evasion count untouched", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [guaranteedHitEffect("eff-guaranteed", "ATTACKER")],
    };
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
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
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[0]!.damage).toBe(20);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    // R-HIT-04: an N-hit evasion is consumed only by a hit it actually evaded.
    // This hit landed (the attacker is guaranteed-hit), so the evasion keeps
    // its full count for a later, non-guaranteed attack.
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
    expect(baseContext.recorder.getEvents().map((event) => event.eventType)).not.toContain(
      "EvasionActivated",
    );
  });

  it("UT-R-HIT-04-010 (R-HIT-04, PR #275 レビュー[P1]): an evasion whose probability roll fails keeps its hit count — the landed hit must not consume it through the ordinary R-EFF-07 confirmed-hit rule", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    // ACT_STELLA_STATUE_AS2_SELF_EVASION shape: probability 0.6, 1 hit.
    const evasion: AppliedEffect = {
      ...hitCountEvasionEffect("eff-evasion", "TARGET", "EVASION", 1),
      statusDetails: { probability: 0.6 },
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    // 0.6 <= 0.6 => the evasion roll fails, so the hit lands.
    const random = new SequenceRandomSource([0.6]);
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
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(true);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
    expect(baseContext.recorder.getEvents().map((event) => event.eventType)).not.toContain(
      "EffectConsumptionChanged",
    );
  });

  it("UT-R-HIT-04-011 (R-HIT-04 boundary, PR #275 レビュー[P1]): a non-evasion INCOMING_HIT-consumption effect on the same target is still consumed by the confirmed hit (R-EFF-07 unchanged)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion: AppliedEffect = {
      ...hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1),
      statusDetails: { probability: 0.6 },
    };
    const bystander = consumptionEffect(
      "eff-incoming-hit",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion, bystander],
    };
    const random = new SequenceRandomSource([0.6]);
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
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(true);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(2);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
    expect(updatedTarget.appliedEffects[1]!.duration.consumptionRemaining).toBe(1);
  });

  it("UT-R-DMG-02-008 (R-DMG-02, Issue #183): an unconditional DAMAGE_IMMUNITY effect nullifies a hit's damage to exactly 1, still confirming the hit (HitConfirmed/DamageApplied still fire)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[0]!.damage).toBe(1);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(99);

    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("HitConfirmed");
    expect(eventTypes).toContain("DamageApplied");

    const damageCalculated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated")!;
    expect(damageCalculated.payload).toMatchObject({
      // Base damage 20 (attack 30 - defense 10) would normally apply, but the
      // nullification overrides just finalDamage — preTruncationDamage keeps
      // auditing the pre-nullification value.
      preTruncationDamage: 20,
      finalDamage: 1,
    });
  });

  it("UT-R-DMG-02-009 (R-DMG-02 damageThreshold, Issue #183): a DAMAGE_IMMUNITY gated by damageThreshold lets damage below the threshold through unmodified", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.5 },
      },
    });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const random = new SequenceRandomSource([]);

    // Base damage 20 (attack 30 - defense 10) does not exceed 50% of 100 HP
    // (50), so the immunity does not trigger and full damage applies.
    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.damage).toBe(20);
  });

  it("UT-R-STS-03-005 (R-STS-03, Issue #183): a DAMAGE hit against a frozen target amplifies this hit's damage by damageAmplificationOnBreak, clears FREEZE, and records FreezeRemoved between DamageCalculated and HitPointReduced", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    // Base damage 20 (attack 30 - defense 10) * 1.5 amplification = 30.
    expect(result.hits[0]!.damage).toBe(30);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(70);
    expect(updatedTarget.appliedEffects).toHaveLength(0);

    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("FreezeRemoved");
    const damageCalculatedIndex = eventTypes.indexOf("DamageCalculated");
    const freezeRemovedIndex = eventTypes.indexOf("FreezeRemoved");
    const hitPointReducedIndex = eventTypes.indexOf("HitPointReduced");
    expect(damageCalculatedIndex).toBeLessThan(freezeRemovedIndex);
    expect(freezeRemovedIndex).toBeLessThan(hitPointReducedIndex);

    const freezeRemoved = context.recorder
      .getEvents()
      .find((e) => e.eventType === "FreezeRemoved")!;
    expect(freezeRemoved.payload).toEqual({
      effectInstanceId: freeze.effectInstanceId,
      battleUnitId: target.battleUnitId,
      triggeringDamage: 30,
    });
  });

  it("UT-R-STS-03-006 (R-STS-03 default amplification +50%, Issue #183): a frozen target with no explicit damageAmplificationOnBreak amplifies by 1.5x", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.damage).toBe(30);
  });

  it("UT-R-STS-03-012 (Q-DMG-01 'ダメージ計算の途中では丸めず、最終結果で切り捨てる'): freeze amplification is applied to the unrounded pre-truncation damage and floored exactly once, not floored again after calculateDamage's own floor", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);
    // Base damage 20 (attack 30 - defense 10) * actionDamageMultiplier 1.045
    // (from a 4.5% damageModifier) = 20.9 pre-truncation.
    const fractionalDamageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      ...damageAction("PREVENTED"),
      payload: {
        ...damageAction("PREVENTED").payload,
        damageModifiers: [{ kind: "CONSTANT", value: 0.045 }],
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      fractionalDamageAction,
      [attacker, target],
      random,
      damageEventContext(),
    );

    // Correct (single final floor): 20.9 * 1.5 = 31.35 -> floor -> 31.
    // The bug this guards against: flooring 20.9 -> 20 first, then *1.5 -> 30
    // -> floor -> 30 (a full point of damage silently lost to Q-DMG-01
    // non-compliant intermediate rounding).
    expect(result.hits[0]!.damage).toBe(31);
  });

  it("UT-R-STS-03-007 (R-STS-03 interacts with R-DMG-02): freeze still clears even when DAMAGE_IMMUNITY nullifies the (already amplified) triggering damage down to 1", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze, immunity],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.damage).toBe(1);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    // FREEZE cleared, DAMAGE_IMMUNITY (unrelated effect) remains.
    expect(updatedTarget.appliedEffects).toEqual([immunity]);
    expect(context.recorder.getEvents().some((e) => e.eventType === "FreezeRemoved")).toBe(true);

    const freezeRemoved = context.recorder
      .getEvents()
      .find((e) => e.eventType === "FreezeRemoved")!;
    // triggeringDamage reflects the final (nullified) damage, not the
    // pre-nullification amplified value.
    expect(freezeRemoved.payload).toMatchObject({ triggeringDamage: 1 });
  });

  it("UT-R-STS-03-008 (R-STS-03 'MISSでは解除しない'): an evaded hit against a frozen target does not amplify damage or clear FREEZE", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze, evasion],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.applied).toBe(false);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects.some((e) => e.statusKind === "FREEZE")).toBe(true);
    expect(context.recorder.getEvents().some((e) => e.eventType === "FreezeRemoved")).toBe(false);
  });

  it("UT-R-STS-03-013 (レビュー指摘[P2], Issue #183): FreezeRemoved reaches onFactEventForPassiveChain before HP is applied, so a PS reacting to it sees pre-damage HP as the baseline", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();
    // Simulate a PS that heals the target by 5 HP the instant FreezeRemoved
    // fires (before this hit's HP reduction is computed).
    const seenEventTypes: string[] = [];
    const contextWithHeal: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        seenEventTypes.push(event.eventType);
        return event.eventType === "FreezeRemoved"
          ? units.map((u) =>
              u.battleUnitId === target.battleUnitId ? { ...u, currentHp: u.currentHp + 5 } : u,
            )
          : units;
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHeal,
    );

    // FreezeRemoved must reach the hook strictly before DamageApplied/
    // HitPointReduced, so a reacting PS's HP change becomes the baseline the
    // hit's own damage is subtracted from.
    expect(seenEventTypes.indexOf("FreezeRemoved")).toBeLessThan(
      seenEventTypes.indexOf("HitPointReduced"),
    );
    // Base damage 20 (attack 30 - defense 10) * 1.5 amplification = 30.
    // Baseline must be the healed HP (100 + 5 = 105), not the stale
    // pre-heal snapshot (100): 105 - 30 = 75.
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(75);
    const damageApplied = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageApplied")!;
    expect(damageApplied.payload).toMatchObject({ hpBefore: 105, hpAfter: 75 });
  });

  it("UT-R-BON-ATTACK-DMG-002 (ON_ATTACK_BONUS_DAMAGE_BUFF, Issue #183, mirrors SKL_ELENA_MOODMAKER_EX): a DAMAGE hit from an attacker holding an isAttackDamageBonus AppliedEffect adds the buff's magnitude on top of the calculated damage", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
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

    // Base damage 20 (attack 30 - defense 10) + bonus 6 = 26.
    expect(result.hits[0]!.damage).toBe(26);
  });

  it("UT-R-BON-ATTACK-DMG-003 (ON_ATTACK_BONUS_DAMAGE_BUFF interacts with R-DMG-02): the bonus is still capped by the target's DAMAGE_IMMUNITY, same as any other damage source", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.damage).toBe(1);
  });

  it("UT-R-BON-ATTACK-DMG-004 (bonus does not affect an evaded hit): an evaded hit does not add the attacker's isAttackDamageBonus", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
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
    expect(result.hits[0]!.damage).toBe(0);
  });
});

/**
 * G-10（`14_Catalog定義スキーマ.md`）／RES-003A（Issue #257）: `applyDamageAction`が
 * 直前結果（1解決スコープ）だけでなく、EffectSequence単位（`context.skillUseId`）の
 * 累計も同じregistryへ記録することを、実executorを通して検証する。
 */
describe("applyDamageAction EffectSequence damage sums (G-10, RES-003A Issue #257)", () => {
  function sumReferencingAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
    return {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SUM_REFERENCING"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_DEALT_RATIO", sourceResult: "SUM_DAMAGE_DEALT", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
  }

  it("UT-DAMAGE-APPLICATION-017 (G-10): two DAMAGE EffectActions of the same EffectSequence accumulate into SUM_DAMAGE_DEALT, which a later formula in that sequence reads as the total", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const first = unit("FIRST", "ENEMY", { defense: 10, maximumHp: 200 });
    const second = unit("SECOND", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    const damageResults: DamageResultRegistry = new Map();
    // 同じcontextを使い回すことで`skillUseId`（=EffectSequence解決）を共有する。
    const context = damageEventContext();

    const firstResult = applyDamageAction(
      attacker,
      [hit("FIRST", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      random,
      { ...context, damageResults },
    );
    const secondResult = applyDamageAction(
      attacker,
      [hit("SECOND", 1)],
      damageAction("PREVENTED"),
      firstResult.units,
      random,
      { ...context, damageResults },
    );
    expect(firstResult.hits[0]!.damage).toBe(20);
    expect(secondResult.hits[0]!.damage).toBe(20);
    // 直前結果は最後の1件だけ、累計はこのEffectSequenceの合計。
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(damageResults.get(attacker.battleUnitId)?.sumDamageDealt?.get(context.skillUseId)).toBe(
      40,
    );

    const referencingResult = applyDamageAction(
      attacker,
      [hit("FIRST", 1)],
      sumReferencingAction(),
      secondResult.units,
      random,
      { ...context, damageResults },
    );
    expect(referencingResult.hits[0]!.damage).toBe(40);
  });

  it("UT-DAMAGE-APPLICATION-018 (G-10): damage produced by another EffectSequence resolution in the same action (a PS chain) stays out of the acting skill's own sum", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const passiveOwner = unit("PASSIVE_OWNER", "ALLY", { attack: 500 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 2000 });
    const random = new SequenceRandomSource([]);
    // `PassiveActivationRuntime`は1行動につき1つのregistryをPS連鎖まで共有する。
    const damageResults: DamageResultRegistry = new Map();
    const skillSequence = damageEventContext();
    const passiveSequence = damageEventContext();

    const skillHit = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, passiveOwner, target],
      random,
      { ...skillSequence, damageResults },
    );
    const passiveHit = applyDamageAction(
      passiveOwner,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      skillHit.units,
      random,
      { ...passiveSequence, damageResults },
    );
    expect(skillHit.hits[0]!.damage).toBe(20);
    expect(passiveHit.hits[0]!.damage).toBe(490);

    const referencingResult = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      sumReferencingAction(),
      passiveHit.units,
      random,
      { ...skillSequence, damageResults },
    );
    // PSが与えた490は別のEffectSequence解決に属するため、20だけを参照する。
    expect(referencingResult.hits[0]!.damage).toBe(20);
  });
});

describe("applyDamageAction hit-level damage event order (DMG-001, Issue #195)", () => {
  it("UT-R-DMG-05-001 (R-DMG-05 #4, DMG-001/Issue #195): a hit records DamageWillBeApplied between CriticalCheckResolved and DamageCalculated, carrying the confirmed critical and piercing rates", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      random,
      context,
    );

    const events = context.recorder.getEvents();
    expect(
      events.map((event) => event.eventType).filter((eventType) => eventType !== "ActionStarted"),
    ).toEqual([
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageWillBeApplied",
      "DamageCalculated",
      "HitPointReduced",
      "DamageApplied",
    ]);

    const criticalCheckResolved = events.find((e) => e.eventType === "CriticalCheckResolved")!;
    const willBeApplied = events.find((e) => e.eventType === "DamageWillBeApplied")!;
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated")!;

    expect(willBeApplied.category).toBe("TIMING");
    expect(willBeApplied.parentEventId).toBe(criticalCheckResolved.eventId);
    expect(damageCalculated.parentEventId).toBe(willBeApplied.eventId);
    expect(willBeApplied.sourceUnitId).toBe(createBattleUnitId("ATTACKER"));
    expect(willBeApplied.targetUnitIds).toEqual([createBattleUnitId("TARGET")]);
    expect(willBeApplied.payload).toEqual({
      skillDefinitionId: createSkillDefinitionId("SKL_ATTACK"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
      damageType: "PHYSICAL",
      // R-CRT-02: 会心倍率は`1.5 + criticalDamageBonus(0.5)`。
      isCritical: true,
      criticalMultiplier: 2,
      defenseIgnoreRate: 0,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
    });
    // TIMINGイベントは状態変更を表さない（`08_ドメインイベント.md`「FACTイベントは、
    // 表す状態変更が確定した後に発行する」の裏返し）。
    expect(willBeApplied.stateDelta).toBeUndefined();
  });

  it("UT-R-DMG-05-002 (R-DMG-05 #4, DMG-001/Issue #195): each hit of a multi-hit DAMAGE records its own DamageWillBeApplied, in hit order", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    const hitIndexes = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "DamageWillBeApplied")
      .map((event) => (event.payload as { hitIndex: number }).hitIndex);
    expect(hitIndexes).toEqual([1, 2]);
  });

  it("UT-R-DMG-05-003 (R-DMG-05 #4 negative, DMG-001/Issue #195): an evaded hit never reaches DamageWillBeApplied", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasionEffect("E_EVADE", "TARGET", { probability: 1 })],
    };
    const random = new SequenceRandomSource([0]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(
      context.recorder.getEvents().some((event) => event.eventType === "DamageWillBeApplied"),
    ).toBe(false);
  });

  it("UT-R-DMG-05-004 (R-DMG-05 #4 + 08_ドメインイベント.md「TIMINGイベント後の再検証」, DMG-001/Issue #195): a PS reacting to DamageWillBeApplied that defeats the target cancels this hit instead of applying damage to a corpse", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = {
      ...damageEventContext(),
      onFactEventForPassiveChain: (event, units) =>
        event.eventType === "DamageWillBeApplied"
          ? units.map((u) => (u.battleUnitId === createBattleUnitId("TARGET") ? defeated(u) : u))
          : units,
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits).toEqual([
      {
        targetBattleUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: false,
        isCritical: false,
        damage: 0,
      },
    ]);
    const eventTypes = context.recorder.getEvents().map((event) => event.eventType);
    expect(eventTypes).toContain("DamageWillBeApplied");
    expect(eventTypes).not.toContain("DamageCalculated");
    expect(eventTypes).not.toContain("DamageApplied");
    // 対象は既に戦闘不能で、このヒットでHPをさらに減らしていない。
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(0);
  });

  it("UT-R-SKL-03-001 (R-SKL-03「使用者が途中で戦闘不能になった場合、残りのヒットを中断する」+ R-DMG-05 #4 再検証, DMG-001/Issue #195): a PS reacting to the first hit's DamageWillBeApplied that defeats the attacker interrupts every remaining hit", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });
    const random = new SequenceRandomSource([]);
    let seen = 0;
    const context: DamageEventContext = {
      ...damageEventContext(),
      onFactEventForPassiveChain: (event, units) => {
        if (event.eventType !== "DamageWillBeApplied") {
          return units;
        }
        seen += 1;
        return units.map((u) =>
          u.battleUnitId === createBattleUnitId("ATTACKER") ? defeated(u) : u,
        );
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(seen).toBe(1);
    expect(result.interruptedCount).toBe(3);
    expect(result.hits.every((outcome) => !outcome.applied)).toBe(true);
    expect(
      context.recorder.getEvents().some((event) => event.eventType === "DamageCalculated"),
    ).toBe(false);
  });

  it("UT-R-DMG-05-005 (R-DMG-05 #4 再検証「ダメージ無効・軽減効果」, DMG-001/Issue #195): a DAMAGE_IMMUNITY granted by a PS reacting to DamageWillBeApplied still nullifies this hit, instead of being read from a pre-TIMING snapshot", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = {
      ...damageEventContext(),
      onFactEventForPassiveChain: (event, units) =>
        event.eventType === "DamageWillBeApplied"
          ? units.map((u) =>
              u.battleUnitId === createBattleUnitId("TARGET")
                ? { ...u, appliedEffects: [immunityEffect("E_IMMUNITY", "TARGET")] }
                : u,
            )
          : units,
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    // R-DMG-02: 無効化されたダメージは1になる（20ではない）。
    expect(result.hits[0]!.damage).toBe(1);
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(99);
  });
});
