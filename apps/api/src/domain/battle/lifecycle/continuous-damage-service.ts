import { isDefeated, requireUnit, type BattleUnit } from "../model/battle-unit.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../model/applied-effect.js";
import {
  grantEffect,
  type GrantEffectContext,
  type GrantEffectRequest,
} from "../effects/effect-grant-service.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import { evaluateFormula } from "../skill/formula-evaluator.js";
import { absorbFromShieldPool, emitShieldConsumed } from "../combat/shield-policy.js";
import { absorbFromNextSubUnit, emitSubUnitDamaged } from "../combat/sub-unit-policy.js";
import type { DepletedAbsorberReason } from "../combat/damage-application-service.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { recordExerciseScoreIfAny } from "../events/exercise-score-recording.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { ContinuousDamageKind } from "../../catalog/definitions/effect-action-payload.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";

/**
 * R-DOT-01「付与対象の行動開始時に発生する」が実装対象とする
 * `APPLY_CONTINUOUS_DAMAGE`の`timing`。`APPLY_CONTINUOUS_HEAL`の
 * `SUPPORTED_CONTINUOUS_HEAL_TIMING`と同じ形で、それ以外の組み合わせは
 * `catalog-integrity.ts`がCatalogロード時点で拒否する
 * （`UNSUPPORTED_CONTINUOUS_DAMAGE_TIMING`）ため、この判定は防御的な二重確認である。
 */
export const SUPPORTED_CONTINUOUS_DAMAGE_TIMING = {
  eventType: "ActionStarted",
  targetSelector: "EFFECT_OWNER",
} as const;

/** R-DOT-03「最大3つまで保持する」。 */
export const MAX_BURN_INSTANCES = 3;

/**
 * R-DOT-04「上限ダメージ = 付与時攻撃力 × 100%」。倍率そのものを定数として置き、
 * 「100%」が式の中で無言の`1`にならないようにする。
 */
export const POISON_DAMAGE_CAP_RATE = 1;

/**
 * R-DOT-03「対象が炎上を3つ保持している場合、各炎上インスタンスが発生させる
 * ダメージをそれぞれ2倍にする」の倍率。
 */
export const BURN_TRIPLE_STACK_MULTIPLIER = 2;

export interface ContinuousDamageEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** 発火するインスタンスの`APPLY_CONTINUOUS_DAMAGE`定義（毒のFormula再評価に使う）。 */
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
  /**
   * R-TEX-02: 戦術演習だけが持つ演習状態。継続ダメージはダメージpipelineの外に
   * あるが、敵HPへ向かう量は同じ規則で計上する（R-TEX-02 #3）。未指定なら
   * 通常戦闘であり、計上もイベント発行も行わない。
   */
  readonly exercise?: ExerciseRuntime;
  /**
   * R-SHD-01第3項（DMG-004、Issue #194）／R-SUB-01（DMG-005、Issue #190）:
   * 残量が0になったシールドインスタンス、または耐久力が0になったサブユニット
   * インスタンスを`EffectExpired`（`reason: SHIELD_DEPLETED` / `SUBUNIT_DEPLETED`）
   * として失効させ、R-EFF-09のカスケードとCombatStat再計算まで行う完全な処理。
   * `damage-application-service.ts`の同名フックと同じ理由（`effects/`への直接依存を
   * 持ち込まない）で呼び出し側が注入する。未指定なら枯渇インスタンスをそのまま残す
   * — このフックを用意しない単体テスト向けの最小動作であり、production経路は常に注入する。
   */
  readonly expireDepletedAbsorbers?: (
    targetUnitId: BattleUnitId,
    depletedEffectInstanceIds: readonly EffectInstanceId[],
    reason: DepletedAbsorberReason,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
}

export interface ContinuousDamageResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-DOT-03「最大3つまで保持する」の重複数。保持者が持つ**全ての**炎上インスタンスを
 * 定義をまたいで数える — raw原文（`戦闘システム.md`「炎上は３回まで重複し、同一の
 * キャラクターが炎上を３回受けたとき」）はどのスキル由来かを区別しないため、
 * R-EFF-05の`EffectKindKey`単位（`isStackLimitReached`）ではなく種別単位で数える。
 */
