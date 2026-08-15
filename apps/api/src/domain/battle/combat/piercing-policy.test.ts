import { describe, expect, it } from "vitest";
import { composePiercing } from "./piercing-policy.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import { effectKindKeyFromDefinitionId } from "../model/applied-effect.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const NO_PIERCING = {
  defenseIgnoreRate: 0,
  shieldIgnoreRate: 0,
  damageReductionIgnoreRate: 0,
} as const;

function attacker(effects: readonly AppliedEffect[] = []): BattleUnit {
  const side = "ALLY" as const;
  const position = { row: "FRONT", column: "CENTER" } as const;
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId("ATTACKER"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const unit = createBattleUnit(member, side, {
    maximumAp: 4,
    maximumPp: 4,
    maximumExtraGauge: 100,
  });
  return { ...unit, appliedEffects: effects };
}

function piercingEffect(
  id: string,
  piercing: Partial<{
    defenseIgnoreRate: number;
    shieldIgnoreRate: number;
    damageReductionIgnoreRate: number;
  }>,
): AppliedEffect {
  const effectActionDefinitionId = createEffectActionDefinitionId(`ACT_${id}`);
  return {
    effectInstanceId: createEffectInstanceId(`battle-1:effect:${id}`),
    effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId("ATTACKER"),
    magnitude: 0,
    categories: ["BUFF"],
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
    piercing: { ...NO_PIERCING, ...piercing },
  };
}

/** `APPLY_PIERCING_MOD`以外の効果（`piercing`を持たない）は合成に寄与しない。 */
function unrelatedEffect(): AppliedEffect {
  const effectActionDefinitionId = createEffectActionDefinitionId("ACT_UNRELATED");
  return {
    effectInstanceId: createEffectInstanceId("battle-1:effect:unrelated"),
    effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId("ATTACKER"),
    magnitude: 0.5,
    categories: ["BUFF"],
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

describe("composePiercing (R-DMG-03, TEMP_PIERCING_GRANT, DMG-003/Issue #196)", () => {
  it("UT-R-DMG-03-020: returns the DAMAGE definition's own static rates when the attacker holds no APPLY_PIERCING_MOD", () => {
    const base = { defenseIgnoreRate: 0.25, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0.1 };
    expect(composePiercing(base, attacker([unrelatedEffect()]))).toEqual(base);
  });

  it("UT-R-DMG-03-021: adds a held grant to the definition's static rate on top of the un-ignored remainder", () => {
    // 「無視されずに残る割合」の積: 1 - (1 - 0) * (1 - 0.5) = 0.5
    expect(
      composePiercing(NO_PIERCING, attacker([piercingEffect("P1", { defenseIgnoreRate: 0.5 })])),
    ).toEqual({ defenseIgnoreRate: 0.5, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 });

    // 静的0.5 + 付与0.5 → 1 - 0.5 * 0.5 = 0.75（単純加算の1.0にはならない）
    expect(
      composePiercing(
        { ...NO_PIERCING, defenseIgnoreRate: 0.5 },
        attacker([piercingEffect("P1", { defenseIgnoreRate: 0.5 })]),
      ).defenseIgnoreRate,
    ).toBeCloseTo(0.75, 10);
  });

  it("UT-R-DMG-03-022: composes each of the three rates independently and never exceeds 1", () => {
    const composed = composePiercing(
      NO_PIERCING,
      attacker([
        piercingEffect("P1", { defenseIgnoreRate: 0.5, shieldIgnoreRate: 1 }),
        piercingEffect("P2", { defenseIgnoreRate: 0.5, damageReductionIgnoreRate: 0.2 }),
      ]),
    );
    expect(composed.defenseIgnoreRate).toBeCloseTo(0.75, 10);
    // 1つでも全量無視(1)があればその率は1で飽和する。
    expect(composed.shieldIgnoreRate).toBe(1);
    expect(composed.damageReductionIgnoreRate).toBeCloseTo(0.2, 10);
  });

  it("UT-R-DMG-03-023: is order-independent (the composition is a product over the un-ignored remainders)", () => {
    const a = piercingEffect("P1", { defenseIgnoreRate: 0.3 });
    const b = piercingEffect("P2", { defenseIgnoreRate: 0.6 });
    expect(composePiercing(NO_PIERCING, attacker([a, b])).defenseIgnoreRate).toBeCloseTo(
      composePiercing(NO_PIERCING, attacker([b, a])).defenseIgnoreRate,
      10,
    );
  });
});
