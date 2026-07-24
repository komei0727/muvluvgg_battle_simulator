import type { ComparisonOperator } from "../../catalog/definitions/catalog-enums.js";
import type { JsonPrimitive } from "../../catalog/definitions/condition-definition.js";

/**
 * `{field, op, value}`形式の`ConditionDefinition`（`EVENT_PAYLOAD`/`RUNTIME_COUNTER`/
 * `LAST_RESULT`）が共有する比較演算子。`triggering/trigger-condition-evaluator.ts`
 * と`skill/effect-step-condition-evaluator.ts`の両方から使う（`domain/battle/skill`
 * は`triggering`へ依存できないため、両者の共有先はこのファイル自身になる）。
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
  }
}
