import {
  composeResourceGainRate,
  consumeAp,
  consumeExGaugeFully,
  increaseExGauge,
  recordExtraGaugeOverflowDiscardedIfAny,
  recordResourceChangeIfAny,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion } from "./action-completion.js";
import {
  completeActionIfActorDefeatedAtStart,
  fireContinuousHealsOnActionStart,
} from "./continuous-heal-service.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { expireEffectsSteps } from "../effects/duration-expiry-service.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { DepletedAbsorberReason } from "../combat/damage-application-service.js";

/**
 * R-SKL-05（凍結中のチャージ維持、Issue #180 PRレビュー[P2]）: `ActionWaited`の
 * PS/Memory連鎖が解決した直後（`ActionCompleting`より前）の、待機確定時点の状態を
 * 渡す。この時点でのみ「維持した」事実を確定できる——連鎖中にチャージが変化し
 * 得るため、呼び出し前に捕まえた`actor`スナップショットではなく、ここで渡す
 * `units`から都度再解決しなければならない。フックは自身のイベントを`recorder`
 * で記録し、返した場合は`resolveWait`が`PassiveActivationRuntime`へ転送して
 * PS/Memory候補を解決してから`ActionCompleting`へ進む（`ActionWaited`と同じ
 * 「確定事実として連鎖の起点になり得る」FACTイベント）。
 */
export interface WaitEstablishedContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  readonly actorId: BattleUnitId;
  readonly units: readonly BattleUnit[];
}

export type WaitEstablishedHook = (
  context: WaitEstablishedContext,
) => BattleDomainEvent | undefined;

/**
 * `06_戦闘状態遷移.md`「待機」: `通常の待機`（AP1消費、R-ACT-03によりEXゲージも
 * 同量増加する）と、`Q-BTL-06`の「AP0・EX満タン・行動不能」（EXゲージ全量消費、
 * 増加なし）の2通りを共通で扱う。
 */
