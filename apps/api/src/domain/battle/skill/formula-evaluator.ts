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
      `sourceResult "${key}" has no recorded value in the evaluation context (RES-002/RES-003, Issue #174/#173, record this at runtime)`,
    );
  }
  return value;
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
