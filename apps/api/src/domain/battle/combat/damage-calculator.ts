import { isFavorableAttribute, resolveAttributeMultiplier } from "./attribute-affinity-policy.js";
import { createPercentage } from "../../shared/percentage.js";
import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import type {
  FormulaDefinition,
  FormulaKind,
} from "../../catalog/definitions/formula-definition.js";
import { evaluateFormula, type FormulaEvaluationContext } from "../skill/formula-evaluator.js";

export interface DamageCalculationInput {
  readonly attackerAttack: number;
  readonly attackerAttribute: Attribute;
  readonly attackerAffinityBonus: number;
  readonly defenderDefense: number;
  readonly defenderAttribute: Attribute;
  /** R-DMG-01の実効防御力に使う。0なら通常処理、1なら防御力を全量無視する。 */
  readonly defenseIgnoreRate: number;
  /** R-DMG-01: スキル威力Formula（R-NUM-04のFormulaEvaluatorで評価する）。 */
  readonly skillPowerFormula: FormulaDefinition;
  /** R-DMG-01のAction内追加ダメージ倍率。各エントリを符号付き割合として評価し合計する。 */
  readonly damageModifiers: readonly FormulaDefinition[];
  /** `CriticalPolicy`が解決済みの会心倍率（R-CRT-02）。 */
  readonly criticalMultiplier: number;
  /**
   * R-DMG-01の与ダメージ倍率。`damage-modifier-policy.ts`の
   * `composeDamageModifiers`が攻撃側の`APPLY_DAMAGE_MOD direction: OUTGOING`から
   * 解決済み（R-DMG-04）。未指定は補正なし（1倍）。
   */
  readonly outgoingDamageMultiplier?: number;
  /** R-DMG-01の被ダメージ倍率（防御側の`INCOMING`、R-DMG-04）。未指定は1倍。 */
  readonly incomingDamageMultiplier?: number;
  /** R-NUM-04: `skillPowerFormula`/`damageModifiers`を評価するための実行時文脈。 */
  readonly formulaContext: FormulaEvaluationContext;
  /**
   * R-CFS-02（DMG-009、Issue #193）: 攻撃側が混乱（`CONFUSION`）を保持したまま
   * ASで攻撃する場合だけ、その混乱インスタンスの数値を渡す。未指定なら混乱倍率は
   * 1、基礎ダメージの差し替えも行わない（＝従来どおりの計算）。「ASであること」の
   * 判定は`damage-application-service.ts`が済ませてからここへ渡す — この関数は
   * `AppliedEffect`もスキル種別も知らない純粋な数値計算に保つ
   * （`outgoingDamageMultiplier`／`resolveDamageImmunity`と同じ責務分割）。
   */
  readonly confusion?: ConfusionDamageInput;
}

/** R-CFS-02: 混乱が基礎ダメージと計算ダメージへ与える2つの割合。 */
export interface ConfusionDamageInput {
  /** 混乱倍率は `1 - damageReductionRate` になる。 */
  readonly damageReductionRate: number;
  /** 攻撃力が実効防御力以下のとき、基礎ダメージへ使う攻撃力の割合。 */
  readonly lowAttackBaseDamageRate: number;
}

