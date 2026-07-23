import type {
  FormulaDefinition,
  StatRatioStat,
} from "../../catalog/definitions/formula-definition.js";
import type { Side as SelectorSide } from "../../catalog/definitions/catalog-enums.js";
import type { MarkerId, TargetBindingId } from "../../catalog/definitions/catalog-ids.js";
import type {
  FormulaSourceReference,
  LastResultReference,
} from "../../catalog/definitions/references.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { matchesRelativeSide } from "../targeting/target-selection-policy.js";

/**
 * R-NUM-04のFormulaEvaluatorが数値を導出するために参照する実行時状態。
 * `skillSource`/`target`は常に必須（`STAT_RATIO`等のsourceが`SKILL_SOURCE`/
 * `TARGET`を要求し得るため）。`triggerSource`/`triggerTarget`/`bindings`/
 * `lastResults`は呼び出し側がまだ用意できない場合があり、Formulaが実際に
 * それらを参照した時点でだけ`DomainValidationError`を投げる
 * （`07_戦闘ルール詳細.md` R-NUM-04「参照が存在しない場合は戦闘開始前の
 * Catalog検証またはpreflightで拒否する」の実行時側の代替 — preflight自体は
 * 別Issueのスコープで、このEvaluatorは代わりに呼び出し時点で明確に失敗する）。
 */
export interface FormulaEvaluationContext {
  readonly skillSource: BattleUnit;
  readonly target: BattleUnit;
  readonly allUnits: readonly BattleUnit[];
  readonly triggerSource?: BattleUnit;
  readonly triggerTarget?: BattleUnit;
  readonly bindings?: ReadonlyMap<TargetBindingId, BattleUnit>;
  /** `references.ts`の`LAST_RESULT_REFERENCE_KINDS`をキーとする、確定済みダメージ結果（RES-002/RES-003、Issue #174/#173が実ライフサイクルへ記録する）。 */
  readonly lastResults?: Readonly<Partial<Record<LastResultReference, number>>>;
}

function resolveSourceUnit(
  ref: FormulaSourceReference,
  context: FormulaEvaluationContext,
  path: string,
): BattleUnit {
  switch (ref.kind) {
    case "SKILL_SOURCE":
      return context.skillSource;
    case "TARGET":
      return context.target;
    case "TRIGGER_SOURCE":
      if (context.triggerSource === undefined) {
        throw new DomainValidationError(
          path,
          'kind "TRIGGER_SOURCE" requires a triggerSource in the evaluation context (RES-005, Issue #172, wires this in production)',
        );
      }
      return context.triggerSource;
    case "TRIGGER_TARGET":
      if (context.triggerTarget === undefined) {
        throw new DomainValidationError(
          path,
          'kind "TRIGGER_TARGET" requires a triggerTarget in the evaluation context (RES-005, Issue #172, wires this in production)',
        );
      }
      return context.triggerTarget;
    case "BINDING": {
      const bound =
        ref.targetBindingId !== undefined ? context.bindings?.get(ref.targetBindingId) : undefined;
      if (bound === undefined) {
        throw new DomainValidationError(
          path,
          `targetBindingId "${ref.targetBindingId}" is not resolved in the evaluation context`,
        );
      }
      return bound;
    }
  }
}

function statValue(unit: BattleUnit, stat: StatRatioStat): number {
  switch (stat) {
    case "MAXIMUM_HP":
      return unit.combatStats.maximumHp;
    case "ATTACK":
      return unit.combatStats.attack;
    case "DEFENSE":
      return unit.combatStats.defense;
    case "CRITICAL_RATE":
      return unit.combatStats.criticalRate;
    case "CRITICAL_DAMAGE_BONUS":
      return unit.combatStats.criticalDamageBonus;
    case "AFFINITY_BONUS":
      return unit.combatStats.affinityBonus;
    case "ACTION_SPEED":
      return unit.combatStats.actionSpeed;
  }
}

/** R-EFF-10: 同じmarkerIdのインスタンスは対象ごとに常に1つだけ存在する。未所持は0スタック扱い。 */
function markerStackCount(unit: BattleUnit, markerId: MarkerId): number {
  return unit.markerStates.find((state) => state.markerId === markerId)?.stackCount ?? 0;
}

