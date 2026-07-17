import type { LogLevel } from "../simulation/simulate-battle-command.js";
import type {
  BattleDomainEvent,
  BattleDomainEventType,
} from "../../domain/battle/events/domain-event.js";

/**
 * `08_ドメインイベント.md`「公開レベル」のSUMMARYに対応するM3イベント種別。
 * 「戦闘開始、行動結果、戦闘不能、ターン終了、戦闘終了」の5項目に、それぞれ
 * 1対1で対応するM3イベントを割り当てる。
 */
const SUMMARY_EVENT_TYPES: ReadonlySet<BattleDomainEventType> = new Set([
  "BattleStarted",
  "ActionCompleted",
  "UnitDefeated",
  "TurnCompleted",
  "BattleCompleted",
]);

/**
 * `09_アプリケーション設計.md`「SimulateBattleResult」: `events`は`logLevel`に
 * 応じて間引いた公開ログ、`stateTransitions`（状態復元に必要な差分）は
 * 公開レベルに関わらず全件保持する（この関数は`events`側だけを扱う）。
 * M3はDETAILED/DIAGNOSTICを区別するDIAGNOSTICカテゴリのイベントをまだ発行しない
 * ため、両レベルは同じ完全な内部イベント列を返す（`08_ドメインイベント.md`
 * 「DIAGNOSTICイベントは詳細ログ設定が有効な場合だけ公開してよい」の対象がまだ存在しない）。
 */
export function projectEventsForLogLevel(
  events: readonly BattleDomainEvent[],
  logLevel: LogLevel,
): readonly BattleDomainEvent[] {
  if (logLevel === "SUMMARY") {
    return events.filter((event) => SUMMARY_EVENT_TYPES.has(event.eventType));
  }
  return events;
}
