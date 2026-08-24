import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  unit,
  damageAction,
  contextFor,
  seedRecorder,
  singleActionStep,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyEffectActionGroups", () => {
  it("UT-R-BON-ATTACK-DMG-001 [R-DMG-06] (R-DMG-06 #1, mirrors SKL_ELENA_MOODMAKER_EX): an APPLY_ATTACK_DAMAGE_BONUS ACTION step evaluates its formula once at grant time (STAT_RATIO(SKILL_SOURCE, ATTACK, 0.15)) and stores the result as magnitude on an isAttackDamageBonus AppliedEffect", () => {
    // R-DMG-06 #1: 加算量の基準は**付与者**であり、バフを受け取る側の攻撃力ではない。
    // 対象へ違う攻撃力を持たせて、`SKILL_SOURCE`側が読まれていることを分ける。
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("X", "ALLY").combatStats, attack: 40 },
    });
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("X", "ENEMY").combatStats, attack: 999 },
    });
    const bonus: EffectActionDefinition = {
      kind: "APPLY_ATTACK_DAMAGE_BONUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
      metadata: { tags: [] },
      payload: {
        formula: {
          kind: "STAT_RATIO",
          source: { kind: "SKILL_SOURCE" },
          stat: "ATTACK",
          ratio: 0.15,
        },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[bonus.effectActionDefinitionId, bonus]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, bonus.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      isAttackDamageBonus: true,
      magnitude: 6, // 付与者(ACTOR)の攻撃力40 * 0.15。対象の999は読まない。
    });
  });

  it("UT-R-FUP-01-007 (Issue #474, mirrors SKL_SUIRAN_CHAOS_PS3): an APPLY_FOLLOW_UP_ATTACK ACTION step grants an isFollowUpAttack AppliedEffect that keeps its NEXT_OUTGOING_ATTACK consumption and stacks with an existing instance", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_ATTACKER", "ALLY");
    const rider: EffectActionDefinition = {
      kind: "APPLY_FOLLOW_UP_ATTACK",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_FOLLOW_UP"),
      metadata: { tags: [] },
      payload: {
        damage: { damageType: "EN", formula: { kind: "SKILL_POWER", power: 0.3588 } },
        onHitEffect: {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FUP_SPEED_DOWN"),
        },
        duration: {
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[rider.effectActionDefinitionId, rider]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, ally.battleUnitId, rider.effectActionDefinitionId),
        singleActionStep(1, true, ally.battleUnitId, rider.effectActionDefinitionId),
      ],
      targetUnitIds: [ally.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, ally], context);

    // 重複可: 2度の付与が2インスタンスとして共存し、それぞれが消費残数1を持つ。
    const target = result.units.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(2);
    for (const effect of target.appliedEffects) {
      expect(effect).toMatchObject({
        isFollowUpAttack: true,
        duplicate: true,
        duration: { consumptionRemaining: 1 },
      });
    }
  });
});

