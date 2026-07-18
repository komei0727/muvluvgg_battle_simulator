import {
  consumePp,
  increaseExGauge,
  recordExtraGaugeOverflowDiscardedIfAny,
  recordResourceChangeIfAny,
  requireUnit,
  type ResourceChangeRecordContext,
} from "./action-resolution-shared.js";
import { recordCooldownStart } from "./action-completion.js";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "./effect-action-group-resolver.js";
import { resolveSkillOrder } from "../skill/skill-resolution-service.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import { detectPassiveCandidates } from "../triggering/passive-trigger-matcher.js";
import {
  createEmptyPassiveActivationGuard,
  type PassiveActivationGuard,
} from "../triggering/passive-activation-guard.js";
import type { PassiveChainLimits } from "../triggering/passive-chain-limits.js";
import type { PassiveCandidate } from "../triggering/passive-candidate.js";
import {
  resolvePassiveChain,
  type PassiveActivation,
  type PassiveChainDependencies,
} from "../triggering/resolve-passive-chain.js";
import type { TriggerCandidateEvent } from "../triggering/trigger-event.js";

/**
 * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」の暫定既定値。
 * M9で設定可能にするまでの固定値（`13_実装計画.md`「実行保護の全上限を設定
 * 可能にする」）。
 */
export const DEFAULT_PASSIVE_CHAIN_LIMITS: PassiveChainLimits = {
  maxPassiveDepth: 8,
  maxEffectsPerScope: 50,
};

/** `PassiveActivationRuntime`が1解決スコープ分の発動処理を行うために必要な依存。 */
export interface PassiveActivationRuntimeContext {
  readonly definitions: BattleDefinitions;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** 行動外のトップレベルイベント（ターン開始・終了など）から発動する場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly limits?: PassiveChainLimits;
}

function toResourceChangeContext(
  context: PassiveActivationRuntimeContext,
): ResourceChangeRecordContext {
  return {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    resolutionScopeId: context.resolutionScopeId,
    rootEventId: context.rootEventId,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
  };
}

/**
 * `05_ドメインモデル.md`「PassiveCandidateStack」の発動処理側（#34/#73が実装する
 * `ActivatePassiveCandidate`）。1解決スコープ（1行動、またはターン開始・終了
 * などの行動外トップレベルイベント）ごとに1つ生成し、`onFactEvent`をそのスコープ
 * 内で起きるFACT/TIMINGイベントの都度呼び出す。R-PS-07（1解決スコープ1回制限、
 * `guard`）と、それに乗る`units`の最新状態をこのインスタンスが保持する。
 *
 * R-SKL-06（ACTION step内の1EffectAction単位での即時PS解決、PS発動条件・対象・
 * action定義順の完成）は#73のスコープ。本実装は`resolveSkillOrder`が計画した
 * PSのEffectSequence全体を`applyEffectActionGroups`で一括適用し、そこから
 * 発生したイベントを`resolvePassiveChain`へ一度にyieldする（R-PS-06の入れ子
 * 解決自体は`resolvePassiveChain`（#21）の既存機構でそのまま働く。#73は
 * このyield粒度を1EffectAction単位まで細かくする）。
 */
export class PassiveActivationRuntime {
  private readonly context: PassiveActivationRuntimeContext;
  private units: readonly BattleUnit[];
  private guard: PassiveActivationGuard;
  private readonly recordedEventIdOf = new Map<TriggerCandidateEvent, DomainEventId>();

  constructor(context: PassiveActivationRuntimeContext, initialUnits: readonly BattleUnit[]) {
    this.context = context;
    this.units = initialUnits;
    this.guard = createEmptyPassiveActivationGuard();
  }

  get currentUnits(): readonly BattleUnit[] {
    return this.units;
  }

  private toTriggerEvent(event: BattleDomainEvent): TriggerCandidateEvent {
    const triggerEvent: TriggerCandidateEvent = {
      eventType: event.eventType,
      category: event.category === "DIAGNOSTIC" ? "FACT" : event.category,
      ...(event.sourceUnitId !== undefined ? { sourceUnitId: event.sourceUnitId } : {}),
      ...(event.sourceSide !== undefined ? { sourceSide: event.sourceSide } : {}),
      ...(event.targetUnitIds !== undefined ? { targetUnitIds: event.targetUnitIds } : {}),
      payload: event.payload,
    };
    this.recordedEventIdOf.set(triggerEvent, event.eventId);
    return triggerEvent;
  }

