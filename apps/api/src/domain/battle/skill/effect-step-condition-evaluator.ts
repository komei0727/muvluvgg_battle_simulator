import type {
  ConditionDefinition,
  JsonPrimitive,
  TargetStateField,
} from "../../catalog/definitions/condition-definition.js";
import type { UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import {
  targetReferenceEquals,
  type TargetReference,
} from "../../catalog/definitions/references.js";
import { DomainValidationError } from "../../shared/errors.js";
import { compareWithOperator } from "./comparison-operator.js";
import type { LastEffectActionResult } from "./last-effect-action-result.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";

/** R-SKL-06: `LastEffectActionResult`を`LAST_RESULT`の`field`が参照できる平坦なrecordへ変換する。 */
function lastResultRecord(lastResult: LastEffectActionResult): Readonly<Record<string, unknown>> {
  return {
    resultKind: lastResult.resultKind,
    effectActionKind: lastResult.effectActionKind,
    effectActionDefinitionId: lastResult.effectActionDefinitionId,
    targetUnitIds: lastResult.targetUnitIds,
  };
}

/**
 * R-SKL-06（CAP_EFFECT_STEP_CONDITION_SCOPE、Issue #230。旧CAP_EFFECT_STEP_CONDITION
 * Issue #171 RES-004後半）: ACTION stepの`targetCondition`（常にその step自身の
 * `target`と同じ`TargetReference`を参照する`TARGET_STATE`/`TARGET_HAS_MARKER`
 * のみで構成される、Catalogロード時点で保証される）を評価するために必要な、
 * 対象ごとの文脈。`stepTarget`と一致する`TargetReference`は`current`（今評価
 * している1体）へ個別に解決し、それ以外（`SELF`/`TRIGGER_SOURCE`など、stepの
 * 対象集合とは無関係な参照）は`resolveOtherReference`で解決する（対象によらず
 * 一定の結果になる）。
 */
export interface EffectStepTargetContext {
  readonly stepTarget: TargetReference;
  readonly current: BattleUnit;
  readonly resolveOtherReference: (reference: TargetReference) => readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
}

/**
 * R-SKL-06/07（CAP_EFFECT_STEP_SET_CONDITION、Issue #227 RES-004集合条件）:
 * `condition`のどこかに`TARGET_SET_COUNT`が含まれるか（AND/OR/NOTを再帰的に見る）。
 * 含まれる場合、この条件は`resolveTargetSet`（`TargetSetResolver`）が必要で、
 * かつ先行stepやPS/Memory連鎖が変更した後の最新状態を反映する必要があるため、
 * 呼び出し側（`skill-resolution-service.ts`の`isEagerActionStep`）はplanning
 * 時点（対象bindingを解決した直後、まだどのstepも実行していない時点）で
 * 即時評価せず、実行がその位置まで進んだ時点でJITに評価する
 * （`conditionReferencesLastResult`と同じ理由・同じ形）。
 */
export function conditionReferencesTargetSetCount(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TARGET_SET_COUNT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionReferencesTargetSetCount(c));
    case "NOT":
      return conditionReferencesTargetSetCount(condition.condition);
    default:
      return false;
  }
}

/**
 * `TARGET_STATE.field`を`BattleUnit`から解決する。`UNIT_TYPE`はCatalogの
 * `UnitDefinition`参照が必要なため`unitDefinitions`を引く。`ROLE`（同じく
 * `UnitDefinition`参照）と`HAS_STATUS`（状態異常追跡、`TARGET_STATE_QUERY_BUFF_DEBUFF`
 * テーマ）は、それぞれ本Capabilityが検証済みのproduction定義を持たないため
 * 未対応のまま隔離する（`triggering/trigger-condition-evaluator.ts`の
 * `resolveTargetStateField`と同じ方針・意図的な重複 — `domain/battle/skill`は
 * `domain/battle/triggering`へ依存できない、module境界）。
 */
function resolveTargetStateField(
  target: BattleUnit,
  field: TargetStateField,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
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
    case "UNIT_TYPE": {
      const unitDefinition = unitDefinitions.get(target.unitDefinitionId);
      if (unitDefinition === undefined) {
        throw new DomainValidationError(
          "condition.field",
          `TARGET_STATE field "UNIT_TYPE" requires a UnitDefinition for unitDefinitionId "${target.unitDefinitionId}"`,
        );
      }
      return unitDefinition.unitType;
    }
    case "ROLE":
    case "HAS_STATUS":
      throw new DomainValidationError(
        "condition.field",
        `TARGET_STATE field "${field}" is not supported by this basic ACTION step condition evaluator (ROLE requires a UnitDefinition lookup not yet driven by a production definition, HAS_STATUS requires state-ailment tracking, TARGET_STATE_QUERY_BUFF_DEBUFF scope)`,
      );
  }
}

