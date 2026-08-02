import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import { shieldPoolsOf } from "./shield-policy.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import {
  createBattleUnit,
  isDefeated,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
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
import type {
  Attribute,
  ConsumptionKind,
  CriticalMode,
} from "../../catalog/definitions/catalog-enums.js";
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
    categories: ["BUFF"],
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
    categories: ["BUFF"],
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
    categories: ["DEBUFF", "STATUS"],
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
    categories: ["BUFF"],
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

/**
 * R-CRT-03（DMG-003A、Issue #295）: production定義
 * （`ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE`／
 * `ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION`）と同じ形の会心状態効果。
 * どちらも保持者の攻撃側に働くため、保持者を`holderId`で明示する。
 */
function criticalStatusEffect(
  id: string,
  holderId: string,
  statusKind: "CRITICAL_GUARANTEE" | "CRITICAL_PREVENTION",
): AppliedEffect {
  return { ...evasionEffect(id, holderId, {}), statusKind, statusDetails: {} };
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
  kind: ConsumptionKind,
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
    categories: ["BUFF"],
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
    // `HitConfirmed`/`CriticalCheckResolved` (PR #283 re-review [P1]) and
    // `DamageWillBeApplied` (R-DMG-05 #4, DMG-001/Issue #195) reach the hook in
    // R-DMG-05 order, each right after it is recorded: this callback path is the
    // ONLY delivery route for them (`effect-action-group-resolver.ts` leaves
    // `innerEvents` empty whenever the callback is supplied), and the chain of
    // each may still cancel or re-shape this hit before damage is calculated.
    expect(seenEventTypes).toEqual([
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
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

  it("UT-R-CRT-03-013 (R-CRT-03 #2, DMG-003A/Issue #295): an attacker holding CRITICAL_GUARANTEE crits a NORMAL-declared attack at 0% criticalRate, and CriticalCheckResolved reports the effective GUARANTEED mode", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, criticalRate: 0, criticalDamageBonus: 0.5 }),
      appliedEffects: [criticalStatusEffect("eff-crit", "ATTACKER", "CRITICAL_GUARANTEE")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    // GUARANTEED は RandomSource を消費しない（R-CRT-01 の NORMAL 判定なら1消費する）。
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("NORMAL"),
      [attacker, target],
      random,
      context,
    );

    // 基礎20 × 会心倍率2.0（150% + 会心ダメージボーナス50%）。
    expect(result.hits[0]!.damage).toBe(40);
    random.assertFullyConsumed();
    const criticalCheckResolved = context.recorder
      .getEvents()
      .find((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalCheckResolved!.payload).toMatchObject({ mode: "GUARANTEED", result: true });
  });

  it("UT-R-CRT-03-014 (R-CRT-03 #1, DMG-003A/Issue #295): an attacker holding CRITICAL_PREVENTION never crits, even when the definition itself declares GUARANTEED", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, criticalRate: 1, criticalDamageBonus: 0.5 }),
      appliedEffects: [criticalStatusEffect("eff-crit", "ATTACKER", "CRITICAL_PREVENTION")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      random,
      context,
    );

    // 基礎20 × 会心倍率1.0（非会心）。
    expect(result.hits[0]!.damage).toBe(20);
    random.assertFullyConsumed();
    const criticalCheckResolved = context.recorder
      .getEvents()
      .find((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalCheckResolved!.payload).toMatchObject({ mode: "PREVENTED", result: false });
  });

  it("UT-R-CRT-03-015 (R-CRT-03 direction, DMG-003A/Issue #295): CRITICAL_PREVENTION held by the *defender* does not stop the attacker's critical — both critical statuses work on their holder's own attacks", () => {
    const attacker = unit("ATTACKER", "ALLY", {
      attack: 30,
      criticalRate: 1,
      criticalDamageBonus: 0.5,
    });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 }),
      appliedEffects: [criticalStatusEffect("eff-crit", "TARGET", "CRITICAL_PREVENTION")],
    };
    // 宣言は NORMAL のままなので R-CRT-01 の実効会心率100%で判定する（1消費）。
    const random = new SequenceRandomSource([0.999999]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("NORMAL"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.damage).toBe(40);
    random.assertFullyConsumed();
    const criticalCheckResolved = context.recorder
      .getEvents()
      .find((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalCheckResolved!.payload).toMatchObject({ mode: "NORMAL", result: true });
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
      // R-DMG-04（DMG-002、Issue #192）: どちらも`APPLY_DAMAGE_MOD`不在で1倍。
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 1,
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

  it("UT-R-SKL-03-002 (R-SKL-03「使用者が途中で戦闘不能になった場合、残りのヒットを中断する」+ R-DMG-05 #4 再検証, DMG-001/Issue #195): a PS reacting to the first hit's DamageWillBeApplied that defeats the attacker interrupts every remaining hit", () => {
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

describe("applyDamageAction shield absorption (DMG-004, Issue #194, R-SHD-01/02/03)", () => {
  function shieldEffect(
    id: string,
    holderId: string,
    amount: number,
    shieldType: "PHYSICAL" | "EN" | null,
  ): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetId: createBattleUnitId(holderId),
      magnitude: amount,
      categories: ["SHIELD"],
      shield: { shieldType, remaining: amount },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function shieldedTarget(
    shields: readonly AppliedEffect[],
    overrides: { defense?: number } = {},
  ): BattleUnit {
    const target = unit("TARGET", "ENEMY", { defense: overrides.defense ?? 10 });
    return { ...target, appliedEffects: shields };
  }

  it("UT-R-SHD-02-004: absorbs the hit with the matching typed shield before the untyped shield and HP", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    // finalDamage = 40 - 10 = 30
    const target = shieldedTarget([
      shieldEffect("SHIELD_TYPED", "TARGET", 20, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 5, null),
    ]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(95);
    // R-SHD-01第3項: 使い切った2インスタンスは`SHIELD_DEPLETED`で失効している。
    expect(updated.appliedEffects).toEqual([]);

    const consumed = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "ShieldConsumed");
    expect(consumed.map((event) => event.payload)).toEqual([
      expect.objectContaining({ shieldType: "PHYSICAL", before: 20, after: 0, absorbed: 20 }),
      expect.objectContaining({ shieldType: null, before: 5, after: 0, absorbed: 5 }),
    ]);

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      calculatedDamage: 30,
      hpDirectDamage: 0,
      typedShieldAbsorbed: 20,
      untypedShieldAbsorbed: 5,
      discardedDamage: 0,
      hitPointDamage: 5,
    });
  });

  it("UT-R-SHD-02-005: leaves a typed shield of a different type untouched", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    const target = shieldedTarget([shieldEffect("SHIELD_EN", "TARGET", 100, "EN")]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(70);
    expect(updated.appliedEffects[0]!.shield!.remaining).toBe(100);
    expect(context.recorder.getEvents().some((e) => e.eventType === "ShieldConsumed")).toBe(false);
  });

  it("UT-R-SHD-03-003: discards the overflow that would take HP below zero and reports it", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 210 });
    // finalDamage = 210 - 10 = 200, shield 50 -> HP damage 150, HP is 100
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 50, null)]);

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      calculatedDamage: 200,
      untypedShieldAbsorbed: 50,
      hitPointDamage: 100,
      discardedDamage: 50,
      hpAfter: 0,
      defeated: true,
    });
  });

  it("UT-R-SHD-02-006: sends the shieldIgnoreRate share straight to HP", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 50 });
    // finalDamage = 50 - 10 = 40, shieldIgnoreRate 0.5 -> 20 direct to HP
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 100, null)]);
    const action = damageAction("PREVENTED");
    const piercingAction = {
      ...action,
      payload: {
        ...action.payload,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0.5, damageReductionIgnoreRate: 0 },
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      piercingAction,
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(80);
    expect(updated.appliedEffects[0]!.shield!.remaining).toBe(80);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      hpDirectDamage: 20,
      untypedShieldAbsorbed: 20,
      hitPointDamage: 20,
    });
  });

  it("UT-R-DMG-03-024 (TEMP_PIERCING_GRANT, DMG-003/Issue #196, PR #296 review [P1]): an APPLY_PIERCING_MOD the attacker holds reaches the confirmed calculation, not only the DamageWillBeApplied snapshot", () => {
    const context = damageEventContext();
    // 一時貫通の保持者。定義自身の`payload.piercing`はすべて0のため、実効防御が
    // 下がったならそれは合成された一時貫通が確定計算まで届いた証拠にしかならない。
    const grantId = createEffectActionDefinitionId("ACT_TEMP_PIERCE");
    const bareAttacker = unit("ATTACKER", "ALLY", { attack: 200 });
    const attacker: BattleUnit = {
      ...bareAttacker,
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("TEMP_PIERCE"),
          effectActionDefinitionId: grantId,
          kindKey: effectKindKeyFromDefinitionId(grantId),
          duplicate: true,
          targetId: bareAttacker.battleUnitId,
          magnitude: 0,
          categories: ["BUFF"],
          piercing: {
            defenseIgnoreRate: 0.5,
            shieldIgnoreRate: 0,
            damageReductionIgnoreRate: 0,
          },
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        },
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 100 });

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // R-DMG-05の順序どおり `DamageWillBeApplied`（snapshot）→ `DamageCalculated`
    // （確定値）。両方が合成後の率を持つことを要求する — 前者だけに現れて
    // 実計算が静的値のまま、というのがレビューで指摘された不具合の形である。
    const willBeApplied = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageWillBeApplied")!;
    expect(willBeApplied.payload).toMatchObject({ defenseIgnoreRate: 0.5 });
    const calculated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      defenseIgnoreRate: 0.5,
      defenderDefense: 100,
      effectiveDefense: 50,
    });
  });

  it("UT-R-SHD-01-005: expires a shield instance whose remaining amount reaches zero", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 10, null)]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // `context.expireDepletedShields`未注入のfallbackでも、枯渇したインスタンスは除去される。
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.appliedEffects).toEqual([]);
    const expired = context.recorder.getEvents().find((e) => e.eventType === "EffectExpired")!;
    expect(expired.payload).toMatchObject({
      effectInstanceId: createEffectInstanceId("SHIELD_UNTYPED"),
      reason: "SHIELD_DEPLETED",
    });
  });

  it("UT-R-SKL-03-003 (R-SKL-03「ヒットごとに命中判定・会心判定・シールド・HP適用を解決する」): each hit of a multi-hit action resolves shield absorption on its own, draining the pool progressively", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    // finalDamage = 30 - 10 = 20 per hit, shield 50 -> 20 / 20 / 10 absorbed.
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 50, null)]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.hits.map((outcome) => outcome.applied)).toEqual([true, true, true]);
    const consumed = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "ShieldConsumed");
    expect(consumed.map((event) => (event.payload as { absorbed: number }).absorbed)).toEqual([
      20, 20, 10,
    ]);
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    // 3ヒット目でシールドを使い切り、超過分の10だけがHPへ通る。
    expect(updated.currentHp).toBe(90);
    expect(updated.appliedEffects).toEqual([]);
  });

  it("UT-R-SHD-02-007 (PRレビュー[P1]): resolves each pool completely (ShieldConsumed -> chain -> depletion expiry) before touching the next pool or HP", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    // finalDamage = 60 - 10 = 50。typed 20 → untyped 20 → HP 10。
    const target = shieldedTarget([
      shieldEffect("SHIELD_TYPED", "TARGET", 20, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 20, null),
    ]);

    // 各FACT通知の時点で観測できる対象の状態を記録する。
    const observed: {
      readonly event: string;
      readonly shieldType?: unknown;
      readonly pools: { physical: number; energy: number; untyped: number };
      readonly hp: number;
    }[] = [];
    const contextWithHook: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        const current = units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
        observed.push({
          event: event.eventType,
          ...(event.eventType === "ShieldConsumed"
            ? { shieldType: (event.payload as { shieldType: unknown }).shieldType }
            : {}),
          pools: shieldPoolsOf(current.appliedEffects),
          hp: current.currentHp,
        });
        return units;
      },
    };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      contextWithHook,
    );

    const shieldEvents = observed.filter((entry) => entry.event === "ShieldConsumed");
    expect(shieldEvents.map((entry) => entry.shieldType)).toEqual(["PHYSICAL", null]);
    // タイプありプールの`ShieldConsumed`時点では、タイプなしプールもHPもまだ手つかず。
    expect(shieldEvents[0]).toMatchObject({
      pools: { physical: 0, energy: 0, untyped: 20 },
      hp: 100,
    });
    // タイプなしプールの`ShieldConsumed`時点でもHPはまだ手つかず。
    expect(shieldEvents[1]).toMatchObject({
      pools: { physical: 0, energy: 0, untyped: 0 },
      hp: 100,
    });

    // 枯渇インスタンスの`EffectExpired`は、`DamageApplied`より前に届く —
    // `DamageApplied`に反応するPSが残量0のシールドを有効として観測しないため。
    const order = observed.map((entry) => entry.event);
    const lastExpired = order.lastIndexOf("EffectExpired");
    expect(lastExpired).toBeGreaterThanOrEqual(0);
    expect(lastExpired).toBeLessThan(order.indexOf("HitPointReduced"));
    expect(order.indexOf("HitPointReduced")).toBeLessThan(order.indexOf("DamageApplied"));
    // `DamageApplied`の時点では、枯渇した2インスタンスが既に除去されている。
    const atDamageApplied = observed.find((entry) => entry.event === "DamageApplied")!;
    expect(atDamageApplied.pools).toEqual({ physical: 0, energy: 0, untyped: 0 });
  });

  it("UT-R-SHD-01-013 (PRレビュー[P1]): ShieldConsumed reports the whole pool total, not just the instances this hit touched", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 15 });
    // finalDamage = 15 - 10 = 5。タイプなしプールは 10 + 50 = 60 のうち5だけ減る。
    const target = shieldedTarget([
      shieldEffect("SHIELD_A", "TARGET", 10, null),
      shieldEffect("SHIELD_B", "TARGET", 50, null),
    ]);

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const consumed = context.recorder.getEvents().find((e) => e.eventType === "ShieldConsumed")!;
    expect(consumed.payload).toMatchObject({
      shieldType: null,
      before: 60,
      after: 55,
      absorbed: 5,
    });
  });

  it("UT-R-SHD-01-006: keeps events and state unchanged for a target that holds no shield", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    const target = unit("TARGET", "ENEMY");

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(context.recorder.getEvents().some((e) => e.eventType === "ShieldConsumed")).toBe(false);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      hitPointDamage: 30,
      discardedDamage: 0,
    });
  });
});

