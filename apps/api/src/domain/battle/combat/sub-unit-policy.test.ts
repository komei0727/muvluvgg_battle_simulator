import { describe, expect, it } from "vitest";
import {
  absorbFromNextSubUnit,
  subUnitAdditionalDamageSources,
  subUnitDurabilityTotal,
  subUnitInstances,
} from "./sub-unit-policy.js";
import type { AppliedEffect, SubUnitState } from "../model/applied-effect.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
} from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";

function unitWithEffects(effects: readonly AppliedEffect[]): BattleUnit {
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
  return { ...unit, appliedEffects: effects };
}

let counter = 0;

const ADDITIONAL_DAMAGE: SubUnitState["additionalDamage"] = {
  formula: {
    kind: "SUBUNIT_ADDITIONAL_DAMAGE",
    ownerAttack: "CURRENT_ATTACK",
    providerAttack: "SOURCE_SNAPSHOT_ATTACK",
    skillMultiplier: 0.5,
    targetDefense: "TARGET_CURRENT_DEFENSE",
  },
};

function subUnitEffect(
  durabilityMax: number,
  options: {
    readonly remaining?: number;
    readonly providerAttack?: number;
    readonly additionalDamage?: SubUnitState["additionalDamage"];
  } = {},
): AppliedEffect {
  counter += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_SUBUNIT_${counter}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${counter}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetId: createBattleUnitId("ally:1"),
    magnitude: durabilityMax,
    categories: ["SUBUNIT"],
    subUnit: {
      durability: options.remaining ?? durabilityMax,
      additionalDamage: options.additionalDamage ?? ADDITIONAL_DAMAGE,
    },
    snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: options.providerAttack ?? 100 },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/** R-SHD-01由来の通常シールド（サブユニットと取り違えないことの確認用）。 */
function shieldEffect(amount: number): AppliedEffect {
  counter += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${counter}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${counter}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetId: createBattleUnitId("ally:1"),
    magnitude: amount,
    categories: ["SHIELD"],
    shield: { shieldType: null, remaining: amount },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

describe("sub-unit-policy (R-SUB-01/02)", () => {
  it("UT-R-SUB-01-001: keeps subunit durability out of the normal shield pools and sums it separately", () => {
    const unit = unitWithEffects([subUnitEffect(100), shieldEffect(40), subUnitEffect(30)]);
    expect(subUnitDurabilityTotal(unit.appliedEffects)).toBe(130);
    expect(subUnitInstances(unit.appliedEffects)).toHaveLength(2);
  });

  it("UT-R-SUB-01-002: absorbs into one instance at a time, oldest first, so each reduction can be notified before the next", () => {
    const first = subUnitEffect(10);
    const second = subUnitEffect(50);
    const unit = unitWithEffects([first, second]);

    const firstAbsorption = absorbFromNextSubUnit(unit, 30);

    expect(firstAbsorption.absorbed).toBe(10);
    expect(firstAbsorption.change?.effectInstanceId).toBe(first.effectInstanceId);
    expect(firstAbsorption.change?.before).toBe(10);
    expect(firstAbsorption.change?.after).toBe(0);
    expect(firstAbsorption.change?.depleted).toBe(true);
    expect(firstAbsorption.appliedEffects.map((effect) => effect.subUnit?.durability)).toEqual([
      0, 50,
    ]);

    // 呼び出し側は残ダメージ（30 - 10 = 20）で次の1体へ進む。
    const afterFirst = unitWithEffects(firstAbsorption.appliedEffects);
    const secondAbsorption = absorbFromNextSubUnit(afterFirst, 20);

    expect(secondAbsorption.absorbed).toBe(20);
    expect(secondAbsorption.change?.effectInstanceId).toBe(second.effectInstanceId);
    expect(secondAbsorption.change?.after).toBe(30);
    expect(secondAbsorption.change?.depleted).toBe(false);
  });

  it("UT-R-SUB-01-003: absorbs at most the instance's remaining durability and lets the rest pass through", () => {
    const unit = unitWithEffects([subUnitEffect(10)]);

    const result = absorbFromNextSubUnit(unit, 100);

    expect(result.absorbed).toBe(10);
    expect(result.change?.depleted).toBe(true);
  });

  it("UT-R-SUB-01-004: reports no change when there is no subunit or no damage routed into it", () => {
    const withSubUnit = unitWithEffects([subUnitEffect(10)]);
    const noDamage = absorbFromNextSubUnit(withSubUnit, 0);
    expect(noDamage.absorbed).toBe(0);
    expect(noDamage.change).toBeUndefined();
    expect(noDamage.appliedEffects).toBe(withSubUnit.appliedEffects);

    const shieldOnly = unitWithEffects([shieldEffect(100)]);
    const noSubUnit = absorbFromNextSubUnit(shieldOnly, 40);
    expect(noSubUnit.absorbed).toBe(0);
    expect(noSubUnit.change).toBeUndefined();
    expect(noSubUnit.appliedEffects).toBe(shieldOnly.appliedEffects);
  });

  it("UT-R-SUB-01-005: treats an already depleted instance as absent (no further absorption, no re-depletion)", () => {
    const depleted = subUnitEffect(10, { remaining: 0 });
    const alive = subUnitEffect(20);
    const unit = unitWithEffects([depleted, alive]);

    const result = absorbFromNextSubUnit(unit, 5);

    expect(result.absorbed).toBe(5);
    expect(result.change?.effectInstanceId).toBe(alive.effectInstanceId);
    expect(subUnitDurabilityTotal(unit.appliedEffects)).toBe(20);
  });

  it("UT-R-SUB-02-003: lists one additional-damage source per live subunit instance, carrying the provider attack snapshot", () => {
    const first = subUnitEffect(10, { providerAttack: 200 });
    const depleted = subUnitEffect(10, { remaining: 0, providerAttack: 300 });
    const second = subUnitEffect(10, { providerAttack: 400 });
    const unit = unitWithEffects([first, depleted, second]);

    expect(subUnitAdditionalDamageSources(unit)).toEqual([
      {
        effectInstanceId: first.effectInstanceId,
        effectActionDefinitionId: first.effectActionDefinitionId,
        additionalDamage: ADDITIONAL_DAMAGE,
        providerAttack: 200,
      },
      {
        effectInstanceId: second.effectInstanceId,
        effectActionDefinitionId: second.effectActionDefinitionId,
        additionalDamage: ADDITIONAL_DAMAGE,
        providerAttack: 400,
      },
    ]);
  });

  it("UT-R-SUB-02-004: treats a missing provider attack snapshot as zero rather than failing the hit", () => {
    const { snapshot: _omitted, ...withoutSnapshot } = subUnitEffect(10);
    expect(
      subUnitAdditionalDamageSources(unitWithEffects([withoutSnapshot]))[0]?.providerAttack,
    ).toBe(0);
  });
});
