import { describe, expect, it } from "vitest";
import {
  absorbFromShieldPool,
  decayActionShields,
  shieldBypassedDamage,
  shieldDecayHolders,
  shieldDecayPools,
  shieldPoolsOf,
} from "./shield-policy.js";
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

  it("UT-R-SHD-01-003: drains instances of the selected pool in grant order and reports depleted ones", () => {
    const first = shieldEffect(10, { shieldType: null });
    const second = shieldEffect(50, { shieldType: null });
    const unit = unitWithShields([first, second]);
    const result = absorbFromShieldPool(unit, 30, null);
    expect(result.absorbed).toBe(30);
    expect(result.change?.depletedEffectInstanceIds).toEqual([first.effectInstanceId]);
    expect(result.appliedEffects.map((effect) => effect.shield?.remaining)).toEqual([0, 30]);
  });

  it("UT-R-SHD-01-004: reports no change when the pool is empty or nothing is routed into it", () => {
    const unit = unitWithShields([shieldEffect(100, { shieldType: null })]);
    const noDamage = absorbFromShieldPool(unit, 0, null);
    expect(noDamage.absorbed).toBe(0);
    expect(noDamage.change).toBeUndefined();
    expect(noDamage.appliedEffects).toBe(unit.appliedEffects);

    const emptyPool = absorbFromShieldPool(unit, 40, "PHYSICAL");
    expect(emptyPool.absorbed).toBe(0);
    expect(emptyPool.change).toBeUndefined();
    expect(emptyPool.appliedEffects).toBe(unit.appliedEffects);
  });

  it("UT-R-SHD-01-011 (PRレビュー[P1]): reports the whole pool total as before/after, including same-type instances this absorption did not touch", () => {
    const first = shieldEffect(10, { shieldType: null });
    const second = shieldEffect(50, { shieldType: null });
    const unit = unitWithShields([first, second]);
    // 5だけ吸収するので変化するのは`first`だけだが、プール前後値は 60 → 55。
    const result = absorbFromShieldPool(unit, 5, null);
    expect(result.change).toMatchObject({ poolBefore: 60, poolAfter: 55, absorbed: 5 });
    expect(result.change?.instances).toEqual([
      { effectInstanceId: first.effectInstanceId, before: 10, after: 5 },
    ]);
  });

  it("UT-R-SHD-02-001: absorbs only from the selected pool, leaving the other pools untouched", () => {
    const unit = unitWithShields([
      shieldEffect(100, { shieldType: "PHYSICAL" }),
      shieldEffect(40, { shieldType: null }),
      shieldEffect(500, { shieldType: "EN" }),
    ]);
    const result = absorbFromShieldPool(unit, 200, "PHYSICAL");
    expect(result.absorbed).toBe(100);
    const pools = shieldPoolsOf(result.appliedEffects);
    expect(pools).toEqual({ physical: 0, energy: 500, untyped: 40 });
  });

  it("UT-R-SHD-02-002: truncates the shieldIgnoreRate share, leaving the remainder to the shields", () => {
    expect(shieldBypassedDamage(200, 0.5)).toBe(100);
    expect(shieldBypassedDamage(123, 0.3)).toBe(36);
    expect(shieldBypassedDamage(40, 1)).toBe(40);
    expect(shieldBypassedDamage(40, 0)).toBe(0);
  });

  it("UT-R-SHD-02-003: never absorbs from a typed pool of a different damage type", () => {
    const unit = unitWithShields([shieldEffect(100, { shieldType: "EN" })]);
    const result = absorbFromShieldPool(unit, 60, "PHYSICAL");
    expect(result.absorbed).toBe(0);
    expect(shieldPoolsOf(result.appliedEffects).energy).toBe(100);
  });

  it("UT-R-SHD-03-001: caps the absorption at the pool total so the overflow can pass to the next destination", () => {
    const unit = unitWithShields([
      shieldEffect(6, { shieldType: "PHYSICAL" }),
      shieldEffect(4, { shieldType: "PHYSICAL" }),
    ]);
    const result = absorbFromShieldPool(unit, 100, "PHYSICAL");
    expect(result.absorbed).toBe(10);
    expect(result.change).toMatchObject({ poolBefore: 10, poolAfter: 0 });
    expect(result.change?.depletedEffectInstanceIds).toHaveLength(2);
  });

  it("UT-R-SHD-03-002: keeps poolAfter equal to poolBefore minus absorbed for every partial absorption", () => {
    const unit = unitWithShields([
      shieldEffect(37, { shieldType: "PHYSICAL" }),
      shieldEffect(11, { shieldType: "PHYSICAL" }),
    ]);
    for (const amount of [1, 37, 38, 48]) {
      const result = absorbFromShieldPool(unit, amount, "PHYSICAL");
      const change = result.change!;
      expect(change.poolBefore).toBe(48);
      expect(change.poolAfter).toBe(48 - result.absorbed);
      expect(change.absorbed).toBe(result.absorbed);
      expect(result.absorbed).toBe(Math.min(amount, 48));
    }
  });
});