export function countBurnInstances(target: BattleUnit): number {
  return target.appliedEffects.filter(
    (effect) => effect.continuousDamage?.continuousDamageKind === "BURN",
  ).length;
}

/**
 * R-DOT-03: 対象が上限（3つ）の炎上を保持しているため、新たな炎上を付与しない。
 * `isStackLimitReached`（`APPLY_STAT_MOD.stacking.max`）と同じく、上限到達時は
 * 付与自体を行わず呼び出し側が`EffectActionCompleted.resultKind: SKIPPED`として
 * 記録する（「変化が無ければイベントを発行しない」規約）。
 */
export function isBurnStackLimitReached(target: BattleUnit): boolean {
  return countBurnInstances(target) >= MAX_BURN_INSTANCES;
}

/** この`AppliedEffect`が継続ダメージであれば、その付与時攻撃力スナップショット（R-DOT-01）。 */
export function snapshotAttackOf(effect: AppliedEffect): number {
  return effect.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY] ?? 0;
}

/** 1インスタンスの発生量の内訳（`ContinuousDamageApplied` payloadと監査用）。 */
export interface ContinuousDamageAmount {
  readonly formulaResult: number;
  readonly burnStackMultiplier: number;
  readonly cappedBySnapshotAttack: boolean;
  /**
   * R-DOT-01の切り捨て・最低1ダメージを適用する**前**の値。炎上の2倍（R-DOT-03）と
   * 毒の上限（R-DOT-04）は適用済みである。
   *
   * R-DOT-04の「効果量」はこの丸め前の値を指す（`毒ダメージ = min(割合ダメージ,
   * 上限ダメージ)`）— 切り捨てと最低1ダメージはR-DOT-01が「各継続ダメージの
   * 最終結果」へ適用する別の共通規則であり、効果量の定義には入らない。
   * したがって再付与の統合判定（`grantPoisonContinuousDamage`）はこの値で比較する
   * （`calculatedDamage`で比べると、最低1へ丸められる
   * 小さな値どうしが同値に潰れて大小関係が失われる）。
   */
  readonly preTruncationDamage: number;
  readonly calculatedDamage: number;
}

/**
 * R-DOT-04 の毒ダメージ1回分。
 *
 * ```text
 * 割合ダメージ = 現在HP × 毒効果率
 * 上限ダメージ = 付与時攻撃力 × 100%
 * 毒ダメージ = min(割合ダメージ, 上限ダメージ)
 * ```
 *
 * 発火時（`calculateContinuousDamage`）と再付与の統合判定
 * （`grantPoisonContinuousDamage` の「効果量は大きい方」）が同じ実装を共有する。
 * 統合判定は候補ごとに`formula`と`snapshotAttack`が違うだけで、`holder`（＝現在HP）は
 * 共通であるため、この関数を同じ`holder`で2回呼べば同じ土俵の比較になる
 * （保存済みの`magnitude`同士を比べると、各インスタンスが自分の
 * 付与時点のHPで評価した値を比べることになり、R-DOT-04の大小関係が逆転しうる）。
 */
export function calculatePoisonTickDamage(
  formula: FormulaDefinition,
  snapshotAttack: number,
  holder: BattleUnit,
  granter: BattleUnit | undefined,
  sourceSide: Side | undefined,
  units: readonly BattleUnit[],
): ContinuousDamageAmount {
  const ratioDamage = evaluateFormula(
    formula,
    {
      ...(granter !== undefined ? { skillSource: granter } : {}),
      ...(sourceSide !== undefined ? { sourceSide } : {}),
      target: holder,
      allUnits: units,
    },
    "continuousDamageFormula",
  );
  const cap = snapshotAttack * POISON_DAMAGE_CAP_RATE;
  const cappedBySnapshotAttack = ratioDamage > cap;
  const capped = cappedBySnapshotAttack ? cap : ratioDamage;
  return {
    formulaResult: ratioDamage,
    burnStackMultiplier: 1,
    cappedBySnapshotAttack,
    preTruncationDamage: capped,
    calculatedDamage: Math.max(1, truncateFraction(capped)),
  };
}

