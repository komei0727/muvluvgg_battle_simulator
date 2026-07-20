import type { AppliedEffect } from "../model/applied-effect.js";
import { recomputeActiveEffects } from "./effect-duplicate-resolution.js";
import { isLinkedGroupParent, linkedGroupChildren } from "./linked-effect-group.js";
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
import type { BattleUnitId } from "../../shared/ids.js";

export interface ExpireEffectsContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export type EffectExpirationReason = "TIME_LIMIT" | "CONSUMPTION" | "SPECIAL_CONDITION";

export interface EffectExpirationRequest {
  readonly effectInstanceId: EffectInstanceId;
  readonly reason: EffectExpirationReason;
}

export interface ExpireEffectsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /** 記録した`EffectExpired`/`EffectiveEffectChanged`イベント（発行順）。呼び出し側がPS候補解決へ個別に通知するために使う。 */
  readonly events: readonly BattleDomainEvent[];
}

/**
 * R-EFF-04/06/07/08「残り回数が0になった時点で即時に失効させ、EffectExpiredを
 * 発行する」/ R-EFF-09「グループの親効果が失効・解除された場合、同じグループの
 * 子効果とMarkerも同時に失効させる...子効果を先に失効させ、最後に親効果を
 * 失効させる」/ R-EFF-05「採用中の最強効果が失効・解除された場合...残存効果
 * があれば次に強い1件を即時に有効化する」。
 *
 * `requests`は同一対象ユニットが保持する`AppliedEffect`の失効理由一覧。
 * 呼び出し側の失効理由ごとにlinkedEffectGroupの親であれば子を先に、最後に
 * 親自身を失効させる（`LINKED_GROUP_CASCADE`理由で子を追加する）。全削除後に
 * 一度だけ`recomputeActiveEffects`し、重複なし効果グループの採用対象が変わった
 * 場合だけ`EffectiveEffectChanged`を発行する。
 */
export function expireEffects(
  context: ExpireEffectsContext,
  units: readonly BattleUnit[],
  targetId: BattleUnitId,
  requests: readonly EffectExpirationRequest[],
  parentEventId: DomainEventId,
): ExpireEffectsResult {
  const target = requireUnit(units, targetId);
  const before = target.appliedEffects;
  const members = before.map((e) => ({
    key: e.effectInstanceId,
    linkedEffectGroupId: e.duration.definition.linkedEffectGroupId,
  }));

  const ordered: EffectExpirationRequest[] = [];
  const seen = new Set<EffectInstanceId>();
  for (const request of requests) {
    const member = members.find((m) => m.key === request.effectInstanceId);
    if (member !== undefined && isLinkedGroupParent(member, members)) {
      for (const child of linkedGroupChildren(member, members)) {
        if (!seen.has(child.key as EffectInstanceId)) {
          seen.add(child.key as EffectInstanceId);
          // 連動失効の子は`SPECIAL_CONDITION`を仮の理由として積み、実際の
          // イベント記録時に`requests`（呼び出し側が明示的に要求した失効）に
          // 含まれない=連動失効由来と判定して`LINKED_GROUP_CASCADE`へ差し替える。
          ordered.push({
            effectInstanceId: child.key as EffectInstanceId,
            reason: "SPECIAL_CONDITION",
          });
        }
      }
    }
    if (!seen.has(request.effectInstanceId)) {
      seen.add(request.effectInstanceId);
      ordered.push(request);
    }
  }

  const byId = new Map(before.map((e) => [e.effectInstanceId, e] as const));
  const kindKeysTouched = new Set(
    ordered
      .map((r) => byId.get(r.effectInstanceId))
      .filter((e): e is AppliedEffect => e !== undefined && !e.duplicate)
      .map((e) => e.kindKey),
  );
  const beforeActiveByKindKey = new Map(
    [...kindKeysTouched].map((kindKey) => [
      kindKey,
      before.find((e) => e.kindKey === kindKey && !e.duplicate && e.active)?.effectInstanceId,
    ]),
  );

  const remaining = before.filter((e) => !seen.has(e.effectInstanceId));
  const recomputed = recomputeActiveEffects(remaining);
  const nextUnits = units.map((u) =>
    u.battleUnitId === targetId ? { ...u, appliedEffects: recomputed } : u,
  );

  let lastEventId = parentEventId;
  const recordedEvents: BattleDomainEvent[] = [];
  for (const request of ordered) {
    const isCascadeChild =
      members.find((m) => m.key === request.effectInstanceId) !== undefined &&
      request.reason === "SPECIAL_CONDITION" &&
      !requests.some((r) => r.effectInstanceId === request.effectInstanceId);
    const expired = context.recorder.record({
      eventType: "EffectExpired",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      targetUnitIds: [targetId],
      payload: {
        effectInstanceId: request.effectInstanceId,
        targetUnitId: targetId,
        kindKey: byId.get(request.effectInstanceId)?.kindKey ?? "",
        reason: isCascadeChild ? "LINKED_GROUP_CASCADE" : request.reason,
      },
    });
    lastEventId = expired.eventId;
    recordedEvents.push(expired);
  }

  for (const kindKey of kindKeysTouched) {
    const beforeActive = beforeActiveByKindKey.get(kindKey);
    const afterActive = recomputed.find(
      (e) => e.kindKey === kindKey && !e.duplicate && e.active,
    )?.effectInstanceId;
    if (beforeActive === afterActive) {
      continue;
    }
    const changed = context.recorder.record({
      eventType: "EffectiveEffectChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      targetUnitIds: [targetId],
      payload: {
        targetUnitId: targetId,
        kindKey,
        ...(beforeActive !== undefined ? { beforeEffectInstanceId: beforeActive } : {}),
        ...(afterActive !== undefined ? { afterEffectInstanceId: afterActive } : {}),
      },
    });
    lastEventId = changed.eventId;
    recordedEvents.push(changed);
  }

  return { units: nextUnits, lastEventId, events: recordedEvents };
}
