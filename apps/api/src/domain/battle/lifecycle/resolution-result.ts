import type { BattleUnit } from "../model/battle-unit.js";
import type { DomainEventId } from "../../shared/event-ids.js";

/**
 * Issue #251: `PassiveActivationRuntime`が反応連鎖まで解決した後に返す共通結果型。
 * `lastEventId`はこの呼び出し自身が発行・解決した実際の終端`DomainEventId`
 * （反応連鎖が無ければ渡された`event`自身、あれば連鎖の最後に記録されたイベント）
 * を表す。呼び出し側は次のイベントの`parentEventId`へこの値をそのまま引き継げば
 * よく、`EventRecorder.getEvents()`の末尾を推測する必要がない。
 */
export interface ResolutionResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}
