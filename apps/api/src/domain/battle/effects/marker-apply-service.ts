import { buildInitialDurationState } from "../model/applied-effect.js";
import {
  buildInitialMarkerState,
  clampMarkerStack,
  markerAnchorOf,
  markerSourceFields,
  type MarkerSource,
  type MarkerState,
} from "../model/marker-state.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { findLinkedGroupAnchor } from "../model/linked-effect-group.js";
import { toMarkerSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { MarkerStackPolicy } from "../../catalog/definitions/catalog-enums.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { MarkerStackDecayDefinition } from "../../catalog/definitions/effect-action-payload.js";

export interface ApplyMarkerContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** R-EFF-09: EffectSequence内の直近の親付与結果（`EffectActionGroupContext`と同じ）。 */
  readonly linkedGroupGrants?: ReadonlyMap<string, string | null>;
}

/**
 * 付与元（`sourceUnitId` / `sourceSide`）は{@link MarkerSource}のexactly-one union で
 * 受け取る。R-MEM-04（M7-008、Issue #176）: Memory の `triggeredEffects` 由来の
 * 付与だけが具体的な付与者ユニットを持たず`sourceSide`（そのMemoryを指定した陣営）
 * を渡す。両方欠落・両方指定はコンパイル時に弾かれる。
 */
export type ApplyMarkerRequest = MarkerSource & {
  readonly markerId: MarkerId;
  readonly targetUnitId: BattleUnitId;
  readonly stackPolicy: MarkerStackPolicy;
  readonly stackMax: number | null;
  readonly durationDefinition: DurationDefinition;
  /** `MARKER_STACK_DECAY_OVER_TIME`（Issue #674）: 省略時はこの付与が逓減対象を増やさない。 */
  readonly decay?: MarkerStackDecayDefinition;
};

export interface ApplyMarkerResult {
  readonly units: readonly BattleUnit[];
  readonly markerState: MarkerState;
  readonly lastEventId: DomainEventId;
}

/**
 * `08_ドメインイベント.md`「Memoryイベントは`sourceUnitId`を持たず、`sourceSide`を
 * 持つ」: envelope・payloadの付与元も`MarkerState`と同じく片方だけを持つ。
 */
function sourceEnvelopeOf(
  request: ApplyMarkerRequest,
): { readonly sourceUnitId: BattleUnitId } | { readonly sourceSide: Side } {
  return request.sourceUnitId !== undefined
    ? { sourceUnitId: request.sourceUnitId }
    : { sourceSide: request.sourceSide };
}

function actionTurnDurationOf(
  marker: MarkerState,
): { readonly unit: "ACTION" | "TURN"; readonly remaining: number } | undefined {
  const timeLimit = marker.duration.definition.timeLimit;
  return (timeLimit?.unit === "ACTION" || timeLimit?.unit === "TURN") &&
    marker.duration.timeLimitRemaining !== undefined
    ? { unit: timeLimit.unit, remaining: marker.duration.timeLimitRemaining }
    : undefined;
}

/**
 * R-EFF-10: `APPLY_MARKER`のADD/KEEP_EXISTING/REFRESH/REPLACEを対象1件・
 * Marker1件単位で適用する。同じ`markerId`でも付与ごとに別の`MarkerState`を持ち、
 * 付与元・期限・連動グループの付与キーを付与分ごとに保持する。
 * - 既存Markerが無い場合: いずれの方針でもスタック1の新規インスタンスを作り
 *   `MarkerApplied`を発行する。
 * - `ADD`: 既存の付与分には触れず、新しい付与分を1インスタンス追加する。
 *   `stack.max`は同じ`markerId`の付与分の合計で判定し、到達済みなら付与分を作らず
 *   イベントも発行しない。
 * - `KEEP_EXISTING`: 何も変更せず、イベントも発行しない（`CombatStatChanged`と
 *   同じ「変化が無ければ発行しない」規約）。
 * - `REFRESH`: スタック数を維持し、Durationだけ新しい定義から再構築する。
 * - `REPLACE`: スタック数を1へ、Duration・stackMaxを新しい定義で丸ごと置き換える。
 * REFRESH/REPLACEは同じ`markerId`へADDと混在させない（`catalog-integrity.ts`の
 * `MIXED_MARKER_STACK_POLICY`）ため付与分は高々1つで、その1つを更新する。
 */
