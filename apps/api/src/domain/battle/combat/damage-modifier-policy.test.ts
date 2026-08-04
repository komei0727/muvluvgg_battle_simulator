import { describe, expect, it } from "vitest";
import { composeDamageModifiers } from "./damage-modifier-policy.js";
import type { AppliedEffect, DamageModifierState } from "../model/applied-effect.js";
import { effectKindKeyFromDefinitionId } from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { Side } from "../../shared/side.js";
import type { MarkerState } from "../model/marker-state.js";

function unitAt(id: string, side: Side): BattleUnit {
  const position = { row: "FRONT" as const, column: "LEFT" as const };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 50,
      defense: 20,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 });
}

function withCurrentHp(unit: BattleUnit, currentHp: number): BattleUnit {
  return { ...unit, currentHp: createHitPoint(currentHp, unit.combatStats.maximumHp) };
}

let instanceCounter = 0;

function damageMod(
  unit: BattleUnit,
  magnitude: number,
  damageModifier: DamageModifierState,
): AppliedEffect {
  instanceCounter += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_DAMAGE_MOD_${instanceCounter}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${instanceCounter}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    categories: ["BUFF"],
    duplicate: true,
    targetUnitId: unit.battleUnitId,
    magnitude,
    damageModifier,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function holding(unit: BattleUnit, ...effects: readonly AppliedEffect[]): BattleUnit {
  return { ...unit, appliedEffects: effects };
}

function markerOn(unit: BattleUnit, markerIdValue: string, stackCount = 1): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId(`MARKER_INSTANCE_${markerIdValue}`),
    markerId: createMarkerId(markerIdValue),
    sourceUnitId: unit.battleUnitId,
    targetUnitId: unit.battleUnitId,
    stackCount,
    stackMax: null,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
  };
}

function compose(
  attacker: BattleUnit,
  defender: BattleUnit,
  overrides: {
    readonly damageType?: "PHYSICAL" | "EN";
    readonly damageReductionIgnoreRate?: number;
  } = {},
) {
  return composeDamageModifiers({
    attacker,
    defender,
    damageType: overrides.damageType ?? "PHYSICAL",
    damageReductionIgnoreRate: overrides.damageReductionIgnoreRate ?? 0,
  });
}

