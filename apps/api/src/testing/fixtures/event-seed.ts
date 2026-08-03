import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId } from "../../domain/shared/ids.js";
import type { DomainEventId, ResolutionScopeId } from "../../domain/shared/event-ids.js";

export interface SeededRecorder {
  readonly recorder: EventRecorder;
  /** 記録済みseedイベント本体（`seededRecorder` 系の旧ヘルパが返していた形）。 */
  readonly seed: ReturnType<EventRecorder["record"]>;
  readonly rootEventId: DomainEventId;
  /** seedイベントへ発番した解決スコープ。後続の行動外イベントが引き継げる。 */
  readonly resolutionScopeId: ResolutionScopeId;
}

/**
 * 行動解決系のテストは因果連鎖の根になるイベントを1件必要とする（`rootEventId`/
 * `parentEventId` が `DomainEventId` を要求する）ため、ターン開始eventを1件
 * 記録済みのrecorderと、そのbranded IDを返す。
 */
export function seedRecorder(battleId: string): SeededRecorder {
  const recorder = new EventRecorder(createBattleId(battleId));
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
  return { recorder, seed, rootEventId: seed.eventId, resolutionScopeId };
}
