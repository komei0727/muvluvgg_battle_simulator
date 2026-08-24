import { applyCooldownManipulationAction } from "../cooldown-manipulation-application-service.js";
import type { EffectActionHandler, EffectActionOutcome } from "./effect-action-handler.js";
import { eventContextOf, requireActorUnit } from "./effect-action-group-context.js";

/**
 * R-SKL-05: 対象のクールタイムを操作する。COOLDOWN_MANIPULATIONは使用者戦闘不能による
 * 中断の対象外（自傷を伴わない純粋な状態操作のため）であり、全件解決済みとして数える。
 * READY（クールタイム0）のskillだけを指すno-opは`SKIPPED`になる。
 */
export const resolveCooldownManipulation: EffectActionHandler<"COOLDOWN_MANIPULATION"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const cooldownResult = applyCooldownManipulationAction(
    application.hits,
    effectAction,
    box.units,
    {
      ...eventContextOf(context),
      parentEventId: startingEventId,
      // COOLDOWN_MANIPULATION/MODIFY_RESOURCE/HEALは発生源ユニットを前提とする
      // （`CooldownManipulationEventContext`等の`sourceUnitId`は必須）。
      // Memory由来の解決はR-MEM-04に従って拒否する。
      sourceUnitId: requireActorUnit(context, box).battleUnitId,
      ...(context.onFactEventForPassiveChain !== undefined
        ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
        : {}),
    },
  );
  box.units = cooldownResult.units;
  return {
    resultKind: cooldownResult.changed ? "APPLIED" : "SKIPPED",
    resolvedCount: application.hits.length,
    interruptedCount: 0,
    criticalHitCount: 0,
    lastEventId: cooldownResult.lastEventId,
  };
};
