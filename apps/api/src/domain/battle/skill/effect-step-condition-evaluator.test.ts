import { describe, expect, it } from "vitest";
import { evaluateEffectStepCondition } from "./effect-step-condition-evaluator.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { LastEffectActionResult } from "./last-effect-action-result.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";

describe("evaluateEffectStepCondition", () => {
  it("UT-R-SKL-06-001: TRUE evaluates to true", () => {
    expect(evaluateEffectStepCondition({ kind: "TRUE" })).toBe(true);
  });

  it("UT-R-SKL-06-002: NOT(TRUE) evaluates to false", () => {
    const condition: ConditionDefinition = { kind: "NOT", condition: { kind: "TRUE" } };
    expect(evaluateEffectStepCondition(condition)).toBe(false);
  });

  it("UT-R-SKL-06-003: AND is true only when every condition is true", () => {
    const allTrue: ConditionDefinition = {
      kind: "AND",
      conditions: [{ kind: "TRUE" }, { kind: "TRUE" }],
    };
    const oneFalse: ConditionDefinition = {
      kind: "AND",
      conditions: [{ kind: "TRUE" }, { kind: "NOT", condition: { kind: "TRUE" } }],
    };
    expect(evaluateEffectStepCondition(allTrue)).toBe(true);
    expect(evaluateEffectStepCondition(oneFalse)).toBe(false);
  });

  it("UT-R-SKL-06-004: OR is true when at least one condition is true", () => {
    const condition: ConditionDefinition = {
      kind: "OR",
      conditions: [{ kind: "NOT", condition: { kind: "TRUE" } }, { kind: "TRUE" }],
    };
    expect(evaluateEffectStepCondition(condition)).toBe(true);
  });

  it("UT-R-SKL-06-005: TARGET_STATE is rejected as M7 scope", () => {
    const condition: ConditionDefinition = {
      kind: "TARGET_STATE",
      target: { kind: "SELF" },
      field: "IS_ALIVE",
      op: "EQ",
      value: true,
    };
    expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
  });

  describe("R-SKL-08: LAST_RESULT (RES-003, Issue #173/#217)", () => {
    const damageResult: LastEffectActionResult = {
      resultKind: "APPLIED",
      effectActionKind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_DAMAGE"),
      targetUnitIds: [createBattleUnitId("enemy-1"), createBattleUnitId("enemy-2")],
    };

    it("UT-R-SKL-08-001: compares resultKind against the supplied last result", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "resultKind",
        op: "EQ",
        value: "APPLIED",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
      expect(evaluateEffectStepCondition({ ...condition, value: "MISSED" }, damageResult)).toBe(
        false,
      );
    });

    it("UT-R-SKL-08-002: compares effectActionKind against the supplied last result", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "effectActionKind",
        op: "EQ",
        value: "DAMAGE",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
    });

    it("UT-R-SKL-08-003: compares effectActionDefinitionId against the supplied last result", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "effectActionDefinitionId",
        op: "EQ",
        value: "ACT_DAMAGE",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
    });

    it("UT-R-SKL-08-004: CONTAINS checks targetUnitIds membership", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "targetUnitIds",
        op: "CONTAINS",
        value: "enemy-2",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
      expect(evaluateEffectStepCondition({ ...condition, value: "enemy-9" }, damageResult)).toBe(
        false,
      );
    });

    it("UT-R-SKL-08-005: throws a Catalog-authoring error when no last result is available", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "resultKind",
        op: "EQ",
        value: "APPLIED",
      };
      expect(() => evaluateEffectStepCondition(condition, undefined)).toThrow(
        DomainValidationError,
      );
      expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-08-006: composes with AND/OR/NOT", () => {
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
          {
            kind: "NOT",
            condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "MISSED" },
          },
        ],
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
    });
  });
});