/**
 * R-SHD-03の保存則（`12_テスト戦略.md`「SHD: Unit／Property」）。任意のダメージ・
 * `shieldIgnoreRate`・複数のタイプあり／なしプール・HPについて、適用先ごとの内訳が
 * 計算ダメージを過不足なく説明することを確かめる（`08_ドメインイベント.md`の
 * 不変条件#6）。`DamageApplied`のpayloadを正本にするのは、これが外部公開契約
 * そのものであり、内部の中間値ではないためである。
 */
describe("shield absorption conservation properties (R-SHD-03)", () => {
  const shieldArb = fc.record({
    amount: fc.integer({ min: 1, max: 200 }),
    shieldType: fc.constantFrom("PHYSICAL" as const, "EN" as const, null),
  });

  it("PROP-SHD-03-001: typedShieldAbsorbed + untypedShieldAbsorbed + hitPointDamage + discardedDamage === calculatedDamage", () => {
    fc.assert(
      fc.property(
        fc.record({
          attack: fc.integer({ min: 11, max: 400 }),
          maximumHp: fc.integer({ min: 1, max: 300 }),
          shieldIgnoreRate: fc.constantFrom(0, 0.25, 0.3, 0.5, 0.75, 1),
          damageType: fc.constantFrom("PHYSICAL" as const, "EN" as const),
          shields: fc.array(shieldArb, { minLength: 0, maxLength: 5 }),
        }),
        (scenario) => {
          const context = damageEventContext();
          const attacker = unit("ATTACKER", "ALLY", { attack: scenario.attack });
          const base = unit("TARGET", "ENEMY", {
            defense: 10,
            maximumHp: scenario.maximumHp,
          });
          const target: BattleUnit = {
            ...base,
            appliedEffects: scenario.shields.map((shield, index) => {
              const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${index}`);
              return {
                effectInstanceId: createEffectInstanceId(`SHIELD_${index}`),
                effectActionDefinitionId: definitionId,
                kindKey: effectKindKeyFromDefinitionId(definitionId),
                duplicate: true,
                targetId: createBattleUnitId("TARGET"),
                magnitude: shield.amount,
                categories: ["SHIELD"],
                shield: { shieldType: shield.shieldType, remaining: shield.amount },
                duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
                appliedTurnNumber: 1,
              } satisfies AppliedEffect;
            }),
          };
          const action = damageAction("PREVENTED");
          const piercingAction = {
            ...action,
            payload: {
              ...action.payload,
              damageType: scenario.damageType,
              piercing: {
                defenseIgnoreRate: 0,
                shieldIgnoreRate: scenario.shieldIgnoreRate,
                damageReductionIgnoreRate: 0,
              },
            },
          };

          applyDamageAction(
            attacker,
            [hit("TARGET", 1)],
            piercingAction,
            [attacker, target],
            new SequenceRandomSource([]),
            context,
          );

          const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied");
          if (applied === undefined) {
            return false;
          }
          const d = applied.payload as unknown as Record<string, number>;
          return (
            d["typedShieldAbsorbed"]! +
              d["untypedShieldAbsorbed"]! +
              d["hitPointDamage"]! +
              d["discardedDamage"]! ===
              d["calculatedDamage"] &&
            // 各項は非負であり、HPは0未満にならない（R-SHD-03第2項）。
            d["typedShieldAbsorbed"]! >= 0 &&
            d["untypedShieldAbsorbed"]! >= 0 &&
            d["hitPointDamage"]! >= 0 &&
            d["discardedDamage"]! >= 0 &&
            d["hpAfter"]! >= 0 &&
            // `hpDirectDamage`は`hitPointDamage`の内訳ではあるが、HPが尽きた場合は
            // 破棄分に飲まれるため上限だけを課す。
            d["hpDirectDamage"]! <= d["calculatedDamage"]
          );
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-SHD-03-002: the shields absorb exactly min(pool total, damage - shieldIgnoreRate share) for the matching pools", () => {
    fc.assert(
      fc.property(
        fc.record({
          attack: fc.integer({ min: 11, max: 400 }),
          shieldIgnoreRate: fc.constantFrom(0, 0.25, 0.5, 1),
          damageType: fc.constantFrom("PHYSICAL" as const, "EN" as const),
          typedAmount: fc.integer({ min: 0, max: 200 }),
          untypedAmount: fc.integer({ min: 0, max: 200 }),
          offTypeAmount: fc.integer({ min: 0, max: 200 }),
        }),
        (scenario) => {
          const context = damageEventContext();
          const attacker = unit("ATTACKER", "ALLY", { attack: scenario.attack });
          const offType = scenario.damageType === "PHYSICAL" ? "EN" : "PHYSICAL";
          const pools: readonly { amount: number; shieldType: "PHYSICAL" | "EN" | null }[] = [
            { amount: scenario.typedAmount, shieldType: scenario.damageType },
            { amount: scenario.untypedAmount, shieldType: null },
            { amount: scenario.offTypeAmount, shieldType: offType },
          ];
          const base = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 10000 });
          const target: BattleUnit = {
            ...base,
            appliedEffects: pools
              .filter((pool) => pool.amount > 0)
              .map((pool, index) => {
                const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${index}`);
                return {
                  effectInstanceId: createEffectInstanceId(`SHIELD_${index}`),
                  effectActionDefinitionId: definitionId,
                  kindKey: effectKindKeyFromDefinitionId(definitionId),
                  duplicate: true,
                  targetId: createBattleUnitId("TARGET"),
                  magnitude: pool.amount,
                  categories: ["SHIELD"],
                  shield: { shieldType: pool.shieldType, remaining: pool.amount },
                  duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
                  appliedTurnNumber: 1,
                } satisfies AppliedEffect;
              }),
          };
          const action = damageAction("PREVENTED");
          const piercingAction = {
            ...action,
            payload: {
              ...action.payload,
              damageType: scenario.damageType,
              piercing: {
                defenseIgnoreRate: 0,
                shieldIgnoreRate: scenario.shieldIgnoreRate,
                damageReductionIgnoreRate: 0,
              },
            },
          };

          const result = applyDamageAction(
            attacker,
            [hit("TARGET", 1)],
            piercingAction,
            [attacker, target],
            new SequenceRandomSource([]),
            context,
          );

          const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied");
          if (applied === undefined) {
            return false;
          }
          const d = applied.payload as unknown as Record<string, number>;
          const finalDamage = d["calculatedDamage"]!;
          const bypassed = Math.trunc(finalDamage * scenario.shieldIgnoreRate);
          const expectedTyped = Math.min(scenario.typedAmount, finalDamage - bypassed);
          const expectedUntyped = Math.min(
            scenario.untypedAmount,
            finalDamage - bypassed - expectedTyped,
          );
          const updated = result.units.find(
            (u) => u.battleUnitId === createBattleUnitId("TARGET"),
          )!;
          return (
            d["hpDirectDamage"] === bypassed &&
            d["typedShieldAbsorbed"] === expectedTyped &&
            d["untypedShieldAbsorbed"] === expectedUntyped &&
            // R-SHD-02末尾: 対応しないタイプありシールドは常に無傷。
            (scenario.damageType === "PHYSICAL"
              ? shieldPoolsOf(updated.appliedEffects).energy
              : shieldPoolsOf(updated.appliedEffects).physical) === scenario.offTypeAmount
          );
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});

/**
 * R-SUB-01/R-SUB-02（DMG-005、Issue #190）: サブユニットの吸収と追加ダメージを、
 * `applyDamageAction`のヒット処理を通して固定する。シールドと同じ入力・同じ
 * 事前条件（`damageEventContext`はhookを注入しないため、失効はfallback経路を通る）。
 */
describe("applyDamageAction sub-units (R-SUB-01/R-SUB-02)", () => {
  const ADDITIONAL_DAMAGE = {
    formula: {
      kind: "SUBUNIT_ADDITIONAL_DAMAGE",
      ownerAttack: "CURRENT_ATTACK",
      providerAttack: "SOURCE_SNAPSHOT_ATTACK",
      skillMultiplier: 0.5,
      targetDefense: "TARGET_CURRENT_DEFENSE",
    },
  } as const;

  function subUnitEffect(
    id: string,
    holderId: string,
    durability: number,
    overrides: {
      readonly providerAttack?: number;
      readonly damageType?: "PHYSICAL" | "EN";
      readonly debuffId?: string;
    } = {},
  ): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SUBUNIT_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetId: createBattleUnitId(holderId),
      magnitude: durability,
      categories: ["SUBUNIT"],
      subUnit: {
        durability,
        additionalDamage: {
          ...ADDITIONAL_DAMAGE,
          ...(overrides.damageType !== undefined ? { damageType: overrides.damageType } : {}),
          ...(overrides.debuffId !== undefined
            ? {
                debuff: {
                  effectActionDefinitionId: createEffectActionDefinitionId(overrides.debuffId),
                },
              }
            : {}),
        },
      },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: overrides.providerAttack ?? 0 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function shieldEffect(
    id: string,
    holderId: string,
    amount: number,
    shieldType: "PHYSICAL" | "EN" | null,
  ): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetId: createBattleUnitId(holderId),
      magnitude: amount,
      categories: ["SHIELD"],
      shield: { shieldType, remaining: amount },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function targetWith(effects: readonly AppliedEffect[], id = "TARGET"): BattleUnit {
    const target = unit(id, "ENEMY", { defense: 10 });
    return { ...target, appliedEffects: effects };
  }

  it("UT-R-SUB-01-008 (R-SUB-01第1項): applies damage to the subunit only after every normal shield is spent", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    // finalDamage = 60 - 10 = 50。タイプあり20 → タイプなし5 → サブユニット10 → HP15。
    const target = targetWith([
      shieldEffect("SHIELD_TYPED", "TARGET", 20, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 5, null),
      subUnitEffect("SUB_1", "TARGET", 10),
    ]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(85);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      typedShieldAbsorbed: 20,
      untypedShieldAbsorbed: 5,
      subUnitAbsorbed: 10,
      hitPointDamage: 15,
      discardedDamage: 0,
      calculatedDamage: 50,
    });
    // 吸収は`ShieldConsumed`（プール単位）→`SubUnitDamaged`（インスタンス単位）の順。
    const order = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "ShieldConsumed" || e.eventType === "SubUnitDamaged")
      .map((e) => e.eventType);
    expect(order).toEqual(["ShieldConsumed", "ShieldConsumed", "SubUnitDamaged"]);
  });

  it("UT-R-SUB-01-009 (R-SUB-01): reduces one subunit instance at a time in grant order, emitting SubUnitDamaged per instance", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    // finalDamage = 50。SUB_1(10) → SUB_2(15) → HP25。
    const target = targetWith([
      subUnitEffect("SUB_1", "TARGET", 10),
      subUnitEffect("SUB_2", "TARGET", 15),
    ]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const damaged = context.recorder.getEvents().filter((e) => e.eventType === "SubUnitDamaged");
    expect(
      damaged.map((e) => e.payload as { effectInstanceId: string; absorbed: number }),
    ).toMatchObject([
      { effectInstanceId: createEffectInstanceId("SUB_1"), absorbed: 10 },
      { effectInstanceId: createEffectInstanceId("SUB_2"), absorbed: 15 },
    ]);
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(75);
    // 両方とも耐久力を使い切ったので`SUBUNIT_DEPLETED`で失効している。
    expect(updated.appliedEffects).toEqual([]);
    const expired = context.recorder.getEvents().filter((e) => e.eventType === "EffectExpired");
    expect(expired.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      "SUBUNIT_DEPLETED",
      "SUBUNIT_DEPLETED",
    ]);
  });

  it("UT-R-SUB-01-010 (R-SUB-01「シールド無視の対象とする」): shieldIgnoreRate bypasses the subunit as well as the shields", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 50 });
    // finalDamage = 40。shieldIgnoreRate 0.5 → 20はHPへ直行、残り20をサブユニットが吸収。
    const target = targetWith([subUnitEffect("SUB_1", "TARGET", 100)]);
    const action = damageAction("PREVENTED");
    const piercingAction = {
      ...action,
      payload: {
        ...action.payload,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0.5, damageReductionIgnoreRate: 0 },
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      piercingAction,
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(80);
    expect(updated.appliedEffects[0]!.subUnit!.durability).toBe(80);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      hpDirectDamage: 20,
      subUnitAbsorbed: 20,
      hitPointDamage: 20,
    });
  });

  it("UT-R-SUB-02-005 (R-SUB-02第1項): adds exactly one additional-damage hit per attacked target, not per hit", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnit: BattleUnit = {
      ...attacker,
      appliedEffects: [subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 100 })],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    const additional = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageApplied" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1"),
      );
    // 3ヒットの単体攻撃でも追加ダメージは1回だけ。
    expect(additional).toHaveLength(1);
    // R-SUB-02: 所持者の現在攻撃力30 + 付与者の付与時攻撃力100 × 0.5 - 対象の防御力10 = 70。
    expect(additional[0]!.payload).toMatchObject({ calculatedDamage: 70, hitPointDamage: 70 });
  });

  it("UT-R-SUB-02-006 (R-SUB-02第2項): adds one additional-damage hit to each target of a multi-target attack, once per held subunit", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnits: BattleUnit = {
      ...attacker,
      appliedEffects: [
        subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 100 }),
        subUnitEffect("SUB_2", "ATTACKER", 50, { providerAttack: 100 }),
      ],
    };
    const targetA = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const targetB = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnits,
      [hit("TARGET", 1), hit("TARGET_2", 2)],
      damageAction("PREVENTED"),
      [attackerWithSubUnits, targetA, targetB],
      new SequenceRandomSource([]),
      context,
    );

    const additional = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageApplied" &&
          String(
            (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId,
          ).startsWith("ACT_SUBUNIT_"),
      );
    // 対象2体 × サブユニット2体 = 4ヒット。対象ごとにまとまり、`hitIndex`は通し番号。
    expect(
      additional.map((event) => ({
        target: (event.payload as { targetUnitId: string }).targetUnitId,
        hitIndex: (event.payload as { hitIndex: number }).hitIndex,
      })),
    ).toEqual([
      { target: createBattleUnitId("TARGET"), hitIndex: 0 },
      { target: createBattleUnitId("TARGET"), hitIndex: 1 },
      { target: createBattleUnitId("TARGET_2"), hitIndex: 2 },
      { target: createBattleUnitId("TARGET_2"), hitIndex: 3 },
    ]);
  });

  it("UT-R-SUB-02-007 (R-SUB-02末尾): the additional damage skips the normal defense attenuation and keeps the minimum of 1", () => {
    const context = damageEventContext();
    // 所持者の攻撃力10 + 付与者0 × 0.5 - 対象の防御力1000 は負値 → 最低1ダメージ。
    const attacker = unit("ATTACKER", "ALLY", { attack: 10 });
    const attackerWithSubUnit: BattleUnit = {
      ...attacker,
      appliedEffects: [subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 0 })],
    };
    const target = unit("TARGET", "ENEMY", { defense: 1000, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    const calculated = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1"),
      );
    expect(calculated).toHaveLength(1);
    expect(calculated[0]!.payload).toMatchObject({
      // 防御力減衰（実効防御）を経ず、対象の現在防御力をそのまま引く。
      effectiveDefense: 1000,
      defenseIgnoreRate: 0,
      attributeMultiplier: 1,
      criticalMultiplier: 1,
      finalDamage: 1,
    });
  });

  it("UT-R-SUB-02-008 (R-SUB-02第3項): applies the accompanying debuff through the injected hook, once per additional-damage hit", () => {
    const granted: { targetUnitId: string; debuffId: string; ownerUnitId: string }[] = [];
    const context: DamageEventContext = {
      ...damageEventContext(),
      grantSubUnitAdditionalDamageDebuff: function* (
        targetUnitId,
        debuffEffectActionDefinitionId,
        ownerUnitId,
        units,
        parentEventId,
      ) {
        granted.push({
          targetUnitId,
          debuffId: debuffEffectActionDefinitionId,
          ownerUnitId,
        });
        // production hook（`grantSubUnitAdditionalDamageDebuffSteps`）と同じく、
        // 付与を1ステップとして`yield`し、driverが更新した`units`を返す。
        const injected = yield { events: [], units };
        return { units: injected ?? units, lastEventId: parentEventId };
      },
    };
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnit: BattleUnit = {
      ...attacker,
      appliedEffects: [
        subUnitEffect("SUB_1", "ATTACKER", 50, {
          providerAttack: 100,
          debuffId: "ACT_SPEED_DOWN",
        }),
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(granted).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET"),
        debuffId: createEffectActionDefinitionId("ACT_SPEED_DOWN"),
        ownerUnitId: createBattleUnitId("ATTACKER"),
      },
    ]);
  });

  it("UT-R-SUB-02-009 (R-SKL-01/R-SKL-03): skips the additional damage entirely when the attacker was defeated mid-attack", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const defeatedAttacker: BattleUnit = {
      ...attacker,
      currentHp: createHitPoint(0, attacker.combatStats.maximumHp),
      appliedEffects: [subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 100 })],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    const result = applyDamageAction(
      defeatedAttacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [defeatedAttacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.interruptedCount).toBe(1);
    expect(context.recorder.getEvents().filter((e) => e.eventType === "DamageApplied")).toEqual([]);
  });
});

