import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

/**
 * R-SKL-06 #1「stepのconditionを評価する。省略時はTRUEとする」。
 * `TARGET_STATE`/`TARGET_HAS_MARKER`/`EVENT_PAYLOAD`/`LAST_RESULT`/
 * `RUNTIME_COUNTER`/`TURN_NUMBER`/`ALIVE_UNIT_COUNT`は、`MarkerState`／
 * `RuntimeCounter`／直前結果等の実行時状態(M7)を前提とするため未対応とする
 * （`triggering/trigger-condition-evaluator.ts`と同じ隔離方針）。
 */
export function evaluateEffectStepCondition(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TRUE":
      return true;
    case "AND":
      return condition.conditions.every((c) => evaluateEffectStepCondition(c));
    case "OR":
      return condition.conditions.some((c) => evaluateEffectStepCondition(c));
    case "NOT":
      return !evaluateEffectStepCondition(condition.condition);
    default:
      throw new DomainValidationError(
        "step.condition",
        `kind "${condition.kind}" is not supported by this basic ACTION step condition evaluator (TARGET_STATE/TARGET_HAS_MARKER/EVENT_PAYLOAD/LAST_RESULT/RUNTIME_COUNTER/TURN_NUMBER/ALIVE_UNIT_COUNT are M7 scope)`,
      );
  }
}
