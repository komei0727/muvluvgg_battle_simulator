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
import type { SkillUseId } from "../../shared/event-ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { Side } from "../../shared/side.js";
import { matchesRelativeSideOf } from "../targeting/target-selection-policy.js";

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
  /**
   * R-MEM-04（Issue #179）: Memory の `triggeredEffects` から評価する場合だけ
   * `undefined`（Memoryは使用者BattleUnitを持たず、source sideだけを持つ）。
   * `SKILL_SOURCE`参照を実際に使うFormulaはその時点で`DomainValidationError`に
   * なる（他の未提供参照と同じ扱い）。`ALIVE_UNIT_COUNT_SCALE`の相対陣営は
   * `sourceSide`で代替できる。
   */
  readonly skillSource?: BattleUnit;
  /** `skillSource`不在時の相対陣営基準（Memoryを指定した陣営）。 */
  readonly sourceSide?: Side;
  readonly target: BattleUnit;
  readonly allUnits: readonly BattleUnit[];
  readonly triggerSource?: BattleUnit;
  readonly triggerTarget?: BattleUnit;
  readonly bindings?: ReadonlyMap<TargetBindingId, BattleUnit>;
  /**
   * `references.ts`の`LAST_RESULT_REFERENCE_KINDS`をキーとする、確定済みダメージ結果。
   * `LAST_DAMAGE_*`は1解決スコープ（=1行動）の直前結果（R-SKL-08）、`SUM_DAMAGE_*`は
   * 1回のEffectSequence解決内の累計（G-10／RES-003A、Issue #257）で、どちらも
   * `damageResultsFor`が`DamageResultRegistry`から組み立てる。
   */
  readonly lastResults?: Readonly<Partial<Record<LastResultReference, number>>>;
}

function resolveSourceUnit(
  ref: FormulaSourceReference,
  context: FormulaEvaluationContext,
  path: string,
): BattleUnit {
  switch (ref.kind) {
    case "SKILL_SOURCE":
      if (context.skillSource === undefined) {
        throw new DomainValidationError(
          path,
          'kind "SKILL_SOURCE" requires a source BattleUnit, which Memory triggeredEffects do not have (R-MEM-04)',
        );
      }
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
  perspectiveSide: Side,
  allUnits: readonly BattleUnit[],
  side: SelectorSide,
): number {
  return allUnits.filter(
    (unit) => !isDefeated(unit) && matchesRelativeSideOf(unit, perspectiveSide, side),
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
      `sourceResult "${key}" has no recorded value in the evaluation context (LAST_DAMAGE_* requires a prior DAMAGE result in this resolution scope; SUM_DAMAGE_* requires the evaluation to happen inside an EffectSequence resolution, G-10/RES-003A)`,
    );
  }
  return value;
}

