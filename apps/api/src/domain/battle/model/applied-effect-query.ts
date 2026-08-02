import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";
import type { AppliedEffect } from "./applied-effect.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { BattleUnit } from "./battle-unit.js";

/**
 * M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`、`CAP_TARGET_EFFECT_QUERY`）:
 * `ConditionDefinition`の`TARGET_HAS_EFFECT`だけを取り出した形。
 */
export type TargetHasEffectQuery = Extract<ConditionDefinition, { kind: "TARGET_HAS_EFFECT" }>;

/**
 * 1つの`AppliedEffect`が`TARGET_HAS_EFFECT`の照会条件に一致するか。
 *
 * カテゴリ判定は`AppliedEffect.categories`（付与時点に`effect-category-classifier.ts`の
 * `effectCategoriesOf`が確定した分類、R-EFF-02/03の解除・免疫判定と同じ正本）だけを
 * 見る。絞り込み（`continuousDamageKinds`/`statKinds`）は`REMOVE_EFFECTS`/
 * `EFFECT_IMMUNITY`のselectorと同じく、カテゴリ一致へANDで重ねる — 指定がある場合、
 * 対応するfieldを持たない効果（例: 継続ダメージでないデバフ）は一致しない。
 */
function matchesQuery(
  effect: AppliedEffect,
  query: TargetHasEffectQuery,
  evaluatorUnitId: BattleUnitId | undefined,
): boolean {
  if (!query.categories.some((category) => effect.categories.includes(category))) {
    return false;
  }
  // DMG-007（Issue #187）: 特定のEffectAction定義由来かどうか。分類軸ではなく定義IDの
  // 直接一致であるため、`categories`とはANDで重ねる（`EFFECT_IMMUNITY`と同じ扱い）。
  if (
    query.effectActionDefinitionIds !== undefined &&
    !query.effectActionDefinitionIds.some((id) => id === effect.effectActionDefinitionId)
  ) {
    return false;
  }
  // DMG-007（Issue #187）: `grantedBy: SELF`は「この条件を評価しているユニット自身が
  // 付与した」インスタンスだけに一致する。付与者を持たない付与（Memory由来など
  // `sourceId`が無いもの）は自身が付与したとは言えないため一致しない。評価元が
  // 渡されていない呼び出し経路も同じ理由で一致させない — 黙って全インスタンスへ
  // 広がるより、条件が成立しない方が安全側である。
  if (
    query.grantedBy === "SELF" &&
    (evaluatorUnitId === undefined || effect.sourceId !== evaluatorUnitId)
  ) {
    return false;
  }
  if (
    query.continuousDamageKinds !== undefined &&
    !query.continuousDamageKinds.some(
      (kind) => effect.continuousDamage?.continuousDamageKind === kind,
    )
  ) {
    return false;
  }
  if (
    query.statKinds !== undefined &&
    !query.statKinds.some((stat) => effect.statModStat === stat)
  ) {
    return false;
  }
  return true;
}

/**
 * 対象が照会条件に一致する`AppliedEffect`を1つ以上保持しているか（存在量化）。
 * 評価時点の`unit.appliedEffects`だけを読むため、直前のstepやPS連鎖が付与・解除した
 * 結果がそのまま反映される（`TARGET_HAS_MARKER`が`markerStates`を読むのと同じ規約）。
 *
 * `Marker`は`AppliedEffect`ではないため対象外である（`TARGET_HAS_MARKER`が担い、
 * `condition-definition.ts`の`TARGET_HAS_EFFECT_CATEGORIES`が`MARKER`を拒否する）。
 */
export function holdsMatchingEffect(
  unit: BattleUnit,
  query: TargetHasEffectQuery,
  /**
   * DMG-007（Issue #187）: `query.grantedBy: "SELF"`が指す「自身」— この条件を
   * 評価しているユニット（PSの保持者／EffectSequenceの使用者）。`grantedBy`を
   * 持たない照会では使わないため省略できる。
   */
  evaluatorUnitId?: BattleUnitId,
): boolean {
  return unit.appliedEffects.some((effect) => matchesQuery(effect, query, evaluatorUnitId));
}

/**
 * M7-001E（Issue #248、`CAP_TARGET_STATE_EXTENDED_FIELD`）: `TARGET_STATE.field:
 * HAS_STATUS`が照会する、対象が今保持している`APPLY_STATUS`由来の状態種別。
 * `TARGET_HAS_EFFECT`と違い`ConditionDefinition.op`/`value`との比較は呼び出し側
 * （`compareWithOperator`を持つevaluator）が行う — `domain/battle/model`は
 * 他の`domain/battle/*`サブモジュールへ依存できないため（module境界）。
 */
export function heldStatusKinds(unit: BattleUnit): readonly StatusKind[] {
  return unit.appliedEffects.flatMap((effect) =>
    effect.statusKind !== undefined ? [effect.statusKind] : [],
  );
}
