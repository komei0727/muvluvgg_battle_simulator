import { describe, expect, it } from "vitest";

import { resolveBreak } from "./break-resolution-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import type { Side } from "../../shared/side.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

/** 強化率が単純な整数になる原基準値（1ブレイク目は全ステータス+20%、会心率は+1pp）。 */
const ENEMY_BASE_STATS: CombatStats = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function unit(id: string, side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: ENEMY_BASE_STATS,
  };
  const base = createBattleUnit(member, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...base, ...overrides };
}

function statModDefinition(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
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

function effect(
  id: string,
  holderId: ReturnType<typeof createBattleUnitId>,
  definitionId: EffectActionDefinitionId,
  overrides: Partial<AppliedEffect> = {},
  /** R-MEM-04: メモリー由来の付与は`sourceUnitId`のキー自体を持たない。 */
  memorySourceSide?: Side,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    ...(memorySourceSide === undefined
      ? { sourceUnitId: holderId }
      : { sourceSide: memorySourceSide }),
    targetUnitId: holderId,
    magnitude: 0.2,
    categories: ["BUFF"],
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
    ...overrides,
  };
}

function marker(
  id: string,
  holderId: ReturnType<typeof createBattleUnitId>,
  overrides: Partial<MarkerState> = {},
  /** R-MEM-04: メモリー由来の付与は`sourceUnitId`のキー自体を持たない。 */
  memorySourceSide?: Side,
): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId(id),
    markerId: createMarkerId("MARKER_X"),
    targetUnitId: holderId,
    ...(memorySourceSide === undefined
      ? { sourceUnitId: holderId }
      : { sourceSide: memorySourceSide }),
    stackCount: 1,
    stackMax: null,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    ...overrides,
  };
}

function createRoot(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<EventRecorder["record"]>["eventId"];
} {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 2,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 2 },
  });
  return { recorder, rootEventId: seed.eventId };
}

function context(exercise: ExerciseRuntime) {
  const { recorder, rootEventId } = createRoot();
  return {
    ctx: {
      recorder,
      turnNumber: 2,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
      exercise,
    },
    recorder,
    rootEventId,
  };
}

const ATTACK_BUFF = statModDefinition("ACT_ATK_UP");
const EFFECT_ACTIONS = new Map([[ATTACK_BUFF.effectActionDefinitionId, ATTACK_BUFF]]);

