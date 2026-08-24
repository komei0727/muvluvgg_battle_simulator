// R-TEX-02 #5: 戦術演習では、ブレイク復活以外で敵ユニットのHPが増えた量を累計スコアから
// 減算する。回復経路（`HealApplied`／`HealingTransferred`）の減算をここで検証する。
// ダメージ→回復変換（R-DTH-01）の減算は`combat/damage-application-service.exercise.test.ts`が持つ。

import { describe, expect, it } from "vitest";
import { applyHealAction } from "./heal-application-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { Side } from "../../shared/side.js";

const ENEMY_BASE_STATS: CombatStats = {
  maximumHp: 100,
  attack: 30,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function unit(
  id: string,
  side: Side,
  overrides: { currentHp?: number; maximumHp?: number; attack?: number } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 100,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const built = createBattleUnit(member, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...built, currentHp: overrides.currentHp ?? built.currentHp };
}

function healAction(ratio: number): Extract<EffectActionDefinition, { kind: "HEAL" }> {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL"),
    kind: "HEAL",
    payload: {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio },
      overheal: "DISCARD",
      distribution: "NONE",
    },
    metadata: { tags: [] },
  };
}

function hit(targetUnitId: string): ResolvedEffectApplication {
  return {
    targetUnitId: createBattleUnitId(targetUnitId),
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL"),
    hitIndex: 0,
  };
}