/** `DamageResultRegistry`が1ユニットについて保持する、スコープ別のDAMAGE結果。 */
export interface DamageResultRegistryEntry {
  readonly lastDamageDealt?: number;
  readonly lastDamageReceived?: number;
  /**
   * G-10（`14_Catalog定義スキーマ.md`）／RES-003A（Issue #257）: `SUM_DAMAGE_DEALT`が
   * 参照する「同一`EffectSequence`実行中」の累計。EffectSequence 1回の解決を
   * 一意に識別する`SkillUseId`をキーにする。
   */
  readonly sumDamageDealt?: ReadonlyMap<SkillUseId, number>;
  /** `SUM_DAMAGE_RECEIVED`側の同じもの。 */
  readonly sumDamageReceived?: ReadonlyMap<SkillUseId, number>;
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
 *
 * G-10／RES-003A（Issue #257）: 同じregistryが`SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`
 * の累計も保持するが、そちらのスコープは1行動ではなく**1回のEffectSequence解決**で
 * ある。`SkillUseId`はまさにその単位で採番される既存の実行時識別子（AS/EXは
 * `action-skill-use-resolver.ts`、チャージ解放は`action-charge-resolver.ts`、PSは
 * `passive-activation-service.ts`の`activatePassiveCandidate`がそれぞれ
 * `recorder.nextSkillUseId()`で新規採番し、`EFFECT_SEQUENCE`スコープの
 * `RuntimeCounter`もこれをキーにする、EFF-006）であるため、`SkillUseId`ごとに
 * 累計を分けることが「同一EffectSequence内のDAMAGE結果合算」そのものになる。
 * 結果として、同じ行動中にPS連鎖が与えたダメージは別のEffectSequence解決
 * （別の`SkillUseId`）に属し、そのスキル自身の累計へは混入しない。
 */
export type DamageResultRegistry = Map<BattleUnitId, DamageResultRegistryEntry>;

/**
 * `DamageResultRegistry`の該当ユニット分を`FormulaEvaluationContext.lastResults`の
 * 断片へ変換する。
 *
 * `effectSequenceId`（現在解決中のEffectSequenceの`SkillUseId`）を渡した場合だけ
 * `SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`を含める。まだ1件もDAMAGE結果が無い
 * EffectSequenceでは0を返す — 空集合の合計は0として定義され、`LAST_DAMAGE_*`の
 * 「直前結果が存在しない」（そもそも値が無い）とは異なるため。逆に
 * EffectSequenceの外（`continuous-heal-service.ts`の継続回復など）から呼ばれた
 * 場合はキー自体を含めず、`SUM_*`を参照するFormulaを`evaluateFormula`が明確な
 * 例外で拒否できるようにする（暗黙の0にしない）。
 */
export function damageResultsFor(
  registry: DamageResultRegistry | undefined,
  unitId: BattleUnitId,
  effectSequenceId?: SkillUseId,
): NonNullable<FormulaEvaluationContext["lastResults"]> {
  const entry = registry?.get(unitId);
  return {
    ...(entry?.lastDamageDealt !== undefined ? { LAST_DAMAGE_DEALT: entry.lastDamageDealt } : {}),
    ...(entry?.lastDamageReceived !== undefined
      ? { LAST_DAMAGE_RECEIVED: entry.lastDamageReceived }
      : {}),
    ...(registry !== undefined && effectSequenceId !== undefined
      ? {
          SUM_DAMAGE_DEALT: entry?.sumDamageDealt?.get(effectSequenceId) ?? 0,
          SUM_DAMAGE_RECEIVED: entry?.sumDamageReceived?.get(effectSequenceId) ?? 0,
        }
      : {}),
  };
}

/** `effectSequenceId`分の累計へ`finalDamage`を加算した新しいMapを返す（元のMapは変更しない）。 */
function accumulated(
  sums: ReadonlyMap<SkillUseId, number> | undefined,
  effectSequenceId: SkillUseId,
  finalDamage: number,
): ReadonlyMap<SkillUseId, number> {
  const next = new Map(sums);
  next.set(effectSequenceId, (sums?.get(effectSequenceId) ?? 0) + finalDamage);
  return next;
}

/**
 * `applyDamageAction`が確定させたダメージ結果を`registry`へ記録する
 * （ミュータブルな共有Mapを直接更新する — 新しいオブジェクトの返却も
 * イミュータブルコピーも不要、`registry`自体が1解決スコープの寿命を表す）。
 * `effectSequenceId`（このDAMAGEが属するEffectSequence解決の`SkillUseId`）を
 * 渡した場合は、G-10の累計（`SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`）へも
 * 同じ値を加算する。
 *
 * R-SKL-08（レビュー再々々指摘[P1]、PR #214）: MISS・対象不在などで効果が
 * 適用されなかった場合も「同じ解決スコープ内で直前に確定した結果」であり、
 * 正規の直前結果として記録する契約 — R-NUM-04の「参照が存在しない場合は
 * Catalog検証またはpreflightで拒否する」はCatalog定義自体の誤り（存在し得ない
 * 参照）を指し、有効な定義のもとで通常発生し得る実行時のMISSを指すものでは
 * ない。呼び出し側（`applyDamageAction`）は不成立ヒットでも`finalDamage: 0`で
 * この関数を呼ぶことで、以前の成功結果を透けて見せずに済ませつつ、後続の
 * `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`評価を（`DomainValidationError`
 * ではなく）0として決定的に解決させる。累計側では0の加算が恒等演算になるため、
 * 不成立ヒットはそれまでの累計をそのまま保つ。
 */
export function recordDamageResult(
  registry: DamageResultRegistry | undefined,
  dealerId: BattleUnitId,
  receiverId: BattleUnitId,
  finalDamage: number,
  effectSequenceId?: SkillUseId,
): void {
  if (registry === undefined) {
    return;
  }
  const dealerBefore = registry.get(dealerId);
  registry.set(dealerId, {
    ...dealerBefore,
    lastDamageDealt: finalDamage,
    ...(effectSequenceId !== undefined
      ? { sumDamageDealt: accumulated(dealerBefore?.sumDamageDealt, effectSequenceId, finalDamage) }
      : {}),
  });
  // 自傷（dealerId === receiverId）では上の`set`で書いたエントリを起点に
  // `lastDamageReceived`も重ねる必要があるため、`registry.get`をここで取り直す。
  const receiverBefore = registry.get(receiverId);
  registry.set(receiverId, {
    ...receiverBefore,
    lastDamageReceived: finalDamage,
    ...(effectSequenceId !== undefined
      ? {
          sumDamageReceived: accumulated(
            receiverBefore?.sumDamageReceived,
            effectSequenceId,
            finalDamage,
          ),
        }
      : {}),
  });
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
    case "HP_RATIO_SCALE": {
      // DMG-002（Issue #192、`HP_RATIO_SCALE_FORMULA`）: 参照対象のHP割合で
      // `min`〜`max`を線形補間する。`LOWER_HP_IS_MAX`はHPが少ないほど`max`へ、
      // `HIGHER_HP_IS_MAX`はHPが多いほど`max`へ近づく。ここでは丸めない
      // （このEvaluator全体の契約 — 整数化は適用側の責務、R-NUM-02）。
      const target = resolveSourceUnit(formula.target, context, `${path}.target`);
      const maximumHp = target.combatStats.maximumHp;
      // 最大HPが0以下（理論上のみ）ならHP割合を0とみなす。0除算でNaNを
      // 伝播させると、以降のダメージ計算全体が静かに壊れるため。
      const hpRatio = maximumHp > 0 ? Math.min(1, Math.max(0, target.currentHp / maximumHp)) : 0;
      const towardMax = formula.direction === "HIGHER_HP_IS_MAX" ? hpRatio : 1 - hpRatio;
      return formula.min + (formula.max - formula.min) * towardMax;
    }
    case "ALIVE_UNIT_COUNT_SCALE": {
      const relativeSide = context.skillSource?.side ?? context.sourceSide;
      if (relativeSide === undefined) {
        throw new DomainValidationError(
          `${path}.side`,
          'kind "ALIVE_UNIT_COUNT_SCALE" requires a source BattleUnit or sourceSide to resolve the relative side',
        );
      }
      const count = aliveUnitCount(relativeSide, context.allUnits, formula.side);
      return Math.min(count * formula.perUnit, formula.max);
    }
    case "PRODUCT":
      // DMG-002（Issue #192）: `SUM`の乗算版。「威力 × (1 + HP割合スケール)」のように
      // 逓減倍率を基礎量へ掛ける形（`SKL_SENKA_CHRISTMAS_AS2`）を、丸めを挟まずに
      // 1つのFormulaで表すために追加した。空集合の積は1（`SUM`の0に対応）だが、
      // `formulas`はCatalog検証で非空が保証される。
      return formula.formulas.reduce(
        (total, child, index) =>
          total * evaluateFormula(child, context, `${path}.formulas[${index}]`),
        1,
      );
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
