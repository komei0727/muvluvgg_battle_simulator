import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import { evaluateFormula } from "../skill/formula-evaluator.js";
import { absorbFromShieldPool, emitShieldConsumed } from "../combat/shield-policy.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { ContinuousDamageKind } from "../../catalog/definitions/effect-action-payload.js";
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
   * R-SHD-01第3項（DMG-004、Issue #194）: 残量が0になったシールドインスタンスを
   * `EffectExpired`（`reason: SHIELD_DEPLETED`）として失効させ、R-EFF-09の
   * カスケードとCombatStat再計算まで行う完全な処理。`damage-application-service.ts`
   * の同名フックと同じ理由（`effects/`への直接依存を持ち込まない）で呼び出し側が
   * 注入する。未指定なら枯渇インスタンスをそのまま残す — このフックを用意しない
   * 単体テスト向けの最小動作であり、production経路は常に注入する。
   */
  readonly expireDepletedShields?: (
    targetUnitId: BattleUnitId,
    depletedEffectInstanceIds: readonly EffectInstanceId[],
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
  readonly calculatedDamage: number;
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
 * - `POISON`（R-DOT-04）: `現在HP × 毒効果率`を発火のたびに評価し直し
 *   （`CURRENT_HP_RATIO`は発火時点の対象HPを参照する必要がある）、
 *   `付与時攻撃力 × 100%`で頭打ちにする。
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
  const snapshotAttack = snapshotAttackOf(effect);

  if (kind === "POISON") {
    const ratioDamage = evaluateFormula(
      definition.payload.formula,
      {
        ...(granter !== undefined ? { skillSource: granter } : {}),
        ...(effect.sourceSide !== undefined ? { sourceSide: effect.sourceSide } : {}),
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
      calculatedDamage: Math.max(1, truncateFraction(capped)),
    };
  }

  const burnStackMultiplier =
    kind === "BURN" && countBurnInstances(holder) >= MAX_BURN_INSTANCES
      ? BURN_TRIPLE_STACK_MULTIPLIER
      : 1;
  return {
    formulaResult: effect.magnitude,
    burnStackMultiplier,
    cappedBySnapshotAttack: false,
    calculatedDamage: Math.max(1, truncateFraction(effect.magnitude * burnStackMultiplier)),
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
      context.expireDepletedShields !== undefined
    ) {
      // `damage-application-service.ts`の`driveRemovalSteps`と同じ規約: 除去1件
      // （とそのR-EFF-09カスケード）ごとに連鎖へ通知してから次の除去へ進む。
      // この経路は必ず`onFactEvent`を持つ（行動開始時処理はPS/Memory連鎖の
      // driverを常に注入する）ため、`yield`して呼び出し元へ委ねる必要はない。
      const removal = context.expireDepletedShields(
        holder.battleUnitId,
        absorption.change.depletedEffectInstanceIds,
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

  const targetBeforeHp =
    working.find((unit) => unit.battleUnitId === holder.battleUnitId) ?? holder;
  const hpBefore = targetBeforeHp.currentHp;
  const hitPointDamage = amount.calculatedDamage - typedShieldAbsorbed - untypedShieldAbsorbed;
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
    ...(effect.sourceId !== undefined ? { sourceUnitId: effect.sourceId } : {}),
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
  lastEventId = applied.eventId;

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
      ...(effect.sourceId !== undefined ? { sourceUnitId: effect.sourceId } : {}),
      ...(effect.sourceSide !== undefined ? { sourceSide: effect.sourceSide } : {}),
      targetUnitIds: [holder.battleUnitId],
      payload: { unitId: holder.battleUnitId, causeEventId: applied.eventId },
    });
    lastEventId = defeated.eventId;
  }
  notify(factEventsStart);

  return { units: working, lastEventId };
}
