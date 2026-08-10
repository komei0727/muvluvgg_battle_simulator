import { applyMarker } from "../../effects/marker-apply-service.js";
import {
  reduceMarkerStackSteps,
  removeMarkersSteps,
} from "../../effects/marker-removal-service.js";
import { requireUnit } from "../action-resolution-shared.js";
import {
  completeGrant,
  driveRemovalSteps,
  rejectIfImmune,
  settledOutcome,
  type EffectActionHandler,
  type EffectActionOutcome,
  type SteppedEffectActionHandler,
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
 * この規約は**評価経路を問わない**ため、除去はどちらの経路でもステップ単位のgeneratorで
 * 駆動する — callbackがあればそのステップのイベントをその場で通知し、無ければ
 * （PS自身のEffectSequence解決）`EFFECT_RESOLVED`としてyieldしてdriverへ委ねる。
 * まとめて除去してからイベント列を渡すと、経路によって同じ除去でPSが発動したり
 * しなかったりする差が生まれる。
 */
export const resolveRemoveMarker: SteppedEffectActionHandler<"REMOVE_MARKER"> = function* (input) {
  const { context, box, application, effectAction, startingEventId, cursor } = input;
  const removalContext = eventContextOf(context);
  // 除去より前に記録済みのイベントは状態を書き換える前に通知しておく — 除去内部の
  // 通知より後にすると、発行順と連鎖解決順が食い違う。
  cursor.notifyPending();

  // 所持判定は先行イベントのPS連鎖を反映した`box.units`から取る — 上の通知で対象の
  // Markerが既に解除されていた場合、この解除はno-op（SKIPPED）になる。
  const target = requireUnit(box.units, application.targetUnitId);
  const existingMarker = target.markerStates.find(
    (marker) => marker.markerId === effectAction.payload.markerId,
  );
  if (existingMarker === undefined) {
    return settledOutcome(input, startingEventId, "SKIPPED");
  }

  // M7-001（`REMOVE_EFFECTS_COUNT_LIMIT`）: `count`があれば指定スタック数だけ部分解除。
  const removalGen =
    effectAction.payload.count !== undefined
      ? reduceMarkerStackSteps(
          removalContext,
          box.units,
          application.targetUnitId,
          effectAction.payload.markerId,
          effectAction.payload.count,
          context.definitions.effectActions,
          startingEventId,
        )
      : removeMarkersSteps(
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
  const removal = yield* driveRemovalSteps(input, removalGen);
  cursor.notifyPending();
  return settledOutcome(
    input,
    removal.lastEventId,
    "changed" in removal && !removal.changed ? "SKIPPED" : "APPLIED",
  );
};
