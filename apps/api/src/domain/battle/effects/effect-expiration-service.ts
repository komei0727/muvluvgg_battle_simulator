import type { AppliedEffect } from "../model/applied-effect.js";
import { recomputeActiveEffects } from "./effect-duplicate-resolution.js";
import {
  isLinkedGroupParent,
  linkedGroupChildren,
  type LinkedGroupMember,
} from "./linked-effect-group.js";
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
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";

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
export type MarkerExpirationReason =
  | "TIME_LIMIT"
  | "CONSUMPTION"
  | "SPECIAL_CONDITION"
  | "EXPLICIT_REMOVE";

export interface EffectExpirationRequest {
  readonly kind: "EFFECT";
  readonly effectInstanceId: EffectInstanceId;
  readonly reason: EffectExpirationReason;
}

export interface MarkerExpirationRequest {
  readonly kind: "MARKER";
  readonly markerId: MarkerId;
  readonly reason: MarkerExpirationReason;
}

export type ExpirationRequest = EffectExpirationRequest | MarkerExpirationRequest;

export interface ExpireEffectsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /** 記録した`EffectExpired`/`MarkerRemoved`/`EffectiveEffectChanged`イベント（発行順）。呼び出し側がPS候補解決へ個別に通知するために使う。 */
  readonly events: readonly BattleDomainEvent[];
}

const EFFECT_KEY_PREFIX = "effect:";
const MARKER_KEY_PREFIX = "marker:";

function keyForRequest(request: ExpirationRequest): string {
  return request.kind === "EFFECT"
    ? `${EFFECT_KEY_PREFIX}${request.effectInstanceId}`
    : `${MARKER_KEY_PREFIX}${request.markerId}`;
}

function requestForCascadeChild(member: LinkedGroupMember): ExpirationRequest {
  if (member.key.startsWith(EFFECT_KEY_PREFIX)) {
    return {
      kind: "EFFECT",
      effectInstanceId: member.key.slice(EFFECT_KEY_PREFIX.length) as EffectInstanceId,
      reason: "SPECIAL_CONDITION",
    };
  }
  return {
    kind: "MARKER",
    markerId: member.key.slice(MARKER_KEY_PREFIX.length) as MarkerId,
    reason: "SPECIAL_CONDITION",
  };
}

/**
 * R-EFF-04/06/07/08「残り回数が0になった時点で即時に失効させ、EffectExpired/
 * MarkerRemovedを発行する」/ R-EFF-09「グループの親効果が失効・解除された場合、
 * 同じグループの子効果とMarkerも同時に失効させる...子効果を先に失効させ、
 * 最後に親効果を失効させる」/ R-EFF-05「採用中の最強効果が失効・解除された
 * 場合...残存効果があれば次に強い1件を即時に有効化する」。
 *
 * `AppliedEffect`と`MarkerState`は共に`linkedEffectGroupId`を持ちうる
 * （PR #155レビュー[P1]: 以前は`AppliedEffect`だけを対象にしており、同じ
 * グループのMarkerが親効果の失効時に残存していた）。`requests`は同一対象
 * ユニットが保持するEFFECT/MARKER混在の失効理由一覧。グループの親であれば
 * EFFECT/MARKERを問わず子を先に、最後に親自身を失効させる
 * （`LINKED_GROUP_CASCADE`理由で子を追加する）。グループ内の「最初に付与
 * されたもの=親」判定は`appliedEffects`配列要素を`markers`配列要素より先とみなす
 * （両コレクション間の真の付与順序を追跡するタイムスタンプを持たないための
 * 決定的な単純化、`linked-effect-group.ts`参照）。
 *
 * EFFECT側の全削除後に一度だけ`recomputeActiveEffects`し、重複なし効果
 * グループの採用対象が変わった場合だけ`EffectiveEffectChanged`を発行する
 * （MarkerはR-EFF-05の対象外）。
 */
