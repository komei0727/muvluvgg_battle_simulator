import { applyMarker } from "../../effects/marker-apply-service.js";
import { removeMarkers, reduceMarkerStack } from "../../effects/marker-removal-service.js";
import { requireUnit } from "../action-resolution-shared.js";
import type { EffectActionResultKind } from "../../events/domain-event.js";
import type { DomainEventId } from "../../../shared/event-ids.js";
import {
  completeGrant,
  rejectIfImmune,
  settledOutcome,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf, requireMarkerSource } from "./effect-action-group-context.js";

/**
 * R-EFF-10: ADD/KEEP_EXISTING/REFRESH/REPLACEのスタック方針を対象1件・Marker1件単位で
 * 適用する（`marker-apply-service.ts`）。`APPLY_MARKER`は`APPLY_STAT_MOD`と異なり
 * Formulaを持たない — スタック量は常に1（ADDは既存スタックへの+1、REPLACE/新規付与は
 * 常にスタック1から始まる）。
 */
export const resolveApplyMarker: EffectActionHandler<"APPLY_MARKER"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const rejected = rejectIfImmune(input, 0);
  if (rejected !== undefined) {
    return rejected;
  }
  return completeGrant(
    input,
    applyMarker(
      eventContextOf(context),
      box.units,
      {
        markerId: effectAction.payload.markerId,
        // R-MEM-04（M7-008）: Memory由来の`APPLY_MARKER`は付与者ユニットを持たないため、
        // `AppliedEffect`と同じく`sourceSide`（そのMemoryを指定した陣営）を渡す。
        ...requireMarkerSource(context),
        targetUnitId: application.targetUnitId,
        stackPolicy: effectAction.payload.stack.policy,
        stackMax: effectAction.payload.stack.max,
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};

/**
 * R-EFF-10「Marker の解除は既存の REMOVE_MARKER（markerId 指定）を使う」
 * （`14_Catalog定義スキーマ.md`）: 対象が指定Markerを所持していない場合はno-op
 * （`COOLDOWN_MANIPULATION`のREADY skillと同じ扱い、resultKind: SKIPPED）。
 *
 * R-EFF-09のカスケードは1インスタンスの除去ごとにPS/Memory連鎖へ通知する必要がある
 * （子の`EffectExpired`をtriggerにするPSが親Markerを既に除去済みとして観測しないように）。
 * `removeMarkers`/`reduceMarkerStack`へcallbackを渡し、そこで通知済みになった分は
 * 一括捕捉から除く（`applyDamageActionSteps`の凍結カスケードと同じ二重処理防止）。
 * callback未指定（PS自身のEffectSequence解決）の経路では従来どおり`innerEvents`が
 * driverへ一括で渡す。
 */
export const resolveRemoveMarker: EffectActionHandler<"REMOVE_MARKER"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId, cursor } = input;
  const removalContext = {
    ...eventContextOf(context),
    ...(context.onFactEventForPassiveChain !== undefined
      ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
      : {}),
  };
  // callbackを渡す場合、除去より前に記録済みのイベントは状態を書き換える前に通知して
  // おく — 除去内部の通知より後にすると、発行順と連鎖解決順が食い違う。
  cursor.notifyPending();

  // 所持判定は先行イベントのPS連鎖を反映した`box.units`から取る — 上の通知で対象の
  // Markerが既に解除されていた場合、この解除はno-op（SKIPPED）になる。
  const target = requireUnit(box.units, application.targetUnitId);
  const existingMarker = target.markerStates.find(
    (marker) => marker.markerId === effectAction.payload.markerId,
  );

  let lastEventId: DomainEventId;
  let resultKind: EffectActionResultKind;
  if (existingMarker === undefined) {
    lastEventId = startingEventId;
    resultKind = "SKIPPED";
  } else if (effectAction.payload.count !== undefined) {
    // M7-001（`REMOVE_EFFECTS_COUNT_LIMIT`）: 指定スタック数だけ部分解除。
    const reduction = reduceMarkerStack(
      removalContext,
      box.units,
      application.targetUnitId,
      effectAction.payload.markerId,
      effectAction.payload.count,
      context.definitions.effectActions,
      startingEventId,
    );
    box.units = reduction.units;
    lastEventId = reduction.lastEventId;
    resultKind = reduction.changed ? "APPLIED" : "SKIPPED";
    cursor.consumeNotifiedByCallee();
  } else {
    const removalResult = removeMarkers(
      removalContext,
      box.units,
      [
        {
          battleUnitId: application.targetUnitId,
          markerInstanceId: existingMarker.markerInstanceId,
          reason: "REMOVED",
        },
      ],
      context.definitions.effectActions,
      startingEventId,
    );
    box.units = removalResult.units;
    lastEventId = removalResult.lastEventId;
    resultKind = "APPLIED";
    cursor.consumeNotifiedByCallee();
  }
  cursor.notifyPending();
  return settledOutcome(input, lastEventId, resultKind);
};