  private eventIdOf(event: TriggerCandidateEvent): DomainEventId {
    const eventId = this.recordedEventIdOf.get(event);
    if (eventId === undefined) {
      throw new DomainValidationError(
        "event",
        "TriggerCandidateEvent was not produced by this PassiveActivationRuntime (its DomainEventId is unknown)",
      );
    }
    return eventId;
  }

  private buildDependencies(): PassiveChainDependencies {
    return {
      detectCandidates: (event) =>
        detectPassiveCandidates({
          event,
          units: this.units,
          unitDefinitions: this.context.definitions.unitDefinitions,
          skillDefinitions: this.context.definitions.skillDefinitions,
          activationGuard: this.guard,
        }),
      getCurrentUnit: (battleUnitId) => requireUnit(this.units, battleUnitId),
      activate: (candidate, event): PassiveActivation =>
        this.activatePassiveCandidate(candidate, event),
      limits: this.context.limits ?? DEFAULT_PASSIVE_CHAIN_LIMITS,
    };
  }

  /**
   * `applyDamageAction`等が確定させたFACT/TIMINGイベントの都度呼び出す
   * エントリーポイント。PS発動で変化した`units`をそのまま返す。
   */
  onFactEvent(event: BattleDomainEvent, units: readonly BattleUnit[]): readonly BattleUnit[] {
    this.units = units;
    const triggerEvent = this.toTriggerEvent(event);
    const result = resolvePassiveChain(triggerEvent, this.guard, this.buildDependencies());
    if (!result.ok) {
      throw new DomainValidationError(
        "resolvePassiveChain",
        `PS chain resolution exceeded its execution guard: ${result.reason}`,
      );
    }
    this.guard = result.activationGuard;
    return this.units;
  }

  /**
   * R-PS-05「発動と再入防止」#2-6。発動済み集合への追加（#1）は
   * `resolvePassiveChain`（`resolveTopGroup`）が本関数を呼ぶ前に済ませている。
   */
  private *activatePassiveCandidate(
    candidate: PassiveCandidate,
    event: TriggerCandidateEvent,
  ): Generator<
    { readonly kind: "EFFECT_RESOLVED"; readonly events: readonly TriggerCandidateEvent[] },
    { readonly interrupted: boolean },
    unknown
  > {
    const skill = candidate.skillDefinition;
    const ownerId = candidate.unit.battleUnitId;
    const triggerEventId = this.eventIdOf(event);
    const resourceCtx = toResourceChangeContext(this.context);

    // R-PS-05 #2: PPを消費し、消費量と同量だけEXゲージを増やす（R-ACT-03/超過切り捨て）。
    const ownerBefore = requireUnit(this.units, ownerId);
    this.units = consumePp(this.units, ownerId, skill.cost.amount);
    const ownerAfterPp = requireUnit(this.units, ownerId);
    let lastEventId = recordResourceChangeIfAny(
      resourceCtx,
      ownerId,
      "PP",
      ownerBefore.currentPp,
      ownerAfterPp.currentPp,
      "SKILL_COST",
      triggerEventId,
      triggerEventId,
    );
    if (ownerBefore.currentPp !== ownerAfterPp.currentPp) {
      const consumed = this.context.recorder.record({
        eventType: "PassivePointConsumed",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          actorUnitId: ownerId,
          skillDefinitionId: skill.skillDefinitionId,
          before: ownerBefore.currentPp,
          after: ownerAfterPp.currentPp,
          consumedAmount: skill.cost.amount,
        },
      });
      lastEventId = consumed.eventId;
    }

