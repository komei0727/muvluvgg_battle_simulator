import { removeCascadedMembers, orderCascadedOnlyMembers } from "./linked-group-cascade.js";
import { NO_EFFECT_INSTANCE_IDS, collectLinkedGroupCascade } from "../model/linked-effect-group.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toMarkerSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { MarkerRemovalReason } from "../events/domain-event.js";
import type { MarkerDurationChange } from "../model/marker-duration.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId, MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionId,
  DomainEventId,
  MarkerInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface RemoveMarkersContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * `duration-expiry-service.ts`の`emitEffectDurationReducedEvents`と同じ役割の
 * `MarkerState`版だが、`MarkerState`は専用の減算イベントを持たず`MarkerUpdated`
 * （`policy`省略）へ統合する（`domain-event.ts`の`MarkerUpdated`コメント参照）。
 */
export function emitMarkerDurationChangedEvents(
  context: RemoveMarkersContext,
  units: readonly BattleUnit[],
  changes: readonly MarkerDurationChange[],
  parentEventId: DomainEventId,
): DomainEventId {
  let lastEventId = parentEventId;
  for (const change of changes) {
    const holder = requireUnit(units, change.battleUnitId);
    const marker = holder.markerStates.find(
      (candidate) => candidate.markerInstanceId === change.markerInstanceId,
    )!;
    const updated = context.recorder.record({
      eventType: "MarkerUpdated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: change.battleUnitId,
      targetUnitIds: [change.battleUnitId],
      payload: {
        markerInstanceId: change.markerInstanceId,
        markerId: marker.markerId,
        targetUnitId: marker.targetId,
        ...(marker.sourceId !== undefined ? { sourceUnitId: marker.sourceId } : {}),
        ...(marker.sourceSide !== undefined ? { sourceSide: marker.sourceSide } : {}),
        stackBefore: marker.stackCount,
        stackAfter: marker.stackCount,
        linkedEffectGroupId: marker.duration.definition.linkedEffectGroupId,
        durationUnit: change.unit,
        remainingBefore: change.before,
        remainingAfter: change.after,
      },
      stateDelta: {
        units: {
          [change.battleUnitId]: {
            markers: {
              [change.markerInstanceId]: {
                before: {
                  ...toMarkerSnapshot(marker),
                  duration: { unit: change.unit, remaining: change.before },
                },
                after: toMarkerSnapshot(marker),
              },
            },
          },
        },
      },
    });
    lastEventId = updated.eventId;
  }
  return lastEventId;
}

/** `duration-expiry-service.ts`の`ExpirationSeedReason`と同じ役割のMarker版。 */
export type MarkerRemovalSeedReason = Exclude<
  MarkerRemovalReason,
  "LINKED_GROUP_CASCADE" | "CONSUMPTION" | "EXPIRATION_CONDITION"
>;

export interface MarkerRemovalSeed {
  readonly battleUnitId: BattleUnitId;
  readonly markerInstanceId: MarkerInstanceId;
  readonly reason: MarkerRemovalSeedReason;
}

export interface RemoveMarkersResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-EFF-10「Markerが0スタックになった場合は解除」/R-EFF-09: `seeds`（明示的な
 * `REMOVE_MARKER`、または時間制限が0になったMarker）から、同じ`linkedEffectGroupId`
 * を共有する未除去のメンバーを`collectLinkedGroupCascade`でカスケードし、
 * `MarkerRemoved`をインスタンスごとに発行してから対象を除去する。`duration-
 * expiry-service.ts`の`expireEffects`と同じ順序規約（子を先に、親を最後に）。
 *
 * M7-013（Issue #267）: カスケードはR-EFF-09第1項が規定するとおり`MarkerState`
 * 同士に閉じず、同じ`linkedEffectGroupId`を持つ`AppliedEffect`（`EffectExpired`
 * ／`reason: LINKED_GROUP_CASCADE`）も巻き込む — production Catalogの
 * `MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT`（負けん気→攻撃力バフ）・
 * `MARKER_AOI_ELEGANT_KOUYOU`（高揚→会心率デバフ／継続ダメージ）がこの向きを
 * 使う。カスケードされた`AppliedEffect`の除去はCombatStat再計算を伴うため
 * `effectActions`を要求する（`expireEffects`と同じ引数位置）。
 */
