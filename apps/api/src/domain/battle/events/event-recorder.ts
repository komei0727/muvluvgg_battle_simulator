import type {
  BattleDomainEvent,
  BattleDomainEventPayloadMap,
  BattleDomainEventType,
  EventCategory,
} from "./domain-event.js";
import {
  createActionId,
  createDomainEventId,
  createEffectInstanceId,
  createResolutionScopeId,
  createSkillUseId,
  type ActionId,
  type DomainEventId,
  type EffectInstanceId,
  type ResolutionScopeId,
  type SkillUseId,
} from "../../shared/event-ids.js";
import type { StateDelta } from "./state-delta.js";
import type { Side } from "../../shared/side.js";
import type { BattleId, BattleUnitId } from "../../shared/ids.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";

/**
 * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」の「発行イベント総数」
 * 上限の暫定既定値（M9で設定可能にするまでの固定値、レビュー指摘[P2]）。
 * PS深度・効果解決数Guardは1解決スコープ単位でしか働かないため、
 * `RuntimeCounterChanged`を自身の更新契機にするCatalog定義（`PassiveActivationRuntime`
 * 側にも専用の再帰深度Guardを設けている）のような、複数解決スコープにまたがる
 * 想定外のイベント量産をBattle全体で捕捉する最終防衛線として機能する。
 *
 * レビュー再指摘[P1]: 旧値（20,000）は`10_API設計.md`「正常な99ターン戦闘を
 * 十分扱える値にする」契約を満たさなかった。5対5・現行ユニットの最大AP(4)・
 * `logLevel: DETAILED`・99ターンの境界シナリオを実測すると、全員WAITの
 * 最小系（AP消費・EX増加・ActionWaited等のみ）で約25,554件、全員が毎ターン
 * 攻撃（ダメージ計算・適用込み）する系で約164,154件、各ユニットが
 * `DamageApplied`に反応する簡易防御PSを持つ系で約203,754件になる
 * （測定手順はPR再レビュー対応時のスクリプトを参照）。実行ガードは
 * 「異常な暴走生成」を止める最終防衛線であり、正常系の実測ワーストケースを
 * 詰めすぎないよう、最大実測値(約204,000件)の約5倍の余裕を確保する。
 */
export const DEFAULT_MAX_TOTAL_EVENTS = 1_000_000;

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
  private effectInstanceCounter = 0;
  private readonly recordedEvents: BattleDomainEvent[] = [];
  private readonly maxTotalEvents: number;

  constructor(battleId: BattleId, maxTotalEvents: number = DEFAULT_MAX_TOTAL_EVENTS) {
    this.battleId = battleId;
    this.maxTotalEvents = maxTotalEvents;
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

  /** `05_ドメインモデル.md`「AppliedEffect」: 新しい効果インスタンスを付与するたびに採番する。 */
  nextEffectInstanceId(): EffectInstanceId {
    this.effectInstanceCounter += 1;
    return createEffectInstanceId(`${this.battleId}:effect:${this.effectInstanceCounter}`);
  }

  /**
   * イベントを1件記録する。`sequence`を1増やし、`eventId = ${battleId}:${sequence}`
   * を採番する。`stateDelta`を持つ場合だけ`stateVersion`を1増やす
   * （「Battleの可変状態へ変更を確定するたびにstateVersionを1増やす」）。
   */
  record<Type extends BattleDomainEventType>(
    input: RecordEventInput<Type>,
  ): Extract<BattleDomainEvent, { eventType: Type }> {
    if (this.recordedEvents.length >= this.maxTotalEvents) {
      throw new ExecutionGuardExceededError(
        `event recording exceeded the SimulationExecutionGuard total-event limit (${this.maxTotalEvents}) for this battle`,
      );
    }
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
