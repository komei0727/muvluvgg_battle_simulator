import { describe, expect, it } from "vitest";
import { resolveDamageImmunity } from "./damage-immunity-policy.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type StatusEffectDetails,
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
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const IMMUNITY_DEFINITION_ID = createEffectActionDefinitionId("ACT_IMMUNITY");

function unit(id: string, maximumHp = 100): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
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

function immunityEffect(
  id: string,
  targetUnitId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: IMMUNITY_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(IMMUNITY_DEFINITION_ID),
    duplicate: true,
    sourceUnitId: createBattleUnitId(targetUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "DAMAGE_IMMUNITY",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function contextFor(target: BattleUnit): FormulaEvaluationContext {
  return { skillSource: unit("ATTACKER"), target, allUnits: [target] };
}

describe("resolveDamageImmunity (R-DMG-02)", () => {
  it("UT-R-DMG-02-001: no DAMAGE_IMMUNITY effect never nullifies", () => {
    const target = unit("TARGET");

    const result = resolveDamageImmunity(target, 50, contextFor(target));

    expect(result).toEqual({ nullified: false });
  });

  it("UT-R-DMG-02-002: an unconditional DAMAGE_IMMUNITY effect (no damageThreshold) always nullifies to a result of 1", () => {
    const effect = immunityEffect("eff-1", "TARGET", {});
    const target = { ...unit("TARGET"), appliedEffects: [effect] };

    const result = resolveDamageImmunity(target, 50, contextFor(target));

    expect(result).toEqual({
      nullified: true,
      nullifiedByEffectInstanceId: effect.effectInstanceId,
      nullifiedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    });
  });

  it("UT-R-DMG-02-003 (G-06/damageThreshold, mirrors production ACT_HARRIET_SAGE_AS2_IMMUNITY): a DAMAGE_IMMUNITY with damageThreshold(GT, CURRENT_HP_RATIO(TARGET, 0.35)) nullifies only when incoming raw damage exceeds 35% of the holder's current HP", () => {
    const effect = immunityEffect("eff-1", "TARGET", {
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
      },
    });
    const targetUnit = { ...unit("TARGET", 100), appliedEffects: [effect] };
    // 35% of 100 HP = 35. A hit of 40 exceeds it -> nullifies.
    const context = contextFor(targetUnit);

    const bigHit = resolveDamageImmunity(targetUnit, 40, context);
    expect(bigHit).toEqual({
      nullified: true,
      nullifiedByEffectInstanceId: effect.effectInstanceId,
      nullifiedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    });

    // A hit of 30 does not exceed 35 -> passes through untouched.
    const smallHit = resolveDamageImmunity(targetUnit, 30, context);
    expect(smallHit).toEqual({ nullified: false });
  });

  it("UT-R-DMG-02-004 (boundary: damageThreshold GT is strictly-greater, not >=): a hit exactly equal to the threshold does not nullify", () => {
    const effect = immunityEffect("eff-1", "TARGET", {
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
      },
    });
    const targetUnit = { ...unit("TARGET", 100), appliedEffects: [effect] };

    const result = resolveDamageImmunity(targetUnit, 35, contextFor(targetUnit));

    expect(result).toEqual({ nullified: false });
  });

  it("UT-R-DMG-02-005 (multiple DAMAGE_IMMUNITY effects, first eligible one applies): the first matching effect in application order nullifies", () => {
    const first = immunityEffect("eff-1", "TARGET", {
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.9 },
      },
    });
    const second = immunityEffect("eff-2", "TARGET", {});
    const targetUnit = { ...unit("TARGET", 100), appliedEffects: [first, second] };

    // 10 does not exceed 90% of 100 (first is ineligible), so the second
    // (unconditional) effect nullifies instead.
    const result = resolveDamageImmunity(targetUnit, 10, contextFor(targetUnit));

    expect(result).toEqual({
      nullified: true,
      nullifiedByEffectInstanceId: second.effectInstanceId,
      nullifiedByEffectActionDefinitionId: second.effectActionDefinitionId,
    });
  });

  it("UT-R-DMG-02-006 (non-DAMAGE_IMMUNITY statusKind ignored): an unrelated status-kind AppliedEffect does not nullify", () => {
    const notImmunity: AppliedEffect = {
      ...immunityEffect("eff-1", "TARGET", {}),
      statusKind: "STUN",
    };
    const targetUnit = { ...unit("TARGET"), appliedEffects: [notImmunity] };

    const result = resolveDamageImmunity(targetUnit, 50, contextFor(targetUnit));

    expect(result).toEqual({ nullified: false });
  });

  it("UT-R-DMG-02-007 (uses the holder's current HP, not maximum HP, for the threshold): a target with reduced current HP nullifies at a lower absolute damage value", () => {
    const effect = immunityEffect("eff-1", "TARGET", {
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
      },
    });
    const damagedTarget = {
      ...unit("TARGET", 100),
      appliedEffects: [effect],
      currentHp: createHitPoint(20, 100),
    };
    // 35% of current HP (20) = 7. A hit of 8 exceeds it -> nullifies, even
    // though 8 would not have exceeded 35% of maximum HP (35).
    const result = resolveDamageImmunity(damagedTarget, 8, contextFor(damagedTarget));

    expect(result).toEqual({
      nullified: true,
      nullifiedByEffectInstanceId: effect.effectInstanceId,
      nullifiedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    });
  });
});
