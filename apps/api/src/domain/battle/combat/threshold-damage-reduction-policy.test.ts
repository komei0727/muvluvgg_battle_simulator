import { describe, expect, it } from "vitest";
import { resolveThresholdDamageReduction } from "./threshold-damage-reduction-policy.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type DamageModifierState,
} from "../model/applied-effect.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { FormulaEvaluationContext } from "../skill/formula-evaluator.js";
import { createHitPoint } from "../model/resource-gauge.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, maximumHp = 100): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ENEMY", position),
    combatStats: {
      maximumHp,
      attack: 30,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ENEMY", LIMITS);
}

function withCurrentHp(target: BattleUnit, currentHp: number): BattleUnit {
  return { ...target, currentHp: createHitPoint(currentHp, target.combatStats.maximumHp) };
}

let instanceCounter = 0;

const CURRENT_HP_20_PERCENT = {
  op: "GT",
  formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.2 },
} as const;

function thresholdMod(
  target: BattleUnit,
  magnitude: number,
  damageModifier: DamageModifierState,
  consumptionRemaining?: number,
): AppliedEffect {
  instanceCounter += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_THRESHOLD_GUARD_${instanceCounter}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${instanceCounter}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    categories: ["BUFF"],
    duplicate: true,
    targetUnitId: target.battleUnitId,
    magnitude,
    damageModifier,
    duration: {
      definition: {
        dispellable: true,
        linkedEffectGroupId: null,
        ...(consumptionRemaining !== undefined
          ? { consumption: { kind: "INCOMING_HIT", maxCount: consumptionRemaining } }
          : {}),
      },
      ...(consumptionRemaining !== undefined ? { consumptionRemaining } : {}),
    },
    appliedTurnNumber: 1,
  };
}

function holding(target: BattleUnit, ...effects: readonly AppliedEffect[]): BattleUnit {
  return { ...target, appliedEffects: effects };
}

function contextFor(target: BattleUnit, attacker: BattleUnit): FormulaEvaluationContext {
  return { skillSource: attacker, target, allUnits: [attacker, target] };
}

function resolve(
  defender: BattleUnit,
  incomingDamage: number,
  overrides: {
    readonly damageType?: "PHYSICAL" | "EN";
    readonly damageReductionIgnoreRate?: number;
  } = {},
) {
  const attacker = unit("ATTACKER");
  return resolveThresholdDamageReduction({
    attacker,
    defender,
    damageType: overrides.damageType ?? "PHYSICAL",
    incomingDamage,
    damageReductionIgnoreRate: overrides.damageReductionIgnoreRate ?? 0,
    formulaContext: contextFor(defender, attacker),
  });
}

describe("resolveThresholdDamageReduction (R-DMG-07)", () => {
  it("UT-R-DMG-07-003 (mirrors アニスPS3「現在HPの20%を超えるダメージのみ50%減少」): a hit exceeding the threshold composes the reduction and reports the applied instance", () => {
    const effect = thresholdMod(unit("TARGET"), -0.5, {
      direction: "INCOMING",
      damageType: null,
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const defender = holding(withCurrentHp(unit("TARGET"), 100), effect);

    // 20% of 100 current HP = 20. A hit of 21 exceeds it.
    const result = resolve(defender, 21);

    expect(result.multiplier).toBeCloseTo(0.5);
    expect(result.appliedEffects).toEqual([
      {
        effectInstanceId: effect.effectInstanceId,
        effectActionDefinitionId: effect.effectActionDefinitionId,
      },
    ]);
  });

  it("UT-R-DMG-07-004 (boundary: GT is strictly-greater): a hit at or below the threshold leaves the damage untouched and consumes nothing", () => {
    const effect = thresholdMod(unit("TARGET"), -0.5, {
      direction: "INCOMING",
      damageType: null,
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const defender = holding(withCurrentHp(unit("TARGET"), 100), effect);

    expect(resolve(defender, 20)).toEqual({ multiplier: 1, appliedEffects: [] });
    expect(resolve(defender, 5)).toEqual({ multiplier: 1, appliedEffects: [] });
  });

  it("UT-R-DMG-07-005: damageType mismatch, a failing dynamic condition, and OUTGOING/thresholdless modifiers do not participate; matching instances sum as max(0, 1 + total)", () => {
    const base = unit("TARGET");
    const enMod = thresholdMod(base, -0.5, {
      direction: "INCOMING",
      damageType: "EN",
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const failingCondition = thresholdMod(base, -0.4, {
      direction: "INCOMING",
      damageType: null,
      condition: {
        kind: "UNIT_STATE",
        unit: "EFFECT_OWNER",
        field: "HP_RATIO",
        op: "LT",
        value: 0.5,
      },
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const thresholdless = thresholdMod(base, -0.3, { direction: "INCOMING", damageType: null });
    const matching1 = thresholdMod(base, -0.5, {
      direction: "INCOMING",
      damageType: "PHYSICAL",
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const matching2 = thresholdMod(base, -0.2, {
      direction: "INCOMING",
      damageType: null,
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const defender = holding(
      withCurrentHp(base, 100),
      enMod,
      failingCondition,
      thresholdless,
      matching1,
      matching2,
    );

    const result = resolve(defender, 50, { damageType: "PHYSICAL" });

    expect(result.multiplier).toBeCloseTo(0.3);
    expect(result.appliedEffects.map((applied) => applied.effectInstanceId)).toEqual([
      matching1.effectInstanceId,
      matching2.effectInstanceId,
    ]);
  });

  it("UT-R-DMG-07-006: an exhausted consumption (remaining 0) skips the instance, damageReductionIgnoreRate attenuates the reduction (R-DMG-03), and the multiplier floors at 0", () => {
    const base = unit("TARGET");
    const exhausted = thresholdMod(
      base,
      -0.5,
      { direction: "INCOMING", damageType: null, damageThreshold: CURRENT_HP_20_PERCENT },
      0,
    );
    expect(resolve(holding(withCurrentHp(base, 100), exhausted), 50)).toEqual({
      multiplier: 1,
      appliedEffects: [],
    });

    const attenuated = thresholdMod(base, -0.5, {
      direction: "INCOMING",
      damageType: null,
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const attenuatedResult = resolve(holding(withCurrentHp(base, 100), attenuated), 50, {
      damageReductionIgnoreRate: 0.4,
    });
    expect(attenuatedResult.multiplier).toBeCloseTo(0.7);
    expect(attenuatedResult.appliedEffects).toHaveLength(1);

    const big1 = thresholdMod(base, -0.8, {
      direction: "INCOMING",
      damageType: null,
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    const big2 = thresholdMod(base, -0.7, {
      direction: "INCOMING",
      damageType: null,
      damageThreshold: CURRENT_HP_20_PERCENT,
    });
    expect(resolve(holding(withCurrentHp(base, 100), big1, big2), 50).multiplier).toBe(0);
  });
});