export function expireEffects(
  context: ExpireEffectsContext,
  units: readonly BattleUnit[],
  targetId: BattleUnitId,
  requests: readonly ExpirationRequest[],
  parentEventId: DomainEventId,
): ExpireEffectsResult {
  const target = requireUnit(units, targetId);
  const beforeEffects = target.appliedEffects;
  const beforeMarkers = target.markers;

  const members: LinkedGroupMember[] = [
    ...beforeEffects.map((e) => ({
      key: `${EFFECT_KEY_PREFIX}${e.effectInstanceId}`,
      linkedEffectGroupId: e.duration.definition.linkedEffectGroupId,
    })),
    ...beforeMarkers.map((m) => ({
      key: `${MARKER_KEY_PREFIX}${m.markerId}`,
      linkedEffectGroupId: m.linkedEffectGroupId,
    })),
  ];

  const ordered: ExpirationRequest[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const key = keyForRequest(request);
    const member = members.find((m) => m.key === key);
    if (member !== undefined && isLinkedGroupParent(member, members)) {
      for (const child of linkedGroupChildren(member, members)) {
        if (!seen.has(child.key)) {
          seen.add(child.key);
          ordered.push(requestForCascadeChild(child));
        }
      }
    }
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(request);
    }
  }

  const effectById = new Map(beforeEffects.map((e) => [e.effectInstanceId, e] as const));
  const explicitKeys = new Set(requests.map((r) => keyForRequest(r)));

  const kindKeysTouched = new Set(
    ordered
      .filter((r): r is EffectExpirationRequest => r.kind === "EFFECT")
      .map((r) => effectById.get(r.effectInstanceId))
      .filter((e): e is AppliedEffect => e !== undefined && !e.duplicate)
      .map((e) => e.kindKey),
  );
  const beforeActiveByKindKey = new Map(
    [...kindKeysTouched].map((kindKey) => [
      kindKey,
      beforeEffects.find((e) => e.kindKey === kindKey && !e.duplicate && e.active)
        ?.effectInstanceId,
    ]),
  );

  const seenEffectIds = new Set(
    ordered
      .filter((r): r is EffectExpirationRequest => r.kind === "EFFECT")
      .map((r) => r.effectInstanceId),
  );
  const seenMarkerIds = new Set(
    ordered.filter((r): r is MarkerExpirationRequest => r.kind === "MARKER").map((r) => r.markerId),
  );
  const remainingEffects = beforeEffects.filter((e) => !seenEffectIds.has(e.effectInstanceId));
  const remainingMarkers = beforeMarkers.filter((m) => !seenMarkerIds.has(m.markerId));
  const recomputed = recomputeActiveEffects(remainingEffects);
  const nextUnits = units.map((u) =>
    u.battleUnitId === targetId
      ? { ...u, appliedEffects: recomputed, markers: remainingMarkers }
      : u,
  );

  let lastEventId = parentEventId;
  const recordedEvents: BattleDomainEvent[] = [];
  for (const request of ordered) {
    const isCascadeChild = !explicitKeys.has(keyForRequest(request));
    if (request.kind === "EFFECT") {
      const reason: "TIME_LIMIT" | "CONSUMPTION" | "SPECIAL_CONDITION" | "LINKED_GROUP_CASCADE" =
        isCascadeChild ? "LINKED_GROUP_CASCADE" : request.reason;
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
          kindKey: effectById.get(request.effectInstanceId)?.kindKey ?? "",
          reason,
        },
      });
      lastEventId = expired.eventId;
      recordedEvents.push(expired);
    } else {
      const reason:
        | "TIME_LIMIT"
        | "CONSUMPTION"
        | "SPECIAL_CONDITION"
        | "EXPLICIT_REMOVE"
        | "LINKED_GROUP_CASCADE" = isCascadeChild ? "LINKED_GROUP_CASCADE" : request.reason;
      const removed = context.recorder.record({
        eventType: "MarkerRemoved",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        targetUnitIds: [targetId],
        payload: { markerId: request.markerId, targetUnitId: targetId, reason },
      });
      lastEventId = removed.eventId;
      recordedEvents.push(removed);
    }
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