/**
 * R-DOT-01〜04: 1つの継続ダメージインスタンスが今回発生させるダメージ量を求める。
 *
 * - `FIXED`/`BURN`（R-DOT-02/03）: 付与時に評価済みの固定量（`AppliedEffect.magnitude`）
 *   をそのまま使う。この`magnitude`は付与時の付与者攻撃力から算出済みであり
 *   （`STAT_RATIO(SKILL_SOURCE, ATTACK)`）、R-DOT-01「付与後の攻撃力変化や付与者の
 *   戦闘不能は計算へ影響しない」を満たす。
 * - `BURN`（R-DOT-03）: 対象が炎上を3つ保持しているなら2倍する。「2倍処理は各
 *   インスタンスの最終結果を算出する前に適用し、合計値を後から2倍にしない」ため、
 *   切り捨て前の値へ掛ける。
 * - `POISON`（R-DOT-04）: `現在HP × 毒効果率`を発火のたびに評価し直す
 *   （`CURRENT_HP_RATIO`は発火時点の対象HPを参照する必要がある）。
 *
 * 最後にR-DOT-01「各継続ダメージの最終結果で小数部分を切り捨て、ダメージが1未満なら
 * 最低1とする」を適用する。ダメージ軽減・増加、属性相性、会心は一切適用しない。
 */
export function calculateContinuousDamage(
  effect: AppliedEffect,
  definition: Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_DAMAGE" }>,
  holder: BattleUnit,
  granter: BattleUnit | undefined,
  units: readonly BattleUnit[],
): ContinuousDamageAmount {
  const kind = definition.payload.continuousDamageKind;

  if (kind === "POISON") {
    return calculatePoisonTickDamage(
      definition.payload.formula,
      snapshotAttackOf(effect),
      holder,
      granter,
      effect.sourceSide,
      units,
    );
  }

  const burnStackMultiplier =
    kind === "BURN" && countBurnInstances(holder) >= MAX_BURN_INSTANCES
      ? BURN_TRIPLE_STACK_MULTIPLIER
      : 1;
  const preTruncationDamage = effect.magnitude * burnStackMultiplier;
  return {
    formulaResult: effect.magnitude,
    burnStackMultiplier,
    cappedBySnapshotAttack: false,
    preTruncationDamage,
    calculatedDamage: Math.max(1, truncateFraction(preTruncationDamage)),
  };
}

/**
 * R-DOT-02「対応するタイプありシールド、タイプなしシールド、HPの順で適用する」の
 * 対象になるのは固定継続ダメージだけである。炎上・毒はシールドとサブユニットで
 * 受けない（R-DOT-04第2項、R-SUB-01「毒、炎上など、通常シールドで受けられない
 * ダメージはサブユニットでも受けない」、R-LNK-02「元ダメージが毒・炎上など
 * シールド対象外なら」）。
 */
export function isShieldApplicableContinuousDamage(kind: ContinuousDamageKind): boolean {
  return kind === "FIXED";
}

/** `emitShieldConsumed`が要求する最小contextを`ContinuousDamageEventContext`から作る。 */
function shieldContextOf(context: ContinuousDamageEventContext): {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
} {
  return {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    rootEventId: context.rootEventId,
  };
}

/**
 * R-DOT-01〜04: 1つの継続ダメージインスタンスを保持者へ適用し、
 * `ContinuousDamageApplied`（致死なら続けて`UnitDefeated`）を発行する。
 *
 * 固定継続ダメージ（R-DOT-02）は`damage-application-service.ts`のヒット処理と同じ
 * 順序でシールドへ振り分ける — プールごとに「減少 → `ShieldConsumed` → 連鎖の解決 →
 * 枯渇分の`EffectExpired`」を完了させてから次のプール・HPへ進む
 * （`08_ドメインイベント.md`「ShieldConsumed payload」）。
 */
