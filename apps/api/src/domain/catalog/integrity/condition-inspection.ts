import type { EffectActionDefinitionId } from "../definitions/catalog-ids.js";
import type { ConditionDefinition } from "../definitions/condition-definition.js";
import type { TargetReference } from "../definitions/references.js";

/**
 * `ConditionDefinition`ツリー（AND/OR/NOTの入れ子）を降下する述語・収集関数。
 * どれも条件木だけを見る純関数で、EffectStepツリーの降下は
 * `effect-step-inspection.ts`が`effect-step-walk.ts`経由で行う。
 *
 * `domain/catalog`は`domain/battle`へ依存できない（module境界）ため、
 * `effect-step-condition-evaluator.ts`／`skill-resolution-service.ts`側の
 * 同名判定とは意図的な重複である。
 */

/** 条件木の中の`TargetReference`と、その定義path。 */
export interface ConditionTargetReferencePath {
  readonly reference: TargetReference;
  readonly path: string;
}

/**
 * `ConditionDefinition`内に埋め込まれた`TargetReference`（`TARGET_STATE`/
 * `TARGET_HAS_MARKER`/`TARGET_HAS_EFFECT`/`POSITION_RELATION`/`TARGET_SET_COUNT`の
 * `target`）を再帰的に収集する。step自身の`target`だけを見る検証はcondition内の
 * 参照を素通ししてしまうため（`TRIGGER_SOURCE`/`TRIGGER_TARGET`の
 * `CAP_TRIGGER_CONTEXT`宣言、`LAST_*`の`MISSING_PRECEDING_RESULT`）、条件木側も
 * 同じ規則で走査する。
 */
export function collectConditionTargetReferences(
  condition: ConditionDefinition,
): readonly TargetReference[] {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
    case "TARGET_HAS_EFFECT":
    case "POSITION_RELATION":
    case "TARGET_SET_COUNT":
      return [condition.target];
    case "AND":
    case "OR":
      return condition.conditions.flatMap((c) => collectConditionTargetReferences(c));
    case "NOT":
      return collectConditionTargetReferences(condition.condition);
    default:
      return [];
  }
}

export function conditionContainsTargetReferenceKind(
  condition: ConditionDefinition,
  kinds: ReadonlySet<string>,
): boolean {
  return collectConditionTargetReferences(condition).some((reference) => kinds.has(reference.kind));
}

/**
 * R-SKL-06/07（CAP_EFFECT_STEP_SET_CONDITION、Issue #227 RES-004集合条件）:
 * `condition`のどこかに`TARGET_SET_COUNT`が含まれるか。
 */
export function conditionContainsTargetSetCount(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TARGET_SET_COUNT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionContainsTargetSetCount(c));
    case "NOT":
      return conditionContainsTargetSetCount(condition.condition);
    default:
      return false;
  }
}

/**
 * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: `condition`のどこかに
 * `EVENT_PAYLOAD`が含まれるか。
 */
export function conditionContainsEventPayload(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "EVENT_PAYLOAD":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionContainsEventPayload(c));
    case "NOT":
      return conditionContainsEventPayload(condition.condition);
    default:
      return false;
  }
}

/**
 * `condition`のどこかに`TARGET_STATE`/`TARGET_HAS_MARKER`/`TARGET_HAS_EFFECT`が
 * 含まれるか。参照先の`TargetReference`は問わない —
 * `effect-step-condition-evaluator.ts`の`evaluateEffectStepCondition`は
 * `TARGET_SET_COUNT`単独経路（`targetContext: undefined`）で呼ばれると、参照先が
 * `step.target`と一致するかどうかに関わらずこの3 kindへ到達した時点で例外を投げる
 * （`EffectStepTargetContext`が無ければ評価できないため）。一致する参照だけを
 * 対象にするとpreflightと実行時が食い違う。
 */
export function conditionContainsTargetStateOrMarker(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
    case "TARGET_HAS_EFFECT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionContainsTargetStateOrMarker(c));
    case "NOT":
      return conditionContainsTargetStateOrMarker(condition.condition);
    default:
      return false;
  }
}

/** 対象ごとに真偽が変わる3 kind（`TARGET_STATE`/`TARGET_HAS_MARKER`/`TARGET_HAS_EFFECT`）の参照をpath付きで集める。 */
export function collectTargetStateOrMarkerReferences(
  condition: ConditionDefinition,
  path: string,
): readonly ConditionTargetReferencePath[] {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
    case "TARGET_HAS_EFFECT":
      return [{ reference: condition.target, path }];
    case "AND":
    case "OR":
      return condition.conditions.flatMap((c, i) =>
        collectTargetStateOrMarkerReferences(c, `${path}.conditions[${i}]`),
      );
    case "NOT":
      return collectTargetStateOrMarkerReferences(condition.condition, `${path}.condition`);
    default:
      return [];
  }
}