function link(transferToUnitId: string, transferRate: number, holderId: string): AppliedEffect {
  return {
    effectInstanceId: `B_1:effect:ACT_LINK` as AppliedEffect["effectInstanceId"],
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_LINK"),
    kindKey: "ACT_LINK" as AppliedEffect["kindKey"],
    duplicate: true,
    sourceUnitId: createBattleUnitId(transferToUnitId),
    targetUnitId: createBattleUnitId(holderId),
    magnitude: transferRate,
    categories: ["BUFF"],
    healingLink: { transferToUnitId: createBattleUnitId(transferToUnitId), transferRate },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

type DomainEventIdOf = ReturnType<EventRecorder["record"]>["eventId"];

function seedRecorder(): { recorder: EventRecorder; rootEventId: DomainEventIdOf } {
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

function context(
  recorder: EventRecorder,
  rootEventId: DomainEventIdOf,
  exercise?: ExerciseRuntime,
  onFactEventForPassiveChain?: NonNullable<
    Parameters<typeof applyHealAction>[4]["onFactEventForPassiveChain"]
  >,
): Parameters<typeof applyHealAction>[4] {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
    parentEventId: rootEventId,
    sourceUnitId: createBattleUnitId("HEALER"),
    effectActions: new Map(),
    ...(exercise !== undefined ? { exercise } : {}),
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
  };
}

describe("heal in a tactical exercise (R-TEX-02 #5 敵回復の減算)", () => {
  it("UT-R-TEX-02-029: a HealApplied on the enemy deducts the actual HP gain and emits ExerciseScoreDeducted owning the cumulative-score delta", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(100);
    const healer = unit("HEALER", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 40, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ENEMY_1")],
      healer,
      healAction(0.3),
      [healer, enemy],
      context(recorder, rootEventId, exercise),
    );

    const deducted = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted");
    expect(deducted).toHaveLength(1);
    const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    expect(deducted[0]!.payload).toEqual({
      targetUnitId: createBattleUnitId("ENEMY_1"),
      amount: 30,
      totalScore: 70,
      causeEventId: healApplied.eventId,
    });
    expect(deducted[0]!.parentEventId).toBe(healApplied.eventId);
    // 累計スコアの差分は`ExerciseScoreDeducted`が単独で所有する（HP差分は`HealApplied`側）。
    expect(deducted[0]!.stateDelta).toEqual({
      exercise: { totalScore: { before: 100, after: 70 } },
    });
    expect(exercise.totalScore).toBe(70);
  });

  it("UT-R-TEX-02-030: a heal on an ally deducts nothing from the score", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(100);
    const healer = unit("HEALER", "ALLY", { currentHp: 100, maximumHp: 100 });
    const ally = unit("ALLY_1", "ALLY", { currentHp: 40, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ALLY_1")],
      healer,
      healAction(0.3),
      [healer, ally],
      context(recorder, rootEventId, exercise),
    );

    expect(recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted")).toEqual([]);
    expect(exercise.totalScore).toBe(100);
  });

  it("UT-R-TEX-02-031: a normal battle (no exercise state) emits no ExerciseScoreDeducted at all", () => {
    const healer = unit("HEALER", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 40, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ENEMY_1")],
      healer,
      healAction(0.3),
      [healer, enemy],
      context(recorder, rootEventId),
    );

    expect(recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted")).toEqual([]);
  });

  it("UT-R-TEX-02-032 (BOUNDARY): overheal discarded by the max-HP cap is not deducted, only the applied amount is", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(100);
    const healer = unit("HEALER", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 90, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ENEMY_1")],
      healer,
      healAction(0.3),
      [healer, enemy],
      context(recorder, rootEventId, exercise),
    );

    const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({ appliedAmount: 10, discardedAmount: 20 });
    const deducted = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted");
    expect(deducted).toHaveLength(1);
    expect(deducted[0]!.payload).toMatchObject({ amount: 10, totalScore: 90 });
  });

  it("UT-R-TEX-02-033 (BOUNDARY): a heal larger than the cumulative score stops the score at 0 instead of going negative", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(10);
    const healer = unit("HEALER", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 40, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ENEMY_1")],
      healer,
      healAction(0.3),
      [healer, enemy],
      context(recorder, rootEventId, exercise),
    );

    const deducted = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted");
    expect(deducted).toHaveLength(1);
    // 実HP増加は30だが、累計10しか無いので減算量は10で止まる。
    expect(deducted[0]!.payload).toMatchObject({ amount: 10, totalScore: 0 });
    expect(deducted[0]!.stateDelta).toEqual({
      exercise: { totalScore: { before: 10, after: 0 } },
    });
    expect(exercise.totalScore).toBe(0);
  });

  it("UT-R-TEX-02-034 (BOUNDARY): a heal that gains no HP (score already 0) emits no ExerciseScoreDeducted", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    const healer = unit("HEALER", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 40, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ENEMY_1")],
      healer,
      healAction(0.3),
      [healer, enemy],
      context(recorder, rootEventId, exercise),
    );

    expect(recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted")).toEqual([]);
  });

  it("UT-R-TEX-02-035 / UT-R-HEAL-04-022: a healing link transferring to the enemy deducts the amount that reached the enemy's HP", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(100);
    const healer = unit("HEALER", "ALLY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 40, maximumHp: 100 });
    const holder: BattleUnit = {
      ...unit("ALLY_1", "ALLY", { currentHp: 40, maximumHp: 100 }),
      appliedEffects: [link("ENEMY_1", 1, "ALLY_1")],
    };
    const { recorder, rootEventId } = seedRecorder();

    applyHealAction(
      [hit("ALLY_1")],
      healer,
      healAction(0.3),
      [healer, holder, enemy],
      context(recorder, rootEventId, exercise),
    );

    const transferred = recorder.getEvents().find((e) => e.eventType === "HealingTransferred")!;
    expect(transferred.payload).toMatchObject({ appliedAmount: 30 });
    const deducted = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreDeducted");
    // 保持者は味方（減算しない）で、敵へ届いた転送分だけを減算する。
    expect(deducted).toHaveLength(1);
    expect(deducted[0]!.payload).toEqual({
      targetUnitId: createBattleUnitId("ENEMY_1"),
      amount: 30,
      totalScore: 70,
      causeEventId: transferred.eventId,
    });
    expect(deducted[0]!.parentEventId).toBe(transferred.eventId);
  });

  it("UT-R-TEX-02-036: the deduction is emitted before the HealApplied child chain, keeping the R-HEAL-04 #4/#6 observation order", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(100);
    const healer = unit("HEALER", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 40, maximumHp: 100 });
    const { recorder, rootEventId } = seedRecorder();
    const chainedAtEventCount: number[] = [];

    applyHealAction(
      [hit("ENEMY_1")],
      healer,
      healAction(0.3),
      [healer, enemy],
      context(recorder, rootEventId, exercise, (_event, units) => {
        chainedAtEventCount.push(recorder.getEvents().length);
        return units;
      }),
    );

    const types = recorder.getEvents().map((e) => e.eventType);
    expect(types).toEqual(["TurnStarted", "HealApplied", "ExerciseScoreDeducted"]);
    // 連鎖callbackは減算イベントの発行後に呼ばれる（3件が記録済みの時点）。
    expect(chainedAtEventCount).toEqual([3]);
  });
});
