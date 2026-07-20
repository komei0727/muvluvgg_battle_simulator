import { recomputeActiveEffects } from "./effect-duplicate-resolution.js";
import {
  isLinkedGroupParent,
  linkedGroupChildren,
  type LinkedGroupMember,
} from "./linked-effect-group.js";
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
  /**
   * PR #155再レビュー[P2]: `EffectExpired`/`MarkerRemoved`/`EffectiveEffectChanged`を
   * 記録するたびに直ちに呼び出し、PS/Memory候補解決を挟む（仕様「各イベントに
   * 対応する候補を直ちに解決する」）。戻り値の`units`をそのまま次の除去・昇格
   * 判定へ使うため、この関数呼び出し中に発生したPS等の反応（同じグループの
   * 別インスタンスの追加除去など）を後続処理が正しく踏まえられる。未指定なら
   * PS解決を行わず（渡されたunitsをそのまま返す）、従来と同じ挙動になる。
   */
  readonly notify?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
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
 * PR #155再レビュー[P2]: 「除去対象の決定」（cascade展開、`ordered`）は呼び出し
 * 時点のスナップショットで一度だけ行うが、「実際の除去・イベント発行・昇格判定」は
 * `ordered`を1件ずつ処理し、`context.notify`（未指定なら無反応）を都度挟む。
 * 各`EffectExpired`/`MarkerRemoved`直後にその対象の重複なしkindKeyグループの
 * 昇格判定を`context.notify`が返した最新状態から行うため、PS等の割り込みが
 * 同じバッチ内の後続対象（同じ/別のkindKeyグループの追加除去・付与など）へ
 * 正しく反映される。`notify`が対象を独自に除去済みにした場合は、その対象の
 * 除去処理・重複イベント発行をスキップする（同じ状態変更を複数イベントの
 * `stateDelta`へ重複して記録しないという既存の不変条件を維持する）。
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
  const notify = context.notify ?? ((_event, currentUnits) => currentUnits);

  let currentUnits = units;
  let lastEventId = parentEventId;
  const recordedEvents: BattleDomainEvent[] = [];

  for (const request of ordered) {
    const isCascadeChild = !explicitKeys.has(keyForRequest(request));
    const currentTarget = requireUnit(currentUnits, targetId);

    if (request.kind === "EFFECT") {
      const removedEffect = currentTarget.appliedEffects.find(
        (e) => e.effectInstanceId === request.effectInstanceId,
      );
      if (removedEffect === undefined) {
        // 既に`notify`（PS反応等）が独立に除去済み。重複してEffectExpiredを発行しない。
        continue;
      }
      const reason: "TIME_LIMIT" | "CONSUMPTION" | "SPECIAL_CONDITION" | "LINKED_GROUP_CASCADE" =
        isCascadeChild ? "LINKED_GROUP_CASCADE" : request.reason;
      const kindKey = effectById.get(request.effectInstanceId)?.kindKey ?? "";
      const wasNonDuplicateActive = !removedEffect.duplicate && removedEffect.active;
      const beforeActive = wasNonDuplicateActive
        ? currentTarget.appliedEffects.find(
            (e) => e.kindKey === kindKey && !e.duplicate && e.active,
          )?.effectInstanceId
        : undefined;

      const recomputedEffects = recomputeActiveEffects(
        currentTarget.appliedEffects.filter((e) => e.effectInstanceId !== request.effectInstanceId),
      );
      currentUnits = currentUnits.map((u) =>
        u.battleUnitId === targetId ? { ...u, appliedEffects: recomputedEffects } : u,
      );

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
          kindKey,
          reason,
        },
        // PR #155再レビュー[P1]（Finding A）: 除去された`AppliedEffect`の
        // `effects`変化を`EffectExpired`自身が所有する。
        stateDelta: {
          units: {
            [targetId]: {
              effects: {
                [request.effectInstanceId]: {
                  before: toEffectSnapshot(removedEffect),
                  after: undefined,
                },
              },
            },
          },
        },
      });
      lastEventId = expired.eventId;
      recordedEvents.push(expired);
      currentUnits = notify(expired, currentUnits);

      if (wasNonDuplicateActive) {
        const afterTarget = requireUnit(currentUnits, targetId);
        const afterActiveEffect = afterTarget.appliedEffects.find(
          (e) => e.kindKey === kindKey && !e.duplicate && e.active,
        );
        const afterActive = afterActiveEffect?.effectInstanceId;
        if (beforeActive !== afterActive) {
          // PR #155再レビュー[P1]（Finding A）: `beforeActive`（=`removedEffect`）
          // 自身の`effects`変化は`EffectExpired`が既に所有しているため、ここでは
          // 「新たに採用された次点インスタンス」の`active`切替だけを持つ
          // （新たな採用が無い場合は追加で報告する対象が無いため`stateDelta`
          // 自体を持たない）。
          const promotedBefore =
            afterActive !== undefined
              ? currentTarget.appliedEffects.find((e) => e.effectInstanceId === afterActive)
              : undefined;
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
            ...(afterActive !== undefined &&
            promotedBefore !== undefined &&
            afterActiveEffect !== undefined
              ? {
                  stateDelta: {
                    units: {
                      [targetId]: {
                        effects: {
                          [afterActive]: {
                            before: toEffectSnapshot(promotedBefore),
                            after: toEffectSnapshot(afterActiveEffect),
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
          currentUnits = notify(changed, currentUnits);
        }
      }
    } else {
      const stillPresent = currentTarget.markers.some((m) => m.markerId === request.markerId);
      if (!stillPresent) {
        // 既に`notify`（PS反応等）が独立に除去済み。重複してMarkerRemovedを発行しない。
        continue;
      }
      const reason:
        | "TIME_LIMIT"
        | "CONSUMPTION"
        | "SPECIAL_CONDITION"
        | "EXPLICIT_REMOVE"
        | "LINKED_GROUP_CASCADE" = isCascadeChild ? "LINKED_GROUP_CASCADE" : request.reason;

      const remainingMarkers = currentTarget.markers.filter((m) => m.markerId !== request.markerId);
      currentUnits = currentUnits.map((u) =>
        u.battleUnitId === targetId ? { ...u, markers: remainingMarkers } : u,
      );

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
      currentUnits = notify(removed, currentUnits);
    }
  }

  return { units: currentUnits, lastEventId, events: recordedEvents };
}