/**
 * `ALIVE_UNIT_COUNT_SCALE`には`STAT_RATIO`等と異なり相対陣営の基準となる
 * `source`フィールドが無い。`ConditionDefinition.ALIVE_UNIT_COUNT`が
 * PS所有者（`context.owner`）を暗黙の基準にするのと同じく、ここでは
 * `context.skillSource`（Formulaを持つ効果の使用者）を基準にする。
 */
function aliveUnitCount(
  perspective: BattleUnit,
  allUnits: readonly BattleUnit[],
  side: SelectorSide,
): number {
  return allUnits.filter(
    (unit) => !isDefeated(unit) && matchesRelativeSide(unit, perspective, side),
  ).length;
}

function lastResultValue(
  context: FormulaEvaluationContext,
  key: LastResultReference,
  path: string,
): number {
  const value = context.lastResults?.[key];
  if (value === undefined) {
    throw new DomainValidationError(
      path,
      `sourceResult "${key}" has no recorded value in the evaluation context (this resolution scope has no matching prior DAMAGE result yet, or SUM_DAMAGE_DEALT/SUM_DAMAGE_RECEIVED accumulation is RES-002/RES-003, Issue #174/#173, scope)`,
    );
  }
  return value;
}

/**
 * R-SKL-08（レビュー再指摘[P1]、PR #214）: `LAST_DAMAGE_DEALT`/`LAST_DAMAGE_RECEIVED`は
 * 「同じ解決スコープ内で直前に確定したDAMAGE結果」だけを参照する。`BattleUnit`の
 * 永続状態にすると別行動・別PS解決の古い値まで見えてしまうため、代わりに
 * 呼び出し側（`action-skill-use-resolver.ts`/`action-charge-resolver.ts`が
 * 1解決スコープ＝1行動ごとに新規生成し、`PassiveActivationRuntime`がそのスコープ内の
 * PS連鎖へ使い回す）が保持する実行時registryとして扱う。`BattleUnit`のフィールドでは
 * ないため、StateDelta・独立Reducer復元の対象にもならない（スコープ終了と同時に
 * 破棄する短命な実行コンテキストであり、監査対象の永続状態ではないため）。
 */
export type LastDamageResultRegistry = Map<
  BattleUnitId,
  { readonly lastDamageDealt?: number; readonly lastDamageReceived?: number }
>;

/** `LastDamageResultRegistry`の該当ユニット分を`FormulaEvaluationContext.lastResults`の断片へ変換する。 */
export function lastDamageResultsFor(
  registry: LastDamageResultRegistry | undefined,
  unitId: BattleUnitId,
): NonNullable<FormulaEvaluationContext["lastResults"]> {
  const entry = registry?.get(unitId);
  return {
    ...(entry?.lastDamageDealt !== undefined ? { LAST_DAMAGE_DEALT: entry.lastDamageDealt } : {}),
    ...(entry?.lastDamageReceived !== undefined
      ? { LAST_DAMAGE_RECEIVED: entry.lastDamageReceived }
      : {}),
  };
}

/**
 * `applyDamageAction`が確定させたダメージ結果を`registry`へ記録する
 * （ミュータブルな共有Mapを直接更新する — 新しいオブジェクトの返却も
 * イミュータブルコピーも不要、`registry`自体が1解決スコープの寿命を表す）。
 *
 * R-SKL-08（レビュー再々々指摘[P1]、PR #214）: MISS・対象不在などで効果が
 * 適用されなかった場合も「同じ解決スコープ内で直前に確定した結果」であり、
 * 正規の直前結果として記録する契約 — R-NUM-04の「参照が存在しない場合は
 * Catalog検証またはpreflightで拒否する」はCatalog定義自体の誤り（存在し得ない
 * 参照）を指し、有効な定義のもとで通常発生し得る実行時のMISSを指すものでは
 * ない。呼び出し側（`applyDamageAction`）は不成立ヒットでも`finalDamage: 0`で
 * この関数を呼ぶことで、以前の成功結果を透けて見せずに済ませつつ、後続の
 * `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`評価を（`DomainValidationError`
 * ではなく）0として決定的に解決させる。
 */
