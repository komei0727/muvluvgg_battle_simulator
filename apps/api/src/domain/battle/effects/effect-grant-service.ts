import {
  buildInitialDurationState,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type ContinuousDamageState,
  type DamageModifierState,
  type EffectImmunityState,
  type HealingLinkState,
  type PiercingModifierState,
  type ShieldState,
  type StatusEffectDetails,
  type SubUnitState,
} from "../model/applied-effect.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";
import type { Side } from "../../shared/side.js";
import { compareWithOperator } from "../skill/comparison-operator.js";
import { effectCategoriesOf } from "./effect-category-classifier.js";

export interface GrantEffectContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface GrantEffectRequest {
  /**
   * 付与する効果の`EffectActionDefinition`そのもの。M7-011（Issue #265、
   * `EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）以前は定義IDだけを受け取っていたが、
   * `EffectApplied`の分類payload（`effectKind`/`categories`）は定義の`kind`と
   * `effect-category-classifier.ts`から導く必要があり、IDと定義が食い違う余地を
   * 残さないよう定義自体を正本にした（`effectActionDefinitionId`はここから導く）。
   */
  readonly definition: EffectActionDefinition;
  /**
   * 付与者。R-MEM-04（Issue #179）: Memory の `triggeredEffects` 由来の付与だけは
   * 具体的な付与者ユニットを持たないため`undefined`を渡し、代わりに`sourceSide`
   * を渡す（`AppliedEffect.sourceId`/`EffectApplied`も同じ規約）。
   */
  readonly sourceId?: BattleUnitId;
  /** R-MEM-04: Memory由来の付与だけが持つ、付与元の陣営。 */
  readonly sourceSide?: Side;
  readonly targetId: BattleUnitId;
  readonly duplicate: boolean;
  readonly magnitude: number;
  /** TGT-004フェーズ3（Issue #167、R-ACTN-03）: `APPLY_STATUS`由来の付与だけが持つ。 */
  readonly statusKind?: StatusKind;
  /** M7-004（Issue #183）: `statusKind`がEVASION/BLIND/FREEZE/DAMAGE_IMMUNITYの場合だけ持つ。 */
  readonly statusDetails?: StatusEffectDetails;
  /** M7-001B（Issue #243、R-EFF-03）: `EFFECT_IMMUNITY`由来の付与だけが持つ。 */
  readonly immunity?: EffectImmunityState;
  /** M7-004（ON_ATTACK_BONUS_DAMAGE_BUFF、Issue #183）: `APPLY_ATTACK_DAMAGE_BONUS`由来の付与だけが持つ。 */
  readonly isAttackDamageBonus?: true;
  /** M7-005-HEAL-LINK（Issue #229、R-HEAL-04）: `APPLY_HEALING_LINK`由来の付与だけが持つ。 */
  readonly healingLink?: HealingLinkState;
  /** DMG-002（Issue #192、R-DMG-04）: `APPLY_DAMAGE_MOD`由来の付与だけが持つ。 */
  readonly damageModifier?: DamageModifierState;
  /** DMG-003（Issue #196、R-DMG-03）: `APPLY_PIERCING_MOD`由来の付与だけが持つ。 */
  readonly piercing?: PiercingModifierState;
  /** DMG-004（Issue #194、R-SHD-01）: `APPLY_SHIELD`由来の付与だけが持つ。 */
  readonly shield?: ShieldState;
  /** DMG-005（Issue #190、R-SUB-01/02）: `APPLY_SUBUNIT`由来の付与だけが持つ。 */
  readonly subUnit?: SubUnitState;
  /** DMG-008（Issue #189、R-DOT-01〜04）: `APPLY_CONTINUOUS_DAMAGE`由来の付与だけが持つ。 */
  readonly continuousDamage?: ContinuousDamageState;
  readonly durationDefinition: DurationDefinition;
  readonly snapshot?: Readonly<Record<string, number>>;
}

export interface GrantEffectResult {
  readonly units: readonly BattleUnit[];
  readonly appliedEffect: AppliedEffect;
  readonly lastEventId: DomainEventId;
}

