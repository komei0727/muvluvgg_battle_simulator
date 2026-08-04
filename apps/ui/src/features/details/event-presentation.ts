// Mirrors docs/ui-design/03_API・データ連携設計.md §12「イベント表示」の共通部分。
// `event-formatters.ts`（M4〜M7）と`damage-event-formatters.ts`（M8、DMG-010／
// Issue #191）の両方が使う型とhelperをここへ置き、両ファイル間の循環importを避ける。

import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

export type EventSeverity = "neutral" | "positive" | "negative";

export interface EventPresentation {
  readonly title: string;
  readonly summary: string;
  readonly details: unknown;
  readonly severity: EventSeverity;
}

export type RosterIndex = ReadonlyMap<string, RosterEntry>;

export type EventFormatter = (
  event: BattleLogEventResponse,
  roster: RosterIndex,
) => EventPresentation | undefined;

export function buildRosterIndex(roster: readonly RosterEntry[]): RosterIndex {
  return new Map(roster.map((entry) => [entry.battleUnitId, entry] as const));
}

export function resolveDisplayName(roster: RosterIndex, battleUnitId: string): string {
  return roster.get(battleUnitId)?.displayName ?? battleUnitId;
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
