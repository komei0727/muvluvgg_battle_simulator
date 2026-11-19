import { describe, expect, it } from "vitest";
import { applyDamageAction } from "./damage-application-service.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import { isDefeated } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  damageAction,
  hit,
  damageEventContext,
  STAT_MOD_DEFINITION_ID,
  statModDefinition,
  testConsumeEffectDuration,
} from "../../../testing/fixtures/damage-application.js";

/**
 * DMG-006（R-INT-01〜03）: 防御介入を実際のダメージpipelineへ配線した
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
    sourceUnitId: createBattleUnitId(holderId),
    targetUnitId: createBattleUnitId(holderId),
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
  targetUnitId: string,
  consumptionRemaining: number,
  survivalHp = 1,
): AppliedEffect {
  return interventionEffect(id, targetUnitId, {
    categories: ["BUFF"],
    deathSurvival: {
      survivalHp: { kind: "CONSTANT", value: survivalHp },
      healAfterSurvival: null,
      healTiming: "ON_SURVIVAL",
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

describe("defensive interventions in the damage pipeline (DMG-006 R-INT-01〜03)", () => {
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
    expect(result.hits[0]!.targetUnitId).toBe(taunter.battleUnitId);
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

  it("UT-R-INT-03-012: a reflect holder killed by the original hit still reflects that hit's confirmed share (R-INT-03)", () => {
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
    // 元ヒット20で倒れても、そのヒット分の反射20 × 75% = 15は確定して発生する。
    expect(
      context.recorder
        .getEvents()
        .filter((e) => e.eventType === "ReflectedDamageGenerated")
        .map((e) => (e.payload as { reflectedDamage: number }).reflectedDamage),
    ).toEqual([15]);
    expect(result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!.currentHp).toBe(85);
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
    // R-LNK-02: リンク分は元ダメージから差し引いて分配する（総被害は20のまま増えない）。
    expect(originalApplied.payload).toMatchObject({ calculatedDamage: 10, hitPointDamage: 10 });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(90);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(90);
  });

  it("UT-R-LNK-02-010: multiple links take their own rate in grant order, capped by the undistributed remainder so the total never exceeds the original damage", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [
        damageLinkHeldByDamaged("LINK_A", "TARGET", "PEER_A", 0.75),
        damageLinkHeldByDamaged("LINK_B", "TARGET", "PEER_B", 0.5),
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
    ).toEqual([15, 5]);
    // 20のうちAが75%=15、Bは50%=10を残り5で頭打ち。元対象には0が残る。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(100);
    expect(result.units.find((u) => u.battleUnitId === peerA.battleUnitId)!.currentHp).toBe(85);
    expect(result.units.find((u) => u.battleUnitId === peerB.battleUnitId)!.currentHp).toBe(95);
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

    // 相互リンクでも1回で止まる（無限往復しない）。100%リンクなので元対象の分は0。
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "LinkedDamageGenerated"),
    ).toHaveLength(1);
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(100);
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

  it("UT-R-LNK-01-011: a link holder killed by its share of the original hit still sends the distributed share to the destination", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const dying = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(5, 100),
      appliedEffects: [damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 0.5)],
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

    // 20を元対象10・リンク先10へ分配。元対象はHP5で倒れても、分配した10は失われない。
    expect(isDefeated(result.units.find((u) => u.battleUnitId === dying.battleUnitId)!)).toBe(true);
    expect(
      context.recorder
        .getEvents()
        .filter((e) => e.eventType === "LinkedDamageGenerated")
        .map((e) => (e.payload as { linkedDamage: number }).linkedDamage),
    ).toEqual([10]);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(90);
  });

  it("UT-R-LNK-01-013: a link and a reflect from a holder killed by the original hit keep going after the destination's shield absorbs part of them", () => {
    const shieldOf = (id: string, holderId: string): AppliedEffect =>
      interventionEffect(id, holderId, {
        magnitude: 3,
        categories: ["SHIELD"],
        shield: { shieldType: "PHYSICAL", remaining: 3 },
      });
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 }),
      appliedEffects: [shieldOf("ATTACKER_SHIELD", "ATTACKER")],
    };
    const dying = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(5, 100),
      appliedEffects: [
        damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 0.5),
        reflectHeldByDefender("REFLECT", "TARGET", 0.75),
      ],
    };
    const peer = {
      ...unit("PEER", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [shieldOf("PEER_SHIELD", "PEER")],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [attacker, dying, peer],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    // 20を元対象10・リンク先10へ分配し、元対象はHP5で倒れる。リンク10は盾3の後に残り7が
    // HPへ、反射15（20×75%）は攻撃者の盾3の後に残り12がHPへ届く。
    expect(isDefeated(result.units.find((u) => u.battleUnitId === dying.battleUnitId)!)).toBe(true);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(93);
    expect(result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!.currentHp).toBe(88);
    const derivedApplied = context.recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "DamageApplied" &&
          ((e.payload as { isLinkedDamage?: true }).isLinkedDamage === true ||
            (e.payload as { isReflectedDamage?: true }).isReflectedDamage === true),
      )
      .map((e) => e.payload as { typedShieldAbsorbed: number; hitPointDamage: number });
    expect(derivedApplied).toMatchObject([
      { typedShieldAbsorbed: 3, hitPointDamage: 7 },
      { typedShieldAbsorbed: 3, hitPointDamage: 12 },
    ]);
  });

  it("UT-R-LNK-02-013 (BOUNDARY): the linked share is truncated without a 1-damage floor, so a share truncated to 0 does not link and the original keeps the whole hit", () => {
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
      context.recorder.getEvents().filter((e) => e.eventType === "LinkedDamageGenerated"),
    ).toEqual([]);
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(99);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-LNK-01-012: the share is split before the original target's shield, so a shield absorbing the whole remaining share still sends the link share", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const targetShield: AppliedEffect = interventionEffect("TARGET_SHIELD", "TARGET", {
      magnitude: 50,
      categories: ["SHIELD"],
      shield: { shieldType: "PHYSICAL", remaining: 50 },
    });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [targetShield, damageLinkHeldByDamaged("LINK", "TARGET", "PEER", 0.35)],
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

    // 20 × 35% = 7をリンク先へ、残り13を元対象の盾が吸収する。
    const originalApplied = context.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "DamageApplied" &&
          (e.payload as { targetUnitId: string }).targetUnitId === target.battleUnitId,
      )!;
    expect(originalApplied.payload).toMatchObject({
      calculatedDamage: 13,
      typedShieldAbsorbed: 13,
      hitPointDamage: 0,
    });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(100);
    expect(result.units.find((u) => u.battleUnitId === peer.battleUnitId)!.currentHp).toBe(93);
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
