import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import { applyFollowUpAttacksSteps, type FollowUpAttackResult } from "./follow-up-attack.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  damageAction,
  hit,
  damageEventContext,
  skillPowerBonusEffect,
  skillPowerModifierEffect,
} from "../../../testing/fixtures/damage-application.js";
import { reproduceDamageCalculated } from "../../../testing/audit/damage-calculated-identity.js";

function damageCalculatedPayloads(context: DamageEventContext): readonly Record<string, unknown>[] {
  return context.recorder
    .getEvents()
    .filter((event) => event.eventType === "DamageCalculated")
    .map((event) => event.payload as Record<string, unknown>);
}

/** R-DMG-08: 攻撃側のスキル威力補正が、DAMAGEの全対象と追撃に乗ること。 */
describe("skill power modifier on damage application (R-DMG-08)", () => {
  it("UT-R-DMG-08-008: scales every target of the holder's DAMAGE and records the multiplier", () => {
    const context = damageEventContext();
    const attacker: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 60 }),
      appliedEffects: [skillPowerModifierEffect("EF_SP", "ATTACKER", -0.75)],
    };
    const first = unit("TARGET_1", "ENEMY", { defense: 10, maximumHp: 500 });
    const second = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 500 });

    const result = applyDamageAction(
      attacker,
      [hit("TARGET_1", 0), hit("TARGET_2", 0)],
      damageAction(),
      [attacker, first, second],
      new SequenceRandomSource([]),
      context,
    );

    // (60 - 10) × 威力1 × 0.25 = 12.5 → 12。
    const hpById = new Map(result.units.map((u) => [u.battleUnitId, u.currentHp]));
    expect(hpById.get(createBattleUnitId("TARGET_1"))).toBe(500 - 12);
    expect(hpById.get(createBattleUnitId("TARGET_2"))).toBe(500 - 12);
    const payloads = damageCalculatedPayloads(context);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ skillPower: 1, skillPowerMultiplier: 0.25, finalDamage: 12 });
    }
  });

  it("UT-R-DMG-08-009: also scales the holder's follow-up attack, which uses a SKILL_POWER formula", () => {
    const context = damageEventContext();
    const attacker: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 60 }),
      appliedEffects: [skillPowerModifierEffect("EF_SP", "ATTACKER", -0.75)],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });
    const working = new Map<BattleUnitId, BattleUnit>([
      [attacker.battleUnitId, attacker],
      [target.battleUnitId, target],
    ]);

    const gen = applyFollowUpAttacksSteps(
      context,
      working,
      new SequenceRandomSource([]),
      attacker.battleUnitId,
      [
        {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FOLLOW_UP_RIDER"),
          sourceUnitId: createBattleUnitId("GRANTOR"),
          damageType: "EN",
          formula: { kind: "SKILL_POWER", power: 1 },
        },
      ],
      [target.battleUnitId],
      false,
      context.parentEventId,
    );
    let step = gen.next();
    while (!step.done) {
      step = gen.next(step.value.units);
    }
    const result: FollowUpAttackResult = step.value;

    expect(result.interrupted).toBe(false);
    expect(working.get(target.battleUnitId)?.currentHp).toBe(500 - 12);
    expect(damageCalculatedPayloads(context)[0]).toMatchObject({
      skillPowerMultiplier: 0.25,
      finalDamage: 12,
    });
  });
});

/** R-DMG-08: 攻撃側のスキル威力の加算値が、多段攻撃の各ヒットと追撃に乗ること。 */
describe("skill power bonus on damage application (R-DMG-08)", () => {
  it("UT-R-DMG-08-020: adds the bonus to every hit of a multi-hit DAMAGE and records it", () => {
    const context = damageEventContext();
    const attacker: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 110 }),
      appliedEffects: [
        skillPowerBonusEffect("EF_SPB", "ATTACKER", 0.5),
        skillPowerModifierEffect("EF_SP", "ATTACKER", -0.5),
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 5000 });

    const result = applyDamageAction(
      attacker,
      [0, 1, 2, 3, 4].map((index) => hit("TARGET", index)),
      damageAction(),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // (110 - 10) × (威力1 + 0.5) × 0.5 = 75 を5ヒット。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)?.currentHp).toBe(
      5000 - 75 * 5,
    );
    const payloads = damageCalculatedPayloads(context);
    expect(payloads).toHaveLength(5);
    for (const payload of payloads) {
      expect(payload).toMatchObject({
        skillPower: 1,
        skillPowerBonus: 0.5,
        skillPowerMultiplier: 0.5,
        finalDamage: 75,
      });
    }
  });

  it("UT-R-DMG-08-027 [R-NUM-02]: the recorded calculation terms reproduce the final damage at the truncation boundary", () => {
    const context = damageEventContext();
    const attacker: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 1010 }),
      appliedEffects: [skillPowerBonusEffect("EF_SPB", "ATTACKER", 0.075)],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 5000 });
    const action = damageAction();
    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      { ...action, payload: { ...action.payload, formula: { kind: "SKILL_POWER", power: 0.848 } } },
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 基礎ダメージ1000 × (84.8 + 7.5) = 923。binary64の和のままでは922になる境界。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)?.currentHp).toBe(
      5000 - 923,
    );
    const [payload] = damageCalculatedPayloads(context);
    expect(payload).toMatchObject({ skillPower: 0.848, skillPowerBonus: 0.075, finalDamage: 923 });
    expect(reproduceDamageCalculated(payload!).finalDamage).toBe(923);
  });

  it("UT-R-DMG-08-021: also adds the bonus to the holder's follow-up attack", () => {
    const context = damageEventContext();
    const attacker: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 60 }),
      appliedEffects: [skillPowerBonusEffect("EF_SPB", "ATTACKER", 0.5)],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });
    const working = new Map<BattleUnitId, BattleUnit>([
      [attacker.battleUnitId, attacker],
      [target.battleUnitId, target],
    ]);

    const gen = applyFollowUpAttacksSteps(
      context,
      working,
      new SequenceRandomSource([]),
      attacker.battleUnitId,
      [
        {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FOLLOW_UP_RIDER"),
          sourceUnitId: createBattleUnitId("GRANTOR"),
          damageType: "EN",
          formula: { kind: "SKILL_POWER", power: 1 },
        },
      ],
      [target.battleUnitId],
      false,
      context.parentEventId,
    );
    let step = gen.next();
    while (!step.done) {
      step = gen.next(step.value.units);
    }

    // (60 - 10) × (1 + 0.5) = 75。
    expect(working.get(target.battleUnitId)?.currentHp).toBe(500 - 75);
    expect(damageCalculatedPayloads(context)[0]).toMatchObject({
      skillPowerBonus: 0.5,
      finalDamage: 75,
    });
  });
});
