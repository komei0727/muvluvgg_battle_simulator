import type { ComparisonOperator } from "../../catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ConditionDefinition,
  JsonPrimitive,
  PositionRelation,
  ResolutionPhase,
  TargetStateField,
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
 * - `owner`: `POSITION_RELATION`/`TARGET_STATE`の`SELF`が指す所有者ユニット。
 *   PS発動条件ではPS所有者、R-EFF-08（`expiration.conditions`）では評価対象の
 *   `AppliedEffect`を保持するユニット（効果インスタンスごとに変わる）。
 * - `skillDefinitionId`: `RUNTIME_COUNTER`が参照する`SkillRuntime`スコープの
 *   所有スキル（`owner`が`skillDefinitionId`のスキルとして保持するcounterだけを
 *   参照し、他スキルや他ユニットのcounterは見えない、`07_戦闘ルール詳細.md`
 *   R-EFF-11「定義されたスコープ内で管理する」）。`AppliedEffect`は所有スキルを
 *   持たないため、R-EFF-08呼び出しでは省略できる — その場合`RUNTIME_COUNTER`は
 *   評価できずthrowする。
 * - `getUnit`: `POSITION_RELATION`/`TARGET_STATE`がevent由来のBattleUnitIdから
 *   対象の`globalCoordinate`/生存状態/その他フィールドを解決するための参照先。
 *   未指定時はどちらも評価できずthrowする（`RUNTIME_COUNTER`と同じ隔離方針）。
 * - `resolutionPhase`: 呼び出し側（`PassiveActivationRuntime`等）が1解決スコープ
 *   ごとに1回だけ決める、現在のroot/ancestorイベントが属するBattle/Turn phase
 *   （`R-PS-01`「固定のeventType分岐を増やさず」）。行動中など通常の解決スコープ
 *   では`undefined`（既定値、いずれの`phase`とも一致しない）。
 */
export interface RuntimeCounterLookupContext {
  readonly owner: BattleUnit;
  readonly skillDefinitionId?: SkillDefinitionId;
  readonly getUnit?: (battleUnitId: BattleUnitId) => BattleUnit | undefined;
  readonly resolutionPhase?: ResolutionPhase;
}

/**
 * `TargetReference`をtrigger文脈で解決する。`SELF`は所有者自身（`POSITION_RELATION`
 * ではPS所有者、`TARGET_STATE`ではその効果を保持するownerユニット）、
 * `TRIGGER_SOURCE`/`TRIGGER_TARGET`はeventのpayload外の発生源・対象を参照する。
 * `BINDING`はEffectSequence文脈（M7）を前提とするため、`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`とともにここでは未対応とする。
 */
function resolveTargetReferenceIds(
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
        `kind "${target.kind}" is not supported by this basic evaluator in trigger context (only SELF/TRIGGER_SOURCE/TRIGGER_TARGET)`,
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

/**
 * `TARGET_STATE.field`（EFF-003レビュー修正 PR #209）を、`BattleUnit`自体から
 * 直接導出できる範囲だけ解決する。`UNIT_TYPE`/`ROLE`はCatalogの`UnitDefinition`
 * 参照が必要（このevaluatorはCatalog参照を持たない）、`HAS_STATUS`は状態異常
 * 追跡（M7-003等）が未実装のため、いずれも明確なエラーで隔離する（他の
 * "basic"evaluatorと同じ方針）。
 */
function resolveTargetStateField(target: BattleUnit, field: TargetStateField): JsonPrimitive {
  switch (field) {
    case "IS_ALIVE":
      return !isDefeated(target);
    case "HP_RATIO":
      return target.combatStats.maximumHp > 0 ? target.currentHp / target.combatStats.maximumHp : 0;
    case "ATTRIBUTE":
      return target.attribute;
    case "POSITION_ROW":
      return target.position.row;
    case "POSITION_COLUMN":
      return target.position.column;
    case "RESOURCE_AP":
      return target.currentAp;
    case "RESOURCE_PP":
      return target.currentPp;
    case "RESOURCE_EX_GAUGE":
      return target.currentExtraGauge;
    case "UNIT_TYPE":
    case "ROLE":
    case "HAS_STATUS":
      throw new DomainValidationError(
        "condition.field",
        `TARGET_STATE field "${field}" is not supported by this basic evaluator (requires a Catalog UnitDefinition lookup or state-ailment tracking not yet available)`,
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
 * Issue #143）、`POSITION_RELATION`／`RESOLUTION_PHASE`（M6、Issue #144）、
 * `TARGET_STATE`（EFF-003レビュー修正 PR #209、`BattleUnit`から直接導出できる
 * フィールドのみ）に対応する評価器。R-EFF-08（`expiration.conditions`）も同じ
 * 評価器を再利用する — `context.owner`は`AppliedEffect`のholderユニットを渡す
 * （PS発動条件と異なり、R-EFF-08では効果インスタンスごとにholderが変わる）。
 * `TARGET_HAS_MARKER`／`ALIVE_UNIT_COUNT`はMarkerState等の実行時状態(M7)を、
 * `TARGET_STATE`のうち`UNIT_TYPE`/`ROLE`/`HAS_STATUS`はCatalog参照や状態異常
 * 追跡を前提とするため未対応とし、呼び出し側が明確なエラーで気付けるように
 * する(`action-selection-policy.ts`等、他の"basic"policyと同じ隔離方針)。
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
      if (context?.skillDefinitionId === undefined) {
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
      const targetIds = resolveTargetReferenceIds(condition.target, owner, event);
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
    case "TARGET_STATE": {
      if (context?.getUnit === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "TARGET_STATE" requires a context with a getUnit lookup (owner + getUnit)',
        );
      }
      const { owner, getUnit } = context;
      const targetIds = resolveTargetReferenceIds(condition.target, owner, event);
      return targetIds.some((id) => {
        const target = getUnit(id);
        if (target === undefined) {
          return false;
        }
        const actual = resolveTargetStateField(target, condition.field);
        return compare(actual, condition.op, condition.value);
      });
    }
    default:
      throw new DomainValidationError(
        "condition",
        `kind "${condition.kind}" is not supported by this basic PassiveTriggerMatcher (TARGET_STATE/TARGET_HAS_MARKER/ALIVE_UNIT_COUNT/LAST_RESULT/TURN_NUMBER are M7 scope)`,
      );
  }
}