/**
 * 再付与時に`statusKind`単位で1インスタンスへ集約する状態異常。R-EFF-12の
 * 「状態異常は状態種別で一致させる」が指すのは、その集約を実際に実装している
 * 状態種別だけである — `grantStunStatus`のSTUN（R-STS-02「再付与時は残り回数が
 * 長い方を一つだけ残す」）と`grantFreezeStatus`のFREEZE（R-STS-03「再付与時に
 * 期間延長や増幅率加算を行わない」）の2つ。
 *
 * PR #277レビュー[P2]: 当初は`request.statusKind`の有無だけで判定しており、
 * 集約を持たない`APPLY_STATUS`（STEALTH/EVASION/BLIND/DAMAGE_IMMUNITY/
 * HIT_EVASION/GUARANTEED_HIT）まで状態種別で同一視していた。これらは
 * `grantEffect`が常に新規インスタンスを追加する（R-EFF-01）ため、別の効果定義
 * による同種ステータスが残っているだけで差し替えが誤発動してしまう。特にR-STS-04
 * の暗闇は「複数の暗闇を付与順に独立して処理する」と規定されており、状態種別
 * 単位の同一視自体が規則に反する。よって集約を持つ2種別だけを列挙する。
 *
 * 分類上の状態異常（`STATUS_AILMENT_KINDS`＝気絶・凍結・暗闇、R-STS-01）とは
 * 意図的に別集合である — ここで問うのは解除・免疫の分類ではなく「再付与が
 * 既存インスタンスへ集約されるか」であり、暗闇は集約されない。
 *
 * FREEZEは`reapply`の宣言自体をCatalogロード時点で拒否する
 * （`UNSUPPORTED_DYNAMIC_DURATION_REAPPLY`、R-STS-03の再付与がno-opで一度も
 * 評価されないため）ので、実際にこの集合が効くのはSTUNだけである。集約規則を
 * 持つ状態種別を将来追加する場合は、その付与サービスと併せてここへ追加する。
 */
const STATUS_KINDS_AGGREGATED_ON_REAPPLY: ReadonlySet<StatusKind> = new Set<StatusKind>([
  "STUN",
  "FREEZE",
]);

/**
 * R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、M7-014、Issue #268）: `duration.reapply`
 * を宣言した効果は、同じ効果が既に対象へ残っている場合だけ初期残り回数を
 * `reapply.count`へ差し替える（`unit`・`owner`は`timeLimit`のまま）。
 * raw原文の例は`SKL_SIENA_DIVA_PS1`「1行動の気絶を付与する。対象に1行動の気絶が
 * 付与されていた場合は、2行動の気絶に上書きする」。
 *
 * 「同じ効果」の一致判定は、その効果自身の再付与規則が持つ同一性に合わせる。
 * 再付与が`statusKind`単位で1インスタンスへ集約される状態異常
 * （`STATUS_KINDS_AGGREGATED_ON_REAPPLY`）だけは`statusKind`で一致させる —
 * raw原文も付与元スキルを限定していない（「対象に1行動の気絶が付与されていた
 * 場合」）ためである。それ以外はすべて`kindKey`（`EffectActionDefinitionId`
 * そのもの）で一致させる。
 *
 * 一致インスタンスが複数ある場合は残り回数が最大のものと比較する。集約される
 * 状態異常は常に1件だけだが、`kindKey`一致の重複あり効果は複数残り得るため、
 * どれと比較するかを付与順のような不安定な基準に委ねない。
 */
export function resolveDurationOnReapply(
  target: BattleUnit,
  request: GrantEffectRequest,
): DurationDefinition {
  const duration = request.durationDefinition;
  const reapply = duration.reapply;
  const timeLimit = duration.timeLimit;
  if (reapply === undefined || timeLimit === undefined) {
    return duration;
  }
  const kindKey = effectKindKeyFromDefinitionId(request.definition.effectActionDefinitionId);
  const aggregatedStatusKind =
    request.statusKind !== undefined && STATUS_KINDS_AGGREGATED_ON_REAPPLY.has(request.statusKind)
      ? request.statusKind
      : undefined;
  const matches = target.appliedEffects.filter((effect) =>
    aggregatedStatusKind !== undefined
      ? effect.statusKind === aggregatedStatusKind
      : effect.kindKey === kindKey,
  );
  if (matches.length === 0) {
    return duration;
  }
  const existingRemaining = Math.max(
    ...matches.map((effect) => effect.duration.timeLimitRemaining ?? 0),
  );
  if (
    !compareWithOperator(
      existingRemaining,
      reapply.existingRemaining.op,
      reapply.existingRemaining.value,
    )
  ) {
    return duration;
  }
  return { ...duration, timeLimit: { ...timeLimit, count: reapply.count } };
}

