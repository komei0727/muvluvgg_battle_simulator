import { describe, expect, it } from "vitest";
import {
  applyOneContinuousDamage,
  type ContinuousDamageEventContext,
} from "./continuous-damage-service.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId, type DomainEventId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";

/**
 * R-TEX-02 #3「ダメージの発生源・種別は問わない…継続ダメージなど…敵HPへ向かうものは
 * 計上する」。ダメージpipelineの外にある継続ダメージも同じ規則で計上する。
 */
const DOT_DEFINITION_ID = createEffectActionDefinitionId("ACT_DOT");

function enemy(currentHp: number, effects: readonly AppliedEffect[]): BattleUnit {
  const position = { row: "FRONT" as const, column: "LEFT" as const };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("enemy:1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ENEMY", position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 20,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const built = createBattleUnit(member, "ENEMY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
  return {
    ...built,
    currentHp: createHitPoint(currentHp, 1000),
    appliedEffects: effects,
  };
}

function dotDefinition(): Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_DAMAGE" }> {
  return {
    effectActionDefinitionId: DOT_DEFINITION_ID,
    kind: "APPLY_CONTINUOUS_DAMAGE",
    payload: {
      continuousDamageKind: "FIXED",
      damageType: "PHYSICAL",
      formula: { kind: "CONSTANT", value: 100 },
      timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
      duration: {
        timeLimit: { unit: "ACTION", count: 3 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
    metadata: { tags: [] },
  };
}

function dotEffect(): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId("EFFECT_DOT"),
    effectActionDefinitionId: DOT_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(DOT_DEFINITION_ID),
    categories: ["DEBUFF"],
    duplicate: true,
    sourceUnitId: createBattleUnitId("ally:1"),
    targetUnitId: createBattleUnitId("enemy:1"),
    magnitude: 100,
    continuousDamage: { continuousDamageKind: "FIXED", damageType: "PHYSICAL" },
    snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: 100 },
    duration: {
      definition: {
        timeLimit: { unit: "ACTION", count: 3 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: 3,
    },
    appliedTurnNumber: 1,
  };
}

function shieldEffect(amount: number): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_SHIELD");
  return {
    effectInstanceId: createEffectInstanceId("EFFECT_SHIELD"),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId("enemy:1"),
    magnitude: amount,
    categories: ["SHIELD"],
    shield: { shieldType: null, remaining: amount },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/** 演習状態は原基準値スナップショットを必ず持つ（R-TEX-04）。スコア計上の検証では値自体は使わない。 */
function exerciseRuntime(): ExerciseRuntime {
  return new ExerciseRuntime(enemy(1000, []).baseCombatStats);
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: DomainEventId } {
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

function contextOf(
  recorder: EventRecorder,
  rootEventId: DomainEventId,
  exercise?: ExerciseRuntime,
): ContinuousDamageEventContext {
  const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
    [DOT_DEFINITION_ID, dotDefinition()],
  ]);
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
    effectActions,
    ...(exercise !== undefined ? { exercise } : {}),
  };
}

function tick(
  holder: BattleUnit,
  exercise: ExerciseRuntime | undefined,
): { recorder: EventRecorder } {
  const { recorder, rootEventId } = seedRecorder();
  applyOneContinuousDamage(
    holder.appliedEffects.find((effect) => effect.continuousDamage !== undefined)!,
    dotDefinition(),
    holder,
    undefined,
    [holder],
    contextOf(recorder, rootEventId, exercise),
    rootEventId,
  );
  return { recorder };
}

describe("continuous damage exercise score accumulation (R-TEX-02)", () => {
  it("UT-R-TEX-02-012: counts the continuous damage that reached the enemy's HP, excluding the shield-absorbed portion", () => {
    const exercise = exerciseRuntime();
    const { recorder } = tick(enemy(500, [shieldEffect(30), dotEffect()]), exercise);

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!;
    const scored = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated");

    expect(exercise.totalScore).toBe(70);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.payload).toMatchObject({ amount: 70, totalScore: 70 });
    expect(scored[0]!.parentEventId).toBe(applied.eventId);
  });

  it("UT-R-TEX-02-013: counts the overkill of a lethal continuous damage in full", () => {
    const exercise = exerciseRuntime();
    const { recorder } = tick(enemy(40, [dotEffect()]), exercise);

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!;
    expect(applied.payload).toMatchObject({ hitPointDamage: 40, discardedDamage: 60 });
    expect(exercise.totalScore).toBe(100);
  });

  it("UT-R-TEX-02-014: a normal battle (no exercise state) emits no ExerciseScoreAccumulated for continuous damage", () => {
    const { recorder } = tick(enemy(500, [dotEffect()]), undefined);

    expect(recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated")).toEqual(
      [],
    );
  });
});
