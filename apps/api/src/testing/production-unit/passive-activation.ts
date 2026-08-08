import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { createBattleId } from "../../domain/shared/ids.js";
import type {
  BattleDomainEvent,
  BattleDomainEventPayloadMap,
  BattleDomainEventType,
} from "../../domain/battle/events/domain-event.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { DamageResultRegistry } from "../../domain/battle/skill/formula-evaluator.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "../../domain/shared/event-ids.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";

/**
 * ユニット単位production結合テストの `-002` 以降が使う、PS発動連鎖のハーネス。
 *
 * PSは「実際に発行されたイベント」を契機にしか発動しないため、対象ユニットのPSを
 * 検証するには (1) 契機イベントを行動envelopeの中で発行し、(2) それを
 * `PassiveActivationRuntime` へ流す、という2段が必ず要る。契機イベントの種類
 * （`SkillUseStarting`／`UnitBeingAttacked`／`HitPointReduced` など）はPSごとに
 * 異なるので、envelope（`ActionStarted` を根とする因果連鎖）だけを共通化し、
 * 契機イベント本体は呼び出し側が宣言する。
 */

export interface PassiveChain {
  readonly recorder: EventRecorder;
  readonly actionId: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  /** 行動の根イベント（`ActionStarted`）のID。 */
  readonly rootEventId: DomainEventId;
  /**
   * 契機イベントを1件発行し、PS候補検出→発動→EffectSequence解決まで通す。
   * 戻り値は連鎖後の全ユニット。
   */
  fire<Type extends BattleDomainEventType>(
    event: PassiveTriggerEvent<Type>,
    units: readonly BattleUnit[],
  ): readonly BattleUnit[];
  /**
   * 既に発行済みのイベント（実ダメージpipelineが出した`HitPointReduced`など）を
   * 契機としてPS連鎖を流す。契機イベントを手組みせず、実装が実際に出した
   * イベントそのものを使いたい場合に用いる。
   */
  fireRecorded(event: BattleDomainEvent, units: readonly BattleUnit[]): readonly BattleUnit[];
  /** 発行済みイベントのうち、指定種別のものだけを発生順に返す。 */
  eventsOfType<Type extends BattleDomainEventType>(
    eventType: Type,
  ): readonly Extract<BattleDomainEvent, { eventType: Type }>[];
}

export interface PassiveTriggerEvent<Type extends BattleDomainEventType> {
  readonly eventType: Type;
  readonly category: "FACT" | "TIMING";
  readonly sourceUnitId?: BattleUnitId;
  readonly targetUnitIds?: readonly BattleUnitId[];
  readonly payload: BattleDomainEventPayloadMap[Type];
}

export interface OpenPassiveChainOptions {
  readonly definitions: BattleDefinitions;
  /** 行動主体（`ActionStarted`のactor）。PS保持者ではなく契機を作る側。 */
  readonly actorUnitId: string;
  /** 既定は「命中・非会心」へ倒す固定列。 */
  readonly random?: RandomSource;
  readonly battleId?: string;
  /**
   * 連鎖を評価するターン番号。`TURN_NUMBER` を読む trigger 条件
   * （「1ターン目には発動しない」等）は payload ではなく評価文脈から読むため、
   * 契機イベントの `turnNumber` と揃える必要がある。
   */
  readonly turnNumber?: number;
  /**
   * R-SKL-08の実行時registry。`PassiveActivationRuntime` は1解決スコープにつき1つ
   * だけ生成される契約のもとで自前のMapを持つが、このハーネスは契機を作る攻撃を
   * runtimeの外で撃つため、同じスコープに居ることを表せるよう呼び出し側の
   * registryを共有させる。反撃系（`DAMAGE_RECEIVED_RATIO`）はこれを読む。
   */
  readonly damageResults?: DamageResultRegistry;
}

/** `ActionStarted` を根に持つ行動envelopeを開き、PS連鎖を流せる状態にする。 */
export function openPassiveChain(options: OpenPassiveChainOptions): PassiveChain {
  const battleId = createBattleId(options.battleId ?? "B_PASSIVE");
  const recorder = new EventRecorder(battleId);
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const actionId = recorder.nextActionId();
  const turnNumber = options.turnNumber ?? 1;
  const actionStarted = recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber,
    cycleNumber: 1,
    actionId,
    resolutionScopeId,
    payload: {
      actorUnitId: options.actorUnitId as BattleUnitId,
      reservedActionType: "AS",
      effectiveActionType: "AS",
      apBefore: 1,
      apAfter: 0,
      exBefore: 0,
      exAfter: 0,
    },
  });
  // 会心・確率抽選をすべて「外れ側」へ倒し、PSが発動したかどうかだけを観測に残す。
  const random = options.random ?? new SequenceRandomSource(new Array<number>(64).fill(0.99));

  const chain: PassiveChain = {
    recorder,
    actionId,
    resolutionScopeId,
    rootEventId: actionStarted.eventId,
    fire(event, units) {
      const recorded = recorder.record({
        eventType: event.eventType,
        category: event.category,
        turnNumber,
        cycleNumber: 1,
        actionId,
        resolutionScopeId,
        parentEventId: actionStarted.eventId,
        rootEventId: actionStarted.eventId,
        ...(event.sourceUnitId === undefined ? {} : { sourceUnitId: event.sourceUnitId }),
        ...(event.targetUnitIds === undefined ? {} : { targetUnitIds: event.targetUnitIds }),
        payload: event.payload,
      });
      return chain.fireRecorded(recorded, units);
    },
    fireRecorded(event, units) {
      const runtime = new PassiveActivationRuntime(
        {
          definitions: options.definitions,
          random,
          recorder,
          turnNumber,
          cycleNumber: 1,
          resolutionScopeId,
          rootEventId: actionStarted.eventId,
          actionId,
        },
        units,
      );
      if (options.damageResults !== undefined) {
        for (const [unitId, entry] of options.damageResults) {
          runtime.damageResultsRegistry.set(unitId, entry);
        }
      }
      return runtime.onFactEvent(event, units).units;
    },
    eventsOfType<Type extends BattleDomainEventType>(eventType: Type) {
      return recorder
        .getEvents()
        .filter(
          (event): event is Extract<BattleDomainEvent, { eventType: Type }> =>
            event.eventType === eventType,
        );
    },
  };
  return chain;
}

/** `PassiveActivated` が報告したスキルIDを発動順に返す。 */
export function activatedPassiveSkillIds(chain: PassiveChain): readonly string[] {
  return chain.eventsOfType("PassiveActivated").map((event) => event.payload.skillDefinitionId);
}
