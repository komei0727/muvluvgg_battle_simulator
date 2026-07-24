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
import type { RuntimeCounterMap } from "../model/runtime-counter-state.js";
import { frontDirectionStep } from "../targeting/position-policy.js";
import { matchesRelativeSide } from "../targeting/target-selection-policy.js";
import { compareWithOperator } from "../skill/comparison-operator.js";

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
 *   R-EFF-11「定義されたスコープ内で管理する」）。
 * - `effectCounters`: `RUNTIME_COUNTER`が参照する`AppliedEffect`スコープの
 *   counter（EFF-005/Issue #162）。R-EFF-08（`expiration.conditions`）は
 *   評価対象の`AppliedEffect`自身が持つ`duration.counters`をここへ渡す —
 *   `AppliedEffect`は所有スキルを持たないため`skillDefinitionId`の代わりに
 *   このcounter mapを使う。`effectCounters`が渡された場合は`skillDefinitionId`
 *   より優先する（両方渡ることは呼び出し側の設計上想定しないが、優先順位は
 *   決定的にする）。どちらも指定しない場合は評価できずthrowする。
 * - `getUnit`: `POSITION_RELATION`/`TARGET_STATE`/`TARGET_HAS_MARKER`がevent由来の
 *   BattleUnitIdから対象の`globalCoordinate`/生存状態/`markerStates`/その他
 *   フィールドを解決するための参照先。未指定時はいずれも評価できずthrowする
 *   （`RUNTIME_COUNTER`と同じ隔離方針）。
 * - `resolutionPhase`: 呼び出し側（`PassiveActivationRuntime`等）が1解決スコープ
 *   ごとに1回だけ決める、現在のroot/ancestorイベントが属するBattle/Turn phase
 *   （`R-PS-01`「固定のeventType分岐を増やさず」）。行動中など通常の解決スコープ
 *   では`undefined`（既定値、いずれの`phase`とも一致しない）。
 * - `units`: `ALIVE_UNIT_COUNT`（RES-004、Issue #171、G-03/Issue #44）が生存数を
 *   数える母集団。`owner`から見た相対陣営（`matchesRelativeSide`、`battle/targeting`
 *   と同じ相対陣営解決を再利用する）でフィルタする。未指定時は評価できずthrowする。
 * - `turnNumber`: `TURN_NUMBER`（RES-004、Issue #171）が参照する現在のターン番号。
 *   呼び出し側が1解決スコープにつき1回だけ決める（`resolutionPhase`と同じ境界）。
 *   未指定時は評価できずthrowする。
 */
