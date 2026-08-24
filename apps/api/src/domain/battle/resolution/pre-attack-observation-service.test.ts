import { describe, expect, it } from "vitest";
import { shouldObserve, withFollowUpRiderDamageTypes } from "./pre-attack-observation-service.js";
import { evaluateTriggerCondition } from "../triggering/trigger-condition-evaluator.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const RIDER_ID = createEffectActionDefinitionId("ACT_TEST_FOLLOW_UP_RIDER");

function unit(id: string, appliedEffects: readonly AppliedEffect[] = []): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
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
  const built = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...built, appliedEffects };
}

function riderEffect(): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId("B_TEST:effect:rider"),
    effectActionDefinitionId: RIDER_ID,
    kindKey: effectKindKeyFromDefinitionId(RIDER_ID),
    duplicate: true,
    targetUnitId: createBattleUnitId("ATTACKER"),
    magnitude: 0,
    categories: ["BUFF"],
    isFollowUpAttack: true,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function riderDefinition(damageType: DamageType): EffectActionDefinition {
  return {
    kind: "APPLY_FOLLOW_UP_ATTACK",
    effectActionDefinitionId: RIDER_ID,
    metadata: { tags: [] },
    payload: {
      damage: { damageType, formula: { kind: "CONSTANT", value: 10 } },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  };
}

const EFFECT_ACTIONS: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> = new Map([
  [RIDER_ID, riderDefinition("EN")],
]);

describe("pre-attack observation (R-ATM-03)", () => {
  it("UT-R-ATM-03-007 (R-ATM-03 #7): a captured follow-up rider's damage type joins the observation's damageTypes set, and an EVENT_PAYLOAD damageType condition then holds on the mixed set", () => {
    const attacker = unit("ATTACKER", [riderEffect()]);
    const observations = withFollowUpRiderDamageTypes(
      [{ targetUnitId: createBattleUnitId("TARGET"), damageTypes: ["PHYSICAL"] }],
      attacker,
      EFFECT_ACTIONS,
    );

    expect(observations).toEqual([
      { targetUnitId: createBattleUnitId("TARGET"), damageTypes: ["PHYSICAL", "EN"] },
    ]);
    // 集合のいずれかで成立すれば真（`SKL_SHIRANA_SORA_PS2`の trigger と同じ形）。
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "damageType", op: "EQ", value: "EN" },
        { payload: { damageTypes: observations[0]!.damageTypes } },
      ),
    ).toBe(true);
  });

  it("UT-R-ATM-03-008 (R-ATM-03 #7 boundary): a rider whose type is already in the set adds nothing, and an attacker holding no rider leaves the observations untouched", () => {
    const physicalRider: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> = new Map([
      [RIDER_ID, riderDefinition("PHYSICAL")],
    ]);
    const observations = [
      { targetUnitId: createBattleUnitId("TARGET"), damageTypes: ["PHYSICAL" as DamageType] },
    ];

    expect(
      withFollowUpRiderDamageTypes(observations, unit("ATTACKER", [riderEffect()]), physicalRider),
    ).toEqual(observations);
    // ライダーを持たない攻撃側では、同じ配列がそのまま返る（複製もしない）。
    expect(withFollowUpRiderDamageTypes(observations, unit("ATTACKER"), EFFECT_ACTIONS)).toBe(
      observations,
    );
  });

  it("UT-R-ATM-03-009 (R-ATM-03 #4): a target that is already defeated at the moment of emission is not observed", () => {
    const alive = unit("ALIVE");
    const defeated: BattleUnit = { ...unit("DEFEATED"), currentHp: 0 };
    const units = [alive, defeated];

    expect(shouldObserve(units, alive.battleUnitId)).toBe(true);
    expect(shouldObserve(units, defeated.battleUnitId)).toBe(false);
    // 盤面から消えた（存在しない）idも観測しない。
    expect(shouldObserve(units, createBattleUnitId("ABSENT"))).toBe(false);
  });
});
