import { describe, expect, it } from "vitest";
import { findEffectsMatchingExpirationCondition } from "./effect-expiration-condition-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
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
  return createBattleUnit(member, "ALLY", LIMITS);
}

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_CURSE");

function effectWithConditions(
  id: string,
  target: BattleUnit,
  conditions: readonly ConditionDefinition[],
): AppliedEffect {
  const definition: DurationDefinition = {
    expiration: { conditions },
    dispellable: true,
    linkedEffectGroupId: null,
  };
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
    duplicate: true,
    sourceId: target.battleUnitId,
    targetId: target.battleUnitId,
    magnitude: 10,
    duration: { definition },
    appliedTurnNumber: 1,
  };
}

const EVENT_PAYLOAD_CONDITION: ConditionDefinition = {
  kind: "EVENT_PAYLOAD",
  field: "unitId",
  op: "EQ",
  value: "target-1",
};

describe("findEffectsMatchingExpirationCondition", () => {
  it("UT-R-EFF-08-001 (R-EFF-08): matches an instance whose expiration.conditions evaluates true against the given event", () => {
    const target = unit("target-1");
    const effect = effectWithConditions("effect-1", target, [EVENT_PAYLOAD_CONDITION]);
    const withEffect = { ...target, appliedEffects: [effect] };

    const matches = findEffectsMatchingExpirationCondition([withEffect], {
      payload: { unitId: "target-1" },
    });

    expect(matches).toEqual([
      { battleUnitId: target.battleUnitId, effectInstanceId: effect.effectInstanceId },
    ]);
  });

  it("UT-R-EFF-08-002: does not match when the condition evaluates false", () => {
    const target = unit("target-1");
    const effect = effectWithConditions("effect-1", target, [EVENT_PAYLOAD_CONDITION]);
    const withEffect = { ...target, appliedEffects: [effect] };

    const matches = findEffectsMatchingExpirationCondition([withEffect], {
      payload: { unitId: "someone-else" },
    });

    expect(matches).toHaveLength(0);
  });

  it("UT-R-EFF-08-003: ignores instances without an expiration clause", () => {
    const target = unit("target-1");
    const definition: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };
    const effect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect-1"),
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
      kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
      duplicate: true,
      sourceId: target.battleUnitId,
      targetId: target.battleUnitId,
      magnitude: 10,
      duration: { definition },
      appliedTurnNumber: 1,
    };
    const withEffect = { ...target, appliedEffects: [effect] };

    const matches = findEffectsMatchingExpirationCondition([withEffect], {
      payload: { unitId: "target-1" },
    });

    expect(matches).toHaveLength(0);
  });

  it("UT-R-EFF-08-004 (multiple independent conditions, OR semantics): matches when ANY condition in the array evaluates true", () => {
    const target = unit("target-1");
    const otherCondition: ConditionDefinition = {
      kind: "EVENT_PAYLOAD",
      field: "sourceDefeated",
      op: "EQ",
      value: true,
    };
    const effect = effectWithConditions("effect-1", target, [
      EVENT_PAYLOAD_CONDITION,
      otherCondition,
    ]);
    const withEffect = { ...target, appliedEffects: [effect] };

    const matches = findEffectsMatchingExpirationCondition([withEffect], {
      payload: { unitId: "someone-else", sourceDefeated: true },
    });

    expect(matches).toHaveLength(1);
  });

  it("UT-R-EFF-08-005: scans across multiple units, collecting matches from each", () => {
    const targetA = unit("target-a");
    const targetB = unit("target-b");
    const effectA = effectWithConditions("effect-a", targetA, [EVENT_PAYLOAD_CONDITION]);
    const effectB = effectWithConditions("effect-b", targetB, [EVENT_PAYLOAD_CONDITION]);
    const units = [
      { ...targetA, appliedEffects: [effectA] },
      { ...targetB, appliedEffects: [effectB] },
    ];

    const matches = findEffectsMatchingExpirationCondition(units, {
      payload: { unitId: "target-1" },
    });

    expect(matches).toEqual([
      { battleUnitId: targetA.battleUnitId, effectInstanceId: effectA.effectInstanceId },
      { battleUnitId: targetB.battleUnitId, effectInstanceId: effectB.effectInstanceId },
    ]);
  });

  it("UT-R-EFF-08-006 (レビュー修正 PR #209、production Catalog ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL): TARGET_STATE/SELF/IS_ALIVE resolves SELF to the effect's own holder unit (not a PS owner) and does not throw", () => {
    const alive = unit("target-1");
    const targetStateCondition: ConditionDefinition = {
      kind: "TARGET_STATE",
      target: { kind: "SELF" },
      field: "IS_ALIVE",
      op: "EQ",
      value: false,
    };
    const effect = effectWithConditions("effect-1", alive, [targetStateCondition]);
    const withEffect = { ...alive, appliedEffects: [effect] };

    const notMatched = findEffectsMatchingExpirationCondition([withEffect], { payload: {} });
    expect(notMatched).toHaveLength(0);

    const defeated = { ...alive, currentHp: 0 };
    const withDefeatedHolder = { ...defeated, appliedEffects: [effect] };
    const matched = findEffectsMatchingExpirationCondition([withDefeatedHolder], { payload: {} });
    expect(matched).toEqual([
      { battleUnitId: alive.battleUnitId, effectInstanceId: effect.effectInstanceId },
    ]);
  });

  it("UT-R-EFF-08-007: SELF resolves independently per instance across multiple units — one holder's death does not affect another holder's own TARGET_STATE/SELF evaluation", () => {
    const aliveHolder = unit("alive-holder");
    const defeatedHolder = { ...unit("defeated-holder"), currentHp: 0 };
    const targetStateCondition: ConditionDefinition = {
      kind: "TARGET_STATE",
      target: { kind: "SELF" },
      field: "IS_ALIVE",
      op: "EQ",
      value: false,
    };
    const effectOnAlive = effectWithConditions("effect-alive", aliveHolder, [targetStateCondition]);
    const effectOnDefeated = effectWithConditions("effect-defeated", defeatedHolder, [
      targetStateCondition,
    ]);
    const units = [
      { ...aliveHolder, appliedEffects: [effectOnAlive] },
      { ...defeatedHolder, appliedEffects: [effectOnDefeated] },
    ];

    const matches = findEffectsMatchingExpirationCondition(units, { payload: {} });

    expect(matches).toEqual([
      {
        battleUnitId: defeatedHolder.battleUnitId,
        effectInstanceId: effectOnDefeated.effectInstanceId,
      },
    ]);
  });

  describe("RUNTIME_COUNTER (APPLIED_EFFECT scope, EFF-005/Issue #162)", () => {
    const HIT_COUNTER = createRuntimeCounterId("RUNTIME_COUNTER_HIT_COUNT");

    function effectWithCounter(
      id: string,
      target: BattleUnit,
      conditions: readonly ConditionDefinition[],
      counterValue: number,
    ): AppliedEffect {
      const definition: DurationDefinition = {
        expiration: { conditions },
        dispellable: true,
        linkedEffectGroupId: null,
      };
      return {
        effectInstanceId: createEffectInstanceId(id),
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
        duplicate: true,
        sourceId: target.battleUnitId,
        targetId: target.battleUnitId,
        magnitude: 10,
        duration: { definition, counters: { [HIT_COUNTER]: { value: counterValue, carry: 0 } } },
        appliedTurnNumber: 1,
      };
    }

    it("UT-R-EFF-11-011: RUNTIME_COUNTER reads the effect instance's own counters (not the holder's SkillRuntime counters) and does not throw", () => {
      const target = unit("target-1");
      const condition: ConditionDefinition = {
        kind: "RUNTIME_COUNTER",
        counter: HIT_COUNTER,
        op: "GTE",
        value: 3,
      };
      const effect = effectWithCounter("effect-1", target, [condition], 3);
      const withEffect = { ...target, appliedEffects: [effect] };

      const matches = findEffectsMatchingExpirationCondition([withEffect], { payload: {} });

      expect(matches).toEqual([
        { battleUnitId: target.battleUnitId, effectInstanceId: effect.effectInstanceId },
      ]);
    });

    it("UT-R-EFF-11-012: does not match when the effect instance's counter has not reached the threshold", () => {
      const target = unit("target-1");
      const condition: ConditionDefinition = {
        kind: "RUNTIME_COUNTER",
        counter: HIT_COUNTER,
        op: "GTE",
        value: 3,
      };
      const effect = effectWithCounter("effect-1", target, [condition], 2);
      const withEffect = { ...target, appliedEffects: [effect] };

      const matches = findEffectsMatchingExpirationCondition([withEffect], { payload: {} });

      expect(matches).toHaveLength(0);
    });

    it("UT-R-EFF-11-013: each effect instance's counters are isolated from other instances (per-instance ownership)", () => {
      const target = unit("target-1");
      const condition: ConditionDefinition = {
        kind: "RUNTIME_COUNTER",
        counter: HIT_COUNTER,
        op: "GTE",
        value: 3,
      };
      const belowThreshold = effectWithCounter("effect-below", target, [condition], 1);
      const atThreshold = effectWithCounter("effect-at", target, [condition], 3);
      const withEffects = { ...target, appliedEffects: [belowThreshold, atThreshold] };

      const matches = findEffectsMatchingExpirationCondition([withEffects], { payload: {} });

      expect(matches).toEqual([
        { battleUnitId: target.battleUnitId, effectInstanceId: atThreshold.effectInstanceId },
      ]);
    });
  });
});
