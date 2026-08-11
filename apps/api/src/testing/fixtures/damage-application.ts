import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../../domain/battle/model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type StatusEffectDetails,
} from "../../domain/battle/model/applied-effect.js";
import { consumeEffectDurations } from "../../domain/battle/model/applied-effect-duration.js";
import type { ExerciseRuntime } from "../../domain/battle/model/exercise-runtime.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffectsSteps,
} from "../../domain/battle/effects/duration-expiry-service.js";
import type { DamageEventContext } from "../../domain/battle/combat/damage-application-service.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createHitPoint } from "../../domain/battle/model/resource-gauge.js";
import type { ResolvedEffectApplication } from "../../domain/battle/skill/skill-resolution-service.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { Side } from "../../domain/shared/side.js";
import type {
  Attribute,
  ConsumptionKind,
  CriticalMode,
} from "../../domain/catalog/definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";

/**
 * `damage-application-service.*.test.ts`の各スイートが共有する、ダメージpipeline用の
 * 手組みビルダー。1つの`applyDamageAction`呼び出しに必要な最小の前提（ユニット・
 * DAMAGE定義・状態効果・`DamageEventContext`）を決定的に組み立てる。
 *
 * スイートを責務別に分けても同じ前提を使い続けられるようにここへ置く。スイート固有の
 * 効果（防御介入・サブユニット・混乱など）は各テストファイルがローカルに組み立てる。
 */

export const LIMITS: BattleUnitResourceLimits = {
  maximumAp: 3,
  maximumPp: 3,
  maximumExtraGauge: 100,
};

export function unit(
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

export function defeated(target: BattleUnit): BattleUnit {
  return { ...target, currentHp: createHitPoint(0, target.combatStats.maximumHp) };
}

export function damageAction(
  criticalMode: CriticalMode = "PREVENTED",
): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
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

export function immunityEffect(
  id: string,
  targetUnitId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_IMMUNITY"),
    kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_IMMUNITY")),
    duplicate: true,
    sourceUnitId: createBattleUnitId(targetUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "DAMAGE_IMMUNITY",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

export function attackDamageBonusEffect(
  id: string,
  holderId: string,
  magnitude: number,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
    kindKey: effectKindKeyFromDefinitionId(
      createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
    ),
    categories: ["BUFF"],
    duplicate: true,
    sourceUnitId: createBattleUnitId(holderId),
    targetUnitId: createBattleUnitId(holderId),
    magnitude,
    isAttackDamageBonus: true,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

export function freezeEffect(
  id: string,
  targetUnitId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
    kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
    duplicate: true,
    sourceUnitId: createBattleUnitId(targetUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["DEBUFF", "STATUS"],
    statusKind: "FREEZE",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

export function evasionEffect(
  id: string,
  targetUnitId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_EVASION"),
    kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_EVASION")),
    duplicate: true,
    sourceUnitId: createBattleUnitId(targetUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "EVASION",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/**
 * R-HIT-04（M7-018）: production定義（`ACT_ANIS_TROUBLEMAKER_PS1_EVASION`の`EVASION`、
 * `ACT_FLUTE_VAMPIRE_PS2_EVASION`の`HIT_EVASION`）と同じ形の、被ヒット消費
 * （`INCOMING_HIT`）付き回避効果。
 */
export function hitCountEvasionEffect(
  id: string,
  targetUnitId: string,
  statusKind: "EVASION" | "HIT_EVASION",
  consumptionRemaining: number,
): AppliedEffect {
  return {
    ...evasionEffect(id, targetUnitId, { probability: 1 }),
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

export function evasionDefinition(): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_EVASION"),
    kind: "APPLY_STATUS",
    payload: {
      status: "EVASION",
      probability: 1,
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    metadata: { tags: [] },
  };
}

export function guaranteedHitEffect(id: string, attackerId: string): AppliedEffect {
  return { ...evasionEffect(id, attackerId, {}), statusKind: "GUARANTEED_HIT" };
}

/**
 * R-CRT-03（DMG-003A）: production定義（`ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE`／
 * `ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION`）と同じ形の会心状態効果。
 * どちらも保持者の攻撃側に働くため、保持者を`holderId`で明示する。
 */
export function criticalStatusEffect(
  id: string,
  holderId: string,
  statusKind: "CRITICAL_GUARANTEE" | "CRITICAL_PREVENTION",
): AppliedEffect {
  return { ...evasionEffect(id, holderId, {}), statusKind, statusDetails: {} };
}

export function hit(targetUnitId: string, hitIndex: number): ResolvedEffectApplication {
  return {
    targetUnitId: createBattleUnitId(targetUnitId),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
    hitIndex,
  };
}

/** `applyDamageAction`は通常`ActionStarted`スコープ内、`SkillUseStarted`直後に呼ばれる。単体テストではその前提イベントを最小限再現する。 */
export function damageEventContext(
  options: { readonly exercise?: ExerciseRuntime } = {},
): DamageEventContext {
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
    ...(options.exercise !== undefined ? { exercise: options.exercise } : {}),
  };
}

export const STAT_MOD_DEFINITION_ID = createEffectActionDefinitionId("ACT_ATK_UP");

export function statModDefinition(): EffectActionDefinition {
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
    metadata: { tags: [] },
  };
}

export function consumptionEffect(
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
    sourceUnitId: ownerId,
    targetUnitId: ownerId,
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
export function testConsumeEffectDuration(
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
