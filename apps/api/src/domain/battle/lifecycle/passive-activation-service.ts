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
  resolveEffectSequencePlan,
  type EffectActionGroupContext,
  type UnitsBox,
} from "./effect-action-group-resolver.js";
import { resolveSkillOrder } from "../skill/skill-resolution-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import { detectPassiveCandidates } from "../triggering/passive-trigger-matcher.js";
import { detectRuntimeCounterUpdates } from "../triggering/runtime-counter-matcher.js";
import {
  createEmptyPassiveActivationGuard,
  type PassiveActivationGuard,
} from "../triggering/passive-activation-guard.js";
import type { PassiveChainLimits } from "../triggering/passive-chain-limits.js";
import type { PassiveCandidate } from "../triggering/passive-candidate.js";
import {
  resolvePassiveChain,
  type PassiveActivation,
  type PassiveActivationStep,
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
   *
   * `08_ドメインイベント.md`「イベント発行と処理」#3（M6最小実装、Issue #143）:
   * 原因イベントに起因する`RuntimeCounter`更新（`counterUpdates`、`SKILL_RUNTIME`
   * スコープ）があれば、`RuntimeCounterChanged`を発行し、その候補解決を
   * （このメソッドへの再入により）原因イベント自身の候補抽出より先に完了させて
   * から、`RUNTIME_COUNTER` Conditionが更新後の値を参照できる状態で原因イベント
   * 自身の候補解決へ進む。
   */
  onFactEvent(event: BattleDomainEvent, units: readonly BattleUnit[]): readonly BattleUnit[] {
    this.units = units;
    const triggerEvent = this.toTriggerEvent(event);

    const counterUpdate = detectRuntimeCounterUpdates({
      event: triggerEvent,
      units: this.units,
      unitDefinitions: this.context.definitions.unitDefinitions,
      skillDefinitions: this.context.definitions.skillDefinitions,
    });
    this.units = counterUpdate.units;
    for (const change of counterUpdate.changes) {
      const recorded = this.context.recorder.record({
        eventType: "RuntimeCounterChanged",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: event.eventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: change.ownerUnitId,
        payload: {
          ownerUnitId: change.ownerUnitId,
          scope: "SKILL_RUNTIME",
          counter: change.counter,
          skillDefinitionId: change.skillDefinitionId,
          before: change.before,
          after: change.after,
          carry: change.carry,
        },
        stateDelta: {
          units: {
            [change.ownerUnitId]: {
              skillCounters: {
                [change.skillDefinitionId]: {
                  [change.counter]: { before: change.before, after: change.after },
                },
              },
            },
          },
        },
      });
      this.units = this.onFactEvent(recorded, this.units);
    }

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
  ): Generator<PassiveActivationStep, { readonly interrupted: boolean }, unknown> {
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
    // Issue #34 (PR #141 review [P1]): ターン開始・終了など行動外の
    // トップレベルイベントから発動したPS（`actionId`を持たない）も実効果を
    // 解決できる。`EffectActionGroupContext`以下は`actionId`を任意にして
    // 素通しする。`EffectSequence.steps`はCatalog検証で非空のため、
    // `resolveEffectSequencePlan`は常に呼び出し、step単位のイベントを発行する
    // （#73: R-SKL-06）。
    //
    // PR #142レビュー[P1]: 以前は`applyEffectActionGroups`でplan全体を同期的に
    // 適用してから、記録された全イベントを一つの`EFFECT_RESOLVED`として
    // まとめてyieldしていた。そのため最初のEffectAction Aが子PSを誘発しても、
    // その子PSが解決される時点では後続EffectAction Bも適用済みになり
    // （「親A→子PS→親B」ではなく「親A→親B→子PS」）、R-PS-06の親処理復帰契約に
    // 反していた。`resolveEffectSequencePlan`（generator）へ`yield*`委譲する
    // ことで、`resolvePassiveChain`の`driveActivation`が管理する共有state
    // （PassiveResolutionStack・深度Guard・効果解決数Guard）へ正しく参加し、
    // 各EffectAction/step境界で子PS連鎖を完全に解決してから次へ進むように
    // なる。
    const skillUseId = this.context.recorder.nextSkillUseId();
    const groupContext: EffectActionGroupContext = {
      definitions: this.context.definitions,
      actorId: ownerId,
      random: this.context.random,
      recorder: this.context.recorder,
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      actionScope: this.context.resolutionScopeId,
      rootEventId: this.context.rootEventId,
      parentEventId: lastEventId,
      skillDefinitionId: skill.skillDefinitionId,
    };
    const box: UnitsBox = { units: this.units };
    const generator = resolveEffectSequencePlan(plan, box, groupContext);
    let step = generator.next();
    while (!step.done) {
      // このyieldをresolvePassiveChainが処理する前に、ここまでの状態変化
      // （box.units）を`this.units`へ反映し、子PSの候補検出・発動が最新状態を
      // 見られるようにする。
      this.units = box.units;
      if (step.value.kind === "TIMING_EVENT") {
        yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(step.value.event) };
      } else {
        yield {
          kind: "EFFECT_RESOLVED",
          events: step.value.events.map((event) => this.toTriggerEvent(event)),
        };
      }
      // 子PS連鎖（あれば）が`this.units`を書き換えている可能性があるため、
      // 一時停止していたgeneratorを再開する前に`box.units`へ取り込む。
      box.units = this.units;
      const lastYielded =
        step.value.kind === "TIMING_EVENT"
          ? step.value.event
          : step.value.events[step.value.events.length - 1];
      if (lastYielded !== undefined) {
        lastEventId = lastYielded.eventId;
      }
      step = generator.next();
    }
    this.units = box.units;
    const effectResult = step.value;
    const interruptedCount = effectResult.interruptedCount;

    // R-PS-05 #6 / R-SKL-01: 使用者(PS所有者)が戦闘不能になり、未解決のまま
    // 打ち切られた適用が実際に残った場合だけ中断とする（PR #141再レビュー[P2]:
    // 戦闘不能かどうかだけでは判定しない — 最後の効果で倒れても残り0件なら
    // 正常解決のまま）。
    const interrupted = interruptedCount > 0;
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
          unresolvedEffectCount: interruptedCount,
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
