import { requireUnit, type ResolvableEffectiveActionType } from "./action-resolution-shared.js";
import {
  decrementActionCooldowns,
  startCooldown,
  type CooldownMap,
} from "../model/cooldown-state.js";
import { decrementActionEffectDurations } from "../effects/effect-duration-decrement.js";
import { expireEffects } from "../effects/effect-expiration-service.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { StateDelta } from "../events/state-delta.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";

interface ActionCompletionContext {
  readonly actionId: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actorId: BattleUnitId;
  /**
   * レビュー再々レビュー[P2]: `ActionCompleting`/`CooldownReduced`/
   * `CooldownCompleted`/`ActionCompleted`を、呼び出し元が保有する
   * `PassiveActivationRuntime`へ接続するためのフック（未指定ならPS解決を
   * 行わない）。`06_戦闘状態遷移.md`のCOMPLETING順序が要求する「`ActionCompleted`
   * とそのPS連鎖をすべて解決した後にスコープを終了する」を満たすには、
   * `finalizeResolutionScope`を呼ぶ前にこれらのイベント自身もPS候補解決を
   * 経由している必要がある（`effect-action-group-resolver.ts`の
   * `onFactEventForPassiveChain`と同じ役割）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

interface ActionCompletionResult {
  readonly completedEventId: DomainEventId;
  readonly units: readonly BattleUnit[];
}

/**
 * `ActionCompleting`/`ActionCompleted`。R-SKL-04 COMPLETING #3-4: 行動者自身の
 * 行動単位クールタイムのうち、現在の行動より前に設定されたものを1減らす
 * （現在の行動で設定されたものは対象外、`decrementActionCooldowns`が判定する）。
 * 戻り値の`completedEventId`は`ActionReservationRemoved`の連鎖に使う。
 *
 * `closingStateDelta`（省略可）は`ActionCompleting`自身が所有する追加の状態差分
 * （`06_戦闘状態遷移.md`「チャージ効果発動」#4のチャージ状態終了など、効果解決
 * より後に観測されるべき差分）。`ActionCompleting`は元々delta無しのTIMING
 * イベントだが、この用途では`stateDelta`を持つ。
 */
export function recordActionCompletion(
  recorder: EventRecorder,
  context: ActionCompletionContext,
  effectiveActionType: ResolvableEffectiveActionType,
  triggeringEventId: DomainEventId,
  units: readonly BattleUnit[],
  closingStateDelta?: StateDelta,
): ActionCompletionResult {
  let working = units;
  const notify = (event: BattleDomainEvent): void => {
    if (context.onFactEventForPassiveChain !== undefined) {
      working = context.onFactEventForPassiveChain(event, working);
    }
  };

  const actionCompleting = recorder.record({
    eventType: "ActionCompleting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    actionId: context.actionId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: triggeringEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { actorUnitId: context.actorId, effectiveActionType },
    ...(closingStateDelta !== undefined ? { stateDelta: closingStateDelta } : {}),
  });
  notify(actionCompleting);

  const actor = requireUnit(working, context.actorId);
  const decrement = decrementActionCooldowns(actor.cooldowns, context.actionId);
  let lastEventId = actionCompleting.eventId;
  if (decrement.changes.length > 0) {
    working = working.map((u) =>
      u.battleUnitId === context.actorId ? { ...u, cooldowns: decrement.cooldowns } : u,
    );
    for (const change of decrement.changes) {
      const reduced = recorder.record({
        eventType: "CooldownReduced",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        actionId: context.actionId,
        resolutionScopeId: context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        sourceUnitId: context.actorId,
        payload: {
          actorUnitId: context.actorId,
          skillDefinitionId: change.skillDefinitionId,
          unit: change.unit,
          before: change.before,
          after: change.after,
        },
        stateDelta: {
          units: {
            [context.actorId]: {
              cooldowns: {
                [change.skillDefinitionId]: {
                  unit: change.unit,
                  before: change.before,
                  after: change.after,
                },
              },
            },
          },
        },
      });
      lastEventId = reduced.eventId;
      notify(reduced);
      if (change.after === 0) {
        const completed = recorder.record({
          eventType: "CooldownCompleted",
          category: "FACT",
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          actionId: context.actionId,
          resolutionScopeId: context.resolutionScopeId,
          parentEventId: lastEventId,
          rootEventId: context.rootEventId,
          sourceUnitId: context.actorId,
          payload: {
            actorUnitId: context.actorId,
            skillDefinitionId: change.skillDefinitionId,
            unit: change.unit,
          },
        });
        lastEventId = completed.eventId;
        notify(completed);
      }
    }
  }

  // R-EFF-04: 対象自身（=この行動者）の行動終了時に、行動単位効果を1減らす。
  // 今回の行動で付与されたものは対象外（`decrementActionEffectDurations`が判定）。
  const actorForEffects = requireUnit(working, context.actorId);
  const effectDecrement = decrementActionEffectDurations(
    actorForEffects.appliedEffects,
    context.actionId,
  );
  if (effectDecrement.changes.length > 0) {
    working = working.map((u) =>
      u.battleUnitId === context.actorId ? { ...u, appliedEffects: effectDecrement.effects } : u,
    );
    const toExpire = effectDecrement.changes
      .filter((change) => change.after === 0)
      .map((change) => ({
        effectInstanceId: change.effectInstanceId,
        reason: "TIME_LIMIT" as const,
      }));
    if (toExpire.length > 0) {
      const expireResult = expireEffects(
        {
          recorder,
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          actionId: context.actionId,
          resolutionScopeId: context.resolutionScopeId,
          rootEventId: context.rootEventId,
        },
        working,
        context.actorId,
        toExpire,
        lastEventId,
      );
      working = expireResult.units;
      lastEventId = expireResult.lastEventId;
      for (const event of expireResult.events) {
        notify(event);
      }
    }
  }

  const actionCompleted = recorder.record({
    eventType: "ActionCompleted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    actionId: context.actionId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { actorUnitId: context.actorId, effectiveActionType },
  });
  notify(actionCompleted);
  return { completedEventId: actionCompleted.eventId, units: working };
}

interface CooldownStartContext {
  /** PS発動がターン開始/終了などアクション外のトップレベルイベントから起きた場合は`undefined`（`unit: "ACTION"`のクールタイムはその場合設定できない）。 */
  readonly actionId?: ActionId;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly actorId: BattleUnitId;
  /** レビュー指摘[P2]: 同じSkillUseに属するイベントは同じSkillUseIdを持つ契約（PSも1つのSkillUse）。呼び出し側が採番済みの場合だけ渡す。 */
  readonly skillUseId?: SkillUseId;
}

interface CooldownStartResult {
  readonly cooldowns: CooldownMap;
  readonly lastEventId: DomainEventId;
}

/**
 * R-SKL-04: スキル使用開始時（AS/EX/チャージ開始のいずれも）にクールタイムを
 * 設定する。`skill.cooldown.count`が0のスキルはCOOLING状態へ遷移しないため
 * `CooldownStarted`を発行しない（`startCooldown`が既に判定済み）。設定scope
 * は`skill.cooldown.unit`により行動単位(`actionId`)またはターン単位
 * (`turnNumber`)を選ぶ（PR#128レビュー[P1]: 呼び出し側が`unit`を無視して常に
 * `actionId`を渡すと、TURN単位クールタイムが設定ターン末に誤って減算される）。
 *
 * `unit: "ACTION"`でも`context.actionId`が無い場合（PS発動がターン開始・終了
 * など行動外のトップレベルイベントから起きた場合、PR #141再レビュー[P1]）は
 * `scope`を`undefined`のまま`startCooldown`へ渡す。`count`が0ならそもそも
 * `scope`を使わないため問題にならず、`count`が正でも`setActionId`を持たない
 * エントリとして設定され、所有者の次の行動終了時（`decrementActionCooldowns`）
 * に正しく1減らせる。
 */
export function recordCooldownStart(
  recorder: EventRecorder,
  context: CooldownStartContext,
  cooldowns: CooldownMap,
  skill: SkillDefinition,
  parentEventId: DomainEventId,
  rootEventId: DomainEventId,
): CooldownStartResult {
  const scope: { readonly actionId: ActionId } | { readonly turnNumber: number } | undefined =
    skill.cooldown.unit === "TURN"
      ? { turnNumber: context.turnNumber }
      : context.actionId !== undefined
        ? { actionId: context.actionId }
        : undefined;
  const result = startCooldown(cooldowns, skill.skillDefinitionId, skill.cooldown, scope);
  if (skill.cooldown.count === 0) {
    return { cooldowns: result.cooldowns, lastEventId: parentEventId };
  }
  const started = recorder.record({
    eventType: "CooldownStarted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId,
    sourceUnitId: context.actorId,
    payload: {
      actorUnitId: context.actorId,
      skillDefinitionId: skill.skillDefinitionId,
      unit: skill.cooldown.unit,
      initialRemaining: skill.cooldown.count,
    },
    stateDelta: {
      units: {
        [context.actorId]: {
          cooldowns: {
            [skill.skillDefinitionId]: {
              unit: skill.cooldown.unit,
              before: result.before,
              after: skill.cooldown.count,
              ...(scope === undefined
                ? {}
                : "actionId" in scope
                  ? { setActionId: scope.actionId }
                  : { setTurnNumber: scope.turnNumber }),
            },
          },
        },
      },
    },
  });
  return { cooldowns: result.cooldowns, lastEventId: started.eventId };
}