describe("resolveBreak (R-TEX-03／05／06)", () => {
  it("UT-R-TEX-03-004: emits UnitBroken owning the exercise.breakCount delta and never emits UnitDefeated", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    exercise.accumulateScore(1300);
    const enemy = unit("enemy-1", "ENEMY", { currentHp: createHitPoint(0, 1000) });
    const { ctx, recorder, rootEventId } = context(exercise);

    const result = resolveBreak(ctx, [enemy], enemy.battleUnitId, EFFECT_ACTIONS, rootEventId);

    const broken = recorder.getEvents().find((event) => event.eventType === "UnitBroken")!;
    expect(broken).toBeDefined();
    expect(broken.payload).toMatchObject({
      unitId: enemy.battleUnitId,
      breakNumber: 1,
      turnNumber: 2,
      totalScore: 1300,
      causeEventId: rootEventId,
    });
    expect(broken.stateDelta).toEqual({ exercise: { breakCount: { before: 0, after: 1 } } });
    expect(recorder.getEvents().some((event) => event.eventType === "UnitDefeated")).toBe(false);
    expect(exercise.breakCount).toBe(1);
    expect(result.lastEventId).not.toBe(rootEventId);
  });

  it("UT-R-TEX-05-001: removes the broken enemy's own effects and markers but keeps Memory-derived grants (R-MEM-04)", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    const enemyId = createBattleUnitId("enemy-1");
    const enemy = unit("enemy-1", "ENEMY", {
      currentHp: createHitPoint(0, 1000),
      appliedEffects: [
        effect("eff-unit", enemyId, ATTACK_BUFF.effectActionDefinitionId),
        // R-MEM-04: メモリー由来の付与は`sourceUnitId`を持たず`sourceSide`だけを持つ。
        effect("eff-memory", enemyId, ATTACK_BUFF.effectActionDefinitionId, {}, "ENEMY"),
      ],
      markerStates: [marker("mk-unit", enemyId), marker("mk-memory", enemyId, {}, "ENEMY")],
    });
    const { ctx, recorder, rootEventId } = context(exercise);

    const result = resolveBreak(ctx, [enemy], enemyId, EFFECT_ACTIONS, rootEventId);

    const revived = result.units.find((candidate) => candidate.battleUnitId === enemyId)!;
    expect(revived.appliedEffects.map((e) => e.effectInstanceId)).toEqual(["eff-memory"]);
    expect(revived.markerStates.map((m) => m.markerInstanceId)).toEqual(["mk-memory"]);
    const removed = recorder.getEvents().filter((event) => event.eventType === "EffectRemoved");
    expect(removed).toHaveLength(1);
    expect(recorder.getEvents().filter((e) => e.eventType === "MarkerRemoved")).toHaveLength(1);
  });

  it("UT-R-TEX-07-001: leaves effects and markers the broken enemy granted to allies untouched", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    const enemyId = createBattleUnitId("enemy-1");
    const allyId = createBattleUnitId("ally-1");
    const enemy = unit("enemy-1", "ENEMY", { currentHp: createHitPoint(0, 1000) });
    const ally = unit("ally-1", "ALLY", {
      appliedEffects: [
        effect("eff-on-ally", allyId, ATTACK_BUFF.effectActionDefinitionId, {
          sourceUnitId: enemyId,
        }),
      ],
      markerStates: [marker("mk-on-ally", allyId, { sourceUnitId: enemyId })],
    });
    const { ctx, recorder, rootEventId } = context(exercise);

    const result = resolveBreak(ctx, [enemy, ally], enemyId, EFFECT_ACTIONS, rootEventId);

    const afterAlly = result.units.find((candidate) => candidate.battleUnitId === allyId)!;
    expect(afterAlly.appliedEffects).toHaveLength(1);
    expect(afterAlly.markerStates).toHaveLength(1);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectRemoved")).toBe(false);
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(false);
  });

  it("UT-R-TEX-04-019: rewrites baseCombatStats from the original snapshot and fully heals to the enhanced maximum, emitting UnitRevived", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    const enemy = unit("enemy-1", "ENEMY", { currentHp: createHitPoint(0, 1000) });
    const { ctx, recorder, rootEventId } = context(exercise);

    const result = resolveBreak(ctx, [enemy], enemy.battleUnitId, EFFECT_ACTIONS, rootEventId);

    const revived = result.units[0]!;
    // 1ブレイク目（R-TEX-04 #2）: HP・攻撃・防御は×1.20、行動速度は×1.05
    // （10 × 1.05 = 10.5 → R-TEX-04 #5の切り捨てで10）、会心率は絶対値+1pp。
    // 会心ダメージボーナスと属性相性ボーナスは強化対象外（同 #3）。
    expect(revived.baseCombatStats).toEqual({
      maximumHp: 1200,
      attack: 120,
      defense: 60,
      criticalRate: 0.11,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    });
    expect(revived.currentHp).toBe(1200);

    const unitRevived = recorder.getEvents().find((event) => event.eventType === "UnitRevived")!;
    expect(unitRevived.payload).toMatchObject({
      unitId: enemy.battleUnitId,
      breakNumber: 1,
      hpAfter: 1200,
    });
    expect(unitRevived.stateDelta?.units?.[enemy.battleUnitId]?.hp).toEqual({
      before: 0,
      after: 1200,
    });
    expect(unitRevived.stateDelta?.units?.[enemy.battleUnitId]?.baseCombatStats).toEqual({
      maximumHp: { before: 1000, after: 1200 },
      attack: { before: 100, after: 120 },
      defense: { before: 50, after: 60 },
      criticalRate: { before: 0.1, after: 0.11 },
    });
  });

  it("UT-R-TEX-04-020: recalculates the break enhancement from the original snapshot every time rather than compounding", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    let units: readonly BattleUnit[] = [unit("enemy-1", "ENEMY")];
    const enemyId = units[0]!.battleUnitId;

    for (let round = 0; round < 2; round += 1) {
      const { ctx, rootEventId } = context(exercise);
      units = units.map((candidate) =>
        candidate.battleUnitId === enemyId
          ? { ...candidate, currentHp: createHitPoint(0, 1000) }
          : candidate,
      );
      units = resolveBreak(ctx, units, enemyId, EFFECT_ACTIONS, rootEventId).units;
    }

    // 2ブレイク目の累計倍率は1 + (20 + 20)/100 = 1.40（複利の1.44ではない）。
    expect(units[0]!.baseCombatStats.maximumHp).toBe(1400);
    expect(units[0]!.currentHp).toBe(1400);
    expect(exercise.breakCount).toBe(2);
  });

  it("UT-R-TEX-06-001: keeps AP/PP/EX gauges, cooldowns, charge and runtime counters across the break", () => {
    const exercise = new ExerciseRuntime(ENEMY_BASE_STATS);
    const enemy = unit("enemy-1", "ENEMY", {
      currentHp: createHitPoint(0, 1000),
      currentAp: 2,
      currentPp: 1,
      currentExtraGauge: 7,
    });
    const { ctx, rootEventId } = context(exercise);

    const result = resolveBreak(ctx, [enemy], enemy.battleUnitId, EFFECT_ACTIONS, rootEventId);

    expect(result.units[0]!.currentAp).toBe(2);
    expect(result.units[0]!.currentPp).toBe(1);
    expect(result.units[0]!.currentExtraGauge).toBe(7);
    expect(result.units[0]!.maximumAp).toBe(3);
    expect(result.units[0]!.maximumExtraGauge).toBe(10);
  });
});