/**
 * R-EFF-05（`STACK_LIMIT_ON_STAT_MOD`、M7-012、Issue #266）: `APPLY_STAT_MOD`の
 * `stacking.max`（重複上限）に到達しているかを判定する。raw原文の例は
 * `SKL_TARISA_TROUBLEMAKER_PS1`「「負けん気」は最大14個まで所持できる」に対応する
 * 攻撃力バフ側の上限。
 *
 * 重複数の単位は`EffectKindKey`（現状は`EffectActionDefinitionId`そのもの、
 * `applied-effect.ts`）— R-EFF-05が同種グループを括る単位と同じものを使い、
 * 別定義由来の同種statバフを巻き込まない。
 *
 * `APPLY_MARKER.stack.max`が単一`MarkerState`のスタック数をclampする
 * （`clampMarkerStack`）のに対し、`AppliedEffect`は「重複あり・重複なしの
 * どちらも効果インスタンスと残り期間を個別に保持する」（R-EFF-05第1〜2項）ため
 * clampする先の可変スタック数を持たない。上限到達時は付与自体を行わず、
 * 呼び出し側が`EffectActionCompleted.resultKind: SKIPPED`として記録する
 * （`marker-apply-service.ts`の`KEEP_EXISTING`と同じ「変化が無ければイベントを
 * 発行しない」規約）。
 */
export function isStackLimitReached(
  target: BattleUnit,
  effectActionDefinitionId: EffectActionDefinitionId,
  max: number | null,
): boolean {
  if (max === null) {
    return false;
  }
  const kindKey = effectKindKeyFromDefinitionId(effectActionDefinitionId);
  return target.appliedEffects.filter((effect) => effect.kindKey === kindKey).length >= max;
}

/**
 * R-EFF-01: 新しい`AppliedEffect`インスタンスを対象へ個別に付与し、`EffectApplied`
 * を発行する。同種の既存効果を上書き・統合せず、重複あり・重複なしのどちらも
 * 常に新規インスタンスとして追加する（重複なし効果群の最強選択・次点繰上げは
 * EFF-002のスコープであり、この関数は関与しない）。
 */
