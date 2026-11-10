// Mirrors docs/ddd/10_API設計.md「BattleStateDeltaResponse」/「ValueChange」/
// 「EntityCollectionDelta」. Walks an arbitrary, possibly-future-extended delta
// object generically instead of hardcoding every field name, so an unknown
// nested shape degrades to nothing rendered rather than crashing
// (01_UI要求・画面設計.md §11 未知event／effect kindでもクラッシュしない).
//
// DMG-010 (Issue #191, 完了条件「subUnit/effect
// collection deltaを汎用JSONだけでなく意味のある表示へ変換する」): an
// EntityCollectionDelta additionally emits one line per added/updated/removed
// entry. Entity identity is read from the id fields the API contract actually
// defines (effects / subUnits / markers / cooldowns) and never inferred from
// definition-ID naming conventions; anything unrecognized falls back to compact
// JSON so a future entity type stays visible instead of silently collapsing to
// a count.

import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EffectLabeler } from "../../lib/effect-display-label.js";

export interface DeltaLine {
  readonly path: string;
  readonly text: string;
  /** 本文に表示名で出したスキル・効果の論理名。行のツールチップへ回す。 */
  readonly logicalNames?: readonly string[];
}

/** 行の組み立てに要る、走査位置と表示名の解決手段。 */
interface FlattenContext {
  readonly resolveUnitName: (battleUnitId: string) => string;
  readonly labeler: EffectLabeler | undefined;
  /** `units.<battleUnitId>`配下を走査中なら、そのユニット。スキルの使用者に使う。 */
  readonly unitId: string | undefined;
  /** `cooldowns`のEntityCollectionDeltaを走査中か。 */
  readonly inCooldowns: boolean;
}

interface LabelledText {
  readonly text: string;
  readonly logicalNames: readonly string[];
}

function lineOf(path: string, labelled: LabelledText): DeltaLine {
  return labelled.logicalNames.length > 0
    ? { path, text: labelled.text, logicalNames: labelled.logicalNames }
    : { path, text: labelled.text };
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

/**
 * 同じく、人が読める定義側の名前。
 *
 * Issue #519: `effectKindKey`はここに含めない。R-STA-03の同種グループ鍵であって
 * 定義識別子ではなく、Catalogが`kindKey`を宣言した定義群では複数の定義が同じ値を
 * 共有するため、定義側の名前として見せると別定義の効果が同じラベルになる。
 * 効果の定義名は`effectDefinitionId`（`10_API設計.md`「EffectStateResponse」の
 * 必須プロパティ）が常に持つ。
 */
const DEFINITION_ID_KEYS = [
  "effectDefinitionId",
  "subUnitDefinitionId",
  "markerId",
  "skillDefinitionId",
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
 * 表示名の解決器があれば、効果・スキルを01_UI要求・画面設計.md §8.6「効果の表示名」で表す。
 * 効果はインスタンスを見分けるためインスタンスIDを添え、スキル（クールタイム）は使用者の
 * キャラ名-スキル種別番号だけで表す（ラッパーの`id`はスキルの論理名そのものであるため）。
 */
function labelledEntity(
  entity: unknown,
  instanceId: string | undefined,
  context: FlattenContext,
): LabelledText | undefined {
  const labeler = context.labeler;
  if (labeler === undefined) {
    return undefined;
  }
  // `cooldowns`の更新・削除はラッパーの`id`がスキル定義IDで、値は残り回数だけを持つ
  if (!isRecord(entity)) {
    return context.inCooldowns && instanceId !== undefined
      ? { text: labeler.skillLabel(context.unitId, instanceId), logicalNames: [instanceId] }
      : undefined;
  }
  const effectDefinitionId = entity["effectDefinitionId"];
  if (typeof effectDefinitionId === "string") {
    const sourceUnitId = entity["sourceUnitId"];
    const sourceSide = entity["sourceSide"];
    const fallback = {
      effectActionDefinitionId: effectDefinitionId,
      ...(typeof sourceUnitId === "string" ? { originUnitId: sourceUnitId } : {}),
      ...(typeof sourceUnitId !== "string" && typeof sourceSide === "string"
        ? { originSide: sourceSide }
        : {}),
    };
    const label =
      instanceId !== undefined
        ? `${labeler.instanceLabel(instanceId, fallback)}（${instanceId}）`
        : labeler.grantLabel(fallback);
    return { text: label, logicalNames: [effectDefinitionId] };
  }
  const skillDefinitionId = entity["skillDefinitionId"];
  if (typeof skillDefinitionId === "string") {
    return {
      text: labeler.skillLabel(context.unitId, skillDefinitionId),
      logicalNames: [skillDefinitionId],
    };
  }
  return undefined;
}

/**
 * `定義ID（インスタンスID）`形のラベル。定義IDが読めなければインスタンスIDだけ、
 * どちらも読めなければ`undefined`を返して呼び出し側をJSON退避へ落とす。
 */
function entityLabel(
  entity: unknown,
  context: FlattenContext,
  fallbackId?: string,
): LabelledText | undefined {
  const instanceId = firstString(entity, INSTANCE_ID_KEYS) ?? fallbackId;
  const labelled = labelledEntity(entity, instanceId, context);
  if (labelled !== undefined) {
    return labelled;
  }
  const definitionId = firstString(entity, DEFINITION_ID_KEYS);
  if (definitionId !== undefined && instanceId !== undefined) {
    return { text: `${definitionId}（${instanceId}）`, logicalNames: [] };
  }
  const text = definitionId ?? instanceId;
  return text !== undefined ? { text, logicalNames: [] } : undefined;
}

/** ValueChangeの片側。`charge`のようにスキルを持つ値は表示名で表す。 */
function labelledValue(value: unknown, context: FlattenContext): LabelledText {
  const labelled = labelledEntity(value, undefined, context);
  return labelled ?? { text: formatValue(value), logicalNames: [] };
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
  return [`${prefix ? `${prefix} ` : ""}${formatValue(before)} → ${formatValue(after)}`];
}

function entryLine(
  prefix: string,
  bucket: "added" | "updated" | "removed",
  index: number,
  labelled: LabelledText,
): DeltaLine {
  return lineOf(`${prefix}.${bucket}[${index}]`, labelled);
}

/** `added`/`removed`は要素そのもの（`removed`は`{id, before}`ラッパー）を1行にする。 */
function presenceLines(
  prefix: string,
  bucket: "added" | "removed",
  entries: readonly unknown[],
  context: FlattenContext,
): readonly DeltaLine[] {
  const marker = bucket === "added" ? "+" : "-";
  return entries.map((entry, index) => {
    const wrapped = bucket === "removed" && isRecord(entry) ? entry["before"] : entry;
    const fallbackId = firstString(entry, ["id"]);
    const label = entityLabel(wrapped, context, fallbackId) ?? {
      text: formatValue(wrapped),
      logicalNames: [],
    };
    return entryLine(prefix, bucket, index, { ...label, text: `${marker} ${label.text}` });
  });
}

function updatedLines(
  prefix: string,
  entries: readonly unknown[],
  context: FlattenContext,
): readonly DeltaLine[] {
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      return entryLine(prefix, "updated", index, {
        text: `~ ${formatValue(entry)}`,
        logicalNames: [],
      });
    }
    const fallbackId = firstString(entry, ["id"]);
    const label = entityLabel(entry["after"] ?? entry["before"], context, fallbackId) ?? {
      text: formatValue(entry),
      logicalNames: [],
    };
    const changes = diffEntity(entry["before"], entry["after"]);
    const changeText = changes.length > 0 ? changes.join("、") : "表示可能な変更項目なし";
    return entryLine(prefix, "updated", index, {
      ...label,
      text: `~ ${label.text}: ${changeText}`,
    });
  });
}

