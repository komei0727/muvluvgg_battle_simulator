import type {
  BattleDomainEvent,
  BattleDomainEventPayloadMap,
  BattleDomainEventType,
  EventCategory,
} from "./domain-event.js";
import {
  createActionId,
  createDomainEventId,
  createResolutionScopeId,
  createSkillUseId,
  type ActionId,
  type DomainEventId,
  type ResolutionScopeId,
  type SkillUseId,
} from "./event-ids.js";
import type { StateDelta } from "./state-delta.js";
import type { Side } from "../side.js";
import type { BattleId, BattleUnitId } from "../../shared/ids.js";

export interface RecordEventInput<Type extends BattleDomainEventType> {
  readonly eventType: Type;
  readonly category: EventCategory;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly parentEventId?: DomainEventId;
  /** 省略時はこのイベント自身のeventIdを使う（`08_ドメインイベント.md`「行動外のトップレベルイベント」）。 */
  readonly rootEventId?: DomainEventId;
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
  readonly targetUnitIds?: readonly BattleUnitId[];
  readonly payload: BattleDomainEventPayloadMap[Type];
  readonly stateDelta?: StateDelta;
}

/**
 * `08_ドメインイベント.md`「イベント発行と処理」を担う採番器。`RandomSource`と
 * 同様、Battle 1つの生存期間につき1インスタンスを生成し、呼び出し側の関数群へ
 * 参照を渡して内部で蓄積させる（ミュータブルなポートとして扱う）。
 */
export class EventRecorder {
  private readonly battleId: BattleId;
  private sequenceCounter = 0;
  private stateVersionCounter = 0;
  private actionCounter = 0;
  private skillUseCounter = 0;
  private scopeCounter = 0;
  private readonly recordedEvents: BattleDomainEvent[] = [];

  constructor(battleId: BattleId) {
    this.battleId = battleId;
  }

  /** `08_ドメインイベント.md`「resolutionScopeId」: ユニット行動ではActionIdと対応する。 */
  nextActionId(): ActionId {
    this.actionCounter += 1;
    return createActionId(`${this.battleId}:action:${this.actionCounter}`);
  }

  nextSkillUseId(): SkillUseId {
    this.skillUseCounter += 1;
    return createSkillUseId(`${this.battleId}:skill-use:${this.skillUseCounter}`);
  }

  /** 行動外のトップレベルイベント（ターン開始・終了など）が発行する新しい解決スコープ。 */
  nextResolutionScopeId(): ResolutionScopeId {
    this.scopeCounter += 1;
    return createResolutionScopeId(`${this.battleId}:scope:${this.scopeCounter}`);
  }

  /**
   * イベントを1件記録する。`sequence`を1増やし、`eventId = ${battleId}:${sequence}`
   * を採番する。`stateDelta`を持つ場合だけ`stateVersion`を1増やす
   * （「Battleの可変状態へ変更を確定するたびにstateVersionを1増やす」）。
   */
  record<Type extends BattleDomainEventType>(
    input: RecordEventInput<Type>,
  ): Extract<BattleDomainEvent, { eventType: Type }> {
    this.sequenceCounter += 1;
    const eventId = createDomainEventId(`${this.battleId}:${this.sequenceCounter}`);
    const stateVersionBefore = this.stateVersionCounter;
    if (input.stateDelta !== undefined) {
      this.stateVersionCounter += 1;
    }
    const stateVersionAfter = this.stateVersionCounter;

    const event = {
      schemaVersion: 1,
      eventId,
      sequence: this.sequenceCounter,
      eventType: input.eventType,
      category: input.category,
      battleId: this.battleId,
      turnNumber: input.turnNumber,
      cycleNumber: input.cycleNumber,
      resolutionScopeId: input.resolutionScopeId,
      rootEventId: input.rootEventId ?? eventId,
      stateVersionBefore,
      stateVersionAfter,
      payload: input.payload,
      ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
      ...(input.skillUseId !== undefined ? { skillUseId: input.skillUseId } : {}),
      ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
      ...(input.sourceUnitId !== undefined ? { sourceUnitId: input.sourceUnitId } : {}),
      ...(input.sourceSide !== undefined ? { sourceSide: input.sourceSide } : {}),
      ...(input.targetUnitIds !== undefined ? { targetUnitIds: input.targetUnitIds } : {}),
      ...(input.stateDelta !== undefined ? { stateDelta: input.stateDelta } : {}),
    } as Extract<BattleDomainEvent, { eventType: Type }>;

    this.recordedEvents.push(event);
    return event;
  }

  getEvents(): readonly BattleDomainEvent[] {
    return this.recordedEvents;
  }
}