/** `reference`が`ctx.stepTarget`と同じなら評価中の1体だけを、それ以外は`resolveOtherReference`が返す集合を候補にする。 */
function resolveConditionTargets(
  reference: TargetReference,
  ctx: EffectStepTargetContext,
): readonly BattleUnit[] {
  return targetReferenceEquals(reference, ctx.stepTarget)
    ? [ctx.current]
    : ctx.resolveOtherReference(reference);
}

/**
 * `TARGET_SET_COUNT`（CAP_EFFECT_STEP_SET_CONDITION、Issue #227 RES-004集合条件）が
 * `target`（`TargetReference`）を対象ごとにではなく集合全体として再解決するための
 * 関数。`EffectStepTargetContext.resolveOtherReference`と同じ形（常に最新の
 * `BattleUnit`集合を返す）だが、`stepTarget`/`current`という「対象ごとの評価」
 * 概念を要求しない（BRANCHのconditionのようにstepの対象集合そのものを持たない
 * 呼び出しにも使えるようにするため、`EffectStepTargetContext`とは独立した
 * パラメータにする）。
 */
export type TargetSetResolver = (reference: TargetReference) => readonly BattleUnit[];

/**
 * R-SKL-06 #1「stepのconditionを評価する。省略時はTRUEとする」に加え、
 * R-SKL-08「直前結果」の`LAST_RESULT`（同じ解決スコープ内の直前に確定した
 * `EffectAction`結果を参照する）、および`TARGET_STATE`/`TARGET_HAS_MARKER`
 * （CAP_EFFECT_STEP_CONDITION、Issue #171 RES-004後半）を評価する。`lastResult`は
 * 呼び出し側（`effect-action-group-resolver.ts`）が同じ解決スコープの
 * `LastResultState`から渡す — 未実行の（「もし実行していたら」の）結果を渡しては
 * ならない。`lastResult`が`undefined`のまま`LAST_RESULT`条件へ到達するのは
 * Catalog preflight（`catalog-integrity.ts`の`MISSING_PRECEDING_RESULT`検証）が
 * 本来防ぐべき構成であり、ここでは最終防衛線として明確な例外を投げる。
 *
 * `targetContext`は`TARGET_STATE`/`TARGET_HAS_MARKER`を評価する場合だけ必要
 * （Issue #230以降、この2 kindはACTION stepの`targetCondition`スコープ専用
 * ——常にこのstep自身の`target`を参照する、Catalogロード時点で保証される
 * ——であり、呼び出し側は動的な参照先判定なしに、対象ごとの評価が必要な
 * ケース（`targetCondition`が非TRUE）でだけ`targetContext`を組み立てて渡す）。
 * `targetContext`が無い呼び出し（例: `BRANCH`のcondition評価、ACTIONの
 * `stepCondition`評価）でこの2 kindに到達した場合は明確な例外を投げ、
 * `EVENT_PAYLOAD`/`RUNTIME_COUNTER`/`TURN_NUMBER`/`ALIVE_UNIT_COUNT`/
 * `POSITION_RELATION`/`RESOLUTION_PHASE`は引き続き未対応とする
 * （`triggering/trigger-condition-evaluator.ts`と同じ隔離方針、これらはPS
 * 発動条件の評価器が担う）。`resolveTargetSet`は`TARGET_SET_COUNT`
 * （CAP_EFFECT_STEP_SET_CONDITION、Issue #227）を評価する場合だけ必要で、
 * `targetContext`とは独立に渡す — BRANCHの`condition`や、ACTIONの
 * `stepCondition`のどちらからも使えるようにする。
 */
const EMPTY_UNIT_DEFINITIONS: ReadonlyMap<UnitDefinitionId, UnitDefinition> = new Map();

