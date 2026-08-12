import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type {
  DamageModConditionDefinition,
  DamageModStateField,
  DamageModUnitReference,
} from "../../catalog/definitions/effect-action-payload.js";
import type { JsonPrimitive } from "../../catalog/definitions/condition-definition.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { compareWithOperator } from "../skill/comparison-operator.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";

/** R-DMG-04の集計文脈。1ヒットの攻撃側・防御側と、そのヒットのダメージタイプ。 */
export interface DamageModifierCompositionInput {
  readonly attacker: BattleUnit;
  readonly defender: BattleUnit;
  readonly damageType: DamageType;
  /**
   * R-DMG-03: 被ダメージ軽減効果のうち軽減方向の補正だけを割合で無視する
   * （`SkillTraits.piercing.damageReductionIgnoreRate`、[0, 1]）。
   */
  readonly damageReductionIgnoreRate: number;
}

export interface DamageModifierComposition {
  /** R-DMG-01の与ダメージ倍率。攻撃側の`OUTGOING`補正の合計から`max(0, 1 + 合計)`。 */
  readonly outgoingMultiplier: number;
  /** R-DMG-01の被ダメージ倍率。防御側の`INCOMING`補正の合計から`max(0, 1 + 合計)`。 */
  readonly incomingMultiplier: number;
}

function hpRatio(unit: BattleUnit): number {
  return unit.combatStats.maximumHp > 0 ? unit.currentHp / unit.combatStats.maximumHp : 0;
}

/**
 * `DamageModStateField`を`BattleUnit`から解決する（`skill/effect-step-condition-
 * evaluator.ts`・`triggering/trigger-condition-evaluator.ts`の`resolveTargetStateField`
 * と同じ方針の意図的な重複 — `domain/battle/combat`はどちらへも依存できない、
 * module境界）。`UNIT_TYPE`/`ROLE`/`HAS_STATUS`は`DamageModStateField`自体が
 * 持たないため、ここで到達し得ない。
 */
function stateFieldValue(unit: BattleUnit, field: DamageModStateField): JsonPrimitive {
  switch (field) {
    case "IS_ALIVE":
      return !isDefeated(unit);
    case "HP_RATIO":
      return hpRatio(unit);
    case "ATTRIBUTE":
      return unit.attribute;
    case "POSITION_ROW":
      return unit.position.row;
    case "POSITION_COLUMN":
      return unit.position.column;
    case "RESOURCE_AP":
      return unit.currentAp;
    case "RESOURCE_PP":
      return unit.currentPp;
    case "RESOURCE_EX_GAUGE":
      return unit.currentExtraGauge;
  }
}

/** R-EFF-10: 同じmarkerIdのインスタンスは対象ごとに常に1つだけ存在する。未所持は0スタック扱い。 */
function markerStackCount(unit: BattleUnit, markerId: MarkerId): number {
  return unit.markerStates.find((state) => state.markerId === markerId)?.stackCount ?? 0;
}

function referencedUnit(
  reference: DamageModUnitReference,
  owner: BattleUnit,
  opponent: BattleUnit,
): BattleUnit {
  return reference === "EFFECT_OWNER" ? owner : opponent;
}

/**
 * `DYNAMIC_DAMAGE_MOD_CONDITION`（DMG-002、Issue #192）: 補正インスタンスの
 * 動的条件を、そのヒットの保持者(`owner`)と相手(`opponent`)に対して評価する。
 * 状態変更もイベント発行も行わない純粋関数。
 */