/**
 * PR #289レビュー[P1][P2]（DMG-005、Issue #190）: サブユニット追加ダメージが
 * R-SUB-02・raw原文（`戦闘システム.md`「サブユニットが攻撃に対して追加するダメージは
 * １ヒットとして扱われます」）どおり**1ヒット**として観測されること、および吸収の
 * 途中でPS/Memory連鎖が前提を崩した場合にR-SKL-01/R-SKL-03の中断契約が働くことを固定する。
 */
describe("sub-unit additional damage is a real hit (R-SUB-02 / R-SKL-03, PR #289 review)", () => {
  const ADDITIONAL_DAMAGE = {
    formula: {
      kind: "SUBUNIT_ADDITIONAL_DAMAGE",
      ownerAttack: "CURRENT_ATTACK",
      providerAttack: "SOURCE_SNAPSHOT_ATTACK",
      skillMultiplier: 0.5,
      targetDefense: "TARGET_CURRENT_DEFENSE",
    },
  } as const;

  const SUBUNIT_DEFINITION_ID = createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1");

  function subUnitEffect(holderId: string, durability = 50, providerAttack = 100): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId("SUB_1"),
      effectActionDefinitionId: SUBUNIT_DEFINITION_ID,
      kindKey: effectKindKeyFromDefinitionId(SUBUNIT_DEFINITION_ID),
      duplicate: true,
      targetId: createBattleUnitId(holderId),
      magnitude: durability,
      categories: ["SUBUNIT"],
      subUnit: { durability, additionalDamage: ADDITIONAL_DAMAGE },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: providerAttack },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function attackerHoldingSubUnit(extra: readonly AppliedEffect[] = []): BattleUnit {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    return { ...attacker, appliedEffects: [subUnitEffect("ATTACKER"), ...extra] };
  }

  /**
   * サブユニット追加ヒットが発行したイベントだけを、発生順の種別列として取り出す。
   * `CriticalCheckResolved`のpayloadは`effectActionDefinitionId`を持たない
   * （`08_ドメインイベント.md`「会心判定イベント」）ため、直前の`HitConfirmed`が
   * 追加ヒットのものだった場合に追加ヒット側として数える。
   */
  function additionalHitEventTypes(context: DamageEventContext): readonly string[] {
    const types: string[] = [];
    let lastWasAdditionalHitConfirmed = false;
    for (const event of context.recorder.getEvents()) {
      const payload = event.payload as { effectActionDefinitionId?: string };
      const isAdditional = payload.effectActionDefinitionId === SUBUNIT_DEFINITION_ID;
      if (event.eventType === "CriticalCheckResolved") {
        if (lastWasAdditionalHitConfirmed) {
          types.push(event.eventType);
        }
        continue;
      }
      if (isAdditional) {
        types.push(event.eventType);
      }
      lastWasAdditionalHitConfirmed = isAdditional && event.eventType === "HitConfirmed";
    }
    return types;
  }

  it("UT-R-SUB-02-010 (R-SKL-03): the additional damage emits the same hit observation events as any other hit", () => {
    const context = damageEventContext();
    const attacker = attackerHoldingSubUnit();
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(additionalHitEventTypes(context)).toEqual([
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageWillBeApplied",
      "DamageCalculated",
      "HitPointReduced",
      "DamageApplied",
    ]);
  });

  it("UT-R-SUB-02-011 (R-EFF-07): the additional hit consumes OUTGOING_HIT on the owner and INCOMING_HIT on the target", () => {
    const recorderContext = damageEventContext();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [STAT_MOD_DEFINITION_ID, statModDefinition()],
    ]);
    const withHooks: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(recorderContext.recorder, effectActions),
    };

    const outgoing = consumptionEffect(
      "eff-outgoing",
      createBattleUnitId("ATTACKER"),
      "OUTGOING_HIT",
      2,
    );
    const attacker = attackerHoldingSubUnit([outgoing]);
    const incoming = consumptionEffect(
      "eff-incoming",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [incoming] };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      withHooks,
    );

    // 通常ヒット1回＋追加ダメージ1ヒット＝どちらの消費条件も2回消費して0になる。
    const updatedAttacker = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("ATTACKER"),
    )!;
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(
      updatedAttacker.appliedEffects.find((e) => e.effectInstanceId === outgoing.effectInstanceId),
    ).toBeUndefined();
    expect(
      updatedTarget.appliedEffects.find((e) => e.effectInstanceId === incoming.effectInstanceId),
    ).toBeUndefined();
  });

  it("UT-R-SUB-02-012 (R-HIT-04): an N-hit evasion can evade the additional hit, consuming only the evading instance", () => {
    const recorderContext = damageEventContext();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [STAT_MOD_DEFINITION_ID, statModDefinition()],
    ]);
    const context: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(recorderContext.recorder, effectActions),
    };
    const attacker = attackerHoldingSubUnit();
    // 残り1回のNヒット回避: 通常ヒットで使い切り、追加ヒットは命中する。
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [evasion] };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 通常ヒットが回避され、追加ヒットは（回避を使い切ったので）命中する。
    const evaded = context.recorder.getEvents().filter((e) => e.eventType === "EvasionActivated");
    expect(evaded).toHaveLength(1);
    expect(additionalHitEventTypes(context)).toContain("HitConfirmed");
    expect(additionalHitEventTypes(context)).toContain("DamageApplied");
  });

  it("UT-R-SUB-02-013 (R-HIT-04): the additional hit itself is evadable, producing no additional damage", () => {
    const recorderContext = damageEventContext();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [STAT_MOD_DEFINITION_ID, statModDefinition()],
    ]);
    const context: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(recorderContext.recorder, effectActions),
    };
    const attacker = attackerHoldingSubUnit();
    // 残り2回: 通常ヒットと追加ヒットの両方を回避する。
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 2);
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [evasion] };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "EvasionActivated"),
    ).toHaveLength(2);
    expect(additionalHitEventTypes(context)).toEqual(["UnitBeingAttacked"]);
    // 追加ダメージが回避されたので対象のHPは無傷。
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(1000);
  });

  it("UT-R-SUB-02-014 (R-DMG-04, PR #289再レビュー[P2]): the additional damage applies the same damage modifiers it advertises in DamageWillBeApplied", () => {
    const context = damageEventContext();
    const attacker = attackerHoldingSubUnit();
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    // 被ダメージ-50%のデバフ（R-DMG-04、`direction: INCOMING`）を対象へ持たせる。
    const incomingHalf: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("DMG_MOD"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_DMG_MOD"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_DMG_MOD")),
      duplicate: true,
      targetId: createBattleUnitId("TARGET"),
      magnitude: -0.5,
      categories: ["DAMAGE_MOD"],
      damageModifier: { direction: "INCOMING", damageType: null },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const target: BattleUnit = { ...baseTarget, appliedEffects: [incomingHalf] };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const additionalCalculated = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            SUBUNIT_DEFINITION_ID,
      );
    expect(additionalCalculated).toHaveLength(1);
    // 所持者30 + 付与者100×0.5 - 防御10 = 70、被ダメージ-50%で 35。
    expect(additionalCalculated[0]!.payload).toMatchObject({
      skillPower: 70,
      incomingDamageMultiplier: 0.5,
      outgoingDamageMultiplier: 1,
      preTruncationDamage: 35,
      finalDamage: 35,
    });

    // 公開イベントの整合: `DamageWillBeApplied`のsnapshotと確定値が一致する。
    const additionalWillBeApplied = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageWillBeApplied" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            SUBUNIT_DEFINITION_ID,
      );
    expect(additionalWillBeApplied[0]!.payload).toMatchObject({
      incomingDamageMultiplier: 0.5,
      outgoingDamageMultiplier: 1,
    });
  });

  it("UT-R-SUB-02-015 (R-ACTN-01 #2, PR #289再レビュー[P2]): no accompanying debuff is granted when the additional damage defeats the target", () => {
    const granted: string[] = [];
    const base = damageEventContext();
    const context: DamageEventContext = {
      ...base,
      grantSubUnitAdditionalDamageDebuff: function* (
        targetUnitId,
        debuffEffectActionDefinitionId,
        _ownerUnitId,
        units,
        parentEventId,
      ) {
        granted.push(`${targetUnitId}:${debuffEffectActionDefinitionId}`);
        const injected = yield { events: [], units };
        return { units: injected ?? units, lastEventId: parentEventId };
      },
    };
    const withDebuff: AppliedEffect = {
      ...subUnitEffect("ATTACKER"),
      subUnit: {
        durability: 50,
        additionalDamage: {
          ...ADDITIONAL_DAMAGE,
          debuff: { effectActionDefinitionId: createEffectActionDefinitionId("ACT_SPEED_DOWN") },
        },
      },
    };
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnit: BattleUnit = { ...attacker, appliedEffects: [withDebuff] };
    // 通常ヒット(20)では死なず、追加ダメージ(70)で戦闘不能になるHPにする。
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 50 });
    const target: BattleUnit = {
      ...baseTarget,
      currentHp: createHitPoint(50, baseTarget.combatStats.maximumHp),
    };

    const result = applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
    // 追加ダメージ自身が対象を倒したので、付随デバフは付与しない。
    expect(granted).toEqual([]);
  });

  it("UT-R-SUB-01-011 (R-SKL-01/R-SKL-03, PR #289レビュー[P2]): a SubUnitDamaged chain that defeats the attacker stops the remaining absorption", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 200, maximumHp: 100 });
    const first = {
      ...subUnitEffect("TARGET", 10),
      effectInstanceId: createEffectInstanceId("SUB_A"),
    };
    const second = {
      ...subUnitEffect("TARGET", 10),
      effectInstanceId: createEffectInstanceId("SUB_B"),
    };
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [first, second] };

    // 最初の`SubUnitDamaged`に反応したPS連鎖が攻撃者を戦闘不能にする。
    let defeatedAttacker = false;
    const withChain: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        if (event.eventType !== "SubUnitDamaged" || defeatedAttacker) {
          return units;
        }
        defeatedAttacker = true;
        return units.map((u) =>
          u.battleUnitId === createBattleUnitId("ATTACKER")
            ? { ...u, currentHp: createHitPoint(0, u.combatStats.maximumHp) }
            : u,
        );
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      withChain,
    );

    // 1体目だけが削られ、2体目は手つかずのまま残る。
    const damaged = context.recorder.getEvents().filter((e) => e.eventType === "SubUnitDamaged");
    expect(damaged).toHaveLength(1);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(
      updatedTarget.appliedEffects.find(
        (e) => e.effectInstanceId === createEffectInstanceId("SUB_B"),
      )?.subUnit?.durability,
    ).toBe(10);
    // PR #289再レビュー[P2]: 使用者が戦闘不能になった時点で「未解決効果を中断する」
    // （R-SKL-01）。解決済みの吸収（1体目の`SubUnitDamaged`）だけが残り、HP適用と
    // `HitPointReduced`以降のイベントは発行されない。
    expect(context.recorder.getEvents().filter((e) => e.eventType === "HitPointReduced")).toEqual(
      [],
    );
    expect(context.recorder.getEvents().filter((e) => e.eventType === "DamageApplied")).toEqual([]);
    expect(updatedTarget.currentHp).toBe(1000);
    expect(result.interruptedCount).toBe(1);
    expect(result.hits.map((outcome) => outcome.applied)).toEqual([false]);
  });
});

