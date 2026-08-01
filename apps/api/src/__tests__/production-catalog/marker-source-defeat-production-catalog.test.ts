import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMarker } from "../../domain/battle/effects/marker-apply-service.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../../domain/battle/events/state-delta.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-020（Issue #279、`MARKER_REMOVAL_ON_SOURCE_DEATH`、R-EFF-10）: 実
 * production `catalog/` の `ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU`（「高揚」）が
 * 宣言する `duration.removeOnSourceDefeated` を、実ライフサイクル
 * （`PassiveActivationRuntime.onFactEvent`が`UnitDefeated`に対して行う解除）へ
 * 通して検証する。子効果（会心率デバフ）がR-EFF-09のcross-typeカスケードで
 * 連動して失効するところまでを1本の経路として確認する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const AOI_UNIT_ID = "UNIT_AOI_ELEGANT";
const AOI_MARKER_EFFECT_ID = "ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU";
const AOI_CRIT_DOWN_EFFECT_ID = "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN";
const AOI_DOT_EFFECT_ID = "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT";
const AOI_MARKER_ID = "MARKER_AOI_ELEGANT_KOUYOU";
const AOI_GROUP_ID = "AOI_ELEGANT_AS1_KOUYOU_LINK";

const BASE_CRITICAL_RATE = 0.5;
const LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 };

function actorFor(unitDefinitionId: string, battleUnitId: string, side: Side): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: BASE_CRITICAL_RATE,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

function loadAoiSnapshot() {
  return loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot([AOI_UNIT_ID as never], []);
}

interface Scene {
  readonly recorder: EventRecorder;
  readonly units: readonly BattleUnit[];
  readonly granterId: BattleUnitId;
  readonly holderId: BattleUnitId;
  readonly definitions: BattleDefinitions;
  readonly seedEventId: BattleDomainEvent["eventId"];
}

/**
 * 実payloadの「高揚」Markerと会心率デバフ子効果を、付与者（Aoi）から別ユニット
 * （敵）へ付与した局面を組み立てる。付与経路は`marker-production-catalog.test.ts`
 * と同じく実行器を直接呼ぶ — 本Issueが追加したのは解除側の配線であり、そこを
 * 実ライフサイクルへ通す。
 */
function sceneWithKouyou(): Scene {
  const snapshot = loadAoiSnapshot();
  const markerAction = snapshot.effectActions.get(AOI_MARKER_EFFECT_ID as never)!;
  const critDownAction = snapshot.effectActions.get(AOI_CRIT_DOWN_EFFECT_ID as never)!;
  if (markerAction.kind !== "APPLY_MARKER" || critDownAction.kind !== "APPLY_STAT_MOD") {
    throw new Error("production Catalog no longer matches the shape this test assumes");
  }

  const granter = actorFor(AOI_UNIT_ID, "B_1:unit:1", "ALLY");
  const holder = actorFor(AOI_UNIT_ID, "B_1:unit:2", "ENEMY");
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  const context = {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId: seed.eventId,
  };

  const marked = applyMarker(
    context,
    [granter, holder],
    {
      markerId: markerAction.payload.markerId,
      sourceId: granter.battleUnitId,
      targetId: holder.battleUnitId,
      stackPolicy: markerAction.payload.stack.policy,
      stackMax: markerAction.payload.stack.max,
      durationDefinition: markerAction.payload.duration,
    },
    seed.eventId,
  );
  const debuffed = grantEffect(
    context,
    marked.units,
    {
      definition: critDownAction,
      sourceId: granter.battleUnitId,
      targetId: holder.battleUnitId,
      duplicate: true,
      magnitude: -0.25,
      durationDefinition: critDownAction.payload.duration,
    },
    marked.lastEventId,
  );

  // `grantEffect`自身はCombatStatを再計算しない（実行器では
  // `effect-action-group-resolver.ts`が付与後に`recalculateCombatStats`を呼ぶ）。
  // 解除側の再計算が基礎値へ戻すことを検証するため、付与直後の再計算結果に
  // 相当する会心率をここで反映しておく。
  const unitsAfterGrant = debuffed.units.map((unit) =>
    unit.battleUnitId === holder.battleUnitId
      ? {
          ...unit,
          combatStats: {
            ...unit.combatStats,
            criticalRate: BASE_CRITICAL_RATE * (1 - 0.25),
          },
        }
      : unit,
  );

  return {
    recorder,
    units: unitsAfterGrant,
    granterId: granter.battleUnitId,
    holderId: holder.battleUnitId,
    definitions: {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(snapshot.effectActions),
      unitDefinitions: new Map(snapshot.units),
      skillDefinitions: new Map(snapshot.skills),
    },
    seedEventId: seed.eventId,
  };
}

/** 独立Reducerの復元結果と突き合わせる、1ユニット分の観測可能な状態。 */
function snapshotOf(unit: BattleUnit): BattleStateSnapshot["units"][BattleUnitId] {
  return {
    hp: unit.currentHp,
    ap: unit.currentAp,
    pp: unit.currentPp,
    extraGauge: unit.currentExtraGauge,
    maximumAp: unit.maximumAp,
    maximumPp: unit.maximumPp,
    maximumExtraGauge: unit.maximumExtraGauge,
    combatStats: unit.combatStats,
    ...(unit.appliedEffects.length > 0
      ? { effects: unit.appliedEffects.map((effect) => toEffectSnapshot(effect, true)) }
      : {}),
    ...(unit.markerStates.length > 0
      ? { markers: unit.markerStates.map((marker) => toMarkerSnapshot(marker)) }
      : {}),
  };
}