export function evaluateDamageModCondition(
  condition: DamageModConditionDefinition,
  owner: BattleUnit,
  opponent: BattleUnit,
): boolean {
  switch (condition.kind) {
    case "TRUE":
      return true;
    case "AND":
      return condition.conditions.every((child) =>
        evaluateDamageModCondition(child, owner, opponent),
      );
    case "OR":
      return condition.conditions.some((child) =>
        evaluateDamageModCondition(child, owner, opponent),
      );
    case "NOT":
      return !evaluateDamageModCondition(condition.condition, owner, opponent);
    case "UNIT_STATE": {
      const unit = referencedUnit(condition.unit, owner, opponent);
      return compareWithOperator(
        stateFieldValue(unit, condition.field),
        condition.op,
        condition.value,
      );
    }
    case "UNIT_HAS_MARKER": {
      const unit = referencedUnit(condition.unit, owner, opponent);
      const stackCount = markerStackCount(unit, condition.markerId);
      // `countCondition`未指定は「1つ以上所持」（`ConditionDefinition`の
      // `TARGET_HAS_MARKER`と同じ規約）。
      return condition.countCondition === undefined
        ? stackCount > 0
        : compareWithOperator(
            stackCount,
            condition.countCondition.op,
            condition.countCondition.value,
          );
    }
    case "HP_RATIO_COMPARISON":
      return compareWithOperator(
        hpRatio(referencedUnit(condition.left, owner, opponent)),
        condition.op,
        hpRatio(referencedUnit(condition.right, owner, opponent)),
      );
  }
}

/**
 * R-DMG-04: `owner`が保持する有効な`APPLY_DAMAGE_MOD`のうち、`direction`が一致し、
 * `damageType`の絞り込みと動的条件を満たすものの`magnitude`（付与時点で評価済みの
 * 符号付き割合）を合算する。`APPLY_DAMAGE_MOD`の`stacking.mode`は`STACKABLE`のみの
 * ため、`composeHealingRate`（R-HEAL-02）と同じく保持している全インスタンスが常に
 * 有効で、R-EFF-05の最強選択は行わない。
 *
 * R-DMG-03: `damageReductionIgnoreRate`は「被ダメージ軽減効果のうち軽減方向の補正
 * だけ」を割合で無視するため、`INCOMING`かつ負の補正にだけ`(1 - rate)`を掛ける。
 * 正の被ダメージ補正（被ダメージ増加デバフ）と`OUTGOING`側は一切変化させない。
 */
function composeRate(
  owner: BattleUnit,
  opponent: BattleUnit,
  direction: "OUTGOING" | "INCOMING",
  damageType: DamageType,
  damageReductionIgnoreRate: number,
): number {
  return owner.appliedEffects.reduce((total, effect) => {
    const modifier = effect.damageModifier;
    if (modifier === undefined || modifier.direction !== direction) {
      return total;
    }
    // R-DMG-07: 閾値付き補正は確定した入射ダメージとの比較でしか適用可否を決められない
    // ため、この合成（入射ダメージ確定前）には参加させない。
    // `threshold-damage-reduction-policy.ts`が計算確定後に独立倍率として適用する。
    if (modifier.damageThreshold !== undefined) {
      return total;
    }
    if (modifier.damageType !== null && modifier.damageType !== damageType) {
      return total;
    }
    if (
      modifier.condition !== undefined &&
      !evaluateDamageModCondition(modifier.condition, owner, opponent)
    ) {
      return total;
    }
    const ignoresReduction = direction === "INCOMING" && effect.magnitude < 0;
    return (
      total +
      (ignoresReduction ? effect.magnitude * (1 - damageReductionIgnoreRate) : effect.magnitude)
    );
  }, 0);
}

/**
 * R-DMG-04の与/被ダメージ倍率をヒット単位で求める。「倍率が0未満になる場合は0」
 * （R-DMG-04）を両方向に適用する。`calculateDamage`（R-DMG-01）はここで得た2つの
 * 倍率を乗算するだけで、`AppliedEffect`自体は知らない（`resolveDamageImmunity`と
 * 同じ責務分割）。
 */
export function composeDamageModifiers(
  input: DamageModifierCompositionInput,
): DamageModifierComposition {
  const rate = input.damageReductionIgnoreRate;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new DomainValidationError(
      "damageReductionIgnoreRate",
      `must be within [0, 1], got ${rate}`,
    );
  }
  return {
    outgoingMultiplier: Math.max(
      0,
      1 + composeRate(input.attacker, input.defender, "OUTGOING", input.damageType, rate),
    ),
    incomingMultiplier: Math.max(
      0,
      1 + composeRate(input.defender, input.attacker, "INCOMING", input.damageType, rate),
    ),
  };
}
