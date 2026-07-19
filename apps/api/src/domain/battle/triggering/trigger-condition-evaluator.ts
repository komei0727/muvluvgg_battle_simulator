import type { ComparisonOperator } from "../../catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ConditionDefinition,
  JsonPrimitive,
} from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnit } from "../model/battle-unit.js";

/**
 * `PassiveTriggerMatcher`が参照する、任意イベントのpayloadだけを持つ最小形。
 * `TriggerDefinition.condition`の`EVENT_PAYLOAD`は`field`をpayloadのプロパティ名
 * として直接参照する（`trigger-definition.test.ts`のドット記法を持たない例と同じ）。
 */
export interface TriggerConditionPayloadSource {
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * `RUNTIME_COUNTER` Conditionを評価するために必要な`SkillRuntime`スコープの
 * 参照先（Issue #143、M6最小実装）。`owner`が`skillDefinitionId`のスキルとして
 * 保持するcounterだけを参照し、他スキルや他ユニットのcounterは見えない
 * （`07_戦闘ルール詳細.md` R-EFF-11「定義されたスコープ内で管理する」）。
 */
export interface RuntimeCounterLookupContext {
  readonly owner: BattleUnit;
  readonly skillDefinitionId: SkillDefinitionId;
}

function compare(actual: unknown, op: ComparisonOperator, expected: JsonPrimitive): boolean {
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

/**
 * R-PS-01「発生源、対象、陣営、スキル種別などをConditionDefinitionで評価する」の
 * うち、`08_ドメインイベント.md`「EVENT_PAYLOAD」と`RUNTIME_COUNTER`（M6最小実装、
 * Issue #143）に対応する評価器。`TARGET_STATE`／`TARGET_HAS_MARKER`／
 * `ALIVE_UNIT_COUNT`はMarkerState等の実行時状態(M7)を前提とするため未対応とし、
 * 呼び出し側が明確なエラーで気付けるようにする
 * (`action-selection-policy.ts`等、他の"basic"policyと同じ隔離方針)。
 */
export function evaluateTriggerCondition(
  condition: ConditionDefinition,
  event: TriggerConditionPayloadSource,
  context?: RuntimeCounterLookupContext,
): boolean {
  switch (condition.kind) {
    case "TRUE":
      return true;
    case "AND":
      return condition.conditions.every((c) => evaluateTriggerCondition(c, event, context));
    case "OR":
      return condition.conditions.some((c) => evaluateTriggerCondition(c, event, context));
    case "NOT":
      return !evaluateTriggerCondition(condition.condition, event, context);
    case "EVENT_PAYLOAD": {
      const actual = event.payload[condition.field];
      return compare(actual, condition.op, condition.value);
    }
    case "RUNTIME_COUNTER": {
      if (context === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "RUNTIME_COUNTER" requires a RuntimeCounterLookupContext (owner + skillDefinitionId)',
        );
      }
      const value = context.owner.skillCounters?.[context.skillDefinitionId]?.[condition.counter]
        ?.value ?? 0;
      if (condition.modulo !== undefined && value % condition.modulo !== 0) {
        return false;
      }
      return compare(value, condition.op, condition.value);
    }
    default:
      throw new DomainValidationError(
        "condition",
        `kind "${condition.kind}" is not supported by this basic PassiveTriggerMatcher (TARGET_STATE/TARGET_HAS_MARKER/ALIVE_UNIT_COUNT/LAST_RESULT/TURN_NUMBER are M7 scope)`,
      );
  }
}