export function removeMarkers(
  context: RemoveMarkersContext,
  units: readonly BattleUnit[],
  seeds: readonly MarkerRemovalSeed[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): RemoveMarkersResult {
  if (seeds.length === 0) {
    return { units, lastEventId: parentEventId };
  }

  const seedIds = new Set(seeds.map((seed) => seed.markerInstanceId));
  const seedInstances = {
    effectInstanceIds: NO_EFFECT_INSTANCE_IDS,
    markerInstanceIds: seedIds,
  };
  const cascade = collectLinkedGroupCascade(units, seedInstances);
  const reasonById = new Map<
    MarkerInstanceId,
    { reason: MarkerRemovalReason; cascaded: boolean }
  >();
  for (const seed of seeds) {
    reasonById.set(seed.markerInstanceId, { reason: seed.reason, cascaded: false });
  }

  // R-EFF-09「子効果を先に、最後に親効果を」: cascadeだけで巻き込まれた
  // `AppliedEffect`／`MarkerState`を共有実装（`linked-group-cascade.ts`）が
  // 先に処理し、そのあとで`seeds`自身のMarkerを除去する。
  const cascadedMembers = orderCascadedOnlyMembers(units, cascade, seedInstances);
  const cascaded = removeCascadedMembers(
    context,
    units,
    cascadedMembers,
    effectActions,
    parentEventId,
    "EffectExpired",
  );

  let working = cascaded.units;
  let lastEventId = cascaded.lastEventId;

  for (const markerInstanceId of seeds.map((seed) => seed.markerInstanceId)) {
    const holder = working.find((unit) =>
      unit.markerStates.some((marker) => marker.markerInstanceId === markerInstanceId),
    );
    if (holder === undefined) {
      continue;
    }
    const target = requireUnit(working, holder.battleUnitId);
    const targetMarker = target.markerStates.find(
      (marker) => marker.markerInstanceId === markerInstanceId,
    )!;

    working = working.map((unit) =>
      unit.battleUnitId === target.battleUnitId
        ? {
            ...unit,
            markerStates: unit.markerStates.filter(
              (marker) => marker.markerInstanceId !== markerInstanceId,
            ),
          }
        : unit,
    );

    const info = reasonById.get(markerInstanceId)!;
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
      sourceUnitId: target.battleUnitId,
      targetUnitIds: [target.battleUnitId],
      payload: {
        markerInstanceId,
        markerId: targetMarker.markerId,
        targetUnitId: target.battleUnitId,
        reason: info.reason,
        linkedEffectGroupId: targetMarker.duration.definition.linkedEffectGroupId,
        cascaded: info.cascaded,
      },
      stateDelta: {
        units: {
          [target.battleUnitId]: {
            markers: {
              [markerInstanceId]: {
                before: toMarkerSnapshot(targetMarker),
                after: undefined,
              },
            },
          },
        },
      },
    });
    lastEventId = removed.eventId;
  }

  return { units: working, lastEventId };
}

export interface ReduceMarkerStackResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /** スタック解除・除去のいずれかが実際に発生した場合`true`（対象Marker不所持なら`false`）。 */
  readonly changed: boolean;
}

/**
 * M7-001（Issue #181、`REMOVE_EFFECTS_COUNT_LIMIT`）: `REMOVE_MARKER`の`count`指定に
 * よる部分解除。対象が`markerId`のMarkerを`count`スタック分だけ失う。残スタックが
 * 0以下になる場合は`removeMarkers`でインスタンスごと除去し（`MarkerRemoved`、
 * reason `REMOVED`、R-EFF-09カスケードを含む）、正の残スタックが残る場合は
 * `MarkerUpdated`（policyを持たないスタック減算、`domain-event.ts`の`MarkerUpdated`
 * コメントの統合方針に従う）を発行する。対象Markerを所持しない場合はno-op。
 */
export function reduceMarkerStack(
  context: RemoveMarkersContext,
  units: readonly BattleUnit[],
  targetId: BattleUnitId,
  markerId: MarkerId,
  count: number,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): ReduceMarkerStackResult {
  const target = requireUnit(units, targetId);
  const existing = target.markerStates.find((marker) => marker.markerId === markerId);
  if (existing === undefined) {
    return { units, lastEventId: parentEventId, changed: false };
  }

  const stackAfter = existing.stackCount - count;
  if (stackAfter <= 0) {
    const result = removeMarkers(
      context,
      units,
      [{ battleUnitId: targetId, markerInstanceId: existing.markerInstanceId, reason: "REMOVED" }],
      effectActions,
      parentEventId,
    );
    return { units: result.units, lastEventId: result.lastEventId, changed: true };
  }

  const nextMarker = { ...existing, stackCount: stackAfter };
  const nextUnits = units.map((unit) =>
    unit.battleUnitId === targetId
      ? {
          ...unit,
          markerStates: unit.markerStates.map((marker) =>
            marker.markerInstanceId === existing.markerInstanceId ? nextMarker : marker,
          ),
        }
      : unit,
  );
  const updated = context.recorder.record({
    eventType: "MarkerUpdated",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: targetId,
    targetUnitIds: [targetId],
    payload: {
      markerInstanceId: existing.markerInstanceId,
      markerId: existing.markerId,
      targetUnitId: targetId,
      ...(existing.sourceId !== undefined ? { sourceUnitId: existing.sourceId } : {}),
      ...(existing.sourceSide !== undefined ? { sourceSide: existing.sourceSide } : {}),
      stackBefore: existing.stackCount,
      stackAfter,
      linkedEffectGroupId: existing.duration.definition.linkedEffectGroupId,
    },
    stateDelta: {
      units: {
        [targetId]: {
          markers: {
            [existing.markerInstanceId]: {
              before: toMarkerSnapshot(existing),
              after: toMarkerSnapshot(nextMarker),
            },
          },
        },
      },
    },
  });
  return { units: nextUnits, lastEventId: updated.eventId, changed: true };
}
