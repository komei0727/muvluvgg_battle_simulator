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
} from "../../../testing/fixtures/damage-application.js";

describe("applyDamageAction: R-CFS-02 混乱時のダメージ / R-DTH-01 幻惑 (DMG-009)", () => {
  function confusionEffect(id: string, holderId: string): AppliedEffect {
    const definitionId = createEffectActionDefinitionId("ACT_CONFUSION");
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceId: createBattleUnitId("SOURCE"),
      targetId: createBattleUnitId(holderId),
      magnitude: 0,
      categories: ["DEBUFF"],
      statusKind: "CONFUSION",
      statusDetails: { confusion: { damageReductionRate: 0.3, lowAttackBaseDamageRate: 0.1 } },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function damageToHealEffect(id: string, holderId: string, healRate = 0.7): AppliedEffect {
    const definitionId = createEffectActionDefinitionId("ACT_DAZZLE");
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceId: createBattleUnitId("SOURCE"),
      targetId: createBattleUnitId(holderId),
      magnitude: 0,
      categories: ["DEBUFF"],
      statusKind: "DAMAGE_TO_HEAL",
      statusDetails: { damageToHeal: { healRate } },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  it("UT-R-CFS-02-101: an AS attack by a confused attacker is scaled by the confusion multiplier", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [confusionEffect("EI_CONFUSION", "ATTACKER")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = { ...damageEventContext(), skillType: "AS" as const };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const damageCalculated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated")!;
    expect(damageCalculated.payload).toMatchObject({ confusionDamageMultiplier: 0.7 });
    // 基礎ダメージ 30 - 10 = 20、混乱倍率 0.7 → 14
    expect(result.hits[0]!.damage).toBe(14);
  });

  it("UT-R-CFS-02-102: the same confused attacker's EX attack is untouched — R-CFS-02 is AS only", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [confusionEffect("EI_CONFUSION", "ATTACKER")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = { ...damageEventContext(), skillType: "EX" as const };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const damageCalculated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated")!;
    expect(damageCalculated.payload).toMatchObject({ confusionDamageMultiplier: 1 });
    expect(result.hits[0]!.damage).toBe(20);
  });

  it("UT-R-CFS-02-103: a confused attacker whose attack is at or below the effective defense uses the substituted base damage", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [confusionEffect("EI_CONFUSION", "ATTACKER")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 30, maximumHp: 100 });
    const context = { ...damageEventContext(), skillType: "AS" as const };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 30 * 0.1 = 3、混乱倍率 0.7 → 2.1 → 切り捨てて2（通常なら最低1ダメージ）
    expect(result.hits[0]!.damage).toBe(2);
  });

  it("UT-R-DTH-01-001: a dazzled attacker heals its would-be victim instead of damaging it", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("EI_DAZZLE", "ATTACKER")],
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(50, 100),
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const events = context.recorder.getEvents();
    const converted = events.find((e) => e.eventType === "DamageConvertedToHeal")!;
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated")!;

    expect(events.filter((e) => e.eventType === "DamageApplied")).toHaveLength(0);
    expect(events.filter((e) => e.eventType === "HitPointReduced")).toHaveLength(0);
    expect(converted.parentEventId).toBe(damageCalculated.eventId);
    // 本来のダメージ 20 → floor(20 * 0.7) = 14
    expect(converted.payload).toMatchObject({
      targetUnitId: createBattleUnitId("TARGET"),
      calculatedDamage: 20,
      healRate: 0.7,
      healAmount: 14,
    });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(64);
    // ダメージを与えていないため、outcomeのdamageは0になる。
    expect(result.hits[0]!.damage).toBe(0);
  });

  it("UT-R-DTH-01-002: the converted heal discards the overflow above maximum HP", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("EI_DAZZLE", "ATTACKER")],
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(95, 100),
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const converted = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageConvertedToHeal")!;
    expect(converted.payload).toMatchObject({ healAmount: 14, appliedHeal: 5 });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-DTH-01-003: a dazzled attack never defeats its target, even at 1 HP", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("EI_DAZZLE", "ATTACKER")],
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(1, 100),
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(context.recorder.getEvents().filter((e) => e.eventType === "UnitDefeated")).toHaveLength(
      0,
    );
    const survivor = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(isDefeated(survivor)).toBe(false);
    expect(survivor.currentHp).toBe(15);
  });

  it("UT-R-DTH-01-004: the converted hit records a 0 damage result for R-SKL-08", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("EI_DAZZLE", "ATTACKER")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const damageResults: DamageResultRegistry = new Map();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      { ...damageEventContext(), damageResults },
    );

    expect(damageResults.get(createBattleUnitId("ATTACKER"))?.lastDamageDealt).toBe(0);
    expect(damageResults.get(createBattleUnitId("TARGET"))?.lastDamageReceived).toBe(0);
  });
});