export function recordLastDamageResult(
  registry: LastDamageResultRegistry | undefined,
  dealerId: BattleUnitId,
  receiverId: BattleUnitId,
  finalDamage: number,
): void {
  if (registry === undefined) {
    return;
  }
  const dealerBefore = registry.get(dealerId);
  registry.set(dealerId, { ...dealerBefore, lastDamageDealt: finalDamage });
  // 自傷（dealerId === receiverId）では上の`set`で書いたエントリを起点に
  // `lastDamageReceived`も重ねる必要があるため、`registry.get`をここで取り直す。
  const receiverBefore = registry.get(receiverId);
  registry.set(receiverId, { ...receiverBefore, lastDamageReceived: finalDamage });
}

/**
 * R-NUM-04のFormulaEvaluator: `FormulaDefinition`を状態変更なしに数値へ評価する。
 * `SUM`/`MIN`/`MAX`/`CLAMP`は子Formulaの評価結果を丸めずに合成する
 * （このファイル自身がどこにも`Math.round`/`Math.floor`を持たないことで保証する
 * — 整数化（R-NUM-02）は適用側の責務）。`SUBUNIT_ADDITIONAL_DAMAGE`は
 * SubUnitの実行時状態を前提とするため未対応とする（DMG-005、Issue #190）。
 */
export function evaluateFormula(
  formula: FormulaDefinition,
  context: FormulaEvaluationContext,
  path = "formula",
): number {
  switch (formula.kind) {
    case "CONSTANT":
      return formula.value;
    case "SKILL_POWER":
      return formula.power;
    case "SUBUNIT_ADDITIONAL_DAMAGE":
      throw new DomainValidationError(
        path,
        'kind "SUBUNIT_ADDITIONAL_DAMAGE" requires SubUnit runtime state that is not implemented yet (DMG-005, Issue #190)',
      );
    case "STAT_RATIO": {
      const source = resolveSourceUnit(formula.source, context, `${path}.source`);
      return statValue(source, formula.stat) * formula.ratio;
    }
    case "MAX_HP_RATIO": {
      const source = resolveSourceUnit(formula.source, context, `${path}.source`);
      return source.combatStats.maximumHp * formula.ratio;
    }
    case "CURRENT_HP_RATIO": {
      const source = resolveSourceUnit(formula.source, context, `${path}.source`);
      return source.currentHp * formula.ratio;
    }
    case "MISSING_HP_RATIO":
    case "LOST_HP_RATIO": {
      // `BattleUnit`は累積被ダメージを別途追跡していないため、「不足HP」と
      // 「失ったHP」はどちらも`maximumHp - currentHp`として同じ値になる
      // （両者が乖離するのは戦闘中にmaximumHp自体が変化した場合だが、それを
      // 区別する専用フィールドは現行モデルに存在しない）。
      const source = resolveSourceUnit(formula.source, context, `${path}.source`);
      return (source.combatStats.maximumHp - source.currentHp) * formula.ratio;
    }
    case "DAMAGE_DEALT_RATIO":
    case "DAMAGE_RECEIVED_RATIO":
      return lastResultValue(context, formula.sourceResult, `${path}.sourceResult`) * formula.ratio;
    case "MARKER_COUNT_SCALE": {
      const target = resolveSourceUnit(formula.target, context, `${path}.target`);
      const stackCount = markerStackCount(target, formula.markerId);
      return Math.min(stackCount * formula.perStack, formula.max);
    }
    case "ALIVE_UNIT_COUNT_SCALE": {
      const count = aliveUnitCount(context.skillSource, context.allUnits, formula.side);
      return Math.min(count * formula.perUnit, formula.max);
    }
    case "SUM":
      return formula.formulas.reduce(
        (total, child, index) =>
          total + evaluateFormula(child, context, `${path}.formulas[${index}]`),
        0,
      );
    case "MIN":
      return Math.min(
        ...formula.formulas.map((child, index) =>
          evaluateFormula(child, context, `${path}.formulas[${index}]`),
        ),
      );
    case "MAX":
      return Math.max(
        ...formula.formulas.map((child, index) =>
          evaluateFormula(child, context, `${path}.formulas[${index}]`),
        ),
      );
    case "CLAMP": {
      const value = evaluateFormula(formula.formula, context, `${path}.formula`);
      return Math.min(formula.max, Math.max(formula.min, value));
    }
  }
}
