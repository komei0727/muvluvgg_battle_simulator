import { expect } from "vitest";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { EffectSequencePlan } from "../../domain/battle/skill/skill-resolution-service.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import type {
  SkillDefinition,
  SkillResolutionDefinition,
} from "../../domain/catalog/definitions/skill-definition.js";
import {
  createEffectActionDefinitionId,
  type createMarkerId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { Side } from "../../domain/shared/side.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { DurationDefinition } from "../../domain/catalog/definitions/duration-definition.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { EffectStepDefinition } from "../../domain/catalog/definitions/effect-sequence.js";
import type { TargetReference } from "../../domain/catalog/definitions/references.js";
import type { ConditionDefinition } from "../../domain/catalog/definitions/condition-definition.js";
import type {
  EffectActionGroupContext,
  EffectActionGroupsResult,
} from "../../domain/battle/resolution/effect-action-group-resolver.js";
import { UNUSED_ENHANCED_BASE_STATS } from "./battle-actors.js";

/**
 * `applyEffectActionGroups`/`resolveEffectSequencePlan`をkind別ハンドラごとの
 * スイートへ分割した際に、各スイートが共有する`EffectSequencePlan`・
 * `EffectActionDefinition`・因果contextの最小ビルダー群。
 * `effect-action-group-resolver.*.test.ts`／`effect-step-resolution.test.ts`が使う。
 */
export const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

export function unit(id: string, side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

export function damageAction(id: string, hitCount = 1): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

export function statModAction(id: string): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "FIXED",
      formula: { kind: "CONSTANT", value: 20 },
      stacking: { mode: "STACKABLE", max: null },
      duration: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

export function statusAction(
  id: string,
  duration: DurationDefinition = {
    timeLimit: { unit: "SKILL_USE", count: 3 },
    dispellable: true,
    linkedEffectGroupId: null,
  },
): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      status: "STEALTH",
      duration,
    },
  };
}

export function markerAction(
  id: string,
  markerId: ReturnType<typeof createMarkerId>,
): EffectActionDefinition {
  return {
    kind: "APPLY_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      markerId,
      stack: { policy: "ADD", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  };
}

export function removeMarkerAction(
  id: string,
  markerId: ReturnType<typeof createMarkerId>,
): EffectActionDefinition {
  return {
    kind: "REMOVE_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: { markerId },
  };
}

export function cooldownManipulationAction(
  id: string,
  targetSkillDefinitionId: ReturnType<typeof createSkillDefinitionId>,
): EffectActionDefinition {
  return {
    kind: "COOLDOWN_MANIPULATION",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: { targetSkillDefinitionId, operation: "RESET" },
  };
}

/**
 * R-TGT-10（Issue #168）: `resolveSkillOrder`が実際に組み立てる
 * `EffectSequencePlan`を、この`applyEffectActionGroups`テストへ橋渡しするための
 * 最小`SkillDefinition`。`skill-resolution-service.test.ts`の同名ヘルパーと同じ形。
 */
export function skillOf(resolution: SkillResolutionDefinition): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution,
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "Test", tags: [] },
  };
}

export const NO_RANDOM: RandomSource = {
  next(): number {
    throw new Error("random should not be consumed by critical.mode: PREVENTED");
  },
};

export const EMPTY_DEFINITIONS: Omit<BattleDefinitions, "effectActions"> = {
  activeSkillsByUnit: new Map(),
  exSkillByUnit: new Map(),
  unitDefinitions: new Map(),
  skillDefinitions: new Map(),
};

export function contextFor(
  actor: BattleUnit,
  effectActions: BattleDefinitions["effectActions"],
  recorder: EventRecorder,
  rootEventId: string,
  onFactEventForPassiveChain?: EffectActionGroupContext["onFactEventForPassiveChain"],
): EffectActionGroupContext {
  return {
    definitions: { ...EMPTY_DEFINITIONS, effectActions },
    actorUnitId: actor.battleUnitId,
    random: NO_RANDOM,
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId("SKL_TEST"),
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
  };
}

export function seedRecorder(): { recorder: EventRecorder; rootEventId: string } {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

export function singleActionStep(
  stepIndex: number,
  satisfied: boolean,
  targetUnitId: BattleUnit["battleUnitId"],
  effectActionDefinitionId: EffectActionDefinition["effectActionDefinitionId"],
  includeDefeated = false,
): EffectSequencePlan["steps"][number] {
  return {
    planKind: "ACTION_PLAN",
    stepIndex,
    stepKind: "ACTION",
    conditionKind: satisfied ? "TRUE" : "NOT",
    satisfied,
    actions: [{ effectActionDefinitionId }],
    applications: satisfied
      ? [
          {
            targetUnitId,
            effectActionDefinitionId,
            includeDefeated,
            hits: [{ targetUnitId, effectActionDefinitionId, hitIndex: 1 }],
          },
        ]
      : [],
  };
}

export function expectCompleted(
  result: EffectActionGroupsResult,
  resolvedEffectCount: number,
): void {
  expect(result.outcome).toEqual({ status: "COMPLETED", resolvedEffectCount });
}

export function expectInterrupted(
  result: EffectActionGroupsResult,
  resolvedEffectCount: number,
  unresolvedEffectCount: number,
): void {
  expect(result.outcome).toEqual({
    status: "INTERRUPTED",
    reason: "ACTOR_DEFEATED",
    resolvedEffectCount,
    unresolvedEffectCount,
  });
}

export function deferredStep(
  stepIndex: number,
  definition: EffectStepDefinition,
): EffectSequencePlan["steps"][number] {
  return { planKind: "DEFERRED", stepIndex, stepKind: definition.kind, definition };
}

export function actionOn(
  target: TargetReference,
  effectActionDefinitionId: EffectActionDefinition["effectActionDefinitionId"],
  targetCondition: ConditionDefinition = { kind: "TRUE" },
): Extract<EffectStepDefinition, { kind: "ACTION" }> {
  return {
    kind: "ACTION",
    stepCondition: { kind: "TRUE" },
    targetCondition,
    target,
    actions: [{ effectActionDefinitionId }],
  };
}
