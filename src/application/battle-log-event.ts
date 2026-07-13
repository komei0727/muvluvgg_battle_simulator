import type {
  BattleDomainEvent,
  BattleDomainEventType,
} from "../domain/battle/events/domain-event.js";
import type { ActionId, DomainEventId } from "../domain/battle/events/event-ids.js";
import type { BattleUnitId } from "../domain/shared/ids.js";

/**
 * `08_ドメインイベント.md`「公開イベント形式」の`BattleLogEvent`。内部イベント名
 * (`eventType`)をそのまま露出させず、機械的に識別可能な`type`を持つ。表示文言は
 * クライアント側／APIプレゼンテーション層で`type`と`details`から生成する。
 */
export interface BattleLogEvent {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly parentSequence?: number;
  readonly sourceUnitId?: BattleUnitId;
  readonly targetUnitIds?: readonly BattleUnitId[];
  readonly details: unknown;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  /**
   * 状態変更を持つイベントだけが持つ、対応する`StateTransition`への参照。
   * `stateTransitions[].causedBySequence`と同じ値であり、`stateDelta`本体は
   * ここへ重複して持たせない。
   */
  readonly stateTransitionReference?: number;
}

/** `PascalCase`のeventTypeを、設計が要求する大文字スネークケースへ変換する。 */
function toUpperSnakeCase(eventType: BattleDomainEventType): string {
  return eventType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * 内部`BattleDomainEvent`を公開`BattleLogEvent`へ変換する。`parentSequence`は
 * `parentEventId`を`allEvents`（公開レベルによる間引き前の全件）から引いた
 * `sequence`で解決するため、親イベント自体が間引かれて`visibleEvents`に
 * 含まれない場合でも正しく参照できる。
 */
export function toBattleLogEvents(
  visibleEvents: readonly BattleDomainEvent[],
  allEvents: readonly BattleDomainEvent[],
): readonly BattleLogEvent[] {
  const sequenceByEventId = new Map<DomainEventId, number>(
    allEvents.map((event) => [event.eventId, event.sequence]),
  );

  return visibleEvents.map((event) => {
    const parentSequence =
      event.parentEventId !== undefined ? sequenceByEventId.get(event.parentEventId) : undefined;

    return {
      sequence: event.sequence,
      type: toUpperSnakeCase(event.eventType),
      turnNumber: event.turnNumber,
      cycleNumber: event.cycleNumber,
      ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
      ...(parentSequence !== undefined ? { parentSequence } : {}),
      ...(event.sourceUnitId !== undefined ? { sourceUnitId: event.sourceUnitId } : {}),
      ...(event.targetUnitIds !== undefined ? { targetUnitIds: event.targetUnitIds } : {}),
      details: event.payload,
      stateVersionBefore: event.stateVersionBefore,
      stateVersionAfter: event.stateVersionAfter,
      ...(event.stateDelta !== undefined ? { stateTransitionReference: event.sequence } : {}),
    };
  });
}