describe("shield decay over time (SHIELD_DECAY_OVER_TIME, DMG-004)", () => {
  const decay = { unit: "ACTION" as const, ratio: 0.25 };

  it("UT-R-SHD-01-007: reduces the remaining amount by the declared ratio of the granted maximum on the holder's action", () => {
    const holder = unitWithShields([shieldEffect(100, { shieldType: null, decay })]);
    const first = decayActionShields([holder], holder.battleUnitId, holder.battleUnitId, null);
    expect(first.change).toMatchObject({
      shieldType: null,
      poolBefore: 100,
      poolAfter: 75,
      absorbed: 25,
    });
    // 減少量は「その時点の残量」ではなく付与時最大値に対する割合なので、等差で減る。
    const second = decayActionShields(first.units, holder.battleUnitId, holder.battleUnitId, null);
    expect(second.change).toMatchObject({ poolBefore: 75, poolAfter: 50, absorbed: 25 });
  });

  it("UT-R-SHD-01-008: depletes at the ratio's reciprocal and reports the instance as depleted", () => {
    let units: readonly BattleUnit[] = [
      unitWithShields([shieldEffect(100, { shieldType: null, decay })]),
    ];
    const holderId = units[0]!.battleUnitId;
    for (let i = 0; i < 3; i++) {
      const step = decayActionShields(units, holderId, holderId, null);
      expect(step.change!.depletedEffectInstanceIds).toEqual([]);
      units = step.units;
    }
    const last = decayActionShields(units, holderId, holderId, null);
    expect(last.change).toMatchObject({ poolBefore: 25, poolAfter: 0, absorbed: 25 });
    expect(last.change!.depletedEffectInstanceIds).toHaveLength(1);
  });

  it("UT-R-SHD-01-009: leaves shields without a decay declaration, and other units' actions, untouched", () => {
    const holder = unitWithShields([
      shieldEffect(100, { shieldType: null }),
      shieldEffect(80, { shieldType: "EN", decay }),
    ]);
    const other = createBattleUnitId("ally:2");
    expect(shieldDecayHolders([holder], other)).toEqual([]);
    expect(shieldDecayPools([holder], other, holder.battleUnitId)).toEqual([]);
    expect(decayActionShields([holder], other, holder.battleUnitId, "EN").change).toBeUndefined();

    expect(shieldDecayHolders([holder], holder.battleUnitId)).toEqual([holder.battleUnitId]);
    // 漸減対象は`EN`プールだけ（タイプなしは`decay`宣言を持たない）。
    expect(shieldDecayPools([holder], holder.battleUnitId, holder.battleUnitId)).toEqual(["EN"]);
    const result = decayActionShields([holder], holder.battleUnitId, holder.battleUnitId, "EN");
    expect(result.change!.shieldType).toBe("EN");
    expect(shieldPoolsOf(result.units[0]!.appliedEffects).untyped).toBe(100);
  });

  it("UT-R-SHD-01-012 (PRレビュー[P1]): reports the whole pool total per pool, including same-pool instances that do not decay", () => {
    const holder = unitWithShields([
      shieldEffect(100, { shieldType: null }),
      shieldEffect(40, { shieldType: null, decay }),
      shieldEffect(80, { shieldType: "EN", decay }),
    ]);
    // R-SHD-02の適用順と同じ並び（タイプあり→タイプなし）で解決する。
    expect(shieldDecayPools([holder], holder.battleUnitId, holder.battleUnitId)).toEqual([
      "EN",
      null,
    ]);

    const en = decayActionShields([holder], holder.battleUnitId, holder.battleUnitId, "EN");
    expect(en.change).toMatchObject({ poolBefore: 80, poolAfter: 60, absorbed: 20 });
    // タイプなしプールは 140 のうち漸減対象は40だけ（10減る）で、プール前後値は 140 → 130。
    const untyped = decayActionShields(en.units, holder.battleUnitId, holder.battleUnitId, null);
    expect(untyped.change).toMatchObject({ poolBefore: 140, poolAfter: 130, absorbed: 10 });
  });

  it("UT-R-SHD-01-015 (PRレビュー再指摘[P1]): decaying one pool leaves the holder's other decaying pools untouched", () => {
    const holder = unitWithShields([
      shieldEffect(80, { shieldType: "EN", decay }),
      shieldEffect(40, { shieldType: null, decay }),
    ]);
    const en = decayActionShields([holder], holder.battleUnitId, holder.battleUnitId, "EN");
    // 先行プールを解決した時点で、後続のタイプなしプールはまだ手つかず。
    expect(shieldPoolsOf(en.units[0]!.appliedEffects)).toEqual({
      physical: 0,
      energy: 60,
      untyped: 40,
    });
  });
});