    const exGain = increaseExGauge(this.units, ownerId, skill.cost.amount);
    this.units = exGain.units;
    lastEventId = recordResourceChangeIfAny(
      resourceCtx,
      ownerId,
      "EX_GAUGE",
      exGain.before,
      exGain.after,
      "EX_GAIN",
      lastEventId,
      triggerEventId,
    );
    if (exGain.after !== exGain.before) {
      const increased = this.context.recorder.record({
        eventType: "ExtraGaugeIncreased",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          battleUnitId: ownerId,
          causeResource: "PP",
          before: exGain.before,
          after: exGain.after,
          increasedAmount: exGain.after - exGain.before,
        },
      });
      lastEventId = increased.eventId;
    }
    lastEventId = recordExtraGaugeOverflowDiscardedIfAny(
      resourceCtx,
      ownerId,
      exGain.requestedAmount,
      exGain.after - exGain.before,
      exGain.discardedAmount,
      lastEventId,
    );

    // R-PS-05 #3: クールタイムを設定する。
    const ownerAfterResources = requireUnit(this.units, ownerId);
    const cooldownResult = recordCooldownStart(
      this.context.recorder,
      {
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        resolutionScopeId: this.context.resolutionScopeId,
        actorId: ownerId,
      },
      ownerAfterResources.cooldowns,
      skill,
      lastEventId,
      this.context.rootEventId,
    );
    this.units = this.units.map((unit) =>
      unit.battleUnitId === ownerId ? { ...unit, cooldowns: cooldownResult.cooldowns } : unit,
    );
    lastEventId = cooldownResult.lastEventId;

    // R-PS-05 #4: 発動済み集合への登録とPP消費後に`PassiveActivated`を発行する。
    const ownerAfterCooldown = requireUnit(this.units, ownerId);
    const passiveActivated = this.context.recorder.record({
      eventType: "PassiveActivated",
      category: "FACT",
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      resolutionScopeId: this.context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: this.context.rootEventId,
      sourceUnitId: ownerId,
      payload: {
        actorUnitId: ownerId,
        skillDefinitionId: skill.skillDefinitionId,
        ppBefore: ownerBefore.currentPp,
        ppAfter: ownerAfterPp.currentPp,
        exBefore: exGain.before,
        exAfter: exGain.after,
        triggerEventId,
      },
    });
    lastEventId = passiveActivated.eventId;

    // R-PS-05 #5: EffectSequenceをR-SKL-01〜08に従って解決する。
    const plan = resolveSkillOrder(
      skill,
      ownerAfterCooldown,
      this.units,
      this.context.definitions.effectActions,
    );
    let newEvents: readonly TriggerCandidateEvent[] = [];
    if (plan.length > 0) {
      if (this.context.actionId === undefined) {
        throw new DomainValidationError(
          "skill.resolution",
          `PS "${skill.skillDefinitionId}" has non-empty resolution steps but was activated outside any action (e.g. a turn-boundary trigger); resolving real effects without an actionId is not supported yet`,
        );
      }
      const beforeCount = this.context.recorder.getEvents().length;
      const skillUseId = this.context.recorder.nextSkillUseId();
      const groupContext: EffectActionGroupContext = {
        definitions: this.context.definitions,
        actorId: ownerId,
        random: this.context.random,
        recorder: this.context.recorder,
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        actionId: this.context.actionId,
        skillUseId,
        actionScope: this.context.resolutionScopeId,
        rootEventId: this.context.rootEventId,
        parentEventId: lastEventId,
        skillDefinitionId: skill.skillDefinitionId,
      };
      this.units = applyEffectActionGroups(plan, this.units, groupContext);
      const recorded = this.context.recorder.getEvents().slice(beforeCount);
      newEvents = recorded.map((recordedEvent) => this.toTriggerEvent(recordedEvent));
      const last = recorded[recorded.length - 1];
      if (last !== undefined) {
        lastEventId = last.eventId;
      }
    }

    if (newEvents.length > 0) {
      yield { kind: "EFFECT_RESOLVED", events: newEvents };
    }

    // R-PS-05 #6 / R-SKL-01: 使用者(PS所有者)が戦闘不能になった場合、未解決効果を中断する。
    const ownerAfterEffects = requireUnit(this.units, ownerId);
    const interrupted = isDefeated(ownerAfterEffects);
    const resolvedStepCount =
      skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps.length : 0;
    if (interrupted) {
      this.context.recorder.record({
        eventType: "PassiveInterrupted",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          actorUnitId: ownerId,
          skillDefinitionId: skill.skillDefinitionId,
          reason: "OWNER_DEFEATED",
          // #73（R-SKL-06）がACTION step単位の解決へ細分化するまでの暫定値:
          // 全体を1バッチとして適用するため、正確な未解決数ではなく計画済み
          // 適用数の上限で近似する。
          unresolvedEffectCount: plan.length,
        },
      });
    } else {
      this.context.recorder.record({
        eventType: "PassiveResolved",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          actorUnitId: ownerId,
          skillDefinitionId: skill.skillDefinitionId,
          resolvedStepCount,
        },
      });
    }

    return { interrupted };
  }
}