describe("APPLY_DAMAGE_MOD (R-DMG-03, R-DMG-04, DMG-002 Issue #192)", () => {
  function damageModAction(
    id: string,
    payload: Extract<EffectActionDefinition, { kind: "APPLY_DAMAGE_MOD" }>["payload"],
  ): EffectActionDefinition {
    return {
      kind: "APPLY_DAMAGE_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload,
    };
  }

  const BATTLE_LONG = {
    timeLimit: { unit: "BATTLE", count: 1 },
    dispellable: true,
    linkedEffectGroupId: null,
  } as const;

  function pierceDamageAction(
    id: string,
    damageReductionIgnoreRate: number,
  ): EffectActionDefinition {
    const base = damageAction(id);
    if (base.kind !== "DAMAGE") {
      throw new Error("damageAction must build a DAMAGE EffectAction");
    }
    return {
      ...base,
      payload: {
        ...base.payload,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate },
      },
    };
  }

  it("UT-R-DMG-04-010 (full stack): an APPLY_DAMAGE_MOD grants an AppliedEffect carrying the direction, damageType and evaluated signed rate", () => {
    const actor = unit("ACTOR", "ALLY");
    const mod = damageModAction("ACT_DMG_UP", {
      direction: "OUTGOING",
      damageType: "EN",
      formula: { kind: "CONSTANT", value: 0.1 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const effectActions = new Map([[mod.effectActionDefinitionId, mod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor], context);

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(1);
    expect(updated.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: mod.effectActionDefinitionId,
      magnitude: 0.1,
      duplicate: true,
      damageModifier: { direction: "OUTGOING", damageType: "EN" },
    });
    expect(
      recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload.resultKind,
    ).toBe("APPLIED");
  });

  it("UT-R-DMG-07-001 (full stack): an APPLY_DAMAGE_MOD with a damageThreshold bakes the threshold into the granted AppliedEffect", () => {
    const actor = unit("ACTOR", "ALLY");
    const mod = damageModAction("ACT_THRESHOLD_GUARD", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.2 },
      },
      stacking: { mode: "STACKABLE" },
      duration: {
        ...BATTLE_LONG,
        consumption: { kind: "INCOMING_HIT", maxCount: 3 },
      },
    });
    const effectActions = new Map([[mod.effectActionDefinitionId, mod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor], context);

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(1);
    expect(updated.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: mod.effectActionDefinitionId,
      magnitude: -0.5,
      damageModifier: {
        direction: "INCOMING",
        damageType: null,
        damageThreshold: {
          op: "GT",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.2 },
        },
      },
    });
    expect(updated.appliedEffects[0]!.duration.consumptionRemaining).toBe(3);
  });

  it("UT-R-DMG-04-011 (full stack): the attacker's OUTGOING and the defender's INCOMING modifiers both scale the damage of a later DAMAGE step", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const outgoing = damageModAction("ACT_DMG_UP", {
      direction: "OUTGOING",
      damageType: null,
      formula: { kind: "CONSTANT", value: 0.5 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const incoming = damageModAction("ACT_DMG_DOWN", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.2 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [outgoing.effectActionDefinitionId, outgoing],
      [incoming.effectActionDefinitionId, incoming],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, actor.battleUnitId, outgoing.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, incoming.effectActionDefinitionId),
        singleActionStep(2, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [actor.battleUnitId, target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    // 基礎ダメージ = attack 20 - defense 10 = 10、与 1.5 倍・被 0.8 倍 -> 12
    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      outgoingDamageMultiplier: 1.5,
      incomingDamageMultiplier: 0.8,
      finalDamage: 12,
    });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(88);
  });

  it("UT-R-DMG-03-004 (full stack): the attacking skill's damageReductionIgnoreRate cancels the defender's reduction but not its increase", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const reduction = damageModAction("ACT_DMG_DOWN", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = pierceDamageAction("ACT_PIERCE", 1);
    const effectActions = new Map([
      [reduction.effectActionDefinitionId, reduction],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, reduction.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      damageReductionIgnoreRate: 1,
      incomingDamageMultiplier: 1,
      finalDamage: 10,
    });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(90);
  });

  it("UT-R-DMG-04-012 (full stack): a dynamic condition on the granted modifier is evaluated per hit, not at grant time", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY", { currentHp: 30 });
    // 「自分よりもHP割合が高い相手から攻撃された場合にのみ」被ダメージを減らす。
    const guard = damageModAction("ACT_GUARD", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      condition: { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [guard.effectActionDefinitionId, guard],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, guard.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    // 攻撃側 100/100 > 対象 30/100 なので条件成立 -> 10 * 0.5 = 5
    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({ incomingDamageMultiplier: 0.5, finalDamage: 5 });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(25);
  });

  it("UT-R-DMG-04-013 (full stack): the same dynamic condition suppresses the modifier when it does not hold", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
    const target = unit("TARGET", "ENEMY");
    const guard = damageModAction("ACT_GUARD", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      condition: { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [guard.effectActionDefinitionId, guard],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, guard.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({ incomingDamageMultiplier: 1, finalDamage: 10 });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(90);
  });
});

describe("APPLY_DAMAGE_MOD damageThreshold (R-DMG-07)", () => {
  function damageModAction(
    id: string,
    payload: Extract<EffectActionDefinition, { kind: "APPLY_DAMAGE_MOD" }>["payload"],
  ): EffectActionDefinition {
    return {
      kind: "APPLY_DAMAGE_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload,
    };
  }

  function thresholdGuardAction(
    id: string,
    thresholdRatio: number,
    maxCount: number,
  ): EffectActionDefinition {
    return damageModAction(id, {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: thresholdRatio },
      },
      stacking: { mode: "STACKABLE" },
      duration: {
        timeLimit: { unit: "BATTLE", count: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
        consumption: { kind: "INCOMING_HIT", maxCount },
      },
    });
  }

  function runGuardedAttack(
    guard: EffectActionDefinition,
    attack: EffectActionDefinition,
    hitCount = 1,
  ) {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const effectActions = new Map([
      [guard.effectActionDefinitionId, guard],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, guard.effectActionDefinitionId),
        {
          planKind: "ACTION_PLAN",
          stepIndex: 1,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          applications: [
            {
              targetUnitId: target.battleUnitId,
              effectActionDefinitionId: attack.effectActionDefinitionId,
              includeDefeated: false,
              hits: Array.from({ length: hitCount }, (_, index) => ({
                targetUnitId: target.battleUnitId,
                effectActionDefinitionId: attack.effectActionDefinitionId,
                hitIndex: index + 1,
              })),
            },
          ],
        },
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };
    const result = applyEffectActionGroups(plan, [actor, target], context);
    return { recorder, result, target };
  }

  it("UT-R-DMG-07-008 (full stack, mirrors アニスPS3): a hit exceeding the threshold is reduced by the separate multiplier and consumes only the applied instance", () => {
    // 基礎ダメージ = attack 20 - defense 10 = 10。閾値 = 現在HP100×5% = 5 < 10 -> 軽減成立。
    const { recorder, result, target } = runGuardedAttack(
      thresholdGuardAction("ACT_THRESHOLD_GUARD", 0.05, 3),
      damageAction("ACT_ATTACK"),
    );

    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({ incomingDamageMultiplier: 1, finalDamage: 5 });
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.currentHp).toBe(95);
    const consumption = recorder
      .getEvents()
      .filter((e) => e.eventType === "EffectConsumptionChanged");
    expect(consumption).toHaveLength(1);
    expect(consumption[0]!.payload).toMatchObject({ before: 3, after: 2 });
    expect(updated.appliedEffects[0]!.duration.consumptionRemaining).toBe(2);
    // R-EFF-07の既存経路と同じく、消費（とそれを契機とするPS連鎖）はこのヒットの
    // `DamageApplied`より後 — 失効起点の連鎖が計算済みヒットの適用前提を変えられない。
    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.indexOf("EffectConsumptionChanged")).toBeGreaterThan(
      eventTypes.indexOf("DamageApplied"),
    );
  });

  it("UT-R-DMG-07-009 (full stack, boundary): a hit at or below the threshold is untouched and consumes nothing", () => {
    // 閾値 = 現在HP100×20% = 20 >= 10 -> 軽減も消費も起きない。
    const { recorder, result, target } = runGuardedAttack(
      thresholdGuardAction("ACT_THRESHOLD_GUARD", 0.2, 3),
      damageAction("ACT_ATTACK"),
    );

    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({ incomingDamageMultiplier: 1, finalDamage: 10 });
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.currentHp).toBe(90);
    expect(
      recorder.getEvents().filter((e) => e.eventType === "EffectConsumptionChanged"),
    ).toHaveLength(0);
    expect(updated.appliedEffects[0]!.duration.consumptionRemaining).toBe(3);
  });

  it("UT-R-DMG-07-010 (full stack): exhausting the consumption expires the guard mid-attack, so the next hit of the same multi-hit attack is unreduced", () => {
    // maxCount 1、2ヒット攻撃: ヒット1は 10 > 5 で軽減(5)・消費0で失効、ヒット2は素通し(10)。
    const { recorder, result, target } = runGuardedAttack(
      thresholdGuardAction("ACT_THRESHOLD_GUARD", 0.05, 1),
      damageAction("ACT_ATTACK", 2),
      2,
    );

    const calculated = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageCalculated")
      .map((e) => e.payload.finalDamage);
    expect(calculated).toEqual([5, 10]);
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.currentHp).toBe(85);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectExpired")).toHaveLength(1);
    expect(updated.appliedEffects).toHaveLength(0);
  });
});
