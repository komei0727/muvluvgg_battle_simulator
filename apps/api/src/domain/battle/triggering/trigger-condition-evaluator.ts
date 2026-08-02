import type { SkillDefinitionId, UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
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
import type { Side } from "../../shared/side.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { heldStatusKinds, holdsMatchingEffect } from "../model/applied-effect-query.js";
import type { RuntimeCounterMap } from "../model/runtime-counter-state.js";
import { frontDirectionStep } from "../targeting/position-policy.js";
import { matchesRelativeSideOf } from "../targeting/target-selection-policy.js";
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
  /**
   * R-MEM-01（Issue #179）: Memory の `triggeredEffects` から評価する場合だけ
   * `undefined`（Memoryは所有ユニットを持たない、R-MEM-04「使用者はMemoryを
   * 指定した陣営を source side とする」）。`owner`を必要とする条件種別
   * （`SELF`対象参照・`POSITION_RELATION`・`SKILL_RUNTIME`スコープの
   * `RUNTIME_COUNTER`・`excludeSelf`）は、その場合に他の未対応条件と同じ
   * 明確な`DomainValidationError`で隔離する（Catalog整合性検証／preflightが
   * 本来ここへ到達させない）。
   */
  readonly owner?: BattleUnit;
  /**
   * `owner`を持たないMemory評価での相対陣営の基準（そのMemoryを編成に指定した
   * 陣営）。`owner`がある場合は`owner.side`を使うためこのフィールドは不要。
   */
  readonly ownerSide?: Side;
  readonly skillDefinitionId?: SkillDefinitionId;
  readonly effectCounters?: RuntimeCounterMap;
  readonly getUnit?: (battleUnitId: BattleUnitId) => BattleUnit | undefined;
  readonly resolutionPhase?: ResolutionPhase;
  readonly units?: readonly BattleUnit[];
  readonly turnNumber?: number;
  /**
   * M7-001E（Issue #248、`CAP_TARGET_STATE_EXTENDED_FIELD`）: `TARGET_STATE`の
   * `UNIT_TYPE`/`ROLE`が引くCatalogの`UnitDefinition`。production定義の例は
   * `SKL_CHIYURU_MAZE_PS2`／`SKL_LUCIE_MAID_PS1`のtrigger条件（「対象が敏捷型／
   * 物理型だった場合」）。未指定時は他の未対応条件と同じく明確な例外で隔離する
   * — 黙ってfalseにすると「trigger条件が常に不成立のPS」を作ってしまう。
   */
  readonly unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
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
  owner: BattleUnit | undefined,
  event: TriggerConditionPayloadSource,
): readonly BattleUnitId[] {
  switch (target.kind) {
    case "SELF":
      // R-MEM-04「対象参照の`SELF`は使用できない」: Memory評価（owner不在）では
      // 「自身」に相当するBattleUnitが存在しないため、黙って0件にせず拒否する。
      if (owner === undefined) {
        throw new DomainValidationError(
          "condition.target",
          'kind "SELF" is not available without an owner BattleUnit (Memory triggeredEffects have no owner unit, R-MEM-04)',
        );
      }
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
 * `TARGET_STATE.field`（EFF-003レビュー修正 PR #209）を1つの値へ解決する。
 * `UNIT_TYPE`/`ROLE`はCatalogの`UnitDefinition`参照が必要なため、呼び出し側が
 * `context.unitDefinitions`で渡した参照表を引く（M7-001E、Issue #248）。
 * `HAS_STATUS`だけは対象が複数の状態を同時に保持しうる存在量化であり単一値へ
 * 解決できないため、`matchesTargetState`が別途判定する。
 *
 * `skill/effect-step-condition-evaluator.ts`の同名関数と同じ方針・意図的な重複
 * （`domain/battle/triggering`と`domain/battle/skill`は互いに依存できない）。
 */
function resolveTargetStateField(
  target: BattleUnit,
  field: TargetStateField,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition> | undefined,
): JsonPrimitive {
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
    case "ROLE": {
      const unitDefinition = unitDefinitions?.get(target.unitDefinitionId);
      if (unitDefinition === undefined) {
        throw new DomainValidationError(
          "condition.field",
          `TARGET_STATE field "${field}" requires a context with unitDefinitions containing "${target.unitDefinitionId}" (CAP_TARGET_STATE_EXTENDED_FIELD)`,
        );
      }
      return field === "UNIT_TYPE" ? unitDefinition.unitType : unitDefinition.role;
    }
    case "HAS_STATUS":
      throw new DomainValidationError(
        "condition.field",
        'TARGET_STATE field "HAS_STATUS" is existentially quantified over the target\'s held statuses and must be evaluated by matchesTargetState, not resolved to a single value',
      );
  }
}

/**
 * M7-001E（Issue #248）: 1体に対する`TARGET_STATE`を判定する。`HAS_STATUS`は
 * 「対象が保持している`APPLY_STATUS`由来の状態種別のいずれかが`op`/`value`へ
 * 一致するか」の存在量化として扱う（`skill/effect-step-condition-evaluator.ts`の
 * `matchesTargetState`と同じ契約）。
 */
function matchesTargetState(
  target: BattleUnit,
  condition: Extract<ConditionDefinition, { kind: "TARGET_STATE" }>,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition> | undefined,
): boolean {
  if (condition.field === "HAS_STATUS") {
    return heldStatusKinds(target).some((statusKind) =>
      compareWithOperator(statusKind, condition.op, condition.value),
    );
  }
  return compareWithOperator(
    resolveTargetStateField(target, condition.field, unitDefinitions),
    condition.op,
    condition.value,
  );
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
      } else if (context?.skillDefinitionId !== undefined && context.owner !== undefined) {
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
      if (context?.getUnit === undefined || context.owner === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "POSITION_RELATION" requires a context with an owner BattleUnit and a getUnit lookup (Memory triggeredEffects have no owner unit, R-MEM-04)',
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
        return matchesTargetState(target, condition, context.unitDefinitions);
      });
    }
    case "TARGET_HAS_EFFECT": {
      // `TARGET_STATE`と同じ隔離方針・同じ解決経路（`getUnit`が無ければ例外、
      // 解決先が居なければ不成立）。判定そのものは`applied-effect-query.ts`が
      // ACTION step条件と共有する（分類元・照会契約を1つに保つ）。
      if (context?.getUnit === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "TARGET_HAS_EFFECT" requires a context with a getUnit lookup (owner + getUnit)',
        );
      }
      const { owner, getUnit } = context;
      return resolveTargetReferenceIds(condition.target, owner, event).some((id) => {
        const target = getUnit(id);
        // DMG-007（Issue #187）: `grantedBy: SELF`が指す「自身」はこのPSの保持者。
        return target !== undefined && holdsMatchingEffect(target, condition, owner?.battleUnitId);
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
      const relativeSide = context?.owner?.side ?? context?.ownerSide;
      if (context?.units === undefined || relativeSide === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "ALIVE_UNIT_COUNT" requires a RuntimeCounterLookupContext with units and an owner (or ownerSide)',
        );
      }
      // Memory評価（owner不在）では除外すべき「自身」が存在しないため、
      // `excludeSelf`を黙って無視せず拒否する（R-MEM-04と同じ隔離方針）。
      if (condition.excludeSelf && context.owner === undefined) {
        throw new DomainValidationError(
          "condition",
          'kind "ALIVE_UNIT_COUNT" with excludeSelf requires an owner BattleUnit (Memory triggeredEffects have no owner unit, R-MEM-04)',
        );
      }
      const { owner, units } = context;
      const count = units.filter(
        (unit) =>
          !isDefeated(unit) &&
          matchesRelativeSideOf(unit, relativeSide, condition.side) &&
          !(condition.excludeSelf && unit.battleUnitId === owner?.battleUnitId),
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
