import type { EffectDurationState } from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { MarkerStackPolicy } from "../../catalog/definitions/catalog-enums.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ApplyMarkerRequest {
  readonly markerId: MarkerId;
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  readonly policy: MarkerStackPolicy;
  readonly stackMax: number | null;
  readonly duration: EffectDurationState;
  readonly dispellable: boolean;
  readonly linkedEffectGroupId: string | null;
}

export interface ApplyMarkerResult {
  readonly markers: readonly MarkerState[];
  readonly before?: MarkerState;
  readonly after: MarkerState;
}

function clampStack(count: number, max: number | null): number {
  const nonNegative = Math.max(0, count);
  return max === null ? nonNegative : Math.min(nonNegative, max);
}

function newMarker(request: ApplyMarkerRequest): MarkerState {
  return {
    markerId: request.markerId,
    sourceId: request.sourceId,
    targetId: request.targetId,
    stackCount: clampStack(1, request.stackMax),
    stackMax: request.stackMax,
    duration: request.duration,
    dispellable: request.dispellable,
    linkedEffectGroupId: request.linkedEffectGroupId,
  };
}

/**
 * R-EFF-10: `APPLY_MARKER`の`ADD`/`KEEP_EXISTING`/`REFRESH`/`REPLACE`。
 * - `ADD`: 既存Markerのスタック数へ1加算する（`stack.max`があれば上限を超えない）。既存が無ければ新規付与する。
 * - `KEEP_EXISTING`: 既存Markerがあれば変更せず、無ければ新規付与する。
 * - `REFRESH`: 既存Markerのスタック数を維持し、Durationだけ新しい定義で再設定する。既存が無ければ新規付与する。
 * - `REPLACE`: 既存Markerを新しい定義内容（スタック数・Duration）で置き換える。既存が無ければ新規付与する。
 *
 * `markers`は対象1ユニット分のMarker一覧を渡す（`markerId`はユニット内で高々1件）。
 */
export function applyMarker(
  markers: readonly MarkerState[],
  request: ApplyMarkerRequest,
): ApplyMarkerResult {
  const existingIndex = markers.findIndex((m) => m.markerId === request.markerId);
  const existing = existingIndex === -1 ? undefined : markers[existingIndex];

  if (existing === undefined) {
    const created = newMarker(request);
    return { markers: [...markers, created], after: created };
  }

  let after: MarkerState;
  switch (request.policy) {
    case "ADD":
      after = {
        ...existing,
        stackCount: clampStack(existing.stackCount + 1, request.stackMax),
        stackMax: request.stackMax,
      };
      break;
    case "KEEP_EXISTING":
      after = existing;
      break;
    case "REFRESH":
      after = { ...existing, duration: request.duration };
      break;
    case "REPLACE":
      after = newMarker(request);
      break;
  }

  const nextMarkers = markers.map((m, index) => (index === existingIndex ? after : m));
  return { markers: nextMarkers, before: existing, after };
}

/** `RemoveMarkerPayload`: 指定Markerを保有している場合、全体を解除する（部分的な減算ではない）。 */
export function removeMarker(
  markers: readonly MarkerState[],
  markerId: MarkerId,
): { readonly markers: readonly MarkerState[]; readonly removed?: MarkerState } {
  const removed = markers.find((m) => m.markerId === markerId);
  if (removed === undefined) {
    return { markers };
  }
  return { markers: markers.filter((m) => m.markerId !== markerId), removed };
}