/**
 * 条件木内の全`TargetReference`を、パス付きで再帰的に収集する
 * （`collectConditionTargetReferences`のパス付き版）。cardinality検証は対象ごとの
 * 3 kindだけが対象だが、参照kindの検証は`TARGET_SET_COUNT`/`POSITION_RELATION`を
 * 含む全ての埋め込み参照へ及ぶ — どれも同じ評価器が解決するためである。
 */
export function collectConditionTargetReferencePaths(
  condition: ConditionDefinition,
  path: string,
): readonly ConditionTargetReferencePath[] {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
    case "TARGET_HAS_EFFECT":
    case "POSITION_RELATION":
    case "TARGET_SET_COUNT":
      return [{ reference: condition.target, path }];
    case "AND":
    case "OR":
      return condition.conditions.flatMap((c, i) =>
        collectConditionTargetReferencePaths(c, `${path}.conditions[${i}]`),
      );
    case "NOT":
      return collectConditionTargetReferencePaths(condition.condition, `${path}.condition`);
    default:
      return [];
  }
}

/**
 * DMG-007（Issue #187）: `TARGET_HAS_EFFECT.grantedBy: "SELF"`が指す「自身」は
 * **その条件を評価しているユニット**であり、実行時にそれを持っているのはPS/Memoryの
 * trigger条件evaluator（`trigger-condition-evaluator.ts`の`context.owner`）だけである。
 */
export function conditionUsesGrantedBy(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TARGET_HAS_EFFECT":
      return condition.grantedBy !== undefined;
    case "AND":
    case "OR":
      return condition.conditions.some(conditionUsesGrantedBy);
    case "NOT":
      return conditionUsesGrantedBy(condition.condition);
    default:
      return false;
  }
}

/**
 * `TARGET_HAS_EFFECT.effectActionDefinitionIds`が指す参照を集める。条件木の中の
 * 参照はどこからも走査されておらず、ID体系だけ正しい存在しないIDを含むCatalogが
 * ロードに成功していた — その条件は実行時に一切一致しないsilent no-opになるため、
 * `EFFECT_IMMUNITY`/`REMOVE_EFFECTS`のpayload参照と同じ規則で拒否する。
 */
export function collectConditionEffectActionReferences(
  condition: ConditionDefinition,
): readonly EffectActionDefinitionId[] {
  switch (condition.kind) {
    case "TARGET_HAS_EFFECT":
      return condition.effectActionDefinitionIds ?? [];
    case "AND":
    case "OR":
      return condition.conditions.flatMap(collectConditionEffectActionReferences);
    case "NOT":
      return collectConditionEffectActionReferences(condition.condition);
    default:
      return [];
  }
}

/** R-SKL-08: conditionのどこかに`LAST_RESULT`が含まれるか。 */
export function conditionReferencesLastResult(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "LAST_RESULT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionReferencesLastResult(c));
    case "NOT":
      return conditionReferencesLastResult(condition.condition);
    default:
      return false;
  }
}

/**
 * 条件の評価に「使用者BattleUnit」が要るかどうか。`trigger-condition-evaluator.ts`が
 * `owner`不在で`DomainValidationError`にする条件種別と1対1で対応させる（R-MEM-04の
 * Memory検証が使う）。
 *
 * - `POSITION_RELATION`: 所有者の座標を基準にする。
 * - `RUNTIME_COUNTER`: `SkillRuntime`/`AppliedEffect`スコープのcounter保持者を要求する
 *   （Memoryはどちらも持たない）。
 * - `ALIVE_UNIT_COUNT`の`excludeSelf`: 除外すべき「自身」が存在しない。
 * - 対象参照`SELF`（`TARGET_STATE`/`TARGET_HAS_MARKER`/`TARGET_SET_COUNT`等）。
 */
export function conditionRequiresSourceUnit(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "POSITION_RELATION":
    case "RUNTIME_COUNTER":
      return true;
    case "ALIVE_UNIT_COUNT":
      return condition.excludeSelf === true;
    case "AND":
    case "OR":
      return condition.conditions.some((child) => conditionRequiresSourceUnit(child));
    case "NOT":
      return conditionRequiresSourceUnit(condition.condition);
    default:
      return collectConditionTargetReferences(condition).some(
        (reference) => reference.kind === "SELF",
      );
  }
}
