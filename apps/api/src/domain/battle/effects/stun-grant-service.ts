import {
  grantEffect,
  resolveDurationOnReapply,
  type GrantEffectContext,
  type GrantEffectRequest,
} from "./effect-grant-service.js";
import { buildInitialDurationState, type AppliedEffect } from "../model/applied-effect.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { DomainEventId } from "../../shared/event-ids.js";

export interface GrantStunResult {
  readonly units: readonly BattleUnit[];
  readonly appliedEffect: AppliedEffect;
  readonly lastEventId: DomainEventId;
}

/**
 * R-STS-02「再付与時は残り回数が長い方を一つだけ残す」: 対象が既に有効なSTUNの
 * `AppliedEffect`を保持している場合、`grantEffect`のように新規インスタンスを
 * 追加せず、同じインスタンスへ残り回数だけを差し替える（`MarkerApplied`の
 * REFRESH/ADD方針と同じ「既存インスタンスを更新する」形、Q-EFF-10の「常に
 * 新規インスタンスを追加する」既定を状態異常固有規則で上書きする）。新しい
 * 残り回数が既存以下の場合は何も変更せず、イベントも発行しない
 * （`MarkerApplied`のKEEP_EXISTING方針と同じ「変化が無ければ発行しない」規約）。
 * 対象が未だSTUNを持たない場合は`grantEffect`をそのまま呼び出す。
 */
export function grantStunStatus(
  context: GrantEffectContext,
  units: readonly BattleUnit[],
  request: GrantEffectRequest,
  parentEventId: DomainEventId,
): GrantStunResult {
  const target = requireUnit(units, request.targetUnitId);
  const existing = target.appliedEffects.find((effect) => effect.statusKind === "STUN");

  if (existing === undefined) {
    return grantEffect(context, units, request, parentEventId);
  }

  // R-EFF-12（M7-014、Issue #268）: `duration.reapply`を宣言した気絶
  // （`ACT_SIENA_DIVA_PS1_STUN`「対象に1行動の気絶が付与されていた場合は、2行動の
  // 気絶に上書きする」）は、既存インスタンスの残り回数に応じて初期残り回数が
  // 変わる。差し替え可否（残り回数が長い方を残す、R-STS-02）の比較も、この
  // 解決後の残り回数で行う。
  const durationDefinition = resolveDurationOnReapply(target, request);
  const newRemaining = durationDefinition.timeLimit?.count ?? 0;
  const existingRemaining = existing.duration.timeLimitRemaining ?? 0;
  if (newRemaining <= existingRemaining) {
    return { units, appliedEffect: existing, lastEventId: parentEventId };
  }

  const nextEffect: AppliedEffect = {
    ...existing,
    ...(request.sourceUnitId !== undefined ? { sourceUnitId: request.sourceUnitId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    duration: buildInitialDurationState(durationDefinition, {
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      turnNumber: context.turnNumber,
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    }),
  };
  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetUnitId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.map((effect) =>
            effect.effectInstanceId === existing.effectInstanceId ? nextEffect : effect,
          ),
        }
      : unit,
  );

  const changed = context.recorder.record({
    eventType: "StunDurationChanged",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    ...(request.sourceUnitId !== undefined ? { sourceUnitId: request.sourceUnitId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetUnitIds: [request.targetUnitId],
    payload: {
      effectInstanceId: existing.effectInstanceId,
      battleUnitId: request.targetUnitId,
      remainingBefore: existingRemaining,
      remainingAfter: newRemaining,
      reason: "REGRANT_EXTENDED",
    },
    stateDelta: {
      units: {
        [request.targetUnitId]: {
          effects: {
            [existing.effectInstanceId]: {
              before: toEffectSnapshot(existing, true),
              after: toEffectSnapshot(nextEffect, true),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, appliedEffect: nextEffect, lastEventId: changed.eventId };
}