/** `DamageCalculated`イベントでの監査に必要な計算過程を含む結果。 */
export interface DamageCalculationResult {
  /** R-DMG-01の実効防御力（`defenderDefense * (1 - defenseIgnoreRate)`）。 */
  readonly effectiveDefense: number;
  /**
   * R-DMG-01の基礎ダメージ（DMG-012）。全倍率が掛かる元の値であり、これが無いと
   * `max(0, 攻撃力 - 実効防御力)`とFormula直値（`CURRENT_HP_RATIO`等）のどちらで
   * 求まったのか、R-CFS-02の低攻撃力差し替えが働いたのかをログから判別できない。
   */
  readonly baseDamage: number;
  readonly skillPower: number;
  /**
   * `skillPowerFormula.kind`（DMG-012）。非`SKILL_POWER`のFormulaでは`skillPower`が
   * 常に`1`になるため、この欄が無いと「`SKILL_POWER`で威力1」と区別できない。
   */
  readonly skillPowerFormulaKind: FormulaKind;
  readonly attributeMultiplier: number;
  /**
   * R-ATR-01の有利属性判定（DMG-012）。`attributeMultiplier === 1`は「有利でない」と
   * 「有利だが属性相性ボーナスが0」の2通りあり、この欄だけが両者を分ける。
   */
  readonly isFavorableAttribute: boolean;
  /** R-DMG-04の与ダメージ倍率（監査用に入力をそのまま返す）。 */
  readonly outgoingDamageMultiplier: number;
  /** R-DMG-04の被ダメージ倍率（R-DMG-03の`damageReductionIgnoreRate`適用済み）。 */
  readonly incomingDamageMultiplier: number;
  readonly actionDamageMultiplier: number;
  /** R-CFS-02: 混乱倍率（混乱を保持しない攻撃では常に1）。 */
  readonly confusionDamageMultiplier: number;
  /** 最終切り捨て・最低1ダメージ（R-DMG-02）を適用する前の値。 */
  readonly preTruncationDamage: number;
  readonly finalDamage: number;
}

/**
 * R-DMG-01: 基礎ダメージ(攻撃力-防御力)へ乗算できるのは`SKILL_POWER`だけ。
 * それ以外のFormula種別（`CURRENT_HP_RATIO`
 * 等）はスキル威力の倍率ではなく、評価結果そのものが基礎ダメージとなる —
 * 攻撃力・防御力を経由しない。実Catalogの`ACT_FLUTE_VAMPIRE_AS1_HP_COST`
 * （対象の現在HP×0.25を直接ダメージ量とする定義）を攻撃側の攻撃力でさらに
 * 乗算してしまうと、意図した量から桁違いに拡大される。属性倍率・Action内追加
 * ダメージ倍率はFormula種別によらず通常どおり適用する（`ACT_AOI_GUARDIAN_PS2_COUNTER`
 * 等はaccuracy/piercingを上書きせず、通常の命中判定を経る前提であるため）。
 *
 * 会心倍率もこの関数にとっては入力（`criticalMultiplier`）であり、Formula種別で
 * 分岐しない。対象の現在HP割合を基礎とする攻撃が会心しないのはR-CRT-04であり、
 * 会心モードを`PREVENTED`へ導出する呼び出し側（`critical-policy.ts`の
 * `resolveDeclaredCriticalMode`）の責務である — この関数は`AppliedEffect`も
 * 会心率も知らない純粋な数値計算に保つ。
 */
function resolveBaseDamageAndSkillPower(
  formula: FormulaDefinition,
  attackerAttack: number,
  effectiveDefense: number,
  context: FormulaEvaluationContext,
  confusion: ConfusionDamageInput | undefined,
): { readonly baseDamage: number; readonly skillPower: number } {
  if (formula.kind === "SKILL_POWER") {
    // R-CFS-02「攻撃側の戦闘中攻撃力が防御側の実効防御力**以下**の場合、基礎
    // ダメージ`max(0, 攻撃力 - 実効防御力)`の代わりに`攻撃力 ×
    // lowAttackBaseDamageRate`を基礎ダメージとする」。比較も差し替えも実効防御力
    // （R-DMG-03の`defenseIgnoreRate`適用後）を基準にする — R-DMG-01が基礎
    // ダメージに使う「防御力」がまさにこの値であり、貫通で実効防御力が下がった
    // 攻撃は差し替え条件からも外れるのが一貫するためである。
    const substituted =
      confusion !== undefined && attackerAttack <= effectiveDefense
        ? attackerAttack * confusion.lowAttackBaseDamageRate
        : Math.max(0, attackerAttack - effectiveDefense);
    return { baseDamage: substituted, skillPower: formula.power };
  }
  return {
    baseDamage: evaluateFormula(formula, context, "skillPowerFormula"),
    skillPower: 1,
  };
}

