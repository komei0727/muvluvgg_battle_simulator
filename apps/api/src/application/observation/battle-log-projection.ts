import type { LogLevel } from "../simulation/simulate-battle-command.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";

/**
 * `09_アプリケーション設計.md`「SimulateBattleResult」: `events`は`logLevel`に
 * 応じた公開ログである。
 *
 * `SUMMARY`はイベントを1件も返さない。このレベルの用途は「編成を比べるための大量
 * 実行」であり、必要なのは勝敗とユニット別集計（`unitSummaries`）だけである。主要
 * イベントを数種類だけ選んで返しても、その用途では読まれないまま応答サイズだけが増える。
 *
 * `DETAILED`は全イベントを返し、`DIAGNOSTIC`は廃止された（`08_ドメインイベント.md`／
 * `10_API設計.md`「公開レベル」）。2つのレベルの差は`EffectStepSkipped`・
 * `ExtraGaugeOverflowDiscarded`の2種だけであり、これを既定から隠すことは「効果が
 * 発動しなかった理由が既定のログに出ない」ことしか意味しなかった。`EventCategory`の
 * `DIAGNOSTIC`はイベントの性質を表す分類としては残る。
 *
 * かつてSUMMARYの選別に使っていた網羅レコード（`SUMMARY_EVENT_TYPE_INCLUSION`）は
 * 廃止した。あれは「新しいイベント種別を足したらSUMMARYへ含めるか必ず判断させる」
 * 強制関数だったが、SUMMARYがイベントを返さなくなった以上その判断自体が存在しない。
 */
export function projectEventsForLogLevel(
  events: readonly BattleDomainEvent[],
  logLevel: LogLevel,
): readonly BattleDomainEvent[] {
  return logLevel === "SUMMARY" ? [] : events;
}
