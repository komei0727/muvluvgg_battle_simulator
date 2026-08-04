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