/**
 * R-DMG-01のAction内追加ダメージ倍率。R-DMG-04の与/被ダメージ倍率と同じ合成
 * パターン（符号付き割合の合計、倍率は`1 + 合計補正`、0未満は0とする）を適用する。
 */
function resolveActionDamageMultiplier(
  damageModifiers: readonly FormulaDefinition[],
  context: FormulaEvaluationContext,
): number {
  const sum = damageModifiers.reduce(
    (total, modifier, index) =>
      total + evaluateFormula(modifier, context, `damageModifiers[${index}]`),
    0,
  );
  return Math.max(0, 1 + sum);
}

/**
 * `DamageCalculator` (R-DMG-01, R-DMG-02の一部)。基礎値、スキル威力、属性倍率、
 * 会心倍率、与/被ダメージ倍率、Action内追加ダメージ倍率から計算ダメージを求め、
 * 最終切り捨てと最低1ダメージ（R-DMG-02の一部）を適用する。
 *
 * 与/被ダメージ倍率（R-DMG-04）自体の集計は`damage-modifier-policy.ts`が担い、
 * この関数は解決済みの倍率だけを受け取る — `AppliedEffect`を知らない純粋な
 * 数値計算に保つため（`resolveDamageImmunity`と同じ責務分割）。ダメージ無効効果
 * （R-DMG-02の残り）も同じ理由でこの関数の対象外。
 */
export function calculateDamage(input: DamageCalculationInput): DamageCalculationResult {
  const effectiveDefense = input.defenderDefense * (1 - input.defenseIgnoreRate);
  const { baseDamage, skillPower } = resolveBaseDamageAndSkillPower(
    input.skillPowerFormula,
    input.attackerAttack,
    effectiveDefense,
    input.formulaContext,
    input.confusion,
  );
  const favorable = isFavorableAttribute(input.attackerAttribute, input.defenderAttribute);
  const attributeMultiplier = resolveAttributeMultiplier(
    input.attackerAttribute,
    input.defenderAttribute,
    createPercentage(input.attackerAffinityBonus),
  );
  const actionDamageMultiplier = resolveActionDamageMultiplier(
    input.damageModifiers,
    input.formulaContext,
  );

  // R-DMG-01の乗算順どおり: 与ダメージ倍率・被ダメージ倍率は会心倍率の後、
  // Action内追加ダメージ倍率の前に掛ける（乗算は可換だが、監査ログ
  // （`DamageCalculated`）が式と同じ並びで読めるようにこの順で書く）。
  const outgoingDamageMultiplier = input.outgoingDamageMultiplier ?? 1;
  const incomingDamageMultiplier = input.incomingDamageMultiplier ?? 1;
  // R-CFS-02: 混乱倍率は与ダメージ倍率（R-DMG-04）とは独立した専用の倍率であり、
  // `DamageCalculated`が個別に公開する。R-DMG-04の集計へ混ぜ込むと、`APPLY_DAMAGE_MOD`
  // 由来ではない減少が与ダメージ補正のsnapshotに紛れて監査できなくなる。
  const confusionDamageMultiplier =
    input.confusion === undefined ? 1 : 1 - input.confusion.damageReductionRate;
  const preTruncationDamage =
    baseDamage *
    skillPower *
    attributeMultiplier *
    input.criticalMultiplier *
    outgoingDamageMultiplier *
    incomingDamageMultiplier *
    actionDamageMultiplier *
    confusionDamageMultiplier;

  return {
    effectiveDefense,
    baseDamage,
    skillPower,
    skillPowerFormulaKind: input.skillPowerFormula.kind,
    attributeMultiplier,
    isFavorableAttribute: favorable,
    outgoingDamageMultiplier,
    incomingDamageMultiplier,
    actionDamageMultiplier,
    confusionDamageMultiplier,
    preTruncationDamage,
    finalDamage: Math.max(1, Math.floor(preTruncationDamage)),
  };
}
