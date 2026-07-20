import type { BattleUnit } from "../model/battle-unit.js";
import {
  createActionPoint,
  createExtraGauge,
  createPassivePoint,
  increaseExtraGaugeWithOverflow,
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

/** WAIT・AS/EX使用・チャージ開始・チャージ発動のすべてで共有される1行動の解決結果。呼び出し側（`resolveActionPhase`）が`ActionReservationRemoved`を同じ解決スコープへ連鎖させるために使う。 */
export interface ActionResolutionResult {
  readonly units: readonly BattleUnit[];
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly completedEventId: DomainEventId;
}

export type ResolvableEffectiveActionType = "AS" | "EX" | "WAIT" | "CHARGE_RELEASE";

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
  readonly requestedAmount: number;
  readonly discardedAmount: number;
}

/** R-ACT-03: AS/PS/待機の消費量と同量だけEXゲージを増やす（超過分は打ち止め）。 */
export function increaseExGauge(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
): ExGaugeIncreaseApplication {
  const actor = requireUnit(units, actorId);
  const result = increaseExtraGaugeWithOverflow(
    actor.currentExtraGauge,
    amount,
    actor.maximumExtraGauge,
  );
  return {
    units: units.map((unit) =>
      unit.battleUnitId === actorId ? { ...unit, currentExtraGauge: result.gauge } : unit,
    ),
    before: actor.currentExtraGauge,
    after: result.gauge,
    requestedAmount: amount,
    discardedAmount: result.discardedAmount,
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
 */
export function recordResourceChangeIfAny(
  context: ResourceChangeRecordContext,
  actorId: BattleUnitId,
  resource: ResourceKind,
  before: number,
  after: number,
  reason: ResourceChangeReason,
  parentEventId: DomainEventId,
  causeEventId: DomainEventId,
): DomainEventId {
  if (before === after) {
    return parentEventId;
  }
  const field = resource === "AP" ? "ap" : resource === "PP" ? "pp" : "extraGauge";
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
      reason,
      causeEventId,
    },
    stateDelta: { units: { [actorId]: { [field]: { before, after } } } },
  });
  return event.eventId;
}

/** R-ACT-03: EX最大値超過分を破棄した時（超過が無ければ発行しない）。 */
export function recordExtraGaugeOverflowDiscardedIfAny(
  context: ResourceChangeRecordContext,
  actorId: BattleUnitId,
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
      requestedAmount,
      actualAmount,
      discardedAmount,
    },
  });
  return event.eventId;
}
