import type { ComparisonOperator } from "../../catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ConditionDefinition,
  JsonPrimitive,
  PositionRelation,
  ResolutionPhase,
} from "../../catalog/definitions/condition-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { frontDirectionStep } from "../targeting/position-policy.js";

/**
 * `PassiveTriggerMatcher`が参照する、任意イベントのpayloadだけを持つ最小形。
 * `TriggerDefinition.condition`の`EVENT_PAYLOAD`は`field`をpayloadのプロパティ名
 * として直接参照する（`trigger-definition.test.ts`のドット記法を持たない例と同じ）。
 * `sourceUnitId`/`targetUnitIds`は`POSITION_RELATION`（Issue #144）が
 * `TRIGGER_SOURCE`/`TRIGGER_TARGET`を解決するために参照する。
 */
export interface TriggerConditionPayloadSource {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sourceUnitId?: BattleUnitId;
  readonly targetUnitIds?: readonly BattleUnitId[];
}

/**
 * `RUNTIME_COUNTER`／`POSITION_RELATION`／`RESOLUTION_PHASE` Conditionを評価する
 * ために必要な文脈（Issue #143/#144、M6最小実装）。
 *
 * - `owner`/`skillDefinitionId`: `RUNTIME_COUNTER`が参照する`SkillRuntime`
 *   スコープの所有者（`owner`が`skillDefinitionId`のスキルとして保持する
 *   counterだけを参照し、他スキルや他ユニットのcounterは見えない、
 *   `07_戦闘ルール詳細.md` R-EFF-11「定義されたスコープ内で管理する」）。
 *   `POSITION_RELATION`もPS所有者の`globalCoordinate`を参照するために使う。
 * - `getUnit`: `POSITION_RELATION`がevent由来のBattleUnitIdから対象の
 *   `globalCoordinate`/生存状態を解決するための参照先。未指定時は
 *   `POSITION_RELATION`を評価できずthrowする（`RUNTIME_COUNTER`と同じ隔離方針）。
 * - `resolutionPhase`: 呼び出し側（`PassiveActivationRuntime`等）が1解決スコープ
 *   ごとに1回だけ決める、現在のroot/ancestorイベントが属するBattle/Turn phase
 *   （`R-PS-01`「固定のeventType分岐を増やさず」）。行動中など通常の解決スコープ
 *   では`undefined`（既定値、いずれの`phase`とも一致しない）。
 */
export interface RuntimeCounterLookupContext {
  readonly owner: BattleUnit;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly getUnit?: (battleUnitId: BattleUnitId) => BattleUnit | undefined;
  readonly resolutionPhase?: ResolutionPhase;
}

/**
 * `POSITION_RELATION.target`（`TargetReference`）をtrigger文脈で解決する。
 * `SELF`はPS所有者自身、`TRIGGER_SOURCE`/`TRIGGER_TARGET`はeventのpayload外の
 * 発生源・対象を参照する。`BINDING`はEffectSequence文脈（M7）を前提とするため、
 * `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`とともにここでは未対応とする。
 */
function resolvePositionRelationTargetIds(
  target: TargetReference,
  owner: BattleUnit,
  event: TriggerConditionPayloadSource,
): readonly BattleUnitId[] {
  switch (target.kind) {
    case "SELF":
      return [owner.battleUnitId];
    case "TRIGGER_SOURCE":
      return event.sourceUnitId !== undefined ? [event.sourceUnitId] : [];
    case "TRIGGER_TARGET":
      return event.targetUnitIds ?? [];
    default:
      throw new DomainValidationError(
        "condition.target",
        `kind "${target.kind}" is not supported by POSITION_RELATION in trigger context (only SELF/TRIGGER_SOURCE/TRIGGER_TARGET)`,
      );
  }
}

/** R-POS-02由来の`frontDirectionStep`で、`owner`から見て`relation`が成立する`target`かどうかを判定する。 */
function matchesPositionRelation(
  owner: BattleUnit,
  target: BattleUnit,
  relation: PositionRelation,
): boolean {
  switch (relation) {
    case "IN_FRONT_OF":
      return (
        target.globalCoordinate.x === owner.globalCoordinate.x &&
        target.globalCoordinate.y === owner.globalCoordinate.y + frontDirectionStep(owner.side)
      );
  }
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
 * うち、`08_ドメインイベント.md`「EVENT_PAYLOAD」、`RUNTIME_COUNTER`（M6最小実装、
 * Issue #143）、`POSITION_RELATION`／`RESOLUTION_PHASE`（M6、Issue #144）に対応する
 * 評価器。`TARGET_STATE`／`TARGET_HAS_MARKER`／`ALIVE_UNIT_COUNT`はMarkerState等の
 * 実行時状態(M7)を前提とするため未対応とし、呼び出し側が明確なエラーで
 * 気付けるようにする(`action-selection-policy.ts`等、他の"basic"policyと同じ
 * 隔離方針)。
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
      const value =
        context.owner.skillCounters?.[context.skillDefinitionId]?.[condition.counter]?.value ?? 0;
      if (condition.modulo !== undefined && value % condition.modulo !== 0) {
        return false;
      }
      return compare(value, condition.op, condition.value);
    }
    case "POSITION_RELATION": {
      if (context?.getUnit === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "POSITION_RELATION" requires a context with a getUnit lookup (owner + getUnit)',
        );
      }
      const { owner, getUnit } = context;
      const targetIds = resolvePositionRelationTargetIds(condition.target, owner, event);
      return targetIds.some((id) => {
        const target = getUnit(id);
        return (
          target !== undefined &&
          !isDefeated(target) &&
          matchesPositionRelation(owner, target, condition.relation)
        );
      });
    }
    case "RESOLUTION_PHASE": {
      const matches = context?.resolutionPhase === condition.phase;
      return condition.negate ? !matches : matches;
    }
    default:
      throw new DomainValidationError(
        "condition",
        `kind "${condition.kind}" is not supported by this basic PassiveTriggerMatcher (TARGET_STATE/TARGET_HAS_MARKER/ALIVE_UNIT_COUNT/LAST_RESULT/TURN_NUMBER are M7 scope)`,
      );
  }
}