export function applyOneContinuousDamage(
  effect: AppliedEffect,
  definition: Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_DAMAGE" }>,
  holder: BattleUnit,
  granter: BattleUnit | undefined,
  units: readonly BattleUnit[],
  context: ContinuousDamageEventContext,
  parentEventId: DomainEventId,
  onFactEvent?: (event: BattleDomainEvent, units: readonly BattleUnit[]) => readonly BattleUnit[],
): ContinuousDamageResult {
  const kind = definition.payload.continuousDamageKind;
  const damageType: DamageType = definition.payload.damageType;
  const amount = calculateContinuousDamage(effect, definition, holder, granter, units);

  let working = units;
  let lastEventId = parentEventId;

  const notify = (fromIndex: number): void => {
    if (onFactEvent === undefined) {
      return;
    }
    for (const event of context.recorder.getEvents().slice(fromIndex)) {
      working = onFactEvent(event, working);
    }
  };

  // R-DOT-02: シールドへ振り分けるのは固定継続ダメージだけ。
  const absorbedByPool = new Map<DamageType | null, number>();
  let poolDamage = isShieldApplicableContinuousDamage(kind) ? amount.calculatedDamage : 0;
  for (const shieldType of [damageType, null] as const) {
    if (poolDamage <= 0) {
      break;
    }
    // 直前のプールの連鎖が残量・保持者を変え得るため、そのつど最新状態から取り直す。
    const currentHolder = working.find((unit) => unit.battleUnitId === holder.battleUnitId);
    if (currentHolder === undefined) {
      break;
    }
    const absorption = absorbFromShieldPool(currentHolder, poolDamage, shieldType);
    if (absorption.change === undefined) {
      continue;
    }
    const holderAfterPool: BattleUnit = {
      ...currentHolder,
      appliedEffects: absorption.appliedEffects,
    };
    working = working.map((unit) =>
      unit.battleUnitId === holder.battleUnitId ? holderAfterPool : unit,
    );
    poolDamage -= absorption.absorbed;
    absorbedByPool.set(shieldType, absorption.absorbed);

    const consumedEventsStart = context.recorder.getEvents().length;
    lastEventId = emitShieldConsumed(
      shieldContextOf(context),
      holderAfterPool,
      absorption.change,
      "CONTINUOUS_DAMAGE_ABSORPTION",
      lastEventId,
    );
    notify(consumedEventsStart);

    if (
      absorption.change.depletedEffectInstanceIds.length > 0 &&
      context.expireDepletedAbsorbers !== undefined
    ) {
      // `damage-application-service.ts`の`driveRemovalSteps`と同じ規約: 除去1件
      // （とそのR-EFF-09カスケード）ごとに連鎖へ通知してから次の除去へ進む。
      // この経路は必ず`onFactEvent`を持つ（行動開始時処理はPS/Memory連鎖の
      // driverを常に注入する）ため、`yield`して呼び出し元へ委ねる必要はない。
      const removal = context.expireDepletedAbsorbers(
        holder.battleUnitId,
        absorption.change.depletedEffectInstanceIds,
        "SHIELD_DEPLETED",
        working,
        lastEventId,
      );
      let step = removal.next();
      while (!step.done) {
        let stepUnits = step.value.units;
        for (const event of step.value.events) {
          stepUnits = onFactEvent === undefined ? stepUnits : onFactEvent(event, stepUnits);
        }
        working = stepUnits;
        step = removal.next(stepUnits);
      }
      working = step.value.units;
      lastEventId = step.value.lastEventId;
    }
  }
  const typedShieldAbsorbed = absorbedByPool.get(damageType) ?? 0;
  const untypedShieldAbsorbed = absorbedByPool.get(null) ?? 0;

  // R-SUB-01第1項「通常シールドをすべて適用した後にサブユニットがダメージを受ける」
  // ＋第2項「毒、炎上など、通常シールドで受けられないダメージはサブユニットでも
  // 受けない」（DMG-005、Issue #190）: シールドと同じ`poolDamage`（固定継続ダメージ
  // だけが正）の残りをサブユニットへ回す。BURN/POISONは`poolDamage`が0のまま
  // ここへ来るため、規則どおり素通ししてHPへ向かう。
  let subUnitAbsorbed = 0;
  while (poolDamage > 0) {
    const currentHolder = working.find((unit) => unit.battleUnitId === holder.battleUnitId);
    if (currentHolder === undefined) {
      break;
    }
    const absorption = absorbFromNextSubUnit(currentHolder, poolDamage);
    if (absorption.change === undefined) {
      break;
    }
    const holderAfter: BattleUnit = {
      ...currentHolder,
      appliedEffects: absorption.appliedEffects,
    };
    working = working.map((unit) =>
      unit.battleUnitId === holder.battleUnitId ? holderAfter : unit,
    );
    poolDamage -= absorption.absorbed;
    subUnitAbsorbed += absorption.absorbed;

    const damagedEventsStart = context.recorder.getEvents().length;
    lastEventId = emitSubUnitDamaged(
      shieldContextOf(context),
      holderAfter,
      absorption.change,
      "CONTINUOUS_DAMAGE_ABSORPTION",
      lastEventId,
    );
    notify(damagedEventsStart);

    if (absorption.change.depleted && context.expireDepletedAbsorbers !== undefined) {
      const removal = context.expireDepletedAbsorbers(
        holder.battleUnitId,
        [absorption.change.effectInstanceId],
        "SUBUNIT_DEPLETED",
        working,
        lastEventId,
      );
      let step = removal.next();
      while (!step.done) {
        let stepUnits = step.value.units;
        for (const event of step.value.events) {
          stepUnits = onFactEvent === undefined ? stepUnits : onFactEvent(event, stepUnits);
        }
        working = stepUnits;
        step = removal.next(stepUnits);
      }
      working = step.value.units;
      lastEventId = step.value.lastEventId;
    }
  }

  const targetBeforeHp =
    working.find((unit) => unit.battleUnitId === holder.battleUnitId) ?? holder;
  const hpBefore = targetBeforeHp.currentHp;
  const hitPointDamage =
    amount.calculatedDamage - typedShieldAbsorbed - untypedShieldAbsorbed - subUnitAbsorbed;
  const hpAfter = Math.max(0, hpBefore - hitPointDamage);
  // R-SHD-03第2項と同じ「HPを0未満にせず、超過分を破棄する」。
  const discardedDamage = hitPointDamage - (hpBefore - hpAfter);
  const updatedTarget: BattleUnit = {
    ...targetBeforeHp,
    // R-NUM-02: HPゲージへ渡す境界で最大値を0方向へ切り捨てて整数化する。
    currentHp: createHitPoint(hpAfter, truncateFraction(targetBeforeHp.combatStats.maximumHp)),
  };
  working = working.map((unit) =>
    unit.battleUnitId === holder.battleUnitId ? updatedTarget : unit,
  );

  const factEventsStart = context.recorder.getEvents().length;
  const applied = context.recorder.record({
    eventType: "ContinuousDamageApplied",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    // R-MEM-04: Memory由来の付与は付与者ユニットを持たず`sourceSide`を持つ。
    ...(effect.sourceUnitId !== undefined ? { sourceUnitId: effect.sourceUnitId } : {}),
    ...(effect.sourceSide !== undefined ? { sourceSide: effect.sourceSide } : {}),
    targetUnitIds: [holder.battleUnitId],
    payload: {
      effectInstanceId: effect.effectInstanceId,
      effectActionDefinitionId: effect.effectActionDefinitionId,
      continuousDamageKind: kind,
      damageType,
      targetUnitId: holder.battleUnitId,
      snapshotAttack: snapshotAttackOf(effect),
      formulaResult: amount.formulaResult,
      burnStackMultiplier: amount.burnStackMultiplier,
      cappedBySnapshotAttack: amount.cappedBySnapshotAttack,
      calculatedDamage: amount.calculatedDamage,
      typedShieldAbsorbed,
      untypedShieldAbsorbed,
      subUnitAbsorbed,
      discardedDamage,
      hitPointDamage: hpBefore - hpAfter,
      hpBefore,
      hpAfter,
      defeated: isDefeated(updatedTarget),
    },
    stateDelta: {
      units: { [holder.battleUnitId]: { hp: { before: hpBefore, after: hpAfter } } },
    },
  });
  // R-TEX-02 #3: 継続ダメージのうちHPへ向かった量（オーバーキル分を含む）を計上する。
  // 計上が発生しなければ`applied.eventId`がそのまま返る。
  lastEventId = recordExerciseScoreIfAny(
    context.exercise,
    context,
    targetBeforeHp,
    hitPointDamage,
    applied.eventId,
  );

  if (!isDefeated(targetBeforeHp) && isDefeated(updatedTarget)) {
    const defeated = context.recorder.record({
      eventType: "UnitDefeated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: applied.eventId,
      rootEventId: context.rootEventId,
      ...(effect.sourceUnitId !== undefined ? { sourceUnitId: effect.sourceUnitId } : {}),
      ...(effect.sourceSide !== undefined ? { sourceSide: effect.sourceSide } : {}),
      targetUnitIds: [holder.battleUnitId],
      payload: { unitId: holder.battleUnitId, causeEventId: applied.eventId },
    });
    lastEventId = defeated.eventId;
  }
  notify(factEventsStart);

  return { units: working, lastEventId };
}

