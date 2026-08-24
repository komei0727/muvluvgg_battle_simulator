import { applyHealActionSteps } from "../heal-application-service.js";
import type { SteppedEffectActionHandler } from "./effect-action-handler.js";
import { eventContextOf, requireActorUnit } from "./effect-action-group-context.js";

/**
 * R-HEAL-01（M7-005）: 即時回復。HEAL_DISTRIBUTEは`distributionShareCount`
 * （同一EffectStep内でこのEffectActionが適用される対象数、`resolveActionApplications`が
 * 算出）で総量を等分する。
 *
 * R-HEAL-04 #4/#6: `applyHealActionSteps`は`context.onFactEventForPassiveChain`未指定
 * （＝PS自身のEffectSequence解決）の場合だけ、`HealApplied`／各`HealingTransferred`の
 * 直後に連鎖境界を`yield`する。DAMAGEの凍結カスケードと同じ形でそれを`EFFECT_RESOLVED`
 * として中継し、`driveActivation`が子PS連鎖をその場で解決してから転送へ進めるようにする —
 * これが無いと、HEAL EffectAction全体（転送を含む）を適用し終えてからまとめてyieldする
 * ことになり、`HealApplied`起点の子PSが転送後のHPを観測してしまう。消費した分だけ
 * 内部イベントの捕捉位置を前進させ、二重処理を防ぐ。
 *
 * R-SKL-01/R-SKL-02: 使用者が`HealApplied`／`HealingTransferred`起点の連鎖で戦闘不能に
 * なった場合、`applyHealActionSteps`は未解決の転送・対象を適用せず`interruptedCount`として
 * 返す。DAMAGEと同じく`INTERRUPTED`として報告し、同じEffectStepの残りの対象と後続stepを
 * 止める（`resolveActionApplications`が`walkInterrupted`へ落とす）。
 */
export const resolveHeal: SteppedEffectActionHandler<"HEAL"> = function* (input) {
  const {
    context,
    box,
    application,
    effectAction,
    startingEventId,
    distributionShareCount,
    cursor,
  } = input;
  const actor = requireActorUnit(context, box);
  const healGen = applyHealActionSteps(
    application.hits,
    actor,
    effectAction,
    box.units,
    {
      ...eventContextOf(context),
      parentEventId: startingEventId,
      // COOLDOWN_MANIPULATION/MODIFY_RESOURCE/HEALは発生源ユニットを前提とする
      // （`CooldownManipulationEventContext`等の`sourceUnitId`は必須）。
      // Memory由来の解決はR-MEM-04に従って拒否する。
      sourceUnitId: actor.battleUnitId,
      effectActions: context.definitions.effectActions,
      ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
      ...(context.onFactEventForPassiveChain !== undefined
        ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
        : {}),
    },
    distributionShareCount,
  );
  let healStep = healGen.next();
  while (!healStep.done) {
    box.units = healStep.value.units;
    yield { kind: "EFFECT_RESOLVED", events: cursor.takePending() };
    // 再開時点のrecorder末尾までは、driverがこの`yield`で既に解決した子連鎖。
    // 拾い直すと同じイベントが2度`resolveEvent`へ渡る（`consumeResolvedByDriver`）。
    cursor.consumeResolvedByDriver();
    // 子PS連鎖（あれば）が`box.units`を書き換えている可能性があるため、一時停止していた
    // generatorを再開する前に取り込む（sync-in）。
    healStep = healGen.next(box.units);
  }
  const healResult = healStep.value;
  box.units = healResult.units;
  return {
    resultKind: healResult.interrupted ? "INTERRUPTED" : healResult.changed ? "APPLIED" : "SKIPPED",
    resolvedCount: healResult.resolvedCount,
    interruptedCount: healResult.interruptedCount,
    criticalHitCount: 0,
    lastEventId: healResult.lastEventId,
  };
};
