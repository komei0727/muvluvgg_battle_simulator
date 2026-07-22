import type { EffectDurationState } from "./applied-effect.js";
import { buildInitialDurationState } from "./applied-effect.js";
import type { ActionId, MarkerInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
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
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  readonly stackCount: number;
  readonly stackMax: number | null;
  readonly duration: EffectDurationState;
}

/** R-EFF-10: 新規Markerインスタンスをスタック1で組み立てる（ADD/KEEP_EXISTING/REFRESH/REPLACEのいずれも、既存Markerが無い場合はこの初期状態から始まる）。 */
export function buildInitialMarkerState(
  markerInstanceId: MarkerInstanceId,
  markerId: MarkerId,
  sourceId: BattleUnitId,
  targetId: BattleUnitId,
  stackMax: number | null,
  durationDefinition: DurationDefinition,
  context: { readonly actionId?: ActionId; readonly turnNumber: number },
): MarkerState {
  return {
    markerInstanceId,
    markerId,
    sourceId,
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
