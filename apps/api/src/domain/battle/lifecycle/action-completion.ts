import { requireUnit, type ResolvableEffectiveActionType } from "./action-resolution-shared.js";
import {
  decrementActionCooldowns,
  startCooldown,
  type CooldownMap,
} from "../model/cooldown-state.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
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

  const actor = requireUnit(units, context.actorId);
  const decrement = decrementActionCooldowns(actor.cooldowns, context.actionId);
  let working = units;
  let lastEventId = actionCompleting.eventId;
  if (decrement.changes.length > 0) {
    working = units.map((u) =>
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
  return { completedEventId: actionCompleted.eventId, units: working };
}

interface CooldownStartContext {
  readonly actionId: ActionId;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly actorId: BattleUnitId;
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
 */
export function recordCooldownStart(
  recorder: EventRecorder,
  context: CooldownStartContext,
  cooldowns: CooldownMap,
  skill: SkillDefinition,
  parentEventId: DomainEventId,
  rootEventId: DomainEventId,
): CooldownStartResult {
  const scope: { readonly actionId: ActionId } | { readonly turnNumber: number } =
    skill.cooldown.unit === "TURN"
      ? { turnNumber: context.turnNumber }
      : { actionId: context.actionId };
  const result = startCooldown(cooldowns, skill.skillDefinitionId, skill.cooldown, scope);
  if (skill.cooldown.count === 0) {
    return { cooldowns: result.cooldowns, lastEventId: parentEventId };
  }
  const started = recorder.record({
    eventType: "CooldownStarted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    actionId: context.actionId,
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
              ...("actionId" in scope
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
