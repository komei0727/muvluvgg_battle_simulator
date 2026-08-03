import type { BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { DamageEventContext, DepletedAbsorberReason } from "./damage-event-context.js";
import type { DomainEventId, EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-STS-03（凍結解除）／R-SHD-01第3項・R-SUB-01（吸収先の個別消滅条件）が要求する効果除去。
 * `combat/`は`effects/`へ依存できない（module境界）ため、R-EFF-09の`linkedEffectGroupId`
 * カスケードとCombatStat再計算を伴う完全な処理は呼び出し側（`lifecycle/`）が注入する
 * hookが担う。このモジュールはhookへのディスパッチと、hookを用意しない単体テスト向けの
 * 最小fallbackだけを持つ。
 */

/** 除去1件ごとに`yield`する、`driveRemovalSteps`が駆動できる形のgenerator。 */
type RemovalSteps = Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
>;

/**
 * R-STS-03: 凍結を解除する。`context.removeFreezeEffect`（呼び出し側が注入する完全版）が
 * あればそれへ、無ければ`fallbackRemoveFreezeEffectSteps`へ委譲する。
 */
export function removeFreezeEffectSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  freezeEffect: AppliedEffect,
  triggeringDamage: number,
  parentEventId: DomainEventId,
): RemovalSteps {
  return context.removeFreezeEffect !== undefined
    ? context.removeFreezeEffect(
        targetUnitId,
        freezeEffect.effectInstanceId,
        triggeringDamage,
        units,
        parentEventId,
      )
    : fallbackRemoveFreezeEffectSteps(
        context,
        units,
        targetUnitId,
        freezeEffect,
        triggeringDamage,
        parentEventId,
      );
}

/**
 * `context.removeFreezeEffect`未指定時のfallback。`AppliedEffect`を直接filterし
 * `FreezeRemoved`だけを発行する — R-EFF-09のlinkedEffectGroupカスケードも
 * CombatStat再計算も行わない（`combat/`は`effects/`へ依存できないため、
 * どちらも呼び出し側が注入する`removeFreezeEffect`でしか実現できない）。
 * production経路（`effect-action-group-resolver.ts`）は常にこのhookを注入する
 * ため、この簡易版が実際に使われるのはhookを用意しない単体テストだけ。
 */
function* fallbackRemoveFreezeEffectSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  freezeEffect: AppliedEffect,
  triggeringDamage: number,
  parentEventId: DomainEventId,
): RemovalSteps {
  const eventsStart = context.recorder.getEvents().length;
  const freezeRemoved = context.recorder.record({
    eventType: "FreezeRemoved",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: targetUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectInstanceId: freezeEffect.effectInstanceId,
      battleUnitId: targetUnitId,
      triggeringDamage,
    },
    stateDelta: {
      units: {
        [targetUnitId]: {
          effects: {
            [freezeEffect.effectInstanceId]: {
              before: toEffectSnapshot(freezeEffect, true),
              after: undefined,
            },
          },
        },
      },
    },
  });
  const updatedUnits = units.map((unit) =>
    unit.battleUnitId === targetUnitId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.filter(
            (effect) => effect.effectInstanceId !== freezeEffect.effectInstanceId,
          ),
        }
      : unit,
  );
  const injected = yield {
    events: context.recorder.getEvents().slice(eventsStart),
    units: updatedUnits,
  };
  return { units: injected ?? updatedUnits, lastEventId: freezeRemoved.eventId };
}

/**
 * R-SHD-01第3項／R-SUB-01（個別消滅条件）: 残量・耐久力が0になった吸収先を
 * 失効させる。`context.expireDepletedAbsorbers`（呼び出し側が注入する完全版）が
 * あればそれへ、無ければ`fallbackExpireDepletedAbsorberSteps`へ委譲する。
 */
export function expireDepletedAbsorberSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  depletedEffectInstanceIds: readonly EffectInstanceId[],
  reason: DepletedAbsorberReason,
  parentEventId: DomainEventId,
): RemovalSteps {
  return context.expireDepletedAbsorbers !== undefined
    ? context.expireDepletedAbsorbers(
        targetUnitId,
        depletedEffectInstanceIds,
        reason,
        units,
        parentEventId,
      )
    : fallbackExpireDepletedAbsorberSteps(
        context,
        units,
        targetUnitId,
        depletedEffectInstanceIds,
        reason,
        parentEventId,
      );
}

/**
 * `context.expireDepletedAbsorbers`未指定時のfallback。`fallbackRemoveFreezeEffectSteps`
 * とまったく同じ役割・同じ制限（R-EFF-09カスケードもCombatStat再計算も行わない）
 * を持つ、単体テスト向けの最小動作。production経路
 * （`effect-action-group-resolver.ts`）は常にhookを注入する。
 */
function* fallbackExpireDepletedAbsorberSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  depletedEffectInstanceIds: readonly EffectInstanceId[],
  reason: DepletedAbsorberReason,
  parentEventId: DomainEventId,
): RemovalSteps {
  let working = units;
  let lastEventId = parentEventId;
  for (const effectInstanceId of depletedEffectInstanceIds) {
    const holder = working.find((unit) => unit.battleUnitId === targetUnitId);
    const expiring = holder?.appliedEffects.find(
      (effect) => effect.effectInstanceId === effectInstanceId,
    );
    if (expiring === undefined) {
      continue;
    }
    const eventsStart = context.recorder.getEvents().length;
    const expired = context.recorder.record({
      eventType: "EffectExpired",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: targetUnitId,
      targetUnitIds: [targetUnitId],
      payload: {
        effectInstanceId,
        battleUnitId: targetUnitId,
        effectActionDefinitionId: expiring.effectActionDefinitionId,
        kindKey: expiring.kindKey,
        reason,
        linkedEffectGroupId: expiring.duration.definition.linkedEffectGroupId,
        cascaded: false,
      },
      stateDelta: {
        units: {
          [targetUnitId]: {
            effects: {
              [effectInstanceId]: { before: toEffectSnapshot(expiring, true), after: undefined },
            },
          },
        },
      },
    });
    working = working.map((unit) =>
      unit.battleUnitId === targetUnitId
        ? {
            ...unit,
            appliedEffects: unit.appliedEffects.filter(
              (effect) => effect.effectInstanceId !== effectInstanceId,
            ),
          }
        : unit,
    );
    lastEventId = expired.eventId;
    const injected = yield {
      events: context.recorder.getEvents().slice(eventsStart),
      units: working,
    };
    working = injected ?? working;
  }
  return { units: working, lastEventId };
}
