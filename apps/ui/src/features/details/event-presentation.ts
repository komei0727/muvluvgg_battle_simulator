// Mirrors docs/ui-design/03_API・データ連携設計.md §12「イベント表示」の共通部分。
// `event-formatters.ts`（M4〜M7）と`damage-event-formatters.ts`（M8、DMG-010／
// Issue #191）の両方が使う型とhelperをここへ置き、両ファイル間の循環importを避ける。
import type { RosterEntry } from "../../entities/roster.js";
import { createEffectLabeler } from "../../lib/effect-display-label.js";
import type { EffectLabeler } from "../../lib/effect-display-label.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

export type EventSeverity = "neutral" | "positive" | "negative";

export interface EventPresentation {
  readonly title: string;
  readonly summary: string;
  readonly details: unknown;
  readonly severity: EventSeverity;
  /**
   * 文言に表示名で出したスキル・効果の論理名。01_UI要求・画面設計.md §8.1「スキル・効果の
   * 表示名」により本文には出さず、行のツールチップでだけ読めるようにする。
   */
  readonly logicalNames?: readonly string[];
}

export type RosterIndex = ReadonlyMap<string, RosterEntry>;

export type EventFormatter = (
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
) => EventPresentation | undefined;

export function buildRosterIndex(roster: readonly RosterEntry[]): RosterIndex {
  return new Map(roster.map((entry) => [entry.battleUnitId, entry] as const));
}

export function resolveDisplayName(roster: RosterIndex, battleUnitId: string): string {
  return roster.get(battleUnitId)?.displayName ?? battleUnitId;
}

/**
 * 表示名の解決器が渡されなければ、Catalog要約もイベント列も持たない解決器で代替する。
 * スキル種別番号・効果内容の位置に論理名が出る（§8.6「効果の表示名」の縮退規則）。
 */
export function labelerFor(roster: RosterIndex, labeler: EffectLabeler | undefined): EffectLabeler {
  return labeler ?? createEffectLabeler(undefined, roster, []);
}

/**
 * 効果インスタンスの表示名を引く時点。毒の統合で採用元が入れ替わるため、イベントの文言は
 * そのイベントの時点までの付与で表す（`EffectLabeler.instanceLabel`の`atSequence`）。
 */
export function eventSequenceOf(event: BattleLogEventResponse): number | undefined {
  const sequence = event["sequence"];
  return typeof sequence === "number" ? sequence : undefined;
}

/** 行のツールチップに出す論理名。名指ししないイベントでは`title`属性自体を付けない。 */
export function logicalNamesTitle(presentation: EventPresentation): string | undefined {
  const names = presentation.logicalNames;
  return names !== undefined && names.length > 0 ? names.join(", ") : undefined;
}

export type EventFormatterRegistry = Readonly<Record<string, EventFormatter>>;

/**
 * カテゴリ別registryを1つへ合成する。同じtypeが複数のカテゴリにあると、単純な
 * spreadでは後勝ちで片方のformatterが黙って死に、そのイベントだけgeneric
 * fallback相当の表示へ落ちる（テストが両方のカテゴリを網羅していないと気づけない）。
 * 起動時に衝突したtypeとカテゴリ名を挙げて失敗させ、静かな上書きを許さない。
 */
export function mergeDisjointFormatters(
  registries: Readonly<Record<string, EventFormatterRegistry>>,
): EventFormatterRegistry {
  const merged: Record<string, EventFormatter> = {};
  const ownerByType = new Map<string, string>();
  const collisions: string[] = [];

  for (const [category, registry] of Object.entries(registries)) {
    for (const [type, formatter] of Object.entries(registry)) {
      const owner = ownerByType.get(type);
      if (owner !== undefined) {
        collisions.push(`${type} (${owner} / ${category})`);
        continue;
      }
      ownerByType.set(type, category);
      merged[type] = formatter;
    }
  }

  if (collisions.length > 0) {
    throw new Error(
      `イベントformatterのtypeがカテゴリ間で重複しています: ${collisions.join(", ")}`,
    );
  }
  return merged;
}