describe("composeDamageModifiers (R-DMG-04, R-DMG-03)", () => {
  it("UT-R-DMG-04-001: multiplies to 1 in both directions when neither side holds an APPLY_DAMAGE_MOD", () => {
    const result = compose(unitAt("U_ATK", "ALLY"), unitAt("U_DEF", "ENEMY"));
    expect(result.outgoingMultiplier).toBe(1);
    expect(result.incomingMultiplier).toBe(1);
  });

  it("UT-R-DMG-04-002: sums the attacker's OUTGOING modifiers as signed ratios into 1 + total", () => {
    const attacker = unitAt("U_ATK", "ALLY");
    const withMods = holding(
      attacker,
      damageMod(attacker, 0.1, { direction: "OUTGOING", damageType: null }),
      damageMod(attacker, 0.25, { direction: "OUTGOING", damageType: null }),
    );
    expect(compose(withMods, unitAt("U_DEF", "ENEMY")).outgoingMultiplier).toBeCloseTo(1.35);
  });

  it("UT-R-DMG-04-003: sums the defender's INCOMING modifiers and ignores the attacker's INCOMING ones", () => {
    const attacker = unitAt("U_ATK", "ALLY");
    const defender = unitAt("U_DEF", "ENEMY");
    const result = compose(
      holding(attacker, damageMod(attacker, -0.9, { direction: "INCOMING", damageType: null })),
      holding(defender, damageMod(defender, -0.3, { direction: "INCOMING", damageType: null })),
    );
    expect(result.outgoingMultiplier).toBe(1);
    expect(result.incomingMultiplier).toBeCloseTo(0.7);
  });

  it("UT-R-DMG-04-004: applies a typed modifier only when the hit's damageType matches", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const withEnOnly = holding(
      defender,
      damageMod(defender, -0.5, { direction: "INCOMING", damageType: "EN" }),
    );
    const attacker = unitAt("U_ATK", "ALLY");
    expect(compose(attacker, withEnOnly, { damageType: "EN" }).incomingMultiplier).toBeCloseTo(0.5);
    expect(compose(attacker, withEnOnly, { damageType: "PHYSICAL" }).incomingMultiplier).toBe(1);
  });

  it("UT-R-DMG-04-005: clamps a multiplier that would fall below 0 to exactly 0", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const withMods = holding(
      defender,
      damageMod(defender, -0.8, { direction: "INCOMING", damageType: null }),
      damageMod(defender, -0.7, { direction: "INCOMING", damageType: null }),
    );
    expect(compose(unitAt("U_ATK", "ALLY"), withMods).incomingMultiplier).toBe(0);
  });

  it("UT-R-DMG-03-001: damageReductionIgnoreRate scales down only the negative INCOMING modifiers", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const withMods = holding(
      defender,
      damageMod(defender, -0.4, { direction: "INCOMING", damageType: null }),
      damageMod(defender, 0.2, { direction: "INCOMING", damageType: null }),
    );
    // -0.4 * (1 - 0.5) + 0.2 = 0.0 -> multiplier 1.0 (the +0.2 increase is untouched)
    expect(
      compose(unitAt("U_ATK", "ALLY"), withMods, { damageReductionIgnoreRate: 0.5 })
        .incomingMultiplier,
    ).toBeCloseTo(1);
  });

  it("UT-R-DMG-03-002: damageReductionIgnoreRate of 1 removes the reduction entirely, and 0 leaves it intact", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const withMods = holding(
      defender,
      damageMod(defender, -0.35, { direction: "INCOMING", damageType: null }),
    );
    const attacker = unitAt("U_ATK", "ALLY");
    expect(
      compose(attacker, withMods, { damageReductionIgnoreRate: 1 }).incomingMultiplier,
    ).toBeCloseTo(1);
    expect(
      compose(attacker, withMods, { damageReductionIgnoreRate: 0 }).incomingMultiplier,
    ).toBeCloseTo(0.65);
  });

  it("UT-R-DMG-03-003: damageReductionIgnoreRate never touches negative OUTGOING modifiers on the attacker", () => {
    const attacker = unitAt("U_ATK", "ALLY");
    const withMods = holding(
      attacker,
      damageMod(attacker, -1, { direction: "OUTGOING", damageType: null }),
    );
    expect(
      compose(withMods, unitAt("U_DEF", "ENEMY"), { damageReductionIgnoreRate: 1 })
        .outgoingMultiplier,
    ).toBe(0);
  });

  it("UT-R-DMG-04-006: a UNIT_STATE condition on the effect owner gates the modifier by the owner's own HP ratio", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const modifier: DamageModifierState = {
      direction: "INCOMING",
      damageType: null,
      condition: {
        kind: "UNIT_STATE",
        unit: "EFFECT_OWNER",
        field: "HP_RATIO",
        op: "GTE",
        value: 0.65,
      },
    };
    const healthy = holding(withCurrentHp(defender, 70), damageMod(defender, -0.3, modifier));
    const wounded = holding(withCurrentHp(defender, 64), damageMod(defender, -0.3, modifier));
    const attacker = unitAt("U_ATK", "ALLY");
    expect(compose(attacker, healthy).incomingMultiplier).toBeCloseTo(0.7);
    expect(compose(attacker, wounded).incomingMultiplier).toBe(1);
  });

  it("UT-R-DMG-04-007: a UNIT_HAS_MARKER condition on OPPONENT gates the modifier by the attacker's markers", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const modifier: DamageModifierState = {
      direction: "INCOMING",
      damageType: null,
      condition: {
        kind: "UNIT_HAS_MARKER",
        unit: "OPPONENT",
        markerId: createMarkerId("MARKER_UKIASHI"),
      },
    };
    const guarded = holding(defender, damageMod(defender, -0.4, modifier));
    const plainAttacker = unitAt("U_ATK", "ALLY");
    const markedAttacker = {
      ...plainAttacker,
      markerStates: [markerOn(plainAttacker, "MARKER_UKIASHI")],
    };
    expect(compose(markedAttacker, guarded).incomingMultiplier).toBeCloseTo(0.6);
    expect(compose(plainAttacker, guarded).incomingMultiplier).toBe(1);
  });

  it("UT-R-DMG-04-008: an HP_RATIO_COMPARISON condition compares the two units in this hit", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const modifier: DamageModifierState = {
      direction: "INCOMING",
      damageType: null,
      // 「自分よりもHP割合が高い相手から攻撃された場合にのみ」
      condition: { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
    };
    const wounded = holding(withCurrentHp(defender, 40), damageMod(defender, -0.1, modifier));
    const attacker = unitAt("U_ATK", "ALLY");
    expect(compose(attacker, wounded).incomingMultiplier).toBeCloseTo(0.9);
    expect(compose(withCurrentHp(attacker, 10), wounded).incomingMultiplier).toBe(1);
  });

  it("UT-R-DMG-04-009: NOT/AND/OR compose the leaf conditions", () => {
    const defender = unitAt("U_DEF", "ENEMY");
    const modifier: DamageModifierState = {
      direction: "INCOMING",
      damageType: null,
      condition: {
        kind: "AND",
        conditions: [
          { kind: "TRUE" },
          {
            kind: "NOT",
            condition: {
              kind: "UNIT_STATE",
              unit: "OPPONENT",
              field: "HP_RATIO",
              op: "LT",
              value: 0.5,
            },
          },
        ],
      },
    };
    const guarded = holding(defender, damageMod(defender, -0.2, modifier));
    const attacker = unitAt("U_ATK", "ALLY");
    expect(compose(attacker, guarded).incomingMultiplier).toBeCloseTo(0.8);
    expect(compose(withCurrentHp(attacker, 10), guarded).incomingMultiplier).toBe(1);
  });
});