export interface GrantPoisonResult {
  readonly units: readonly BattleUnit[];
  readonly appliedEffect: AppliedEffect;
  readonly lastEventId: DomainEventId;
}

/** R-DOT-04の統合で「効果量」として一組で採用する、毒ダメージを決める2値と採用元。 */
interface PoisonMagnitudeCandidate {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly formula: FormulaDefinition;
  /** 付与時に評価した割合ダメージ（`現在HP × 毒効果率`）。監査用の保存値。 */
  readonly magnitude: number;
  /** R-DOT-01の付与時攻撃力＝R-DOT-04の上限ダメージ。 */
  readonly snapshotAttack: number;
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
}

/**
 * R-DOT-04「既存の毒へ再付与した場合、効果期間は長い方、効果量は大きい方を
 * 引き継いだ一つの毒を残す。期間と効果量は別々の付与元から採用できる」。
 *
 * `grantStunStatus`（R-STS-02）と同じく、Q-EFF-10の既定「再付与は常に新規
 * インスタンスを追加する」を毒固有の規則で上書きし、既存インスタンスを更新する。
 * 気絶と違い比較軸が2つあるため、期間と効果量をそれぞれ独立に採用し、両方とも
 * 既存側が勝った場合だけ変化なし（イベントを発行しない）とする。
 *
 * 「効果量」の比較は、両候補を**この統合時点の対象HP**で評価し直した
 * 1回あたり毒ダメージ（`calculatePoisonTickDamage`＝`min(現在HP × 効果率, 付与時攻撃力)`）
 * で行う。保存済みの`AppliedEffect.magnitude`同士を比べると、各インスタンスが自分の
 * 付与時点のHPで評価した値を比べることになり、大小関係が逆転しうる — 例えばHP 1000で
 * 10%毒（保存値100）を受けた後、HP 300で20%毒（保存値60）を受けると保存値では10%毒が
 * 残るが、次回tickの実ダメージは30対60で20%毒の方が大きい。10%毒と20%毒はどちらも
 * production Catalogに実在するため、この取り違えは実戦闘で起こりうる。
 *
 * 割合と上限は同じ付与元から来た一組として採用する — R-DOT-04が別々の付与元から
 * 採用してよいと述べているのは「期間」と「効果量」の2つであり、効果量を構成する
 * 割合と上限をさらに分解して混ぜてよいとは述べていない。
 *
 * 「既存の毒」は保持者が持つ毒インスタンス全体から探す（`EffectKindKey`単位では
 * ない）— R-DOT-04は付与元スキルを限定しておらず、別スキル由来の毒との統合も
 * 対象だからである。R-DOT-04の統合により毒は常に高々1つしか存在しない。
 *
 * 本関数が`effects/`ではなく`lifecycle/`に居るのは、この比較が発火時とまったく同じ
 * 毒ダメージ計算を必要とするためである（`effects/`は`lifecycle/`へ依存できないため、
 * `effects/`側に置くと計算が二重定義になり両者が乖離しうる）。気絶・凍結の付与
 * サービスが`effects/`に居るのは、それらの再付与判定が残り回数の比較だけで済み、
 * ダメージ計算を必要としないからである。
 */
