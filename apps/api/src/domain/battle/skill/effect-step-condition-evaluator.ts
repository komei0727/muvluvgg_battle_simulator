import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { compareWithOperator } from "./comparison-operator.js";
import type { LastEffectActionResult } from "./last-effect-action-result.js";

/**
 * `LastEffectActionResult`の`field`参照を、`EVENT_PAYLOAD`と同じ`{field, op, value}`
 * 意味論で解決するための平坦なレコード（R-SKL-08）。
 */
function lastResultRecord(lastResult: LastEffectActionResult): Readonly<Record<string, unknown>> {
  return {
    resultKind: lastResult.resultKind,
    effectActionKind: lastResult.effectActionKind,
    effectActionDefinitionId: lastResult.effectActionDefinitionId,
    targetUnitIds: lastResult.targetUnitIds,
  };
}

/**
 * R-SKL-06 #1「stepのconditionを評価する。省略時はTRUEとする」。
 * `TARGET_STATE`/`TARGET_HAS_MARKER`/`EVENT_PAYLOAD`/`RUNTIME_COUNTER`/
 * `TURN_NUMBER`/`ALIVE_UNIT_COUNT`は、`MarkerState`／`RuntimeCounter`等の
 * 実行時状態(RES-004、Issue #171)を前提とするため未対応とする
 * （`triggering/trigger-condition-evaluator.ts`と同じ隔離方針）。`LAST_RESULT`
 * （R-SKL-08）は`lastResult`（呼び出し側が同じ解決スコープ内で直前に確定した
 * `EffectAction`結果を渡す、BRANCH/REPEATの内側で発生した結果も含む）を参照する。
 */
export function evaluateEffectStepCondition(
  condition: ConditionDefinition,
  lastResult?: LastEffectActionResult,
): boolean {
  switch (condition.kind) {
    case "TRUE":
      return true;
    case "AND":
      return condition.conditions.every((c) => evaluateEffectStepCondition(c, lastResult));
    case "OR":
      return condition.conditions.some((c) => evaluateEffectStepCondition(c, lastResult));
    case "NOT":
      return !evaluateEffectStepCondition(condition.condition, lastResult);
    case "LAST_RESULT": {
      if (lastResult === undefined) {
        throw new DomainValidationError(
          "step.condition",
          'kind "LAST_RESULT" requires a preceding EffectAction result in the same resolution scope (Catalog-authoring error: no step can precede this one)',
        );
      }
      const actual = lastResultRecord(lastResult)[condition.field];
      return compareWithOperator(actual, condition.op, condition.value);
    }
    default:
      throw new DomainValidationError(
        "step.condition",
        `kind "${condition.kind}" is not supported by this basic ACTION step condition evaluator (TARGET_STATE/TARGET_HAS_MARKER/EVENT_PAYLOAD/RUNTIME_COUNTER/TURN_NUMBER/ALIVE_UNIT_COUNT are RES-004 scope)`,
      );
  }
}
