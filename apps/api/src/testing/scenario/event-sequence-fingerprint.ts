import { createHash } from "node:crypto";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";

/**
 * Golden battle snapshot（`12_テスト戦略.md`「Golden battle 回帰層」）が固定する
 * イベント種別の要約。`eventTypeCounts`は種別ごとの件数（差分の読める回帰検出）、
 * `eventSequenceHash`は`eventTypeCounts`だけでは拾えない**順序**の回帰（同じ集合で
 * 並びだけ変わるケース）を1行のハッシュで拾う。ハッシュが変わった行だけでは何が
 * 変わったか読めないため、疑わしいケースはテスト実行部（`run-production-battle.ts`の
 * 各`runProduction*Battle`）を直接呼び直し、`events.map((e) => e.type)`で全列を見る
 * のがデバッグ経路になる。
 */
export interface EventSequenceFingerprint {
  readonly eventCount: number;
  readonly eventTypeCounts: Readonly<Record<string, number>>;
  readonly eventSequenceHash: string;
}

export function summarizeEventSequence(
  events: readonly Pick<BattleLogEvent, "type">[],
): EventSequenceFingerprint {
  const eventTypeCounts: Record<string, number> = {};
  for (const event of events) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
  }

  const eventSequenceHash = createHash("sha256")
    .update(JSON.stringify(events.map((event) => event.type)), "utf8")
    .digest("hex")
    .slice(0, 16);

  return {
    eventCount: events.length,
    eventTypeCounts: Object.fromEntries(
      Object.entries(eventTypeCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    eventSequenceHash: `sha256:${eventSequenceHash}`,
  };
}