export function grantPoisonContinuousDamage(
  context: GrantEffectContext,
  units: readonly BattleUnit[],
  request: GrantEffectRequest,
  /** 既存インスタンスの毒効果率（`formula`）を引くためのCatalog参照。 */
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): GrantPoisonResult {
  const target = requireUnit(units, request.targetUnitId);
  const existing = target.appliedEffects.find(
    (effect) => effect.continuousDamage?.continuousDamageKind === "POISON",
  );
  // 既存の毒が無ければ、R-EFF-01の一般規則どおり新規インスタンスを足す。
  if (existing === undefined) {
    return grantEffect(context, units, request, parentEventId);
  }

  // 既存インスタンスの毒効果率は統合判定に必須である。`AppliedEffect`は同じ
  // `effectActions`から解決した定義でしか作られないため、production経路では
  // 常に引ける。引けない場合はCatalogとの不整合であり、黙って2つ目の毒を足すと
  // R-DOT-04「一つの毒を残す」を破るため、明確な例外で停止する。
  const existingDefinition = effectActions.get(existing.effectActionDefinitionId);
  if (existingDefinition === undefined || existingDefinition.kind !== "APPLY_CONTINUOUS_DAMAGE") {
    throw new DomainValidationError(
      "existing.effectActionDefinitionId",
      `R-DOT-04 poison merge requires the existing instance's APPLY_CONTINUOUS_DAMAGE definition, but "${existing.effectActionDefinitionId}" is not in the Catalog`,
    );
  }

  const existingCandidate: PoisonMagnitudeCandidate = {
    effectActionDefinitionId: existing.effectActionDefinitionId,
    formula: existingDefinition.payload.formula,
    magnitude: existing.magnitude,
    snapshotAttack: snapshotAttackOf(existing),
    ...(existing.sourceUnitId !== undefined ? { sourceUnitId: existing.sourceUnitId } : {}),
    ...(existing.sourceSide !== undefined ? { sourceSide: existing.sourceSide } : {}),
  };
  const incomingCandidate: PoisonMagnitudeCandidate = {
    effectActionDefinitionId: request.definition.effectActionDefinitionId,
    formula:
      request.definition.kind === "APPLY_CONTINUOUS_DAMAGE"
        ? request.definition.payload.formula
        : existingDefinition.payload.formula,
    magnitude: request.magnitude,
    snapshotAttack: request.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY] ?? 0,
    ...(request.sourceUnitId !== undefined ? { sourceUnitId: request.sourceUnitId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
  };

  // 両候補を「この統合時点の対象HP」で評価する。`holder`が共通なので同じ土俵になる。
  const tickOf = (candidate: PoisonMagnitudeCandidate): ContinuousDamageAmount =>
    calculatePoisonTickDamage(
      candidate.formula,
      candidate.snapshotAttack,
      target,
      units.find((unit) => unit.battleUnitId === candidate.sourceUnitId),
      candidate.sourceSide,
      units,
    );
  const existingTick = tickOf(existingCandidate);
  const incomingTick = tickOf(incomingCandidate);
  // R-DOT-04の「効果量」＝上限適用後・切り捨て前の毒ダメージで比較する。
  // `calculatedDamage`（R-DOT-01の切り捨て・最低1適用後）で
  // 比べると、例えば現在HP 9での10%毒(0.9)と20%毒(1.8)がどちらも1へ丸められて同値に
  // なり、本来採用すべき20%毒が採られない。HPが回復した後の発生量に差が出る。
  const takeIncomingMagnitude = incomingTick.preTruncationDamage > existingTick.preTruncationDamage;

  const existingRemaining = existing.duration.timeLimitRemaining ?? 0;
  const incomingRemaining = request.durationDefinition.timeLimit?.count ?? 0;
  const takeIncomingDuration = incomingRemaining > existingRemaining;

  if (!takeIncomingMagnitude && !takeIncomingDuration) {
    // `marker-apply-service.ts`のKEEP_EXISTINGと同じ「変化が無ければイベントを
    // 発行しない」規約。呼び出し側は`resultKind: SKIPPED`として記録する。
    return { units, appliedEffect: existing, lastEventId: parentEventId };
  }

  const adopted = takeIncomingMagnitude ? incomingCandidate : existingCandidate;
  const adoptedTick = takeIncomingMagnitude ? incomingTick : existingTick;
  // 効果量側の採用元は、割合を決める効果定義と付与者・付与時攻撃力を一組で運ぶ。
  // 付与者はどちらか一方だけを持つ（R-MEM-04）ため、差し替える場合は
  // `sourceUnitId`/`sourceSide`の両方を採用元のものへ入れ替える。
  const { sourceUnitId: _sourceId, sourceSide: _sourceSide, ...existingWithoutSource } = existing;
  const nextEffect: AppliedEffect = {
    ...existingWithoutSource,
    effectActionDefinitionId: adopted.effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(adopted.effectActionDefinitionId),
    ...(adopted.sourceUnitId !== undefined ? { sourceUnitId: adopted.sourceUnitId } : {}),
    ...(adopted.sourceSide !== undefined ? { sourceSide: adopted.sourceSide } : {}),
    // 保存する`magnitude`も統合時点で評価し直した割合ダメージへ揃える。これにより
    // `AppliedEffect.magnitude`は常に「直近の付与／統合時点で評価した割合ダメージ」を
    // 意味し、監査値として候補間で比較可能な基準を保つ。
    magnitude: adoptedTick.formulaResult,
    snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: adopted.snapshotAttack },
    duration: takeIncomingDuration
      ? {
          ...existing.duration,
          definition: request.durationDefinition,
          timeLimitRemaining: incomingRemaining,
          // R-EFF-04の初回減算除外は「今この行動で付与された」ことを表すため、
          // 期間を差し替えた側の付与時点（＝この行動）で更新する。
          ...(context.actionId !== undefined ? { grantedActionId: context.actionId } : {}),
          grantedTurnNumber: context.turnNumber,
        }
      : existing.duration,
  };

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetUnitId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.map((effect) =>
            effect.effectInstanceId === existing.effectInstanceId ? nextEffect : effect,
          ),
        }
      : unit,
  );

  const merged = context.recorder.record({
    eventType: "EffectMerged",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    ...(request.sourceUnitId !== undefined ? { sourceUnitId: request.sourceUnitId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetUnitIds: [request.targetUnitId],
    payload: {
      effectInstanceId: existing.effectInstanceId,
      battleUnitId: request.targetUnitId,
      effectActionDefinitionId: nextEffect.effectActionDefinitionId,
      reason: "POISON_REAPPLY",
      magnitudeBefore: existing.magnitude,
      magnitudeAfter: nextEffect.magnitude,
      snapshotAttackBefore: existingCandidate.snapshotAttack,
      snapshotAttackAfter: adopted.snapshotAttack,
      // 採用判断の基準そのもの（上限適用後・切り捨て前）。保存値（`magnitude*`）は
      // 評価時点が候補ごとに異なりうるため、これが無いとログから採否の理由を
      // 再現できない。実際に与えるダメージはこれをR-DOT-01で丸めた値になる。
      tickDamageBefore: existingTick.preTruncationDamage,
      tickDamageAfter: adoptedTick.preTruncationDamage,
      remainingBefore: existingRemaining,
      remainingAfter: nextEffect.duration.timeLimitRemaining ?? 0,
    },
    stateDelta: {
      units: {
        [request.targetUnitId]: {
          effects: {
            [existing.effectInstanceId]: {
              before: toEffectSnapshot(existing, true),
              after: toEffectSnapshot(nextEffect, true),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, appliedEffect: nextEffect, lastEventId: merged.eventId };
}
