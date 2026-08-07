import { describe, expect, it } from "vitest";
import {
  calculateContinuousDamage,
  grantPoisonContinuousDamage,
} from "./continuous-damage-service.js";
import type { GrantEffectContext, GrantEffectRequest } from "../effects/effect-grant-service.js";
import { CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY } from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import type { createDomainEventId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string, currentHp?: number): BattleUnit {
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
  const built = createBattleUnit(member, "ALLY", LIMITS);
  return currentHp === undefined
    ? built
    : { ...built, currentHp: createHitPoint(currentHp, member.combatStats.maximumHp) };
}

/** 付与済みの効果を保ったままHPだけを差し替える（再付与前に対象が被弾した状況）。 */
function unitWithPoison(target: BattleUnit, currentHp: number): BattleUnit {
  return {
    ...target,
    currentHp: createHitPoint(currentHp, target.combatStats.maximumHp),
  };
}

/**
 * R-DOT-04の統合は既存インスタンスの毒効果率をCatalogから引く必要がある
 * （両候補を統合時点の同じ現在HPで評価するため）。
 */
function effectActionsOf(
  ...definitions: readonly EffectActionDefinition[]
): ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> {
  return new Map(definitions.map((d) => [d.effectActionDefinitionId, d]));
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

function poisonDefinition(
  id: string,
  ratio: number,
  count: number,
): Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_DAMAGE" }> {
  return {
    kind: "APPLY_CONTINUOUS_DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
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
  targetUnitId: string,
  sourceUnitId: string,
  magnitude: number,
  sourceAttack: number,
  durationCount: number,
): GrantEffectRequest {
  return {
    definition,
    sourceUnitId: createBattleUnitId(sourceUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
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
      effectActionsOf(definition),
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

    // 対象は満タン（現在HP 1000）。1件目の効果量は min(1000×10%, 50) = 50、期間5。
    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(weakButLong, "target-1", "source-1", 100, 50, 5),
      effectActionsOf(weakButLong, strongButShort),
      rootEventId,
    );
    // 2件目: 効果量 min(1000×20%, 300) = 200 > 50 なので効果量は差し替え。
    //         期間1 < 5 なので期間は既存を維持する（別々の付与元から採用する）。
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(strongButShort, "target-1", "source-2", 200, 300, 1),
      effectActionsOf(weakButLong, strongButShort),
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
      // 採用判断の基準（統合時点の現在HP 1000で評価した1回あたりダメージ）。
      tickDamageBefore: 50,
      tickDamageAfter: 200,
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
      effectActionsOf(strongShort, weakLong),
      rootEventId,
    );
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(weakLong, "target-1", "source-2", 100, 50, 4),
      effectActionsOf(strongShort, weakLong),
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
      effectActionsOf(strong, weak),
      rootEventId,
    );
    const eventsBefore = recorder.getEvents().length;
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(weak, "target-1", "source-2", 100, 50, 2),
      effectActionsOf(strong, weak),
      rootEventId,
    );

    expect(second.units).toBe(first.units);
    expect(second.lastEventId).toBe(rootEventId);
    expect(recorder.getEvents()).toHaveLength(eventsBefore);
  });

  it("UT-R-DOT-04-007 (boundary): the poison magnitude comparison uses min(ratio damage, snapshot attack), so a huge ratio capped low loses to a smaller uncapped one", () => {
    const { recorder, rootEventId } = seedRecorder();
    // 既存: 割合ダメージ 1000×100% = 1000 だが上限10 → 実効10。
    const cappedLow = poisonDefinition("ACT_POISON_A", 1.0, 2);
    // 新規: 割合ダメージ 1000×5% = 50、上限500 → 実効50。
    const uncapped = poisonDefinition("ACT_POISON_B", 0.05, 2);

    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(cappedLow, "target-1", "source-1", 1000, 10, 2),
      effectActionsOf(cappedLow, uncapped),
      rootEventId,
    );
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(uncapped, "target-1", "source-2", 50, 500, 2),
      effectActionsOf(cappedLow, uncapped),
      rootEventId,
    );

    const merged = second.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!
      .appliedEffects[0]!;
    expect(merged.magnitude).toBe(50);
    expect(merged.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]).toBe(500);
  });

  it("UT-R-DOT-04-009 (regression): both candidates are compared at the re-application's current HP, so a 20% poison applied after the target lost HP still displaces a 10% poison granted at full HP", () => {
    const { recorder, rootEventId } = seedRecorder();
    // production Catalogに実在する組み合わせ（10%毒と20%毒）。上限は両者とも
    // 十分に高く、判断を分けるのは割合ダメージだけになるようにする。
    const tenPercent = poisonDefinition("ACT_POISON_A", 0.1, 2);
    const twentyPercent = poisonDefinition("ACT_POISON_B", 0.2, 2);
    const effectActions = effectActionsOf(tenPercent, twentyPercent);

    // 満タン（HP 1000）で10%毒を付与する。保存される割合ダメージは 1000×10% = 100。
    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(tenPercent, "target-1", "source-1", 100, 1000, 2),
      effectActions,
      rootEventId,
    );
    expect(first.appliedEffect.magnitude).toBe(100);

    // 対象がHP 300まで削られてから20%毒を再付与する。この時点の割合ダメージは
    // 10%毒が 300×10% = 30、20%毒が 300×20% = 60 であり、20%毒の方が大きい。
    const damagedUnits = first.units.map((u) =>
      u.battleUnitId === createBattleUnitId("target-1") ? unitWithPoison(u, 300) : u,
    );
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      damagedUnits,
      poisonRequest(twentyPercent, "target-1", "source-2", 60, 1000, 2),
      effectActions,
      rootEventId,
    );

    const merged = second.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!
      .appliedEffects[0]!;
    // 保存値どうし（100 対 60）で比べると10%毒が残ってしまうが、実際の毒ダメージは
    // 同じ現在HP 300に対して30対60なので、R-DOT-04は20%毒を採用しなければならない。
    expect(merged.effectActionDefinitionId).toBe(createEffectActionDefinitionId("ACT_POISON_B"));
    expect(merged.magnitude).toBe(60);

    const mergedEvent = recorder.getEvents().find((e) => e.eventType === "EffectMerged")!;
    expect(mergedEvent.payload).toMatchObject({
      // 採用判断は統合時点の現在HP 300で評価した1回あたりダメージで行う。
      tickDamageBefore: 30,
      tickDamageAfter: 60,
      magnitudeBefore: 100,
      magnitudeAfter: 60,
    });
  });

  it("UT-R-DOT-04-010 (regression): the same comparison keeps the stronger existing poison when the target's HP change does not overturn it", () => {
    const { recorder, rootEventId } = seedRecorder();
    const twentyPercent = poisonDefinition("ACT_POISON_A", 0.2, 2);
    const tenPercent = poisonDefinition("ACT_POISON_B", 0.1, 2);
    const effectActions = effectActionsOf(twentyPercent, tenPercent);

    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1")],
      poisonRequest(twentyPercent, "target-1", "source-1", 200, 1000, 2),
      effectActions,
      rootEventId,
    );
    const damagedUnits = first.units.map((u) =>
      u.battleUnitId === createBattleUnitId("target-1") ? unitWithPoison(u, 300) : u,
    );
    const eventsBefore = recorder.getEvents().length;
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      damagedUnits,
      poisonRequest(tenPercent, "target-1", "source-2", 30, 1000, 2),
      effectActions,
      rootEventId,
    );

    // HP 300での実効値は60対30。既存が勝ち、期間も同じなので何も変わらない。
    expect(second.units).toBe(damagedUnits);
    expect(recorder.getEvents()).toHaveLength(eventsBefore);
  });

  it("UT-R-DOT-04-011 (boundary): the magnitude comparison happens before R-DOT-01 rounding, so a 20% poison still displaces a 10% poison when both would deal the minimum 1 damage", () => {
    const { recorder, rootEventId } = seedRecorder();
    const tenPercent = poisonDefinition("ACT_POISON_A", 0.1, 2);
    const twentyPercent = poisonDefinition("ACT_POISON_B", 0.2, 2);
    const effectActions = effectActionsOf(tenPercent, twentyPercent);

    // 現在HP 9まで削られた対象。上限（付与時攻撃力）は十分高く、判断を分けるのは
    // 割合ダメージだけになる。10%毒は0.9、20%毒は1.8であり効果量は20%毒の方が大きい。
    const first = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      [unit("source-1"), unit("target-1", 9)],
      poisonRequest(tenPercent, "target-1", "source-1", 0.9, 1000, 2),
      effectActions,
      rootEventId,
    );
    const second = grantPoisonContinuousDamage(
      contextOf(recorder, rootEventId),
      first.units,
      poisonRequest(twentyPercent, "target-1", "source-2", 1.8, 1000, 2),
      effectActions,
      rootEventId,
    );

    // R-DOT-01の切り捨て・最低1を先に適用すると 0.9→1 と 1.8→1 が同値に潰れ、
    // 10%毒が残ってしまう。効果量は丸め前で比較しなければならない。
    const merged = second.units.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!
      .appliedEffects[0]!;
    expect(merged.effectActionDefinitionId).toBe(createEffectActionDefinitionId("ACT_POISON_B"));
    expect(merged.magnitude).toBeCloseTo(1.8);

    const mergedEvent = recorder.getEvents().find((e) => e.eventType === "EffectMerged")!;
    const payload = mergedEvent.payload as { tickDamageBefore: number; tickDamageAfter: number };
    // 比較基準は丸め前の値なので、1未満・非整数のまま記録される。
    expect(payload.tickDamageBefore).toBeCloseTo(0.9);
    expect(payload.tickDamageAfter).toBeCloseTo(1.8);

    // どちらの候補でも、この時点で実際に与えるダメージはR-DOT-01の最低1で同じ1になる。
    // 差が現れるのは対象のHPが回復した後である（10%なら10、20%なら20）。
    const healed = second.units.map((u) =>
      u.battleUnitId === createBattleUnitId("target-1") ? unitWithPoison(u, 100) : u,
    );
    const holder = healed.find((u) => u.battleUnitId === createBattleUnitId("target-1"))!;
    expect(
      calculateContinuousDamage(merged, twentyPercent, holder, undefined, healed).calculatedDamage,
    ).toBe(20);
  });
});
