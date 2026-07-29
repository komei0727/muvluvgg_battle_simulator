import type { EffectDurationState } from "./applied-effect.js";
import { buildInitialDurationState } from "./applied-effect.js";
import type { ActionId, MarkerInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

/**
 * `05_ドメインモデル.md`「MarkerState」/R-EFF-10: ユニットへ付与された固有状態
 * （raw固有スタック、専用印、条件参照用状態）を汎用Markerとして表す。
 * `AppliedEffect`と異なり、同じ`markerId`を持つインスタンスは対象ごとに常に
 * 1つだけ存在する — 複数の付与元から同じMarkerが付与された場合もスタック数を
 * 1つの`MarkerState`へ積み上げる（`sourceId`は直近の付与者を表す監査用の値で、
 * インスタンス識別には使わない）。`duration`は`AppliedEffect`と同じ
 * `EffectDurationState`を再利用する（`DurationDefinition`のtimeLimit/
 * consumption/expiration/linkedEffectGroupがMarkerにもそのまま適用される、
 * R-EFF-09「同じlinkedEffectGroupIdを持つAppliedEffectとMarkerStateは親子連動
 * グループとして扱う」）。
 */
export interface MarkerState {
  readonly markerInstanceId: MarkerInstanceId;
  readonly markerId: MarkerId;
  /**
   * 直近の付与者の戦闘ユニットID。R-MEM-04（M7-008、Issue #176）: Memory の
   * `triggeredEffects` 由来の付与だけは具体的な付与者ユニットを持たないため
   * `undefined`になり、代わりに`sourceSide`（そのMemoryを指定した陣営）を持つ
   * （`AppliedEffect.sourceId`/`10_API設計.md`の`MarkerStateResponse.sourceUnitId?`も
   * 同じ理由で任意）。
   */
  readonly sourceId?: BattleUnitId;
  /** R-MEM-04: Memory由来の付与だけが持つ、付与元の陣営（source side）。 */
  readonly sourceSide?: Side;
  readonly targetId: BattleUnitId;
  readonly stackCount: number;
  readonly stackMax: number | null;
  readonly duration: EffectDurationState;
}

/**
 * `AppliedEffect`と同じく、付与元は「具体的なユニット」か「Memoryを指定した陣営」の
 * どちらか一方だけを持つ（`effect-grant-service.ts`の`GrantEffectRequest`と同型）。
 */
export interface MarkerSource {
  readonly sourceId?: BattleUnitId;
  readonly sourceSide?: Side;
}

/** R-EFF-10: 新規Markerインスタンスをスタック1で組み立てる（ADD/KEEP_EXISTING/REFRESH/REPLACEのいずれも、既存Markerが無い場合はこの初期状態から始まる）。 */
export function buildInitialMarkerState(
  markerInstanceId: MarkerInstanceId,
  markerId: MarkerId,
  source: MarkerSource,
  targetId: BattleUnitId,
  stackMax: number | null,
  durationDefinition: DurationDefinition,
  context: { readonly actionId?: ActionId; readonly turnNumber: number },
): MarkerState {
  return {
    markerInstanceId,
    markerId,
    ...(source.sourceId !== undefined ? { sourceId: source.sourceId } : {}),
    ...(source.sourceSide !== undefined ? { sourceSide: source.sourceSide } : {}),
    targetId,
    stackCount: 1,
    stackMax,
    duration: buildInitialDurationState(durationDefinition, context),
  };
}

/** R-EFF-10「スタック数は0未満にせず、stack.maxがある場合は上限を超えない」。 */
export function clampMarkerStack(stackCount: number, stackMax: number | null): number {
  const floored = Math.max(0, stackCount);
  return stackMax === null ? floored : Math.min(floored, stackMax);
}