export function grantEffect(
  context: GrantEffectContext,
  units: readonly BattleUnit[],
  request: GrantEffectRequest,
  parentEventId: DomainEventId,
): GrantEffectResult {
  const target = requireUnit(units, request.targetId);
  const effectActionDefinitionId = request.definition.effectActionDefinitionId;
  const kindKey = effectKindKeyFromDefinitionId(effectActionDefinitionId);
  // R-EFF-12（M7-014、Issue #268）: 以降はCatalog上の`durationDefinition`ではなく
  // 再付与解決後のものを正本にする（`AppliedEffect.duration.definition`にも
  // これが入り、次回の再付与判定は解決後の残り回数と比較される）。
  const durationDefinition = resolveDurationOnReapply(target, request);
  const timeLimit = durationDefinition.timeLimit;

  // M7-001E（Issue #248）: 分類は`definition.kind`と`magnitude`の符号だけから決まる
  // ため、`AppliedEffect`を組み立てる前にここで一度だけ確定させ、インスタンス・
  // `EffectApplied.payload`・`EffectSnapshot`の3者が同じ値を運ぶようにする
  // （分類元は`effectCategoriesOf`ただ1つ）。
  const categories = [
    ...effectCategoriesOf(
      {
        magnitude: request.magnitude,
        ...(request.statusKind !== undefined ? { statusKind: request.statusKind } : {}),
      },
      request.definition,
    ),
  ].sort();

  const newEffect: AppliedEffect = {
    effectInstanceId: context.recorder.nextEffectInstanceId(),
    effectActionDefinitionId,
    kindKey,
    duplicate: request.duplicate,
    ...(request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetId: request.targetId,
    magnitude: request.magnitude,
    ...(request.statusKind !== undefined ? { statusKind: request.statusKind } : {}),
    ...(request.statusDetails !== undefined ? { statusDetails: request.statusDetails } : {}),
    ...(request.immunity !== undefined ? { immunity: request.immunity } : {}),
    ...(request.isAttackDamageBonus !== undefined
      ? { isAttackDamageBonus: request.isAttackDamageBonus }
      : {}),
    ...(request.healingLink !== undefined ? { healingLink: request.healingLink } : {}),
    ...(request.damageModifier !== undefined ? { damageModifier: request.damageModifier } : {}),
    ...(request.piercing !== undefined ? { piercing: request.piercing } : {}),
    ...(request.shield !== undefined ? { shield: request.shield } : {}),
    ...(request.subUnit !== undefined ? { subUnit: request.subUnit } : {}),
    ...(request.continuousDamage !== undefined
      ? { continuousDamage: request.continuousDamage }
      : {}),
    categories,
    ...(request.definition.kind === "APPLY_STAT_MOD"
      ? { statModStat: request.definition.payload.stat }
      : {}),
    duration: buildInitialDurationState(durationDefinition, {
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      turnNumber: context.turnNumber,
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    }),
    appliedTurnNumber: context.turnNumber,
    ...(context.actionId !== undefined ? { appliedActionId: context.actionId } : {}),
    ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
  };

  // R-EFF-05: この新規インスタンス自身が採用対象かどうかは、対象の既存効果を
  // 含めた選択結果から決まる（重複あり効果は常にtrue、重複なし効果は同種
  // グループ内で最強の場合だけtrue）。この付与によって他の既存インスタンスの
  // 採用可否が変化した場合の`EffectiveEffectChanged`は、呼び出し側のCombatStat
  // 再計算（`combat-stat-recalculation-service.ts`）が扱う — ここでは新規
  // インスタンス自身の`EffectApplied.stateDelta`だけを正しく組み立てる。
  const isEffective = selectEffectiveInstances([...target.appliedEffects, newEffect]).has(
    newEffect.effectInstanceId,
  );

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetId
      ? { ...unit, appliedEffects: [...unit.appliedEffects, newEffect] }
      : unit,
  );

  const applied = context.recorder.record({
    eventType: "EffectApplied",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    // `08_ドメインイベント.md`「Memoryイベントは`sourceUnitId`を持たず、
    // `sourceSide`を持つ」: Memory由来の付与（R-MEM-04）は発生源ユニットを
    // 持たないため、envelopeもpayloadも`sourceSide`へ置き換える。
    ...(request.sourceId !== undefined ? { sourceUnitId: request.sourceId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetUnitIds: [request.targetId],
    payload: {
      effectInstanceId: newEffect.effectInstanceId,
      effectActionDefinitionId,
      ...(request.sourceId !== undefined ? { sourceUnitId: request.sourceId } : {}),
      ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
      targetUnitId: request.targetId,
      duplicate: request.duplicate,
      kindKey,
      // M7-011（Issue #265、`EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）:
      // `TriggerDefinition.condition`の`EVENT_PAYLOAD`が「デバフが付与された際」
      // 「状態異常が付与された際」を表現できるようにする分類フィールド。
      // `kindKey`は`EffectActionDefinitionId`そのもの（定義ごとに一意）で分類には
      // 使えないため、効果の種類（`effectKind`）と、解除・免疫判定の正本である
      // `effect-category-classifier.ts`が導く分類集合（`categories`）を併せて運ぶ。
      // `categories`は複数値（R-STS-01「状態異常はデバフの一種」の`APPLY_STATUS`は
      // `STATUS`と`DEBUFF`の両方）を取るため配列とし、`op: CONTAINS`で判定する。
      // 順序はイベント列の決定性のためソートして固定する。
      effectKind: request.definition.kind,
      categories: newEffect.categories,
      magnitude: request.magnitude,
      ...(request.statusKind !== undefined ? { statusKind: request.statusKind } : {}),
      linkedEffectGroupId: durationDefinition.linkedEffectGroupId,
      ...(timeLimit !== undefined
        ? { durationUnit: timeLimit.unit, initialRemaining: timeLimit.count }
        : {}),
      ...(newEffect.duration.timeLimitRemaining !== undefined
        ? { remainingCount: newEffect.duration.timeLimitRemaining }
        : {}),
      ...(timeLimit?.owner !== undefined ? { durationOwner: timeLimit.owner } : {}),
      ...(durationDefinition.consumption !== undefined
        ? {
            consumptionKind: durationDefinition.consumption.kind,
            consumptionMaxCount: durationDefinition.consumption.maxCount,
          }
        : {}),
      ...(newEffect.duration.consumptionRemaining !== undefined
        ? { consumptionRemaining: newEffect.duration.consumptionRemaining }
        : {}),
      ...(durationDefinition.expiration !== undefined
        ? { expirationConditions: durationDefinition.expiration.conditions }
        : {}),
      ...(newEffect.duration.grantedActionId !== undefined
        ? { grantedActionId: newEffect.duration.grantedActionId }
        : {}),
      ...(newEffect.duration.grantedTurnNumber !== undefined
        ? { grantedTurnNumber: newEffect.duration.grantedTurnNumber }
        : {}),
      ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
    },
    stateDelta: {
      units: {
        [request.targetId]: {
          effects: {
            [newEffect.effectInstanceId]: {
              before: undefined,
              after: toEffectSnapshot(newEffect, isEffective),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, appliedEffect: newEffect, lastEventId: applied.eventId };
}