/**
 * DMG-006（Issue #188、R-INT-01〜03）: 防御介入を実際のダメージpipelineへ配線した
 * 部分の検証。選択規則そのものは`defensive-intervention-policy.test.ts`が担う。
 */
function interventionEffect(
  id: string,
  holderId: string,
  extra: Partial<AppliedEffect>,
): AppliedEffect {
  const definitionId = createEffectActionDefinitionId(`ACT_${id}`);
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceId: createBattleUnitId(holderId),
    targetId: createBattleUnitId(holderId),
    magnitude: 0,
    categories: ["DEBUFF"],
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
    ...extra,
  };
}

function redirectHeldByAttacker(id: string, attackerId: string, redirectTo: string): AppliedEffect {
  return interventionEffect(id, attackerId, {
    targetRedirect: {
      redirectToUnitId: createBattleUnitId(redirectTo),
      actionKinds: ["DAMAGE"],
    },
  });
}

function coverHeldByAttacker(
  id: string,
  attackerId: string,
  coverer: string,
  guardRate = 0,
): AppliedEffect {
  return interventionEffect(id, attackerId, {
    cover: {
      covererUnitId: createBattleUnitId(coverer),
      damageShareRate: 1,
      guardRate,
      actionKinds: ["DAMAGE"],
    },
  });
}