export interface FlattenDeltaOptions {
  /** `addedUnits`の行に出すユニット名。省略時は`battleUnitId`のまま出す。 */
  readonly resolveUnitName?: (battleUnitId: string) => string;
  /** 渡すと効果・スキルを表示名で表し、論理名を`logicalNames`へ回す。省略時は定義IDのまま出す。 */
  readonly labeler?: EffectLabeler;
}

/**
 * 総力戦の`addedUnits`（`FORMATION_DEPLOYED`が所有）。要素は`BattleStateResponse.units`と
 * 同じ完全な形なので、全項目を行へ展開せず、ユニットを名指しする1行に留める。
 */
function addedUnitLines(
  entries: readonly unknown[],
  resolveUnitName: (battleUnitId: string) => string,
): readonly DeltaLine[] {
  return entries.map((entry, index) => {
    const battleUnitId = firstString(entry, ["battleUnitId"]);
    const label = battleUnitId !== undefined ? resolveUnitName(battleUnitId) : formatValue(entry);
    return { path: `addedUnits[${String(index)}]`, text: `+ ${label} 出撃` };
  });
}

function flattenAt(delta: unknown, prefix: string, context: FlattenContext): readonly DeltaLine[] {
  if (!isRecord(delta)) {
    return [];
  }
  if (isValueChange(delta)) {
    const before = labelledValue(delta.before, context);
    const after = labelledValue(delta.after, context);
    return [
      lineOf(prefix, {
        text: `${before.text} → ${after.text}`,
        logicalNames: [...new Set([...before.logicalNames, ...after.logicalNames])],
      }),
    ];
  }
  if (isEntityCollectionDelta(delta)) {
    const entryContext = { ...context, inCooldowns: prefix.split(".").at(-1) === "cooldowns" };
    return [
      {
        path: prefix,
        text: `+${delta.added.length} / ~${delta.updated.length} / -${delta.removed.length}`,
      },
      ...presenceLines(prefix, "added", delta.added, entryContext),
      ...updatedLines(prefix, delta.updated, entryContext),
      ...presenceLines(prefix, "removed", delta.removed, entryContext),
    ];
  }
  return Object.entries(delta).flatMap(([key, value]) => {
    if (prefix === "" && key === "addedUnits" && Array.isArray(value)) {
      return addedUnitLines(value, context.resolveUnitName);
    }
    // `BattleStateDeltaResponse.units`はbattleUnitIdをキーに持つ
    const unitId = prefix === "units" ? key : context.unitId;
    return flattenAt(value, prefix ? `${prefix}.${key}` : key, { ...context, unitId });
  });
}

export function flattenDelta(
  delta: unknown,
  options: FlattenDeltaOptions = {},
): readonly DeltaLine[] {
  return flattenAt(delta, "", {
    resolveUnitName: options.resolveUnitName ?? ((battleUnitId) => battleUnitId),
    labeler: options.labeler,
    unitId: undefined,
    inCooldowns: false,
  });
}
