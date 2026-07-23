import { describe, expect, it } from "vitest";
import { evaluateEffectStepCondition } from "./effect-step-condition-evaluator.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { LastEffectActionResult } from "./last-effect-action-result.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";

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

  const missedResult: LastEffectActionResult = {
    resultKind: "MISSED",
    effectActionKind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_EXAMPLE"),
    targetUnitIds: [createBattleUnitId("ENEMY_1")],
  };

  it("UT-R-SKL-08-001 (R-SKL-08): LAST_RESULT field=resultKind compares against the threaded last result", () => {
    const condition: ConditionDefinition = {
      kind: "LAST_RESULT",
      field: "resultKind",
      op: "EQ",
      value: "MISSED",
    };
    expect(evaluateEffectStepCondition(condition, missedResult)).toBe(true);
    expect(evaluateEffectStepCondition({ ...condition, value: "APPLIED" }, missedResult)).toBe(
      false,
    );
  });

  it("UT-R-SKL-08-002 (R-SKL-08): LAST_RESULT can compare other last-result fields such as effectActionKind", () => {
    const condition: ConditionDefinition = {
      kind: "LAST_RESULT",
      field: "effectActionKind",
      op: "NEQ",
      value: "APPLY_MARKER",
    };
    expect(evaluateEffectStepCondition(condition, missedResult)).toBe(true);
  });

  it("UT-R-SKL-08-003 (R-SKL-08): LAST_RESULT nested inside AND/OR/NOT still reads the threaded last result", () => {
    const condition: ConditionDefinition = {
      kind: "AND",
      conditions: [
        { kind: "TRUE" },
        {
          kind: "NOT",
          condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
        },
      ],
    };
    expect(evaluateEffectStepCondition(condition, missedResult)).toBe(true);
  });

  it("UT-R-SKL-08-004 (R-SKL-08, boundary): LAST_RESULT with no preceding result throws (Catalog-authoring error, not a legitimate runtime state)", () => {
    const condition: ConditionDefinition = {
      kind: "LAST_RESULT",
      field: "resultKind",
      op: "EQ",
      value: "MISSED",
    };
    expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
  });
});
