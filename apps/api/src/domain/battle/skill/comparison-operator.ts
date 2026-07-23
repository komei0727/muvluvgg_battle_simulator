import type { ComparisonOperator } from "../../catalog/definitions/catalog-enums.js";
import type { JsonPrimitive } from "../../catalog/definitions/condition-definition.js";

/**
 * `ConditionDefinition`の`op`/`value`比較を共通化する。`EVENT_PAYLOAD`
 * （`triggering/trigger-condition-evaluator.ts`）と`LAST_RESULT`
 * （`effect-step-condition-evaluator.ts`）が同じ`{field, op, value}`形と
 * 比較意味論を共有するため、RES-003（Issue #173）でここへ抽出した。
 */
export function compareWithOperator(
  actual: unknown,
  op: ComparisonOperator,
  expected: JsonPrimitive,
): boolean {
  switch (op) {
    case "GT":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "GTE":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "LT":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "LTE":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "EQ":
      return actual === expected;
    case "NEQ":
      return actual !== expected;
    case "IN":
      return Array.isArray(expected) && (expected as readonly unknown[]).includes(actual);
    case "CONTAINS":
      return Array.isArray(actual) && (actual as readonly unknown[]).includes(expected);
    default:
      return false;
  }
}
