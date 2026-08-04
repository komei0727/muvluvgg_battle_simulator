import type { BattleUnit } from "../model/battle-unit.js";
import {
  createActionPoint,
  createExtraGauge,
  createPassivePoint,
  increaseExtraGaugeWithOverflow,
  truncateFraction,
} from "../model/resource-gauge.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ResourceChangeReason } from "../events/domain-event.js";
import type { ResourceKind } from "../../catalog/definitions/catalog-enums.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";

/** WAIT・AS/EX使用・チャージ開始・チャージ発動のすべてで共有される1行動の解決結果。呼び出し側（`resolveActionPhase`）が`ActionReservationRemoved`を同じ解決スコープへ連鎖させるために使う。 */
export interface ActionResolutionResult {
  readonly units: readonly BattleUnit[];
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly completedEventId: DomainEventId;
}

export type ResolvableEffectiveActionType = "AS" | "EX" | "WAIT" | "CHARGE_RELEASE";

/**
 * `finalizeAction`が必要とする`PassiveActivationRuntime`の最小面。
 * `passive-activation-service.ts`が当モジュールへ依存しているため、具象クラスを
 * importすると循環依存になる。
 */
export interface ResolutionScopeFinalizer {
  finalizeResolutionScope(completedEventId: DomainEventId): {
    readonly units: readonly BattleUnit[];
  };
}

/**
 * 行動解決の共通エピローグ。`06_戦闘状態遷移.md`のCOMPLETING順序では
 * `ActionCompleted`とそのPS連鎖をすべて解決した後にスコープを終了するため、
 * `finalizeResolutionScope`（`resetScope: "RESOLUTION_SCOPE"`のcounter破棄・
 * `RuntimeCounterReset`発行）は`recordActionCompletion`より後で呼び出す。
 * `recordActionCompletion`の`onFactEventForPassiveChain`が内部の各イベントで
 * `passiveRuntime`を同期済みのため、ここでの追加同期は不要。
 */
export function finalizeAction(
  passiveRuntime: ResolutionScopeFinalizer,
  completion: { readonly completedEventId: DomainEventId },
  actionScope: ResolutionScopeId,
  rootEventId: DomainEventId,
): ActionResolutionResult {
  const { units } = passiveRuntime.finalizeResolutionScope(completion.completedEventId);
  return { units, actionScope, rootEventId, completedEventId: completion.completedEventId };
}

