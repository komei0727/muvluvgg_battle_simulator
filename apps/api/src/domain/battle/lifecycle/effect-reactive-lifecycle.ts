import { decrementConsumption } from "../effects/effect-consumption.js";
import { expireEffects, type ExpirationRequest } from "../effects/effect-expiration-service.js";
import { findEffectsWithSatisfiedExpiration } from "./effect-special-expiration.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";

export interface EffectReactiveLifecycleContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface EffectReactiveLifecycleResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  readonly events: readonly BattleDomainEvent[];
}

/**
 * R-EFF-07: `consumption.kind`ごとの消費契機をこのeventTypeから決定する。
 * `HitConfirmed`はMISSの場合は発行されない（`applyDamageAction`が
 * `resolveHit()`が偽の場合HitConfirmed自体を記録しない）ため、命中系イベントの
 * 発行そのものが「MISSでなく命中が確定した」ことを意味し、`OUTGOING_HIT`/
 * `INCOMING_HIT`の契機として過不足なく対応する。
 *
 * ただし実際の契機イベントは`HitConfirmed`ではなく`DamageApplied`を使う
 * （PR #155再レビュー[P1]で発覚: `damage-application-service.ts`の
 * `applyDamageAction`は`onFactEventForPassiveChain`（=このモジュールが
 * フックする`PassiveActivationRuntime.onFactEvent`）へ`HitConfirmed`/
 * `CriticalCheckResolved`/`DamageCalculated`を一切渡さず、`DamageApplied`
 * （と`UnitDefeated`）だけを渡す設計になっている。`DamageApplied`に到達する
 * ヒットは必ずその直前に`HitConfirmed`（MISSでない確定ヒット）を経ているため、
 * 契機としての正しさは`HitConfirmed`と同値）。
 *
 * `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`/`STATUS_BLOCKED`は、それぞれ
 * 「MISSを含む命中判定到達」「`UnitBeingAttacked`」「`EffectApplicationRejected`」
 * という、現時点でこのリポジトリに存在しないイベント・区別が必要なため未対応
 * （`UnitBeingAttacked`/`EffectApplicationRejected`はいずれも別Issue管轄:
 * 前者は#25、後者は#31）。存在しない契機をここで推測して実装しない。
 */
function consumptionKindsTriggeredForUnit(
  event: BattleDomainEvent,
  unitId: ReturnType<typeof requireUnit>["battleUnitId"],
): readonly ConsumptionKind[] {
  if (event.eventType !== "DamageApplied") {
    return [];
  }
  const kinds: ConsumptionKind[] = [];
  if (event.sourceUnitId === unitId) {
    kinds.push("OUTGOING_HIT");
  }
  if (event.payload.targetUnitId === unitId) {
    kinds.push("INCOMING_HIT");
  }
  return kinds;
}

/**
 * R-EFF-07/08: 原因イベント確定直後・PS/Memory候補抽出前に、消費条件と特殊
 * 失効条件を同じ仕組みで評価する（`RuntimeCounterChanged`検出と対称の
 * 「原因イベント後・候補抽出前」フック、`passive-activation-service.ts`の
 * `onFactEvent`から呼ばれる想定）。消費条件が0に達した効果と特殊失効条件が
 * 成立した効果をまとめて`expireEffects`へ渡し、0に達していない消費条件の
 * 変化は`EffectConsumptionChanged`として個別に発行する。
 */
export function applyEffectConsumptionAndExpiration(
  context: EffectReactiveLifecycleContext,
  units: readonly BattleUnit[],
  event: BattleDomainEvent,
  parentEventId: DomainEventId,
): EffectReactiveLifecycleResult {
  let working = units;
  let lastEventId = parentEventId;
  const recordedEvents: BattleDomainEvent[] = [];

  for (const unitSnapshot of units) {
    const holder = requireUnit(working, unitSnapshot.battleUnitId);
    const triggeredKinds = consumptionKindsTriggeredForUnit(event, holder.battleUnitId);

    let currentEffects = holder.appliedEffects;
    const consumptionExpireIds = new Set<EffectInstanceId>();
    for (const kind of triggeredKinds) {
      const decrement = decrementConsumption(currentEffects, kind);
      if (decrement.changes.length === 0) {
        continue;
      }
      currentEffects = decrement.effects;
      for (const change of decrement.changes) {
        if (change.after === 0) {
          consumptionExpireIds.add(change.effectInstanceId);
          continue;
        }
        const changed = context.recorder.record({
          eventType: "EffectConsumptionChanged",
          category: "FACT",
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
          ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
          resolutionScopeId: context.resolutionScopeId,
          parentEventId: lastEventId,
          rootEventId: context.rootEventId,
          targetUnitIds: [holder.battleUnitId],
          payload: {
            effectInstanceId: change.effectInstanceId,
            targetUnitId: holder.battleUnitId,
            consumptionKind: kind,
            before: change.before,
            after: change.after,
          },
        });
        lastEventId = changed.eventId;
        recordedEvents.push(changed);
      }
    }
    if (currentEffects !== holder.appliedEffects) {
      working = working.map((u) =>
        u.battleUnitId === holder.battleUnitId ? { ...u, appliedEffects: currentEffects } : u,
      );
    }

    const specialExpired = findEffectsWithSatisfiedExpiration(currentEffects, event);

    const toExpire: readonly ExpirationRequest[] = [
      ...[...consumptionExpireIds].map(
        (effectInstanceId): ExpirationRequest => ({
          kind: "EFFECT",
          effectInstanceId,
          reason: "CONSUMPTION",
        }),
      ),
      ...specialExpired
        .filter((e) => !consumptionExpireIds.has(e.effectInstanceId))
        .map(
          (e): ExpirationRequest => ({
            kind: "EFFECT",
            effectInstanceId: e.effectInstanceId,
            reason: "SPECIAL_CONDITION",
          }),
        ),
    ];
    if (toExpire.length === 0) {
      continue;
    }
    const expireResult = expireEffects(
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        rootEventId: context.rootEventId,
      },
      working,
      holder.battleUnitId,
      toExpire,
      lastEventId,
    );
    working = expireResult.units;
    lastEventId = expireResult.lastEventId;
    recordedEvents.push(...expireResult.events);
  }

  return { units: working, lastEventId, events: recordedEvents };
}