/** 付与者を戦闘不能にし、その`UnitDefeated`を実ライフサイクルへ流す。 */
function defeatGranter(scene: Scene): readonly BattleUnit[] {
  const unitsWithDefeatedGranter = scene.units.map((unit) =>
    unit.battleUnitId === scene.granterId ? { ...unit, currentHp: 0 } : unit,
  );
  const defeated = scene.recorder.record({
    eventType: "UnitDefeated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: scene.recorder.nextResolutionScopeId(),
    parentEventId: scene.seedEventId,
    rootEventId: scene.seedEventId,
    targetUnitIds: [scene.granterId],
    payload: { unitId: scene.granterId, causeEventId: scene.seedEventId },
  });
  const runtime = new PassiveActivationRuntime(
    {
      definitions: scene.definitions,
      random: new SequenceRandomSource([]),
      recorder: scene.recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: defeated.resolutionScopeId,
      rootEventId: scene.seedEventId,
    },
    unitsWithDefeatedGranter,
  );
  return runtime.onFactEvent(defeated, unitsWithDefeatedGranter).units;
}

describe("production Catalog removeOnSourceDefeated (M7-020, Issue #279, R-EFF-10)", () => {
  it("IT-MARKER-SOURCE-DEFEAT-PROD-001: ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU declares removeOnSourceDefeated as the group's PARENT, and neither CHILD declares it", () => {
    const snapshot = loadAoiSnapshot();
    const marker = snapshot.effectActions.get(AOI_MARKER_EFFECT_ID as never)!;
    expect(marker.kind).toBe("APPLY_MARKER");
    if (marker.kind !== "APPLY_MARKER") {
      return;
    }
    expect(marker.payload.duration.removeOnSourceDefeated).toBe(true);
    expect(marker.payload.duration.linkedEffectGroupId).toBe(AOI_GROUP_ID);
    expect(marker.payload.duration.linkedEffectGroupRole).toBe("PARENT");

    // 子はMarkerの解除に連動するだけで、自身が付与者戦闘不能を契機にしない
    // （`catalog-integrity.ts`が非APPLY_MARKERへの宣言を拒否する裏付け）。
    for (const childId of [AOI_CRIT_DOWN_EFFECT_ID, AOI_DOT_EFFECT_ID]) {
      const child = snapshot.effectActions.get(childId as never)!;
      const duration =
        child.kind === "APPLY_STAT_MOD" || child.kind === "APPLY_CONTINUOUS_DAMAGE"
          ? child.payload.duration
          : undefined;
      expect(duration?.linkedEffectGroupRole).toBe("CHILD");
      expect(duration?.removeOnSourceDefeated).toBeUndefined();
    }
  });

  it("IT-MARKER-SOURCE-DEFEAT-PROD-002 (real lifecycle wiring): the granter's UnitDefeated removes 「高揚」 with reason SOURCE_DEFEATED and cascades its CHILD away, restoring base CRITICAL_RATE", () => {
    const scene = sceneWithKouyou();
    const holderBefore = scene.units.find((u) => u.battleUnitId === scene.holderId)!;
    expect(holderBefore.markerStates).toHaveLength(1);
    expect(holderBefore.combatStats.criticalRate).toBeCloseTo(BASE_CRITICAL_RATE * (1 - 0.25), 9);

    const eventsBefore = scene.recorder.getEvents().length;
    const units = defeatGranter(scene);

    const holder = units.find((u) => u.battleUnitId === scene.holderId)!;
    expect(holder.markerStates).toHaveLength(0);
    expect(holder.appliedEffects).toHaveLength(0);
    expect(holder.combatStats.criticalRate).toBe(BASE_CRITICAL_RATE);

    const removals = scene.recorder
      .getEvents()
      .slice(eventsBefore)
      .filter((e) => e.eventType === "EffectExpired" || e.eventType === "MarkerRemoved");
    // R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」。
    expect(removals.map((e) => e.eventType)).toEqual(["EffectExpired", "MarkerRemoved"]);
    expect(removals[0]!.payload).toMatchObject({
      effectActionDefinitionId: AOI_CRIT_DOWN_EFFECT_ID,
      reason: "LINKED_GROUP_CASCADE",
      linkedEffectGroupId: AOI_GROUP_ID,
      cascaded: true,
    });
    expect(removals[1]!.payload).toMatchObject({
      markerId: AOI_MARKER_ID,
      reason: "SOURCE_DEFEATED",
      linkedEffectGroupId: AOI_GROUP_ID,
      cascaded: false,
    });
  });

  it("IT-MARKER-SOURCE-DEFEAT-PROD-003 (independent Reducer restoration): applying only the removal StateDeltas to the pre-defeat snapshot leaves neither 「高揚」 nor its CHILD behind", () => {
    const scene = sceneWithKouyou();
    const eventsBefore = scene.recorder.getEvents().length;
    const initial: BattleStateSnapshot = {
      status: "READY",
      currentTurn: 1,
      units: {
        [scene.holderId]: snapshotOf(scene.units.find((u) => u.battleUnitId === scene.holderId)!),
      },
    };
    const units = defeatGranter(scene);

    const reduced = scene.recorder
      .getEvents()
      .slice(eventsBefore)
      .reduce(
        (state, event) =>
          event.stateDelta === undefined ? state : applyStateDelta(state, event.stateDelta),
        initial,
      );

    const holder = units.find((u) => u.battleUnitId === scene.holderId)!;
    const restored = reduced.units[scene.holderId]!;
    expect(restored.effects ?? []).toHaveLength(0);
    expect(restored.markers ?? []).toHaveLength(0);
    expect(restored).toEqual(snapshotOf(holder));
  });
});
