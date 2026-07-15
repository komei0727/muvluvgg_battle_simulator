// Mirrors docs/ddd/10_API設計.md「BattleStateDeltaResponse」/「ValueChange」/
// 「EntityCollectionDelta」. Walks an arbitrary, possibly-future-extended delta
// object generically instead of hardcoding every field name, so an unknown
// nested shape degrades to nothing rendered rather than crashing
// (01_UI要求・画面設計.md §11 未知event／effect kindでもクラッシュしない).

export interface DeltaLine {
  readonly path: string;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValueChange(
  value: Record<string, unknown>,
): value is { before: unknown; after: unknown } {
  return Object.keys(value).length === 2 && "before" in value && "after" in value;
}

function isEntityCollectionDelta(
  value: Record<string, unknown>,
): value is { added: unknown[]; updated: unknown[]; removed: unknown[] } {
  return (
    Array.isArray(value["added"]) &&
    Array.isArray(value["updated"]) &&
    Array.isArray(value["removed"])
  );
}

function formatValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "undefined";
}

export function flattenDelta(delta: unknown, prefix = ""): readonly DeltaLine[] {
  if (!isRecord(delta)) {
    return [];
  }
  if (isValueChange(delta)) {
    return [{ path: prefix, text: `${formatValue(delta.before)} → ${formatValue(delta.after)}` }];
  }
  if (isEntityCollectionDelta(delta)) {
    return [
      {
        path: prefix,
        text: `+${delta.added.length} / ~${delta.updated.length} / -${delta.removed.length}`,
      },
    ];
  }
  return Object.entries(delta).flatMap(([key, value]) =>
    flattenDelta(value, prefix ? `${prefix}.${key}` : key),
  );
}
