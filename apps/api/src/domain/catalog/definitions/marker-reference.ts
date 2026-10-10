import { createMarkerId, type MarkerId } from "./catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";

/**
 * マーカー所持数を問う定義（`MARKER_COUNT_SCALE`・`MARKER_COUNT` order・
 * `TARGET_HAS_MARKER`）が参照するマーカー。`markerId`か`markerIds`のどちらか一方だけを持つ。
 *
 * `markerIds`は寿命の違う同名マーカーを合算して数えるためにある。`MarkerState`は
 * markerIdごとに1インスタンス・1 Durationしか持てないため、寿命の違うスタックは
 * markerIdを分けるしかなく、所持数を問う側がそれらを合計する（R-EFF-10）。
 */
export type MarkerReference =
  | { readonly markerId: MarkerId; readonly markerIds?: undefined }
  | { readonly markerIds: readonly MarkerId[]; readonly markerId?: undefined };

/** 参照しているマーカーを宣言順に返す。単一指定なら1件だけを返す。 */
export function referencedMarkerIds(reference: MarkerReference): readonly MarkerId[] {
  return reference.markerIds ?? [reference.markerId];
}

export function createMarkerReference(
  input: { readonly markerId?: unknown; readonly markerIds?: unknown },
  path: string,
): MarkerReference {
  if (input.markerId !== undefined && input.markerIds !== undefined) {
    throw new DomainValidationError(path, 'must declare only one of "markerId" or "markerIds"');
  }
  if (input.markerIds === undefined) {
    if (typeof input.markerId !== "string") {
      throw new DomainValidationError(`${path}.markerId`, 'is required (or declare "markerIds")');
    }
    return { markerId: createMarkerId(input.markerId, `${path}.markerId`) };
  }
  if (!Array.isArray(input.markerIds) || input.markerIds.length === 0) {
    throw new DomainValidationError(`${path}.markerIds`, "must be a non-empty array");
  }
  const markerIds = input.markerIds.map((value: unknown, i) => {
    if (typeof value !== "string") {
      throw new DomainValidationError(`${path}.markerIds[${i}]`, "must be a string");
    }
    return createMarkerId(value, `${path}.markerIds[${i}]`);
  });
  // 重複は合算で二重に数えられ、宣言者の意図と黙ってずれるため拒否する。
  if (new Set(markerIds).size !== markerIds.length) {
    throw new DomainValidationError(`${path}.markerIds`, "must not contain duplicates");
  }
  return { markerIds };
}