export function applyMarker(
  context: ApplyMarkerContext,
  units: readonly BattleUnit[],
  request: ApplyMarkerRequest,
  parentEventId: DomainEventId,
): ApplyMarkerResult {
  const target = requireUnit(units, request.targetUnitId);
  const sameMarker = target.markerStates.filter((marker) => marker.markerId === request.markerId);
  const existing = sameMarker.at(-1);
  if (existing !== undefined && request.stackPolicy === "ADD") {
    const heldTotal = sameMarker.reduce((total, marker) => total + marker.stackCount, 0);
    if (request.stackMax !== null && heldTotal >= request.stackMax) {
      return { units, markerState: existing, lastEventId: parentEventId };
    }
  }
  const grantContext = {
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    turnNumber: context.turnNumber,
    linkedGroupGrantOrder: context.recorder.getEvents().length,
  };

  if (existing === undefined || request.stackPolicy === "ADD") {
    // R-EFF-09: `SKILL_USE`範囲の子Markerは、紐づく親の付与分の識別子を持つ。
    const childAnchor = findLinkedGroupAnchor(
      target,
      request.durationDefinition,
      context.skillUseId,
      context.linkedGroupGrants,
    );
    const markerState = buildInitialMarkerState(
      context.recorder.nextMarkerInstanceId(),
      request.markerId,
      request,
      request.targetUnitId,
      request.stackMax,
      request.durationDefinition,
      { ...grantContext, ...(childAnchor !== undefined ? { linkedGroupAnchor: childAnchor } : {}) },
      request.decay,
    );
    const nextUnits = units.map((unit) =>
      unit.battleUnitId === request.targetUnitId
        ? { ...unit, markerStates: [...unit.markerStates, markerState] }
        : unit,
    );
    const timeLimit = request.durationDefinition.timeLimit;
    const applied = context.recorder.record({
      eventType: "MarkerApplied",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId,
      rootEventId: context.rootEventId,
      ...sourceEnvelopeOf(request),
      targetUnitIds: [request.targetUnitId],
      payload: {
        markerInstanceId: markerState.markerInstanceId,
        markerId: request.markerId,
        ...sourceEnvelopeOf(request),
        targetUnitId: request.targetUnitId,
        stackCount: markerState.stackCount,
        stackMax: markerState.stackMax,
        linkedEffectGroupId: request.durationDefinition.linkedEffectGroupId,
        ...(timeLimit !== undefined
          ? { durationUnit: timeLimit.unit, initialRemaining: timeLimit.count }
          : {}),
        ...(markerState.duration.timeLimitRemaining !== undefined
          ? { remainingCount: markerState.duration.timeLimitRemaining }
          : {}),
        ...(timeLimit?.owner !== undefined ? { durationOwner: timeLimit.owner } : {}),
        ...(request.durationDefinition.consumption !== undefined
          ? {
              consumptionKind: request.durationDefinition.consumption.kind,
              consumptionMaxCount: request.durationDefinition.consumption.maxCount,
            }
          : {}),
        ...(markerState.duration.consumptionRemaining !== undefined
          ? { consumptionRemaining: markerState.duration.consumptionRemaining }
          : {}),
        ...(request.durationDefinition.expiration !== undefined
          ? { expirationConditions: request.durationDefinition.expiration.conditions }
          : {}),
      },
      stateDelta: {
        units: {
          [request.targetUnitId]: {
            markers: {
              [markerState.markerInstanceId]: {
                before: undefined,
                after: toMarkerSnapshot(markerState),
              },
            },
          },
        },
      },
    });
    return { units: nextUnits, markerState, lastEventId: applied.eventId };
  }

  if (request.stackPolicy === "KEEP_EXISTING") {
    return { units, markerState: existing, lastEventId: parentEventId };
  }

  const stackBefore = existing.stackCount;
  const durationBefore = actionTurnDurationOf(existing);

  // 付与者は片方だけを持つため、REFRESH/REPLACEで作り直す付与分の`sourceUnitId`/
  // `sourceSide`は上書きではなく両方を落としてから入れ替える。
  const {
    sourceUnitId: _previousSourceId,
    sourceSide: _previousSourceSide,
    ...withoutSource
  } = existing;
  const carried = { ...withoutSource, ...markerSourceFields(request) };
  // REPLACEは`decay`宣言も新しい付与の内容へ丸ごと置き換える。`carried`経由の古い
  // 宣言を残さないよう、undefinedプロパティも明示的に落とす
  // （exactOptionalPropertyTypesのため`{ decay: undefined }`は代入できない）。
  const { decay: _previousDecay, ...carriedWithoutDecay } = carried;

  let nextMarker: MarkerState;
  if (request.stackPolicy === "REFRESH") {
    nextMarker = {
      ...carried,
      duration: buildInitialDurationState(request.durationDefinition, {
        ...grantContext,
        ...markerAnchorOf(request.durationDefinition, existing.markerInstanceId),
      }),
    };
  } else {
    // REPLACE: 既存Markerを新しい定義内容で丸ごと置き換える（逓減対象数・宣言も
    // 新しい付与の内容へリセットする）。
    nextMarker = {
      ...carriedWithoutDecay,
      stackCount: clampMarkerStack(1, request.stackMax),
      stackMax: request.stackMax,
      duration: buildInitialDurationState(request.durationDefinition, {
        ...grantContext,
        ...markerAnchorOf(request.durationDefinition, existing.markerInstanceId),
      }),
      decayingStackCount: request.decay !== undefined ? 1 : 0,
      ...(request.decay !== undefined ? { decay: request.decay } : {}),
    };
  }

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetUnitId
      ? {
          ...unit,
          markerStates: unit.markerStates.map((marker) =>
            marker.markerInstanceId === existing.markerInstanceId ? nextMarker : marker,
          ),
        }
      : unit,
  );

  const durationAfter = actionTurnDurationOf(nextMarker);
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
    ...sourceEnvelopeOf(request),
    targetUnitIds: [request.targetUnitId],
    payload: {
      markerInstanceId: nextMarker.markerInstanceId,
      markerId: request.markerId,
      targetUnitId: request.targetUnitId,
      ...sourceEnvelopeOf(request),
      policy: request.stackPolicy,
      stackBefore,
      stackAfter: nextMarker.stackCount,
      linkedEffectGroupId: nextMarker.duration.definition.linkedEffectGroupId,
      ...(durationAfter !== undefined ? { durationUnit: durationAfter.unit } : {}),
      ...(durationBefore !== undefined ? { remainingBefore: durationBefore.remaining } : {}),
      ...(durationAfter !== undefined ? { remainingAfter: durationAfter.remaining } : {}),
    },
    stateDelta: {
      units: {
        [request.targetUnitId]: {
          markers: {
            [nextMarker.markerInstanceId]: {
              before: toMarkerSnapshot(existing),
              after: toMarkerSnapshot(nextMarker),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, markerState: nextMarker, lastEventId: updated.eventId };
}
