import { describe, expect, it } from "vitest";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";

const SKILL_ID = createSkillDefinitionId("SKL_PS1");
const COUNTER_ID = createRuntimeCounterId("RUNTIME_COUNTER_CRIT");

function ownerWithCounter(value?: number): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("U1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position: { row: "FRONT", column: "LEFT" },
    globalCoordinate: toGlobalCoordinate("ALLY", { row: "FRONT", column: "LEFT" }),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
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
  if (value === undefined) {
    return unit;
  }
  return {
    ...unit,
    skillCounters: { [SKILL_ID]: { [COUNTER_ID]: { value, carry: 0 } } },
  };
}

describe("evaluateTriggerCondition", () => {
  it("UT-R-PS-01-001: TRUE always matches", () => {
    expect(evaluateTriggerCondition({ kind: "TRUE" }, { payload: {} })).toBe(true);
  });

  it("UT-R-PS-01-002: EVENT_PAYLOAD compares a payload field with the operator", () => {
    const condition: ConditionDefinition = {
      kind: "EVENT_PAYLOAD",
      field: "hpDamage",
      op: "GT",
      value: 0,
    };
    expect(evaluateTriggerCondition(condition, { payload: { hpDamage: 5 } })).toBe(true);
    expect(evaluateTriggerCondition(condition, { payload: { hpDamage: 0 } })).toBe(false);
  });

  it("UT-R-PS-01-003: EVENT_PAYLOAD supports EQ/NEQ/IN/CONTAINS against string and array payload fields", () => {
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "status", op: "EQ", value: "FREEZE" },
        { payload: { status: "FREEZE" } },
      ),
    ).toBe(true);
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "status", op: "NEQ", value: "FREEZE" },
        { payload: { status: "STUN" } },
      ),
    ).toBe(true);
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "status", op: "IN", value: ["FREEZE", "STUN"] as never },
        { payload: { status: "STUN" } },
      ),
    ).toBe(true);
  });

  it("UT-R-PS-01-004: EVENT_PAYLOAD returns false when the field is missing from payload", () => {
    const condition: ConditionDefinition = {
      kind: "EVENT_PAYLOAD",
      field: "missingField",
      op: "EQ",
      value: 1,
    };
    expect(evaluateTriggerCondition(condition, { payload: {} })).toBe(false);
  });

  it("UT-R-PS-01-005: AND requires every sub-condition to hold", () => {
    const condition: ConditionDefinition = {
      kind: "AND",
      conditions: [
        { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: 1 },
        { kind: "EVENT_PAYLOAD", field: "b", op: "EQ", value: 2 },
      ],
    };
    expect(evaluateTriggerCondition(condition, { payload: { a: 1, b: 2 } })).toBe(true);
    expect(evaluateTriggerCondition(condition, { payload: { a: 1, b: 3 } })).toBe(false);
  });

  it("UT-R-PS-01-006: OR requires at least one sub-condition to hold", () => {
    const condition: ConditionDefinition = {
      kind: "OR",
      conditions: [
        { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: 1 },
        { kind: "EVENT_PAYLOAD", field: "b", op: "EQ", value: 2 },
      ],
    };
    expect(evaluateTriggerCondition(condition, { payload: { a: 0, b: 2 } })).toBe(true);
    expect(evaluateTriggerCondition(condition, { payload: { a: 0, b: 0 } })).toBe(false);
  });

  it("UT-R-PS-01-007: NOT inverts the inner condition", () => {
    const condition: ConditionDefinition = {
      kind: "NOT",
      condition: { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: 1 },
    };
    expect(evaluateTriggerCondition(condition, { payload: { a: 1 } })).toBe(false);
    expect(evaluateTriggerCondition(condition, { payload: { a: 2 } })).toBe(true);
  });

  it("UT-R-PS-01-008: an unsupported condition kind throws a clear DomainValidationError (M7 scope)", () => {
    const condition: ConditionDefinition = {
      kind: "TURN_NUMBER",
      op: "EQ",
      value: 1,
    };
    expect(() => evaluateTriggerCondition(condition, { payload: {} })).toThrow(
      DomainValidationError,
    );
  });

  describe("RUNTIME_COUNTER (Issue #143)", () => {
    const condition: Extract<ConditionDefinition, { kind: "RUNTIME_COUNTER" }> = {
      kind: "RUNTIME_COUNTER",
      counter: COUNTER_ID,
      op: "GTE",
      value: 1,
    };

    it("UT-R-PS-01-009: throws when no RuntimeCounterLookupContext is supplied", () => {
      expect(() => evaluateTriggerCondition(condition, { payload: {} })).toThrow(
        DomainValidationError,
      );
    });

    it("UT-R-PS-01-010: an absent counter defaults to value 0", () => {
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: ownerWithCounter(), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-011: compares the owning skill's current counter value with op/value", () => {
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: ownerWithCounter(1), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: ownerWithCounter(0), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-012 (RUNTIME_COUNTER_MODULO): modulo adds 'value mod modulo == 0' as an extra condition (every 3rd)", () => {
      const everyThird: ConditionDefinition = { ...condition, modulo: 3 };
      expect(
        evaluateTriggerCondition(
          everyThird,
          { payload: {} },
          { owner: ownerWithCounter(3), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          everyThird,
          { payload: {} },
          { owner: ownerWithCounter(4), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(false);
      expect(
        evaluateTriggerCondition(
          everyThird,
          { payload: {} },
          { owner: ownerWithCounter(6), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-013: a counter belonging to a different SkillDefinitionId is not visible (SKILL_RUNTIME scope isolation)", () => {
      const owner = ownerWithCounter(5);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          {
            owner,
            skillDefinitionId: createSkillDefinitionId("SKL_OTHER"),
          },
        ),
      ).toBe(false);
    });
  });
});