export interface RuntimeCounterLookupContext {
  readonly owner: BattleUnit;
  readonly skillDefinitionId?: SkillDefinitionId;
  readonly effectCounters?: RuntimeCounterMap;
  readonly getUnit?: (battleUnitId: BattleUnitId) => BattleUnit | undefined;
  readonly resolutionPhase?: ResolutionPhase;
  readonly units?: readonly BattleUnit[];
  readonly turnNumber?: number;
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

/**
 * R-PS-01「発生源、対象、陣営、スキル種別などをConditionDefinitionで評価する」の
 * うち、`08_ドメインイベント.md`「EVENT_PAYLOAD」、`RUNTIME_COUNTER`（M6最小実装、
 * Issue #143）、`POSITION_RELATION`／`RESOLUTION_PHASE`（M6、Issue #144）、
 * `TARGET_STATE`（EFF-003レビュー修正 PR #209、`BattleUnit`から直接導出できる
 * フィールドのみ）に対応する評価器。R-EFF-08（`expiration.conditions`）も同じ
 * 評価器を再利用する — `context.owner`は`AppliedEffect`のholderユニットを渡す
 * （PS発動条件と異なり、R-EFF-08では効果インスタンスごとにholderが変わる）。
 * `TARGET_HAS_MARKER`（`BattleUnit.markerStates`）／`ALIVE_UNIT_COUNT`（`context.units`
 * を相対陣営でフィルタ）／`TURN_NUMBER`（`context.turnNumber`）はRES-004
 * （Issue #171、`CAP_PASSIVE_ACTIVATION_CONDITION`）が対応する。`TARGET_STATE`の
 * うち`UNIT_TYPE`/`ROLE`/`HAS_STATUS`はCatalog参照や状態異常追跡を前提とするため
 * 未対応とし、呼び出し側が明確なエラーで気付けるようにする(`action-selection-policy.ts`
 * 等、他の"basic"policyと同じ隔離方針)。
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
      return compareWithOperator(actual, condition.op, condition.value);
    }
    case "RUNTIME_COUNTER": {
      let value: number;
      if (context?.effectCounters !== undefined) {
        value = context.effectCounters[condition.counter]?.value ?? 0;
      } else if (context?.skillDefinitionId !== undefined) {
        value =
          context.owner.skillCounters?.[context.skillDefinitionId]?.[condition.counter]?.value ?? 0;
      } else {
        throw new DomainValidationError(
          "condition",
          'kind "RUNTIME_COUNTER" requires a RuntimeCounterLookupContext (owner + skillDefinitionId, or owner + effectCounters)',
        );
      }
      if (condition.modulo !== undefined && value % condition.modulo !== 0) {
        return false;
      }
      return compareWithOperator(value, condition.op, condition.value);
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
        return compareWithOperator(actual, condition.op, condition.value);
      });
    }
    case "TARGET_HAS_MARKER": {
      if (context?.getUnit === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "TARGET_HAS_MARKER" requires a context with a getUnit lookup (owner + getUnit)',
        );
      }
      const { owner, getUnit } = context;
      const targetIds = resolveTargetReferenceIds(condition.target, owner, event);
      return targetIds.some((id) => {
        const target = getUnit(id);
        if (target === undefined) {
          return false;
        }
        const marker = target.markerStates.find((state) => state.markerId === condition.markerId);
        if (marker === undefined) {
          return false;
        }
        if (condition.countCondition === undefined) {
          return true;
        }
        return compareWithOperator(
          marker.stackCount,
          condition.countCondition.op,
          condition.countCondition.value,
        );
      });
    }
    case "ALIVE_UNIT_COUNT": {
      if (context?.units === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "ALIVE_UNIT_COUNT" requires a RuntimeCounterLookupContext with units (owner + units)',
        );
      }
      const { owner, units } = context;
      const count = units.filter(
        (unit) =>
          !isDefeated(unit) &&
          matchesRelativeSide(unit, owner, condition.side) &&
          !(condition.excludeSelf && unit.battleUnitId === owner.battleUnitId),
      ).length;
      return compareWithOperator(count, condition.op, condition.value);
    }
    case "TURN_NUMBER": {
      if (context?.turnNumber === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "TURN_NUMBER" requires a RuntimeCounterLookupContext with turnNumber',
        );
      }
      // `modulo`はRUNTIME_COUNTERと異なり、比較対象そのものを剰余へ置き換える
      // （turnNumberは「Nターンごと」を表す剰余判定そのものが目的で、RUNTIME_COUNTER
      // のように剰余ゲート＋生値比較を独立に組み合わせる必要がない）。production
      // Catalog `SKL_MERU_SIRIUS_PS2`（`op: EQ, value: 0, modulo: 2`）は1始まりの
      // turnNumberに対し「偶数ターンで発動」を表し、剰余ゲート＋生値比較では
      // turnNumberが0にならない限り絶対に成立しない。
      const compared =
        condition.modulo !== undefined ? context.turnNumber % condition.modulo : context.turnNumber;
      return compareWithOperator(compared, condition.op, condition.value);
    }
    default:
      throw new DomainValidationError(
        "condition",
        `kind "${condition.kind}" is not supported by this basic PassiveTriggerMatcher (LAST_RESULT is EffectStep-scoped, see effect-step-condition-evaluator.ts)`,
      );
  }
}
