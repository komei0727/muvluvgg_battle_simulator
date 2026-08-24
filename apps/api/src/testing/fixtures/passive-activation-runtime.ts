import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { PassiveActivationRuntimeContext } from "../../domain/battle/lifecycle/passive-activation-service.js";
import type { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { Side } from "../../domain/shared/side.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";
import { UNUSED_ENHANCED_BASE_STATS } from "./battle-actors.js";

/**
 * `passive-activation-service.*.test.ts`（観点分割、REF-050）が共有する
 * `PassiveActivationRuntime`テスト用の最小ビルダー群。全ビルダーがこのファイルへの
 * 移動元だった`passive-activation-service.test.ts`と同じ既定値を保つ。
 */
export const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

export function unit(
  id: string,
  side: Side,
  overrides: {
    maximumPp?: number;
    maximumExtraGauge?: number;
    currentPp?: number;
    currentExtraGauge?: number;
    currentHp?: number;
    maximumHp?: number;
    attack?: number;
    defense?: number;
    unitDefinitionId?: UnitDefinitionId;
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: overrides.unitDefinitionId ?? createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 10,
      defense: overrides.defense ?? 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const limits = {
    maximumAp: LIMITS.maximumAp,
    maximumPp: overrides.maximumPp ?? LIMITS.maximumPp,
    maximumExtraGauge: overrides.maximumExtraGauge ?? LIMITS.maximumExtraGauge,
  };
  const built = createBattleUnit(member, side, limits);
  return {
    ...built,
    currentPp: overrides.currentPp ?? built.currentPp,
    currentExtraGauge: overrides.currentExtraGauge ?? built.currentExtraGauge,
    currentHp: overrides.currentHp ?? built.currentHp,
  };
}

export function unitDefinitionOf(
  id: UnitDefinitionId,
  passiveSkillDefinitionIds: readonly SkillDefinitionId[],
): UnitDefinition {
  return {
    unitDefinitionId: id,
    category: "PLAYABLE",
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 10,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds,
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    metadata: {
      displayName: "Test Unit",
      characterName: "Test Character",
      characterId: "CHAR_TEST",
      affiliations: [],
      tags: [],
    },
  };
}

export function passiveSkillOf(
  id: string,
  overrides: {
    ppCost?: number;
    cooldown?: SkillDefinition["cooldown"];
    resolution?: SkillDefinition["resolution"];
    triggers?: SkillDefinition["triggers"];
  } = {},
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: overrides.ppCost ?? 2 },
    activationCondition: { kind: "TRUE" },
    triggers: overrides.triggers ?? [
      {
        eventType: "TurnStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "TRUE" },
      },
    ],
    counterUpdates: [],
    resolution: overrides.resolution ?? { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: overrides.cooldown ?? { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: id, tags: [] },
  };
}

export function damageEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

export function statusEffectAction(id: string, skillUseCount: number): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      status: "STEALTH",
      duration: {
        timeLimit: { unit: "SKILL_USE", count: skillUseCount },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

export function definitionsOf(
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<
    ReturnType<typeof createEffectActionDefinitionId>,
    EffectActionDefinition
  > = new Map(),
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions,
    skillDefinitions,
  };
}

export function recordTurnStarted(recorder: EventRecorder): BattleDomainEvent {
  return recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
}

export function contextOf(
  recorder: EventRecorder,
  definitions: BattleDefinitions,
  triggerEvent: BattleDomainEvent,
  actionId?: ReturnType<typeof createActionId>,
  resolutionPhase?: PassiveActivationRuntimeContext["resolutionPhase"],
  turnNumber = 1,
): PassiveActivationRuntimeContext {
  return {
    definitions,
    random: new SequenceRandomSource([]),
    recorder,
    turnNumber,
    cycleNumber: 1,
    resolutionScopeId: triggerEvent.resolutionScopeId,
    rootEventId: triggerEvent.eventId,
    ...(actionId !== undefined ? { actionId } : {}),
    ...(resolutionPhase !== undefined ? { resolutionPhase } : {}),
  };
}
