import { describe, expect, it } from "vitest";
import { absorbWithShields, decayActionShields, shieldPoolsOf } from "./shield-policy.js";
import type { AppliedEffect, ShieldState } from "../model/applied-effect.js";
import { effectKindKeyFromDefinitionId } from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";

function unitWithShields(shields: readonly AppliedEffect[]): BattleUnit {
  const position = { row: "FRONT" as const, column: "LEFT" as const };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("ally:1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 1000,
      attack: 50,
      defense: 20,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  const unit = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
  return { ...unit, appliedEffects: shields };
}

let counter = 0;

function shieldEffect(
  amount: number,
  shield: Omit<ShieldState, "remaining"> & { remaining?: number },
): AppliedEffect {
  counter += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${counter}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${counter}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetId: createBattleUnitId("ally:1"),
    magnitude: amount,
    shield: {
      shieldType: shield.shieldType,
      remaining: shield.remaining ?? amount,
      ...(shield.decay !== undefined ? { decay: shield.decay } : {}),
    },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

describe("shield-policy (R-SHD-01/02/03)", () => {
  it("UT-R-SHD-01-001: sums shield instances of the same type into one pool", () => {
    const unit = unitWithShields([
      shieldEffect(100, { shieldType: "PHYSICAL" }),
      shieldEffect(50, { shieldType: "PHYSICAL" }),
      shieldEffect(30, { shieldType: "EN" }),
      shieldEffect(20, { shieldType: null }),
    ]);
    expect(shieldPoolsOf(unit.appliedEffects)).toEqual({ physical: 150, energy: 30, untyped: 20 });
  });

  it("UT-R-SHD-01-002: ignores non-shield effects and reports zero pools when none are held", () => {
    expect(shieldPoolsOf(unitWithShields([]).appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 0,
    });
  });

  it("UT-R-SHD-02-001: applies damage to the matching typed pool, then the untyped pool, then HP", () => {
    const unit = unitWithShields([
      shieldEffect(100, { shieldType: "PHYSICAL" }),
      shieldEffect(40, { shieldType: null }),
      shieldEffect(500, { shieldType: "EN" }),
    ]);
    const result = absorbWithShields(unit, 200, "PHYSICAL", 0);
    expect(result.hpDirectDamage).toBe(0);
    expect(result.typedShieldAbsorbed).toBe(100);
    expect(result.untypedShieldAbsorbed).toBe(40);
    expect(result.hitPointDamage).toBe(60);
    // 対応しないタイプありシールド（EN）は消費されない。
    expect(shieldPoolsOf(result.appliedEffects).energy).toBe(500);
  });

  it("UT-R-SHD-02-002: routes the shieldIgnoreRate share straight to HP before any shield absorbs", () => {
    const unit = unitWithShields([shieldEffect(100, { shieldType: null })]);
    const result = absorbWithShields(unit, 200, "PHYSICAL", 0.5);
    expect(result.hpDirectDamage).toBe(100);
    expect(result.untypedShieldAbsorbed).toBe(100);
    expect(result.hitPointDamage).toBe(100);
  });

  it("UT-R-SHD-02-003: never applies damage to a typed shield of a different damage type", () => {
    const unit = unitWithShields([shieldEffect(100, { shieldType: "EN" })]);
    const result = absorbWithShields(unit, 60, "PHYSICAL", 0);
    expect(result.typedShieldAbsorbed).toBe(0);
    expect(result.untypedShieldAbsorbed).toBe(0);
    expect(result.hitPointDamage).toBe(60);
    expect(shieldPoolsOf(result.appliedEffects).energy).toBe(100);
  });

  it("UT-R-SHD-03-001: passes the overflow of each pool to the next destination", () => {
    const unit = unitWithShields([
      shieldEffect(10, { shieldType: "PHYSICAL" }),
      shieldEffect(10, { shieldType: null }),
    ]);
    const result = absorbWithShields(unit, 100, "PHYSICAL", 0);
    expect(result.typedShieldAbsorbed).toBe(10);
    expect(result.untypedShieldAbsorbed).toBe(10);
    expect(result.hitPointDamage).toBe(80);
  });

  it("UT-R-SHD-03-002: conserves the calculated damage across every destination", () => {
    const unit = unitWithShields([
      shieldEffect(37, { shieldType: "PHYSICAL" }),
      shieldEffect(11, { shieldType: null }),
    ]);
    const result = absorbWithShields(unit, 123, "PHYSICAL", 0.3);
    // `hitPointDamage`は`hpDirectDamage`を含むHP行きの総量。
    expect(result.hpDirectDamage).toBe(36);
    expect(result.typedShieldAbsorbed + result.untypedShieldAbsorbed + result.hitPointDamage).toBe(
      123,
    );
  });

  it("UT-R-SHD-01-003: drains shield instances of the same pool in grant order and reports depleted ones", () => {
    const first = shieldEffect(10, { shieldType: null });
    const second = shieldEffect(50, { shieldType: null });
    const unit = unitWithShields([first, second]);
    const result = absorbWithShields(unit, 30, "PHYSICAL", 0);
    expect(result.untypedShieldAbsorbed).toBe(30);
    expect(result.depletedEffectInstanceIds).toEqual([first.effectInstanceId]);
    const remaining = result.appliedEffects.map((effect) => effect.shield?.remaining);
    expect(remaining).toEqual([0, 30]);
  });

  it("UT-R-SHD-01-004: leaves the unit untouched when the damage is fully routed past the shields", () => {
    const unit = unitWithShields([shieldEffect(100, { shieldType: null })]);
    const result = absorbWithShields(unit, 40, "PHYSICAL", 1);
    expect(result.hpDirectDamage).toBe(40);
    expect(result.untypedShieldAbsorbed).toBe(0);
    expect(result.hitPointDamage).toBe(40);
    expect(result.appliedEffects).toBe(unit.appliedEffects);
    expect(result.depletedEffectInstanceIds).toEqual([]);
  });
});

describe("shield decay over time (SHIELD_DECAY_OVER_TIME, DMG-004)", () => {
  const decay = { unit: "ACTION" as const, ratio: 0.25 };

  it("UT-R-SHD-01-007: reduces the remaining amount by the declared ratio of the granted maximum on the holder's action", () => {
    const holder = unitWithShields([shieldEffect(100, { shieldType: null, decay })]);
    const first = decayActionShields([holder], holder.battleUnitId);
    expect(first.changes).toEqual([
      expect.objectContaining({ shieldType: null, before: 100, after: 75 }),
    ]);
    // 減少量は「その時点の残量」ではなく付与時最大値に対する割合なので、等差で減る。
    const second = decayActionShields(first.units, holder.battleUnitId);
    expect(second.changes[0]).toEqual(expect.objectContaining({ before: 75, after: 50 }));
  });

  it("UT-R-SHD-01-008: depletes at the ratio's reciprocal and reports the instance as depleted", () => {
    let units: readonly BattleUnit[] = [
      unitWithShields([shieldEffect(100, { shieldType: null, decay })]),
    ];
    const holderId = units[0]!.battleUnitId;
    for (let i = 0; i < 3; i++) {
      units = decayActionShields(units, holderId).units;
    }
    const last = decayActionShields(units, holderId);
    expect(last.changes[0]).toEqual(expect.objectContaining({ before: 25, after: 0 }));
    expect(last.depleted).toHaveLength(1);
  });

  it("UT-R-SHD-01-009: leaves shields without a decay declaration, and other units' actions, untouched", () => {
    const holder = unitWithShields([
      shieldEffect(100, { shieldType: null }),
      shieldEffect(80, { shieldType: "EN", decay }),
    ]);
    const other = createBattleUnitId("ally:2");
    expect(decayActionShields([holder], other).changes).toEqual([]);
    const result = decayActionShields([holder], holder.battleUnitId);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.shieldType).toBe("EN");
  });
});
