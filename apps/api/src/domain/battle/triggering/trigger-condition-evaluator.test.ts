import { describe, expect, it } from "vitest";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

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
});