export function requireUnit(units: readonly BattleUnit[], id: BattleUnitId): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === id);
  if (unit === undefined) {
    throw new DomainValidationError("battleUnitId", `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

export function consumeAp(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentAp: createActionPoint(unit.currentAp - amount, unit.maximumAp) }
      : unit,
  );
}

/** R-ACT-03（EX行）: APは消費せず、EXゲージを全量消費する。 */
export function consumeExGaugeFully(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentExtraGauge: createExtraGauge(0, unit.maximumExtraGauge) }
      : unit,
  );
}

/** R-PS-05 #2: PSのPP消費（AS/EXの`consumeAp`と対称）。 */
export function consumePp(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentPp: createPassivePoint(unit.currentPp - amount, unit.maximumPp) }
      : unit,
  );
}

export interface ExGaugeIncreaseApplication {
  readonly units: readonly BattleUnit[];
  readonly before: number;
  readonly after: number;
  /** M7-002（Issue #185）: Modifier適用前・capacity適用前の基礎量（`ResourceChanged.baseDelta`）。 */
  readonly baseDelta: number;
  /** Modifier適用後・capacity適用前の要求増加量（Modifier不在なら`baseDelta`と同値）。 */
  readonly requestedAmount: number;
  readonly discardedAmount: number;
}

/**
 * G-05（`14_Catalog定義スキーマ.md`、M7-002/Issue #185）: 対象が保持する
 * 有効な`APPLY_RESOURCE_GAIN_MOD`（`resource`が一致するものだけ）の`rateDelta`
 * （付与時点で評価済み、`AppliedEffect.magnitude`）を合算する。stacking契約は
 * `APPLY_STAT_MOD`と同じ"STACKABLE"のみのため、`selectEffectiveInstances`の
 * 最強選択（R-EFF-05、重複なしグループ向け）は不要 — 保持している全インスタンス
 * が常に有効。
 */
export function composeResourceGainRate(
  unit: BattleUnit,
  resource: ResourceKind,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): number {
  return unit.appliedEffects
    .filter((effect) => {
      const definition = effectActions.get(effect.effectActionDefinitionId);
      return (
        definition !== undefined &&
        definition.kind === "APPLY_RESOURCE_GAIN_MOD" &&
        definition.payload.resource === resource
      );
    })
    .reduce((sum, effect) => sum + effect.magnitude, 0);
}

/**
 * R-HEAL-02（M7-005、Issue #184）: 対象が保持する有効な`APPLY_HEALING_MOD`のうち
 * `direction`が一致するものだけの補正値（付与時点で評価済み、
 * `AppliedEffect.magnitude`）を符号付き割合として合算する。`composeResourceGainRate`
 * と同じく、stacking契約が`STACKABLE`のみのため`selectEffectiveInstances`の最強選択
 * （R-EFF-05、重複なしグループ向け）は不要 — 保持している全インスタンスが常に有効。
 * 呼び出し側（`heal-application-service.ts`）が回復者の`OUTGOING`と対象の`INCOMING`を
 * 合算し、`1 + 合計`を倍率として（0未満は0に丸めて）適用する。
 */
export function composeHealingRate(
  unit: BattleUnit,
  direction: "OUTGOING" | "INCOMING",
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): number {
  return unit.appliedEffects
    .filter((effect) => {
      const definition = effectActions.get(effect.effectActionDefinitionId);
      return (
        definition !== undefined &&
        definition.kind === "APPLY_HEALING_MOD" &&
        definition.payload.direction === direction
      );
    })
    .reduce((sum, effect) => sum + effect.magnitude, 0);
}

/**
 * R-ACT-03: AS/PS/待機の消費量と同量だけEXゲージを増やす（超過分は打ち止め）。
 * M7-002（Issue #185）: `resourceGainRate`（対象ユニットに有効な`RESOURCE_GAIN_MOD`
 * の合成済み倍率、未指定なら0）を`amount`（基礎量）へ`amount * (1 + rate)`で
 * 適用してから、`increaseExtraGaugeWithOverflow`（内部で最終的に1回だけ切り捨てる
 * — R-NUM-02）へ渡す。
 */
export function increaseExGauge(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
  resourceGainRate = 0,
): ExGaugeIncreaseApplication {
  const actor = requireUnit(units, actorId);
  // PRレビュー指摘[P1]（PR #254）: RESOURCE_GAIN_MODはSTACKABLEで、`composeResourceGainRate`が
  // 保持中の全インスタンスを合算するため、負のrateが複数重なると合成後の`resourceGainRate`が
  // -100%を下回りうる（R-FRM-03で同一UnitDefinitionの複数編成が許容されるためproduction到達可能）。
  // このAPI自体は「EXゲージ増加」（R-ACT-03）であり、Modifierは増加量を0まで減衰させられるが、
  // 既存ゲージを減少させる経路ではないため、合成後の要求量を0で floor する。
  const rawRequestedAmount = Math.max(0, amount * (1 + resourceGainRate));
  const result = increaseExtraGaugeWithOverflow(
    actor.currentExtraGauge,
    rawRequestedAmount,
    actor.maximumExtraGauge,
  );
  // R-NUM-02: truncate exactly once, here, at the final application boundary.
  // `result.discardedAmount` is derived from the untruncated `rawRequestedAmount`
  // and would otherwise disagree with the already-truncated `after`/`before`
  // (`requestedAmount === actualAmount + discardedAmount` must hold exactly).
  const requestedAmount = truncateFraction(rawRequestedAmount);
  const actualAmount = result.gauge - actor.currentExtraGauge;
  return {
    units: units.map((unit) =>
      unit.battleUnitId === actorId ? { ...unit, currentExtraGauge: result.gauge } : unit,
    ),
    before: actor.currentExtraGauge,
    after: result.gauge,
    baseDelta: amount,
    requestedAmount,
    discardedAmount: requestedAmount - actualAmount,
  };
}

export interface ResourceChangeRecordContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** レビュー指摘[P2]: 同じSkillUseに属するイベントは同じSkillUseIdを持つ契約（PSも1つのSkillUse）。呼び出し側が採番済みの場合だけ渡す。 */
  readonly skillUseId?: SkillUseId;
}

/**
 * R-ACT-04: 変化後に`ResourceChanged`を発行する（変化量0では発行しない）。
 * 戻り値は次のイベントが繋ぐべき`parentEventId`（変化が無ければ引数の
 * `parentEventId`をそのまま返す）。
 *
 * M7-002（Issue #185）: `baseDelta`（Modifier適用前・capacity適用前の基礎量）を
 * 呼び出し側から受け取る — `RESOURCE_GAIN_MOD`が影響しない消費・回復では
 * 呼び出し側が`after - before`をそのまま渡す（`baseDelta === delta`）。
 */
export function recordResourceChangeIfAny(
  context: ResourceChangeRecordContext,
  actorId: BattleUnitId,
  resource: ResourceKind,
  before: number,
  after: number,
  baseDelta: number,
  reason: ResourceChangeReason,
  parentEventId: DomainEventId,
  causeEventId: DomainEventId,
): DomainEventId {
  if (before === after) {
    return parentEventId;
  }
  const field =
    resource === "AP" ? "ap" : resource === "PP" ? "pp" : resource === "HP" ? "hp" : "extraGauge";
  const event = context.recorder.record({
    eventType: "ResourceChanged",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: actorId,
    payload: {
      battleUnitId: actorId,
      resource,
      before,
      after,
      delta: after - before,
      baseDelta,
      reason,
      causeEventId,
    },
    stateDelta: { units: { [actorId]: { [field]: { before, after } } } },
  });
  return event.eventId;
}

/**
 * R-ACT-03: EX最大値超過分を破棄した時（超過が無ければ発行しない）。
 * M7-002（Issue #185）: `baseDelta`（Modifier適用前・capacity適用前の基礎量）を
 * payloadへ保持する — `ResourceChanged`が発行されない（`delta`が0の）打ち止め
 * でも、このイベントが唯一の一次情報源として`baseDelta`を保持し続ける。
 */
export function recordExtraGaugeOverflowDiscardedIfAny(
  context: ResourceChangeRecordContext,
  actorId: BattleUnitId,
  baseDelta: number,
  requestedAmount: number,
  actualAmount: number,
  discardedAmount: number,
  parentEventId: DomainEventId,
): DomainEventId {
  if (discardedAmount <= 0) {
    return parentEventId;
  }
  const event = context.recorder.record({
    eventType: "ExtraGaugeOverflowDiscarded",
    category: "DIAGNOSTIC",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: actorId,
    payload: {
      battleUnitId: actorId,
      baseDelta,
      requestedAmount,
      actualAmount,
      discardedAmount,
    },
  });
  return event.eventId;
}
