import { decrementConsumption } from "../effects/effect-consumption.js";
import { expireEffects, type ExpirationRequest } from "../effects/effect-expiration-service.js";
import { findEffectsWithSatisfiedExpiration } from "./effect-special-expiration.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
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
  /**
   * PR #155再レビュー[P2]: `EffectConsumptionChanged`（および内部で呼ぶ
   * `expireEffects`が記録する`EffectExpired`/`MarkerRemoved`/
   * `EffectiveEffectChanged`）を記録するたびに直ちに呼び出し、PS/Memory候補
   * 解決を挟む。未指定ならPS解決を行わない（渡されたunitsをそのまま返す）。
   */
  readonly notify?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
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
 * `NEXT_OUTGOING_ATTACK`は仕様上「MISSを含む命中判定到達」が契機だが、
 * `resolveHit()`が現状常に`true`を返すスタブのためMISSそのものが存在せず
 * （#25でMISS実装予定）、「命中判定に到達した」と「命中が確定した」は現時点で
 * 常に同じ瞬間を指す。そのため`OUTGOING_HIT`と同じ`DamageApplied`契機を
 * 安全に共用できる（PR #155再レビュー[P1]）。MISSが実装された時点で両者は
 * 分岐する（`NEXT_OUTGOING_ATTACK`はMISSでも消費するが`OUTGOING_HIT`は
 * 消費しない）ため、#25側でこのロジックの再検討が必要になる。
 *
 * `NEXT_INCOMING_ATTACK`/`STATUS_BLOCKED`は、それぞれ「`UnitBeingAttacked`」
 * 「`EffectApplicationRejected`」という、現時点でこのリポジトリに存在しない
 * イベントが必要なため未対応（いずれも別Issue管轄: 前者は#25、後者は#31）。
 * `LETHAL_DAMAGE`は`R-EFF-07`にトリガー条件自体が定義されていない仕様未確定の
 * 消費種別のため、独自解釈で実装しない。存在しない契機・未確定の仕様をここで
 * 推測して実装しない。
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
    kinds.push("OUTGOING_HIT", "NEXT_OUTGOING_ATTACK");
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
  const notify = context.notify ?? ((_event, currentUnits) => currentUnits);

  for (const unitSnapshot of units) {
    const holder = requireUnit(working, unitSnapshot.battleUnitId);
    const triggeredKinds = consumptionKindsTriggeredForUnit(event, holder.battleUnitId);

    let currentEffects = holder.appliedEffects;
    const consumptionExpireIds = new Set<EffectInstanceId>();
    for (const kind of triggeredKinds) {
      const beforeDecrementEffects = currentEffects;
      const decrement = decrementConsumption(currentEffects, kind);
      if (decrement.changes.length === 0) {
        continue;
      }
      currentEffects = decrement.effects;
      working = working.map((u) =>
        u.battleUnitId === holder.battleUnitId ? { ...u, appliedEffects: currentEffects } : u,
      );
      for (const change of decrement.changes) {
        const beforeEffect = beforeDecrementEffects.find(
          (e) => e.effectInstanceId === change.effectInstanceId,
        );
        const afterEffect = currentEffects.find(
          (e) => e.effectInstanceId === change.effectInstanceId,
        );
        // PR #155再レビュー[P2]: 残回数が0へ達する変化も「消費条件で残回数が
        // 変化した後」（`08_ドメインイベント.md`「EffectConsumptionChanged」）に
        // 該当するため、`EffectExpired`に置き換えず先に記録する
        // （`CooldownReduced`が0へ達する変化でも記録され、その後`CooldownCompleted`
        // が続く既存の対称パターンと揃える）。記録直後に`notify`を挟み、
        // 後続の判定（特殊失効・`expireEffects`）が最新状態を踏まえられる
        // ようにする（`expireEffects`と同じ「各イベント直後にPS解決」原則）。
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
          // PR #155再レビュー[P1]（Finding A）: 消費条件による残り回数変化を
          // `effects`stateDeltaとして持つ。0へ達した場合の効果除去は続けて
          // `expireEffects`が`EffectExpired`として別途所有する。
          ...(beforeEffect !== undefined && afterEffect !== undefined
            ? {
                stateDelta: {
                  units: {
                    [holder.battleUnitId]: {
                      effects: {
                        [change.effectInstanceId]: {
                          before: toEffectSnapshot(beforeEffect),
                          after: toEffectSnapshot(afterEffect),
                        },
                      },
                    },
                  },
                },
              }
            : {}),
        });
        lastEventId = changed.eventId;
        recordedEvents.push(changed);
        working = notify(changed, working);
        if (change.after === 0) {
          consumptionExpireIds.add(change.effectInstanceId);
        }
      }
    }

    // PR #155再レビュー[P2]: `TARGET_STATE`（`target: SELF`）は「この効果を保持
    // するユニット」を指す。`notify`によるPS反応後の最新`working`から`holder`を
    // 再取得し、`currentEffects`ではなくその時点の実効果集合を使う。
    const holderAfterConsumption = requireUnit(working, holder.battleUnitId);
    const specialExpired = findEffectsWithSatisfiedExpiration(
      holderAfterConsumption.appliedEffects,
      event,
      {
        owner: holderAfterConsumption,
        getUnit: (id) => working.find((u) => u.battleUnitId === id),
      },
    );

    const toExpire: readonly ExpirationRequest[] = [
      ...[...consumptionExpireIds]
        .filter((id) =>
          holderAfterConsumption.appliedEffects.some((e) => e.effectInstanceId === id),
        )
        .map(
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
        notify,
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
