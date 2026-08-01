import { describe, expect, it } from "vitest";
import { grantPoisonContinuousDamage } from "./poison-grant-service.js";
import type { GrantEffectContext, GrantEffectRequest } from "./effect-grant-service.js";
import { CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY } from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import type { createDomainEventId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", LIMITS);
}

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<typeof createDomainEventId>;
} {
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

function poisonDuration(count: number): DurationDefinition {
  return { timeLimit: { unit: "ACTION", count }, dispellable: true, linkedEffectGroupId: null };
}

function poisonDefinition(id: string, ratio: number, count: number): EffectActionDefinition {
  return {
    kind: "APPLY_CONTINUOUS_DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      continuousDamageKind: "POISON",
      damageType: "PHYSICAL",
      formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio },
      timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
      duration: poisonDuration(count),
    },
  };
}

function poisonRequest(
  definition: EffectActionDefinition,
  targetId: string,
  sourceId: string,
  magnitude: number,
  sourceAttack: number,
  durationCount: number,
): GrantEffectRequest {
  return {
    definition,
    sourceId: createBattleUnitId(sourceId),
    targetId: createBattleUnitId(targetId),
    duplicate: true,
    magnitude,
    continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
    durationDefinition: poisonDuration(durationCount),
    snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: sourceAttack },
  };
}

function contextOf(recorder: EventRecorder, rootEventId: GrantEffectContext["rootEventId"]) {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
  } satisfies GrantEffectContext;
}

describe("grantPoisonContinuousDamage (R-DOT-04, DMG-008 Issue #189)", () => {
  it("UT-R-DOT-04-003: grants a brand-new poison instance when the target carries none", () => {
    const { recorder, rootEventId } = seedRecorder();
    const definition = poisonDefinition("ACT_POISON_A", 0.1, 2);

    const result = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(definition, "target-1", "source-1", 100, 50, 2),
      rootEventId,
    );

    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectMerged")).toBe(false);
    const target = result.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]!.continuousDamage?.continuousDamageKind).toBe("POISON");
  });

  it("UT-R-DOT-04-004: re-applying keeps exactly one poison, taking the longer duration and the larger magnitude from whichever source won each", () => {
    const { recorder, rootEventId } = seedRecorder();
    const weakButLong = poisonDefinition("ACT_POISON_A", 0.1, 5);
    const strongButShort = poisonDefinition("ACT_POISON_B", 0.2, 1);

    // 1件目: 効果量 min(100, 50) = 50、期間5。
    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(weakButLong, "target-1", "source-1", 100, 50, 5),
      rootEventId,
    );
    // 2件目: 効果量 min(200, 300) = 200 > 50 なので効果量は差し替え。
    //         期間1 < 5 なので期間は既存を維持する（別々の付与元から採用する）。
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(strongButShort, "target-1", "source-2", 200, 300, 1),
      rootEventId,
    );

    const target = second.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!;
    expect(target.appliedEffects).toHaveLength(1);
    const merged = target.appliedEffects[0]!;
    // 統合先は既存インスタンスであり、IDは維持される。
    expect(merged.effectInstanceId).toBe(first.appliedEffect.effectInstanceId);
    expect(merged.magnitude).toBe(200);
    expect(merged.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]).toBe(300);
    expect(merged.effectActionDefinitionId).toBe(createEffectActionDefinitionId("ACT_POISON_B"));
    expect(merged.duration.timeLimitRemaining).toBe(5);

    const mergedEvent = recorder.getEvents().find((e) => e.eventType === "EffectMerged")!;
    expect(mergedEvent.payload).toMatchObject({
      reason: "POISON_REAPPLY",
      magnitudeBefore: 100,
      magnitudeAfter: 200,
      snapshotAttackBefore: 50,
      snapshotAttackAfter: 300,
      remainingBefore: 5,
      remainingAfter: 5,
    });
    // 新規インスタンスは追加しないため`EffectApplied`は1件目の分だけ。
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectApplied")).toHaveLength(1);
  });

  it("UT-R-DOT-04-005: re-applying takes the longer duration even when the existing magnitude wins", () => {
    const { recorder, rootEventId } = seedRecorder();
    const strongShort = poisonDefinition("ACT_POISON_A", 0.2, 1);
    const weakLong = poisonDefinition("ACT_POISON_B", 0.1, 4);

    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(strongShort, "target-1", "source-1", 200, 300, 1),
      rootEventId,
    );
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(weakLong, "target-1", "source-2", 100, 50, 4),
      rootEventId,
    );

    const merged = second.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!
      .appliedEffects[0]!;
    expect(merged.magnitude).toBe(200);
    expect(merged.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]).toBe(300);
    // 効果量側は据え置きなので、採用元の定義IDも既存のまま。
    expect(merged.effectActionDefinitionId).toBe(createEffectActionDefinitionId("ACT_POISON_A"));
    expect(merged.duration.timeLimitRemaining).toBe(4);
  });

  it("UT-R-DOT-04-006 (不成立): re-applying a strictly weaker and shorter poison changes nothing and emits no event", () => {
    const { recorder, rootEventId } = seedRecorder();
    const strong = poisonDefinition("ACT_POISON_A", 0.2, 4);
    const weak = poisonDefinition("ACT_POISON_B", 0.1, 2);

    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(strong, "target-1", "source-1", 200, 300, 4),
      rootEventId,
    );
    const eventsBefore = recorder.getEvents().length;
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(weak, "target-1", "source-2", 100, 50, 2),
      rootEventId,
    );

    expect(second.units).toBe(first.units);
    expect(second.lastEventId).toBe(rootEventId);
    expect(recorder.getEvents()).toHaveLength(eventsBefore);
  });

  it("UT-R-DOT-04-007 (boundary): the poison magnitude comparison uses min(ratio damage, snapshot attack), so a huge ratio capped low loses to a smaller uncapped one", () => {
    const { recorder, rootEventId } = seedRecorder();
    // 既存: 割合ダメージ1000だが上限10 → 実効10。
    const cappedLow = poisonDefinition("ACT_POISON_A", 1.0, 2);
    // 新規: 割合ダメージ50、上限500 → 実効50。
    const uncapped = poisonDefinition("ACT_POISON_B", 0.05, 2);

    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(cappedLow, "target-1", "source-1", 1000, 10, 2),
      rootEventId,
    );
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(uncapped, "target-1", "source-2", 50, 500, 2),
      rootEventId,
    );

    const merged = second.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!
      .appliedEffects[0]!;
    expect(merged.magnitude).toBe(50);
    expect(merged.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]).toBe(500);
  });
});