function reflectHeldByDefender(id: string, defenderId: string, ratio: number): AppliedEffect {
  return interventionEffect(id, defenderId, {
    categories: ["BUFF"],
    reflect: {
      formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio },
      allowRecursiveReflect: false,
    },
  });
}

function damageLinkHeldByDamaged(
  id: string,
  damagedId: string,
  linkToUnitId: string,
  linkRate = 0.5,
): AppliedEffect {
  return interventionEffect(id, damagedId, {
    damageLink: { linkToUnitId: createBattleUnitId(linkToUnitId), linkRate },
  });
}

function deathSurvivalHeldByTarget(
  id: string,
  targetId: string,
  consumptionRemaining: number,
  survivalHp = 1,
): AppliedEffect {
  return interventionEffect(id, targetId, {
    categories: ["BUFF"],
    deathSurvival: {
      survivalHp: { kind: "CONSTANT", value: survivalHp },
      healAfterSurvival: null,
    },
    duration: {
      definition: {
        consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      consumptionRemaining,
    },
  });
}

describe("defensive interventions in the damage pipeline (DMG-006, Issue #188, R-INT-01〜03)", () => {
  it("UT-R-INT-01-010: a redirect the attacker holds moves the whole hit onto the taunting unit and emits DamageRedirected before DamageCalculated", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [redirectHeldByAttacker("REDIRECT", "ATTACKER", "TAUNTER")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const taunter = unit("TAUNTER", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, taunter],
      new SequenceRandomSource([]),
      context,
    );

    const events = context.recorder.getEvents();
    const redirected = events.find((e) => e.eventType === "DamageRedirected")!;
    expect(redirected.payload).toEqual({
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 0,
      reason: "TARGET_REDIRECT",
      originalTargetUnitId: target.battleUnitId,
      newTargetUnitId: taunter.battleUnitId,
      effectInstanceId: createEffectInstanceId("REDIRECT"),
      causeEffectActionDefinitionId: createEffectActionDefinitionId("ACT_REDIRECT"),
    });
    // R-INT-01: `DamageWillBeApplied`の後・`DamageCalculated`の前に評価する。
    const order = events.map((e) => e.eventType);
    expect(order.indexOf("DamageWillBeApplied")).toBeLessThan(order.indexOf("DamageRedirected"));
    expect(order.indexOf("DamageRedirected")).toBeLessThan(order.indexOf("DamageCalculated"));

    // R-INT-02第2項: 後続効果が参照する対象も、最終的にダメージを受けた側になる。
    expect(result.hits[0]!.targetBattleUnitId).toBe(taunter.battleUnitId);
    const damagedTaunter = result.units.find((u) => u.battleUnitId === taunter.battleUnitId)!;
    const untouchedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(damagedTaunter.currentHp).toBe(100 - 20);
    expect(untouchedTarget.currentHp).toBe(100);
  });

  it("UT-R-INT-02-010: cover is evaluated against the redirected target and both interventions are reported in R-INT-01 order", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [
        redirectHeldByAttacker("REDIRECT", "ATTACKER", "TAUNTER"),
        coverHeldByAttacker("COVER", "ATTACKER", "COVERER"),
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const taunter = unit("TAUNTER", "ENEMY", { defense: 10, maximumHp: 100 });
    const coverer = unit("COVERER", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, taunter, coverer],
      new SequenceRandomSource([]),
      context,
    );

    const redirects = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageRedirected");
    expect(
      redirects.map((e) => [
        (e.payload as { reason: string }).reason,
        (e.payload as { originalTargetUnitId: string }).originalTargetUnitId,
        (e.payload as { newTargetUnitId: string }).newTargetUnitId,
      ]),
    ).toEqual([
      ["TARGET_REDIRECT", target.battleUnitId, taunter.battleUnitId],
      ["COVER", taunter.battleUnitId, coverer.battleUnitId],
    ]);
    expect(result.units.find((u) => u.battleUnitId === coverer.battleUnitId)!.currentHp).toBe(80);
    expect(result.units.find((u) => u.battleUnitId === taunter.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-INT-02-011: a self-cover that only guards keeps the defender and reduces the damage by guardRate (ACT_EVIE_ECO_PS1_COVER)", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [coverHeldByAttacker("COVER", "ATTACKER", "TARGET", 0.5)],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 素のダメージ20（攻撃30 - 防御10）が50%ガードで10になる。
    expect(result.hits[0]!.damage).toBe(10);
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(90);
    const redirected = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageRedirected")!;
    expect(redirected.payload).toMatchObject({
      reason: "COVER",
      originalTargetUnitId: target.battleUnitId,
      newTargetUnitId: target.battleUnitId,
      damageShareRate: 1,
      guardRate: 0.5,
    });
  });

  it("UT-R-INT-03-010: a reflect the defender holds generates ReflectedDamageGenerated after the original DamageApplied and applies isReflectedDamage damage to the attacker", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [reflectHeldByDefender("REFLECT", "TARGET", 0.75)],
    };
    const context = damageEventContext();
    const damageResults: DamageResultRegistry = new Map();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      { ...context, damageResults },
    );

    const generated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "ReflectedDamageGenerated")!;
    const originalApplied = context.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "DamageApplied" &&
          (e.payload as { targetUnitId: string }).targetUnitId === target.battleUnitId,
      )!;
    expect(generated.payload).toMatchObject({
      sourceDamageEventId: originalApplied.eventId,
      reflectedByUnitId: target.battleUnitId,
      reflectToUnitId: attacker.battleUnitId,
      sourceDamage: 20,
      // 20 × 75% = 15。
      formulaResult: 15,
      reflectedDamage: 15,
      damageType: "PHYSICAL",
    });

    const reflectedApplied = context.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "DamageApplied" &&
          (e.payload as { isReflectedDamage?: true }).isReflectedDamage === true,
      )!;
    expect(reflectedApplied.payload).toMatchObject({
      targetUnitId: attacker.battleUnitId,
      calculatedDamage: 15,
      hitPointDamage: 15,
      isReflectedDamage: true,
    });
    expect(result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!.currentHp).toBe(85);
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(80);
  });

  it("UT-R-INT-03-011: a reflected hit never reflects again, even when the attacker also holds a reflect (R-INT-03第2項)", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 }),
      appliedEffects: [reflectHeldByDefender("ATTACKER_REFLECT", "ATTACKER", 1)],
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [reflectHeldByDefender("REFLECT", "TARGET", 0.75)],
    };
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "ReflectedDamageGenerated"),
    ).toHaveLength(1);
  });

  it("UT-R-INT-03-012: a reflect holder killed by the original hit does not reflect (R-ACTN-01 #2)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const dying = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(5, 100),
      appliedEffects: [reflectHeldByDefender("REFLECT", "TARGET", 0.75)],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, dying],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    expect(isDefeated(result.units.find((u) => u.battleUnitId === dying.battleUnitId)!)).toBe(true);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "ReflectedDamageGenerated"),
    ).toEqual([]);
  });

  it("UT-R-LNK-01-010: a link the damaged unit holds emits LinkedDamageGenerated after the original DamageApplied and applies isLinkedDamage damage to the destination", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 0.5)],
    };
    const peer = unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    const originalApplied = context.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "DamageApplied" &&
          (e.payload as { targetUnitId: string }).targetUnitId === target.battleUnitId,
      )!;
    const generated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "LinkedDamageGenerated")!;
    expect(generated.payload).toMatchObject({
      sourceDamageEventId: originalApplied.eventId,
      linkedFromUnitId: target.battleUnitId,
      linkToUnitId: peer.battleUnitId,
      // R-LNK-01: シールド・HPへの振り分け前の最終ダメージ（攻撃30 - 防御10）。
      sourceDamage: 20,
      linkRate: 0.5,
      linkedDamage: 10,
      damageType: "PHYSICAL",
      shieldApplicable: true,
    });

    const linkedApplied = context.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "DamageApplied" &&
          (e.payload as { isLinkedDamage?: true }).isLinkedDamage === true,
      )!;
    expect(linkedApplied.payload).toMatchObject({
      targetUnitId: peer.battleUnitId,
      calculatedDamage: 10,
      hitPointDamage: 10,
      isLinkedDamage: true,
    });
    // R-LNK-02: 元ダメージはそのまま残り、リンク先へ**追加で**発生する（転送ではない）。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(80);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(90);
  });

  it("UT-R-LNK-02-010: every link the damaged unit holds fires with the full amount — R-LNK-02 does not divide by the number of destinations", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [
        damageLinkHeldByDamaged("LINK_A", "TARGET", "PEER_A", 1),
        damageLinkHeldByDamaged("LINK_B", "TARGET", "PEER_B", 1),
      ],
    };
    const peerA = unit("PEER_A", "ENEMY", { defense: 10, maximumHp: 100 });
    const peerB = unit("PEER_B", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, peerA, peerB],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    expect(
      context.recorder
        .getEvents()
        .filter((e) => e.eventType === "LinkedDamageGenerated")
        .map((e) => (e.payload as { linkedDamage: number }).linkedDamage),
    ).toEqual([20, 20]);
    expect(result.units.find((u) => u.battleUnitId === peerA.battleUnitId)!.currentHp).toBe(80);
    expect(result.units.find((u) => u.battleUnitId === peerB.battleUnitId)!.currentHp).toBe(80);
  });

  it("UT-R-LNK-03-010: linked damage never links again, even when the destination also holds a link back (R-LNK-03第2項)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 1)],
    };
    const peer = {
      ...unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [damageLinkHeldByDamaged("LINK_BACK", "PEER", "TARGET", 1)],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    // 相互リンクでも1回で止まる（無限往復しない）。
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "LinkedDamageGenerated"),
    ).toHaveLength(1);
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(80);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(80);
  });

  it("UT-R-LNK-02-011: linked damage is absorbed by the destination's own shields (R-LNK-02第4項)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 1)],
    };
    const peerShield: AppliedEffect = interventionEffect("PEER_SHIELD", "PEER", {
      magnitude: 12,
      categories: ["SHIELD"],
      shield: { shieldType: "PHYSICAL", remaining: 12 },
    });
    const peer = {
      ...unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [peerShield],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    const linkedApplied = context.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "DamageApplied" &&
          (e.payload as { isLinkedDamage?: true }).isLinkedDamage === true,
      )!;
    expect(linkedApplied.payload).toMatchObject({
      typedShieldAbsorbed: 12,
      hitPointDamage: 8,
    });
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(92);
  });

  it("UT-R-LNK-02-012: R-INT-01 evaluates the link (#3) before the reflect (#4), so LinkedDamageGenerated precedes ReflectedDamageGenerated", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [
        damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 0.5),
        reflectHeldByDefender("REFLECT", "TARGET", 0.75),
      ],
    };
    const peer = unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    const order = context.recorder.getEvents().map((e) => e.eventType);
    expect(order.indexOf("LinkedDamageGenerated")).toBeGreaterThan(-1);
    expect(order.indexOf("LinkedDamageGenerated")).toBeLessThan(
      order.indexOf("ReflectedDamageGenerated"),
    );
  });

  it("UT-R-LNK-01-011: a link whose source unit was killed by the original hit does not fire (R-ACTN-01 #2)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const dying = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(5, 100),
      appliedEffects: [damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 1)],
    };
    const peer = unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, dying, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    expect(isDefeated(result.units.find((u) => u.battleUnitId === dying.battleUnitId)!)).toBe(true);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "LinkedDamageGenerated"),
    ).toEqual([]);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-LNK-02-013: the linked amount keeps R-DMG-02's truncation and 1-damage floor", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 11, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      // 元ダメージ1 × 1% = 0.01 → 切り捨て0 → 最低1。
      appliedEffects: [damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 0.01)],
    };
    const peer = unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    expect(
      (
        context.recorder.getEvents().find((e) => e.eventType === "LinkedDamageGenerated")!
          .payload as { linkedDamage: number }
      ).linkedDamage,
    ).toBe(1);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(99);
  });

  it("UT-R-INT-01-011: a lethal hit against a death-survival holder stops HP at survivalHp, discards the rest, and replaces UnitDefeated with LethalDamageSurvived", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(5, 100),
      appliedEffects: [deathSurvivalHeldByTarget("SURVIVAL", "TARGET", 1)],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      {
        ...context,
        consumeEffectDuration: testConsumeEffectDuration(
          context.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const survived = context.recorder
      .getEvents()
      .find((e) => e.eventType === "LethalDamageSurvived")!;
    expect(survived.payload).toEqual({
      effectInstanceId: createEffectInstanceId("SURVIVAL"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SURVIVAL"),
      battleUnitId: target.battleUnitId,
      lethalDamage: 20,
      hpBefore: 5,
      survivalHp: 1,
    });
    expect(context.recorder.getEvents().filter((e) => e.eventType === "UnitDefeated")).toEqual([]);

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    // 保存則（不変条件#6）: 吸収0 + HPダメージ4 + 破棄16 = 確定ダメージ20。
    expect(applied.payload).toMatchObject({
      calculatedDamage: 20,
      hitPointDamage: 4,
      discardedDamage: 16,
      hpBefore: 5,
      hpAfter: 1,
      defeated: false,
    });

    const survivor = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(survivor.currentHp).toBe(1);
    // R-EFF-07: 耐えたインスタンス自身の`LETHAL_DAMAGE`消費を1消費して失効する。
    expect(survivor.appliedEffects).toEqual([]);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "EffectConsumptionChanged"),
    ).toHaveLength(1);
  });

  it("UT-R-INT-01-012: a death-survival instance whose LETHAL_DAMAGE consumption is spent no longer prevents the defeat", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(5, 100),
      appliedEffects: [deathSurvivalHeldByTarget("SURVIVAL", "TARGET", 0)],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(isDefeated(result.units.find((u) => u.battleUnitId === target.battleUnitId)!)).toBe(
      true,
    );
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "LethalDamageSurvived"),
    ).toEqual([]);
    expect(context.recorder.getEvents().filter((e) => e.eventType === "UnitDefeated")).toHaveLength(
      1,
    );
  });

  it("UT-R-INT-01-013: survivalHp is clamped to the HP the target still had, so a non-lethal hit is unaffected by the holder's death survival", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [deathSurvivalHeldByTarget("SURVIVAL", "TARGET", 1, 50)],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 致死ではないため耐えは成立せず、通常どおり20だけ削れる。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(80);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "LethalDamageSurvived"),
    ).toEqual([]);
  });

  it("UT-R-INT-01-014: death survival also protects against reflected damage, since both share the HP application path", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 }),
      currentHp: createHitPoint(3, 100),
      appliedEffects: [deathSurvivalHeldByTarget("SURVIVAL", "ATTACKER", 1)],
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [reflectHeldByDefender("REFLECT", "TARGET", 0.75)],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    expect(result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!.currentHp).toBe(1);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "LethalDamageSurvived"),
    ).toHaveLength(1);
  });
});