export function resolveWait(
  actor: BattleUnit,
  reservedActionType: ReservedActionKind,
  waitReason: string,
  consumedResource: "AP" | "EX_GAUGE",
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
  actionId: ActionId,
  actionScope: ResolutionScopeId,
  onWaitEstablished?: WaitEstablishedHook,
): ActionResolutionResult {
  const actorId = actor.battleUnitId;
  const consumedAmount = consumedResource === "AP" ? 1 : actor.currentExtraGauge;
  let working =
    consumedResource === "AP"
      ? consumeAp(units, actorId, consumedAmount)
      : consumeExGaugeFully(units, actorId);
  const actorAfterCost = requireUnit(working, actorId);

  const exGain =
    consumedResource === "AP"
      ? increaseExGauge(
          working,
          actorId,
          consumedAmount,
          composeResourceGainRate(actorAfterCost, "EX_GAUGE", definitions.effectActions),
        )
      : undefined;
  if (exGain !== undefined) {
    working = exGain.units;
  }
  const actorAfterExGain = requireUnit(working, actorId);

  const actionStarted = recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    sourceUnitId: actorId,
    payload: {
      actorUnitId: actorId,
      reservedActionType,
      effectiveActionType: "WAIT",
      apBefore: actor.currentAp,
      apAfter: actorAfterCost.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actorAfterExGain.currentExtraGauge,
      waitReason,
    },
  });

  const resourceChangeContext = {
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    rootEventId: actionStarted.eventId,
  };
  // R-ACT-04: 消費を先に適用し、その後に増加を適用する。
  let lastEventId =
    consumedResource === "AP"
      ? recordResourceChangeIfAny(
          resourceChangeContext,
          actorId,
          "AP",
          actor.currentAp,
          actorAfterCost.currentAp,
          actorAfterCost.currentAp - actor.currentAp,
          "WAIT_COST",
          actionStarted.eventId,
          actionStarted.eventId,
        )
      : recordResourceChangeIfAny(
          resourceChangeContext,
          actorId,
          "EX_GAUGE",
          actor.currentExtraGauge,
          actorAfterCost.currentExtraGauge,
          actorAfterCost.currentExtraGauge - actor.currentExtraGauge,
          "WAIT_COST",
          actionStarted.eventId,
          actionStarted.eventId,
        );
  if (exGain !== undefined) {
    lastEventId = recordResourceChangeIfAny(
      resourceChangeContext,
      actorId,
      "EX_GAUGE",
      exGain.before,
      exGain.after,
      exGain.baseDelta,
      "EX_GAIN",
      lastEventId,
      actionStarted.eventId,
    );
    lastEventId = recordExtraGaugeOverflowDiscardedIfAny(
      resourceChangeContext,
      actorId,
      exGain.baseDelta,
      exGain.requestedAmount,
      exGain.after - exGain.before,
      exGain.discardedAmount,
      lastEventId,
    );
  }

  // レビュー再々々レビュー[P2]: 待機も`ActionWaited`と`ActionCompleting`/
  // Cooldown更新/`ActionCompleted`を発動タイミングとするPS/counter更新を
  // 持ちうるため、この行動専用の`PassiveActivationRuntime`を生成して接続する。
  // PRレビュー指摘[P2]（PR #256、Issue #184）: 生成をR-HEAL-03の継続回復発火より
  // 前へ移し、`HealApplied`もAS/EX経路と同じFACTイベント連鎖へ流す。この時点の
  // `working`はコスト消費・EXゲージ増加を適用済みで、`ActionWaited`より前に
  // 状態を変えるのは継続回復だけのため、生成位置を早めても観測できる差はない。
  const passiveRuntime = new PassiveActivationRuntime(
    {
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      actionId,
    },
    working,
  );

  // R-HEAL-03（M7-005、Issue #184）: 保持者自身の`ActionStarted`を契機とする
  // 継続回復を、行動本体（`ActionWaited`）より前に発火させる。
  const continuousHeal = fireContinuousHealsOnActionStart(
    working,
    actorId,
    {
      ...resourceChangeContext,
      effectActions: definitions.effectActions,
      // R-DOT-01（DMG-008、Issue #189）: 同じ走査で解決する継続ダメージ。
      // 固定継続ダメージがシールドを枯渇させた場合の失効（R-SHD-01第3項）は、
      // `effect-action-group-resolver.ts`のヒット処理とまったく同じ
      // `expireEffectsSteps`経由で行う（R-EFF-09カスケードとCombatStat再計算を共有する）。
      continuousDamage: {
        effectActions: definitions.effectActions,
        expireDepletedAbsorbers: (
          targetUnitId: BattleUnitId,
          depletedEffectInstanceIds: readonly EffectInstanceId[],
          expiryReason: DepletedAbsorberReason,
          unitsForExpiry: readonly BattleUnit[],
          expiryParentEventId: DomainEventId,
        ) =>
          expireEffectsSteps(
            {
              recorder,
              turnNumber,
              cycleNumber,
              actionId,
              resolutionScopeId: actionScope,
              rootEventId: actionStarted.eventId,
            },
            unitsForExpiry,
            depletedEffectInstanceIds.map((effectInstanceId) => ({
              battleUnitId: targetUnitId,
              effectInstanceId,
              reason: expiryReason,
            })),
            definitions.effectActions,
            expiryParentEventId,
          ),
      },
    },
    lastEventId,
    (event, unitsForChain) => passiveRuntime.onFactEvent(event, unitsForChain).units,
  );
  working = continuousHeal.units;
  lastEventId = continuousHeal.lastEventId;

  // START_EVENT #4（`06_戦闘状態遷移.md`、再レビュー[P2] PR #256）: 継続回復と
  // その`HealApplied`起点のPS連鎖で行動者が戦闘不能になった場合、本体を実行せず
  // `COMPLETING`へ進む。
  const interrupted = completeActionIfActorDefeatedAtStart(
    working,
    actorId,
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
      effectActions: definitions.effectActions,
      onFactEventForPassiveChain: (
        event: BattleDomainEvent,
        unitsForChain: readonly BattleUnit[],
      ) => passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    "WAIT",
    continuousHeal.lastEventId,
    actionScope,
    actionStarted.eventId,
    (completedEventId) => passiveRuntime.finalizeResolutionScope(completedEventId).units,
  );
  if (interrupted !== undefined) {
    return interrupted;
  }

  const actionWaited = recorder.record({
    eventType: "ActionWaited",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    parentEventId: lastEventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    payload: {
      actorUnitId: actorId,
      waitReason,
      consumedResource,
      consumedAmount,
    },
  });

  working = passiveRuntime.onFactEvent(actionWaited, working).units;

  // R-SKL-05（Issue #180 PRレビュー[P2]）: `ActionWaited`自身のPS/Memory連鎖が
  // 解決した後、`ActionCompleting`より前のこの時点で待機確定時イベント（例:
  // `ChargeHeldByFreeze`）を記録する。連鎖中の状態変化を反映した`working`から
  // 判定させるため、呼び出し前の`actor`スナップショットは渡さない。
  let completionTriggerEventId = actionWaited.eventId;
  const establishedEvent = onWaitEstablished?.({
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    rootEventId: actionStarted.eventId,
    parentEventId: actionWaited.eventId,
    actorId,
    units: working,
  });
  if (establishedEvent !== undefined) {
    working = passiveRuntime.onFactEvent(establishedEvent, working).units;
    completionTriggerEventId = establishedEvent.eventId;
  }

  const completion = recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
      effectActions: definitions.effectActions,
      onFactEventForPassiveChain: (event, unitsForChain) =>
        passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    "WAIT",
    completionTriggerEventId,
    working,
  );
  const { units: finalUnits } = passiveRuntime.finalizeResolutionScope(completion.completedEventId);

  return {
    units: finalUnits,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}
