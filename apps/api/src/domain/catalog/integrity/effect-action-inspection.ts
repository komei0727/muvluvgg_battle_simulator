import type { DurationDefinition } from "../definitions/duration-definition.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { FormulaDefinition } from "../definitions/formula-definition.js";

/**
 * `EffectActionDefinition`のkind横断アクセサと`FormulaDefinition`の再帰探索。
 * kindごとのpayload形状を知っているのはこのmoduleだけで、検証本体
 * （`effect-action-integrity.ts`／`memory-integrity.ts`）はここを経由する。
 */

/**
 * `EffectActionDefinition`が持つ`FormulaDefinition`をkind横断で取り出す。
 * `durationOf`と同じ網羅`switch`とし、新しいkindの追加時にこの関数の更新漏れを
 * コンパイルエラーとして検出する。
 */
export function formulasOf(effectAction: EffectActionDefinition): readonly FormulaDefinition[] {
  switch (effectAction.kind) {
    case "DAMAGE":
      return [effectAction.payload.formula, ...effectAction.payload.damageModifiers];
    case "HEAL":
    case "APPLY_CONTINUOUS_HEAL":
    case "APPLY_CONTINUOUS_DAMAGE":
    case "APPLY_STAT_MOD":
    case "APPLY_DAMAGE_MOD":
    case "APPLY_HEALING_MOD":
    case "MODIFY_RESOURCE_CAPACITY":
    case "APPLY_SHIELD":
    case "APPLY_ATTACK_DAMAGE_BONUS":
    case "APPLY_REFLECT":
      return [effectAction.payload.formula];
    case "APPLY_RESOURCE_GAIN_MOD":
      return [effectAction.payload.rateDelta];
    case "MODIFY_RESOURCE":
      return effectAction.payload.formula === undefined ? [] : [effectAction.payload.formula];
    case "APPLY_STATUS":
    case "REMOVE_EFFECTS":
    case "EFFECT_IMMUNITY":
    case "APPLY_MARKER":
    case "REMOVE_MARKER":
    case "APPLY_DEATH_SURVIVAL":
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
    case "APPLY_HEALING_LINK":
    case "APPLY_DAMAGE_LINK":
    case "APPLY_SUBUNIT":
    case "COOLDOWN_MANIPULATION":
    case "APPLY_PIERCING_MOD":
      // `APPLY_PIERCING_MOD`（DMG-003、Issue #196）の3率はFormulaではなく静的な
      // Catalog値（R-DMG-03の[0, 1]）のため、Formula走査の対象を持たない。
      return [];
    default: {
      const exhaustive: never = effectAction;
      throw new Error(`unhandled EffectActionDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** `SUM`/`PRODUCT`/`MIN`/`MAX`/`CLAMP`の入れ子を含めて`SUM_DAMAGE_*`参照を再帰的に探す。 */
export function referencesSumDamageResult(formula: FormulaDefinition): boolean {
  switch (formula.kind) {
    case "DAMAGE_DEALT_RATIO":
    case "DAMAGE_RECEIVED_RATIO":
      return (
        formula.sourceResult === "SUM_DAMAGE_DEALT" ||
        formula.sourceResult === "SUM_DAMAGE_RECEIVED"
      );
    case "SUM":
    case "PRODUCT":
    case "MIN":
    case "MAX":
      return formula.formulas.some(referencesSumDamageResult);
    case "CLAMP":
      return referencesSumDamageResult(formula.formula);
    default:
      return false;
  }
}

/** `SUM`/`PRODUCT`/`MIN`/`MAX`/`CLAMP`の入れ子を含めて`MARKER_COUNT_SCALE`を再帰的に探す。 */
export function referencesMarkerCountScale(formula: FormulaDefinition): boolean {
  switch (formula.kind) {
    case "MARKER_COUNT_SCALE":
      return true;
    case "SUM":
    case "PRODUCT":
    case "MIN":
    case "MAX":
      return formula.formulas.some(referencesMarkerCountScale);
    case "CLAMP":
      return referencesMarkerCountScale(formula.formula);
    default:
      return false;
  }
}

/**
 * `DurationDefinition`を運ぶkindだけ値を返す（`APPLY_MARKER`を含む）。
 * EFF-005/Issue #162: `AppliedEffect`スコープのRuntimeCounter（`counterUpdates`）
 * 宣言に`CAP_EFFECT_RUNTIME_COUNTER`を要求する検証のために、`duration`本体を
 * kindを問わず取り出す。網羅`switch`とし、新しいkindが
 * `effect-action-definition.ts`へ追加された際にこの関数の更新漏れをコンパイル
 * エラーとして検出する。
 */
export function durationOf(effectAction: EffectActionDefinition): DurationDefinition | undefined {
  switch (effectAction.kind) {
    case "APPLY_CONTINUOUS_HEAL":
    case "APPLY_CONTINUOUS_DAMAGE":
    case "APPLY_STAT_MOD":
    case "APPLY_DAMAGE_MOD":
    case "APPLY_HEALING_MOD":
    case "MODIFY_RESOURCE_CAPACITY":
    case "APPLY_STATUS":
    case "APPLY_SHIELD":
    case "EFFECT_IMMUNITY":
    case "APPLY_DEATH_SURVIVAL":
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
    case "APPLY_REFLECT":
    case "APPLY_MARKER":
    case "APPLY_ATTACK_DAMAGE_BONUS":
    case "APPLY_RESOURCE_GAIN_MOD":
    case "APPLY_HEALING_LINK":
    case "APPLY_DAMAGE_LINK":
    case "APPLY_PIERCING_MOD":
    case "APPLY_SUBUNIT":
      // `APPLY_SUBUNIT`は`SUBUNIT_DURATION`（DMG-005、Issue #190）でサブユニット自身も
      // 存続期間を持つ継続効果になった（`ApplySubunitPayload.duration`）。
      return effectAction.payload.duration;
    case "DAMAGE":
    case "HEAL":
    case "MODIFY_RESOURCE":
    case "REMOVE_EFFECTS":
    case "REMOVE_MARKER":
    case "COOLDOWN_MANIPULATION":
      return undefined;
    default: {
      const exhaustive: never = effectAction;
      throw new Error(`unhandled EffectActionDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
