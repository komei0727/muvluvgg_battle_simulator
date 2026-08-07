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
  it("UT-R-BON-ATTACK-DMG-001 (ON_ATTACK_BONUS_DAMAGE_BUFF, Issue #183, mirrors SKL_ELENA_MOODMAKER_EX): an APPLY_ATTACK_DAMAGE_BONUS ACTION step evaluates its formula once at grant time (STAT_RATIO(TARGET, ATTACK, 0.15)) and stores the result as magnitude on an isAttackDamageBonus AppliedEffect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("X", "ENEMY").combatStats, attack: 40 },
    });
    const bonus: EffectActionDefinition = {
      kind: "APPLY_ATTACK_DAMAGE_BONUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "STAT_RATIO", source: { kind: "TARGET" }, stat: "ATTACK", ratio: 0.15 },
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
      magnitude: 6, // 40 attack * 0.15
    });
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