export function evaluateEffectStepCondition(
  condition: ConditionDefinition,
  lastResult?: LastEffectActionResult,
  targetContext?: EffectStepTargetContext,
  resolveTargetSet?: TargetSetResolver,
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): boolean {
  switch (condition.kind) {
    case "TRUE":
      return true;
    case "AND":
      return condition.conditions.every((c) =>
        evaluateEffectStepCondition(
          c,
          lastResult,
          targetContext,
          resolveTargetSet,
          unitDefinitions,
        ),
      );
    case "OR":
      return condition.conditions.some((c) =>
        evaluateEffectStepCondition(
          c,
          lastResult,
          targetContext,
          resolveTargetSet,
          unitDefinitions,
        ),
      );
    case "NOT":
      return !evaluateEffectStepCondition(
        condition.condition,
        lastResult,
        targetContext,
        resolveTargetSet,
        unitDefinitions,
      );
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
    case "TARGET_STATE": {
      if (targetContext !== undefined) {
        const candidates = resolveConditionTargets(condition.target, targetContext);
        return candidates.some((unit) =>
          compareWithOperator(
            resolveTargetStateField(unit, condition.field, targetContext.unitDefinitions),
            condition.op,
            condition.value,
          ),
        );
      }
      // BRANCH（Issue #230 レビュー[P1]）: BRANCHの`condition`は対象ごとの
      // 評価コンテキストを持たないが、参照する`TargetReference`が高々1体にしか
      // 解決されないことをCatalog preflight（`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`）
      // が保証する場合に限り、`resolveTargetSet`で解決した0〜1体へ直接評価する
      // （量化規則を発明する必要がない — 候補が0件ならfalse、1件ならその1体を
      // 評価するだけ）。2件以上解決された場合はpreflightの取りこぼしとして
      // 最終防衛線の例外を投げる。
      if (resolveTargetSet !== undefined) {
        const candidates = resolveTargetSet(condition.target);
        if (candidates.length > 1) {
          throw new DomainValidationError(
            "step.condition",
            `kind "TARGET_STATE" resolved ${candidates.length} units for a step-wide (BRANCH) condition, but step-wide quantification over more than one unit is not supported (Catalog preflight should already guarantee at most one unit for this TargetReference)`,
          );
        }
        const unit = candidates[0];
        if (unit === undefined) {
          return false;
        }
        return compareWithOperator(
          resolveTargetStateField(unit, condition.field, unitDefinitions ?? EMPTY_UNIT_DEFINITIONS),
          condition.op,
          condition.value,
        );
      }
      throw new DomainValidationError(
        "step.condition",
        'kind "TARGET_STATE" requires an EffectStepTargetContext (CAP_EFFECT_STEP_CONDITION) or a TargetSetResolver (BRANCH step-wide scope)',
      );
    }
    case "TARGET_HAS_MARKER": {
      if (targetContext !== undefined) {
        const candidates = resolveConditionTargets(condition.target, targetContext);
        return candidates.some((unit) => {
          const marker = unit.markerStates.find((state) => state.markerId === condition.markerId);
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
      // TARGET_STATEの分岐と同じ理由・同じ形（BRANCH step-wide scope、Issue #230
      // レビュー[P1]）: 高々1体にしか解決されないことをpreflightが保証する場合に
      // 限り、直接その1体を評価する。
      if (resolveTargetSet !== undefined) {
        const candidates = resolveTargetSet(condition.target);
        if (candidates.length > 1) {
          throw new DomainValidationError(
            "step.condition",
            `kind "TARGET_HAS_MARKER" resolved ${candidates.length} units for a step-wide (BRANCH) condition, but step-wide quantification over more than one unit is not supported (Catalog preflight should already guarantee at most one unit for this TargetReference)`,
          );
        }
        const unit = candidates[0];
        if (unit === undefined) {
          return false;
        }
        const marker = unit.markerStates.find((state) => state.markerId === condition.markerId);
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
      }
      throw new DomainValidationError(
        "step.condition",
        'kind "TARGET_HAS_MARKER" requires an EffectStepTargetContext (CAP_EFFECT_STEP_CONDITION) or a TargetSetResolver (BRANCH step-wide scope)',
      );
    }
    case "TARGET_SET_COUNT": {
      if (resolveTargetSet === undefined) {
        throw new DomainValidationError(
          "step.condition",
          'kind "TARGET_SET_COUNT" requires a TargetSetResolver (CAP_EFFECT_STEP_SET_CONDITION, only available when the caller can re-resolve a TargetReference against the latest Battle state)',
        );
      }
      const aliveCount = resolveTargetSet(condition.target).filter(
        (unit) => !isDefeated(unit),
      ).length;
      return compareWithOperator(aliveCount, condition.op, condition.value);
    }
    default:
      throw new DomainValidationError(
        "step.condition",
        `kind "${condition.kind}" is not supported by this basic ACTION step condition evaluator (EVENT_PAYLOAD/RUNTIME_COUNTER/TURN_NUMBER/ALIVE_UNIT_COUNT/POSITION_RELATION/RESOLUTION_PHASE are PS trigger/activation scope)`,
      );
  }
}
