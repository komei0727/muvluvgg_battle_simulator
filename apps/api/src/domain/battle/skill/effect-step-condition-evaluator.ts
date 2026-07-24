import type {
  ConditionDefinition,
  JsonPrimitive,
  TargetStateField,
} from "../../catalog/definitions/condition-definition.js";
import type { UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
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
 * R-SKL-06（CAP_EFFECT_STEP_CONDITION、Issue #171 RES-004後半）: ACTION stepの
 * `condition`がその step自身の`target`と同じ`TargetReference`を参照する
 * `TARGET_STATE`/`TARGET_HAS_MARKER`を評価するために必要な、対象ごとの文脈。
 * `stepTarget`と一致する`TargetReference`は`current`（今評価している1体）へ
 * 個別に解決し、それ以外（`SELF`/`TRIGGER_SOURCE`など、stepの対象集合とは
 * 無関係な参照）は`resolveOtherReference`で解決する（対象によらず一定の結果
 * になる）。
 *
 * `wholeSet: true`（CAP_EFFECT_STEP_SET_CONDITION、PRレビュー[P2]再指摘、
 * Issue #227）を指定すると、`stepTarget`と一致する参照も`current`へ個別に
 * 絞り込まず、常に`resolveOtherReference`（解決済み候補全体）を使う —
 * `TARGET_STATE`/`TARGET_HAS_MARKER`の評価器実装は元々`candidates.some(...)`
 * なので、これは「stepTargetの解決候補のいずれか1つでも満たすか」という
 * step全体としての判定になる。`TARGET_SET_COUNT`と組み合わさる複合条件を
 * 「stepを丸ごとskipすべきか」を判定する（`effect-action-group-resolver.ts`の
 * `resolveAfterTiming`）ために使い、対象ごとのフィルタ（`current`を個別に
 * 絞り込む通常モード、`buildEffectStepPerTargetFilter`）とは独立している。
 */
export interface EffectStepTargetContext {
  readonly stepTarget: TargetReference;
  readonly current: BattleUnit;
  readonly resolveOtherReference: (reference: TargetReference) => readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly wholeSet?: boolean;
}

function targetReferenceEquals(a: TargetReference, b: TargetReference): boolean {
  return a.kind === b.kind && a.targetBindingId === b.targetBindingId;
}

/**
 * R-SKL-06: `condition`のどこかに、`stepTarget`と同じ`TargetReference`を持つ
 * `TARGET_STATE`/`TARGET_HAS_MARKER`が含まれるか（AND/OR/NOTを再帰的に見る、
 * `conditionReferencesLastResult`と同じ形）。含まれる場合、この条件はstep全体
 * ではなく対象ごとに個別評価する（呼び出し側 `skill-resolution-service.ts` /
 * `effect-action-group-resolver.ts` が、この関数の結果に応じて一括評価か
 * 対象ごとの`EffectStepTargetContext`付き評価かを選ぶ）。
 */
export function conditionReferencesStepTarget(
  condition: ConditionDefinition,
  stepTarget: TargetReference,
): boolean {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
      return targetReferenceEquals(condition.target, stepTarget);
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionReferencesStepTarget(c, stepTarget));
    case "NOT":
      return conditionReferencesStepTarget(condition.condition, stepTarget);
    default:
      return false;
  }
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
  if (ctx.wholeSet) {
    return ctx.resolveOtherReference(reference);
  }
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
 * （呼び出し側が`conditionReferencesStepTarget`でstep全体を一度だけ評価するか
 * 対象ごとに評価するかを決めるため、両kindとも`targetContext`が無い呼び出し
 * （例: `BRANCH`のcondition評価）では明確な例外を投げ、`EVENT_PAYLOAD`/
 * `RUNTIME_COUNTER`/`TURN_NUMBER`/`ALIVE_UNIT_COUNT`/`POSITION_RELATION`/
 * `RESOLUTION_PHASE`は引き続き未対応とする（`triggering/trigger-condition-evaluator.ts`
 * と同じ隔離方針、これらはPS発動条件の評価器が担う）。`resolveTargetSet`は
 * `TARGET_SET_COUNT`（CAP_EFFECT_STEP_SET_CONDITION、Issue #227）を評価する
 * 場合だけ必要で、`targetContext`とは独立に渡す — BRANCHのconditionや、
 * stepの対象別条件と組み合わせるACTIONのconditionのどちらからも使えるようにする。
 */
export function evaluateEffectStepCondition(
  condition: ConditionDefinition,
  lastResult?: LastEffectActionResult,
  targetContext?: EffectStepTargetContext,
  resolveTargetSet?: TargetSetResolver,
): boolean {
  switch (condition.kind) {
    case "TRUE":
      return true;
    case "AND":
      return condition.conditions.every((c) =>
        evaluateEffectStepCondition(c, lastResult, targetContext, resolveTargetSet),
      );
    case "OR":
      return condition.conditions.some((c) =>
        evaluateEffectStepCondition(c, lastResult, targetContext, resolveTargetSet),
      );
    case "NOT":
      return !evaluateEffectStepCondition(
        condition.condition,
        lastResult,
        targetContext,
        resolveTargetSet,
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
      if (targetContext === undefined) {
        throw new DomainValidationError(
          "step.condition",
          'kind "TARGET_STATE" requires an EffectStepTargetContext (CAP_EFFECT_STEP_CONDITION, only available when evaluating an ACTION step\'s own condition)',
        );
      }
      const candidates = resolveConditionTargets(condition.target, targetContext);
      return candidates.some((unit) =>
        compareWithOperator(
          resolveTargetStateField(unit, condition.field, targetContext.unitDefinitions),
          condition.op,
          condition.value,
        ),
      );
    }
    case "TARGET_HAS_MARKER": {
      if (targetContext === undefined) {
        throw new DomainValidationError(
          "step.condition",
          'kind "TARGET_HAS_MARKER" requires an EffectStepTargetContext (CAP_EFFECT_STEP_CONDITION, only available when evaluating an ACTION step\'s own condition)',
        );
      }
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
