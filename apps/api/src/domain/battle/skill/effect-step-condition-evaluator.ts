import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { compareWithOperator } from "./comparison-operator.js";
import type { LastEffectActionResult } from "./last-effect-action-result.js";

/** R-SKL-08: `LastEffectActionResult`を`LAST_RESULT`の`field`が参照できる平坦なrecordへ変換する。 */
function lastResultRecord(lastResult: LastEffectActionResult): Readonly<Record<string, unknown>> {
  return {
    resultKind: lastResult.resultKind,
    effectActionKind: lastResult.effectActionKind,
    effectActionDefinitionId: lastResult.effectActionDefinitionId,
    targetUnitIds: lastResult.targetUnitIds,
  };
}

/**
 * R-SKL-06 #1「stepのconditionを評価する。省略時はTRUEとする」に加え、
 * R-SKL-08「直前結果」の`LAST_RESULT`（同じ解決スコープ内の直前に確定した
 * `EffectAction`結果を参照する）を評価する。`lastResult`は呼び出し側
 * （`effect-action-group-resolver.ts`）が同じ解決スコープの`LastResultState`
 * から渡す — 未実行の（「もし実行していたら」の）結果を渡してはならない。
 * `lastResult`が`undefined`のまま`LAST_RESULT`条件へ到達するのはCatalog
 * preflight（`catalog-integrity.ts`の`MISSING_PRECEDING_RESULT`検証）が
 * 本来防ぐべき構成であり、ここでは最終防衛線として明確な例外を投げる。
 * `TARGET_STATE`/`TARGET_HAS_MARKER`/`EVENT_PAYLOAD`/`RUNTIME_COUNTER`/
 * `TURN_NUMBER`/`ALIVE_UNIT_COUNT`は、`MarkerState`／`RuntimeCounter`等の
 * 実行時状態(M7)を前提とするため未対応とする（`triggering/trigger-condition-evaluator.ts`
 * と同じ隔離方針）。
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
        `kind "${condition.kind}" is not supported by this basic ACTION step condition evaluator (TARGET_STATE/TARGET_HAS_MARKER/EVENT_PAYLOAD/RUNTIME_COUNTER/TURN_NUMBER/ALIVE_UNIT_COUNT are M7 scope)`,
      );
  }
}
