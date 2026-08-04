// Mirrors docs/ddd/10_API設計.md「BattleStateDeltaResponse」/「ValueChange」/
// 「EntityCollectionDelta」. Walks an arbitrary, possibly-future-extended delta
// object generically instead of hardcoding every field name, so an unknown
// nested shape degrades to nothing rendered rather than crashing
// (01_UI要求・画面設計.md §11 未知event／effect kindでもクラッシュしない).
//
// DMG-010 (Issue #191, 07_UI実装・拡張計画.md §12完了条件「subUnit/effect
// collection deltaを汎用JSONだけでなく意味のある表示へ変換する」): an
// EntityCollectionDelta additionally emits one line per added/updated/removed
// entry. Entity identity is read from the id fields the API contract actually
// defines (effects / subUnits / markers / cooldowns) and never inferred from
// definition-ID naming conventions; anything unrecognized falls back to compact
// JSON so a future entity type stays visible instead of silently collapsing to
// a count.

import { isRecord } from "../../lib/unknown-narrowing.js";

export interface DeltaLine {
  readonly path: string;
  readonly text: string;
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

/**
 * `10_API設計.md`が定義する各エンティティのインスタンスID
 * （`EffectStateResponse`／`SubUnitStateResponse`／`MarkerStateResponse`）と、
 * `EntityCollectionDelta.updated`/`removed`のラッパーが持つ`id`。
 */
const INSTANCE_ID_KEYS = [
  "effectInstanceId",
  "subUnitInstanceId",
  "markerInstanceId",
  "id",
] as const;

/** 同じく、人が読める定義側の名前。`effectKindKey`は定義IDそのものなので最後に見る。 */
const DEFINITION_ID_KEYS = [
  "effectDefinitionId",
  "subUnitDefinitionId",
  "markerId",
  "skillDefinitionId",
  "effectKindKey",
] as const;

function firstString(entity: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(entity)) {
    return undefined;
  }
  for (const key of keys) {
    const value = entity[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * `定義ID（インスタンスID）`形のラベル。定義IDが読めなければインスタンスIDだけ、
 * どちらも読めなければ`undefined`を返して呼び出し側をJSON退避へ落とす。
 */
function entityLabel(entity: unknown, fallbackId?: string): string | undefined {
  const instanceId = firstString(entity, INSTANCE_ID_KEYS) ?? fallbackId;
  const definitionId = firstString(entity, DEFINITION_ID_KEYS);
  if (definitionId !== undefined && instanceId !== undefined) {
    return `${definitionId}（${instanceId}）`;
  }
  return definitionId ?? instanceId;
}

/**
 * 更新エントリの`before`/`after`を再帰的に比較し、値が変わったleafだけを
 * `path before → after`として並べる。公開projectionに現れない変化（例えば
 * `EffectStateResponse.value`が持たない内部状態の増減）では空になるため、
 * 呼び出し側が「変更なし」と明示できるよう空配列をそのまま返す。
 */
function diffEntity(before: unknown, after: unknown, prefix = ""): readonly string[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) =>
      diffEntity(before[key], after[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  if (before === after) {
    return [];
  }
  return [`${prefix} ${formatValue(before)} → ${formatValue(after)}`];
}

function entryLine(
  prefix: string,
  bucket: "added" | "updated" | "removed",
  index: number,
  text: string,
): DeltaLine {
  return { path: `${prefix}.${bucket}[${index}]`, text };
}

/** `added`/`removed`は要素そのもの（`removed`は`{id, before}`ラッパー）を1行にする。 */
function presenceLines(
  prefix: string,
  bucket: "added" | "removed",
  entries: readonly unknown[],
): readonly DeltaLine[] {
  const marker = bucket === "added" ? "+" : "-";
  return entries.map((entry, index) => {
    const wrapped = bucket === "removed" && isRecord(entry) ? entry["before"] : entry;
    const fallbackId = firstString(entry, ["id"]);
    const label = entityLabel(wrapped, fallbackId) ?? formatValue(wrapped);
    return entryLine(prefix, bucket, index, `${marker} ${label}`);
  });
}

function updatedLines(prefix: string, entries: readonly unknown[]): readonly DeltaLine[] {
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      return entryLine(prefix, "updated", index, `~ ${formatValue(entry)}`);
    }
    const fallbackId = firstString(entry, ["id"]);
    const label = entityLabel(entry["after"] ?? entry["before"], fallbackId) ?? formatValue(entry);
    const changes = diffEntity(entry["before"], entry["after"]);
    const changeText = changes.length > 0 ? changes.join("、") : "表示可能な変更項目なし";
    return entryLine(prefix, "updated", index, `~ ${label}: ${changeText}`);
  });
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
      ...presenceLines(prefix, "added", delta.added),
      ...updatedLines(prefix, delta.updated),
      ...presenceLines(prefix, "removed", delta.removed),
    ];
  }
  return Object.entries(delta).flatMap(([key, value]) =>
    flattenDelta(value, prefix ? `${prefix}.${key}` : key),
  );
}
