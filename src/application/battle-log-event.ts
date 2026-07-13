import type { StateTransition } from "./battle-observation.js";
import type {
  BattleDomainEvent,
  BattleDomainEventType,
  EventCategory,
} from "../domain/battle/events/domain-event.js";
import type { ActionId, DomainEventId, SkillUseId } from "../domain/battle/events/event-ids.js";
import { DomainValidationError } from "../domain/shared/errors.js";
import type { BattleUnitId } from "../domain/shared/ids.js";

/**
 * `10_API設計.md`「BattleLogEventResponse」と同じ形。内部イベント名(`eventType`)を
 * そのまま露出させず、機械的に識別可能な`type`を持つ。表示文言はクライアント側／
 * APIプレゼンテーション層で`type`と`details`から生成する。
 */
export interface BattleLogEvent {
  readonly sequence: number;
  readonly type: string;
  readonly category: EventCategory;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly parentSequence?: number;
  /** 解決スコープの起点イベント連番。ルートイベント自身では自分の`sequence`と同じ値になる。 */
  readonly rootSequence: number;
  readonly sourceUnitId?: BattleUnitId;
  /** 対象なしの場合は空配列（省略しない）。 */
  readonly targetUnitIds: readonly BattleUnitId[];
  readonly details: unknown;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  /**
   * このイベントが所有する状態変更の`stateTransitions`配列における0始まりの
   * インデックス。状態変更がなければ省略する。`stateDelta`本体はここへ重複して
   * 持たせない。
   */
  readonly stateTransitionIndex?: number;
}

/** `PascalCase`のeventTypeを、設計が要求する大文字スネークケースへ変換する。 */
function toUpperSnakeCase(eventType: BattleDomainEventType): string {
  return eventType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function requireSequence(
  sequenceByEventId: ReadonlyMap<DomainEventId, number>,
  eventId: DomainEventId,
  path: string,
): number {
  const sequence = sequenceByEventId.get(eventId);
  if (sequence === undefined) {
    throw new DomainValidationError(
      path,
      `references a DomainEventId absent from the given event list: "${eventId}"`,
    );
  }
  return sequence;
}

/**
 * 内部`BattleDomainEvent`を公開`BattleLogEvent`へ変換する。`parentSequence`/
 * `rootSequence`は`parentEventId`/`rootEventId`を`allEvents`（公開レベルによる
 * 間引き前の全件）から引いた`sequence`で解決するため、親・ルートイベント自体が
 * 間引かれて`visibleEvents`に含まれない場合でも正しく参照できる。
 * `stateTransitionIndex`は`stateTransitions`配列内の対応エントリの位置。
 */
export function toBattleLogEvents(
  visibleEvents: readonly BattleDomainEvent[],
  allEvents: readonly BattleDomainEvent[],
  stateTransitions: readonly StateTransition[],
): readonly BattleLogEvent[] {
  const sequenceByEventId = new Map<DomainEventId, number>(
    allEvents.map((event) => [event.eventId, event.sequence]),
  );
  const transitionIndexBySequence = new Map<number, number>(
    stateTransitions.map((transition, index) => [transition.causedBySequence, index]),
  );

  return visibleEvents.map((event) => {
    const parentSequence =
      event.parentEventId !== undefined
        ? requireSequence(sequenceByEventId, event.parentEventId, "parentEventId")
        : undefined;
    const rootSequence = requireSequence(sequenceByEventId, event.rootEventId, "rootEventId");
    const stateTransitionIndex = transitionIndexBySequence.get(event.sequence);

    return {
      sequence: event.sequence,
      type: toUpperSnakeCase(event.eventType),
      category: event.category,
      turnNumber: event.turnNumber,
      cycleNumber: event.cycleNumber,
      ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
      ...(event.skillUseId !== undefined ? { skillUseId: event.skillUseId } : {}),
      ...(parentSequence !== undefined ? { parentSequence } : {}),
      rootSequence,
      ...(event.sourceUnitId !== undefined ? { sourceUnitId: event.sourceUnitId } : {}),
      targetUnitIds: event.targetUnitIds ?? [],
      details: event.payload,
      stateVersionBefore: event.stateVersionBefore,
      stateVersionAfter: event.stateVersionAfter,
      ...(stateTransitionIndex !== undefined ? { stateTransitionIndex } : {}),
    };
  });
}
