import {
  consumeAp,
  consumeExGaugeFully,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion } from "./action-completion.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { ActionId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleUnit } from "../model/battle-unit.js";

/**
 * `06_戦闘状態遷移.md`「待機」: `通常の待機`（AP1消費）と、`Q-BTL-06`の
 * 「AP0・EX満タン・行動不能」（EXゲージ全量消費）の2通りを共通で扱う。
 * どちらもEXゲージ増加(R-ACT-04)は対象外（M6スコープ）。
 */
export function resolveWait(
  actor: BattleUnit,
  reservedActionType: ReservedActionKind,
  waitReason: string,
  consumedResource: "AP" | "EX_GAUGE",
  units: readonly BattleUnit[],
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
  actionId: ActionId,
  actionScope: ResolutionScopeId,
): ActionResolutionResult {
  const actorId = actor.battleUnitId;
  const consumedAmount = consumedResource === "AP" ? 1 : actor.currentExtraGauge;
  const working =
    consumedResource === "AP"
      ? consumeAp(units, actorId, consumedAmount)
      : consumeExGaugeFully(units, actorId);
  const actorAfter = requireUnit(working, actorId);
  const stateDeltaEntry =
    consumedResource === "AP"
      ? { ap: { before: actor.currentAp, after: actorAfter.currentAp } }
      : { extraGauge: { before: actor.currentExtraGauge, after: actorAfter.currentExtraGauge } };

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
      apAfter: actorAfter.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actorAfter.currentExtraGauge,
      waitReason,
    },
    stateDelta: { units: { [actorId]: stateDeltaEntry } },
  });

  const actionWaited = recorder.record({
    eventType: "ActionWaited",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    parentEventId: actionStarted.eventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    payload: {
      actorUnitId: actorId,
      waitReason,
      consumedResource,
      consumedAmount,
    },
  });

  const completion = recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
    },
    "WAIT",
    actionWaited.eventId,
    working,
  );

  return {
    units: completion.units,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}
