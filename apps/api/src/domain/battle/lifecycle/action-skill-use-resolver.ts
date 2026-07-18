import {
  consumeAp,
  consumeExGaugeFully,
  increaseExGauge,
  recordExtraGaugeOverflowDiscardedIfAny,
  recordResourceChangeIfAny,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion, recordCooldownStart } from "./action-completion.js";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import { resolveSkillOrder } from "../skill/skill-resolution-service.js";
import type { ActionId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { TargetBindingDefinition } from "../../catalog/definitions/effect-sequence.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";

/** `08_ドメインイベント.md`「TargetsSelected」payload: targetBindingごとの解決対象。 */
export function resolveBindingSelections(
  targetBindings: readonly TargetBindingDefinition[],
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): readonly { targetBindingId: string; selectedTargetUnitIds: readonly BattleUnitId[] }[] {
  return targetBindings.map((binding) => ({
    targetBindingId: binding.targetBindingId,
    selectedTargetUnitIds: resolveTargets(binding.selector, actor, allUnits).map(
      (unit) => unit.battleUnitId,
    ),
  }));
}

/**
 * `06_戦闘状態遷移.md` のRESOURCE_CONSUMING〜COMPLETINGのうちAS/EXが共有する
 * 手順（`EX` はASと同じイベント・効果解決手順を使用し、APを消費せず開始時に
 * EXゲージを全量消費する点だけが異なる）。DAMAGE以外のEffectActionKindの解決は
 * 対象外（M6/M7）。
 */
export function resolveSkillUse(
  actor: BattleUnit,
  skill: SkillDefinition,
  effectiveActionType: "AS" | "EX",
  reservedActionType: ReservedActionKind,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
  actionId: ActionId,
  actionScope: ResolutionScopeId,
): ActionResolutionResult {
  const actorId = actor.battleUnitId;
  // R-ACT-03: ASは消費APと同量、EXは増加なし。
  let working =
    effectiveActionType === "EX"
      ? consumeExGaugeFully(units, actorId)
      : consumeAp(units, actorId, skill.cost.amount);
  const actorAfterCost = requireUnit(working, actorId);

  const exGain =
    effectiveActionType === "AS" ? increaseExGauge(working, actorId, skill.cost.amount) : undefined;
  if (exGain !== undefined) {
    working = exGain.units;
  }
  const actorAfterExGain = requireUnit(working, actorId);

  const actionStarted = recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    sourceUnitId: actorId,
    payload: {
      actorUnitId: actorId,
      reservedActionType,
      effectiveActionType,
      apBefore: actor.currentAp,
      apAfter: actorAfterCost.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actorAfterExGain.currentExtraGauge,
    },
  });

  // Issue #34 (R-PS-07): PS発動済み集合を1解決スコープ（=1行動）ごとに破棄する
  // ため、`PassiveActivationRuntime`もこの行動専用に1つだけ生成する。
  const passiveRuntime = new PassiveActivationRuntime(
    {
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      actionId,
    },
    working,
  );

  const resourceChangeContext = {
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    rootEventId: actionStarted.eventId,
  };
  // R-ACT-04: 消費を先に適用し、その後に増加を適用する（両方とも変化量0では発行しない）。
  let lastEventId =
    effectiveActionType === "EX"
      ? recordResourceChangeIfAny(
          resourceChangeContext,
          actorId,
          "EX_GAUGE",
          actor.currentExtraGauge,
          actorAfterCost.currentExtraGauge,
          "SKILL_COST",
          actionStarted.eventId,
          actionStarted.eventId,
        )
      : recordResourceChangeIfAny(
          resourceChangeContext,
          actorId,
          "AP",
          actor.currentAp,
          actorAfterCost.currentAp,
          "SKILL_COST",
          actionStarted.eventId,
          actionStarted.eventId,
        );
  if (exGain !== undefined) {
    lastEventId = recordResourceChangeIfAny(
      resourceChangeContext,
      actorId,
      "EX_GAUGE",
      exGain.before,
      exGain.after,
      "EX_GAIN",
      lastEventId,
      actionStarted.eventId,
    );
    lastEventId = recordExtraGaugeOverflowDiscardedIfAny(
      resourceChangeContext,
      actorId,
      exGain.requestedAmount,
      exGain.after - exGain.before,
      exGain.discardedAmount,
      lastEventId,
    );
  }

  const plan = resolveSkillOrder(skill, actorAfterExGain, working, definitions.effectActions);
  const targetUnitIds = [...new Set(plan.map((entry) => entry.targetBattleUnitId))];

  const skillUseId = recorder.nextSkillUseId();
  const targetsSelected = recorder.record({
    eventType: "TargetsSelected",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    resolutionScopeId: actionScope,
    parentEventId: lastEventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    targetUnitIds,
    payload: {
      skillDefinitionId: skill.skillDefinitionId,
      // `plan`(直前の`resolveSkillOrder`呼び出し)が既にkind==="IMMEDIATE"を検証済み。
      bindings:
        skill.resolution.kind === "IMMEDIATE"
          ? resolveBindingSelections(skill.resolution.targetBindings, actorAfterCost, working)
          : [],
    },
  });

  const skillUseStarting = recorder.record({
    eventType: "SkillUseStarting",
    category: "TIMING",
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    resolutionScopeId: actionScope,
    parentEventId: targetsSelected.eventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    targetUnitIds,
    payload: {
      skillDefinitionId: skill.skillDefinitionId,
      actorUnitId: actorId,
      targetUnitIds,
      costResource: skill.cost.resource,
      costAmount: skill.cost.amount,
    },
  });

  // R-SKL-04 #4: 使用したスキルへクールタイムを設定し、現在の行動IDを設定
  // スコープとして記録する（SkillUseStarting発行後、SkillUseStarted発行前）。
  const cooldownResult = recordCooldownStart(
    recorder,
    { actionId, turnNumber, cycleNumber, resolutionScopeId: actionScope, actorId },
    actorAfterExGain.cooldowns,
    skill,
    skillUseStarting.eventId,
    actionStarted.eventId,
  );
  const actorWithCooldown = { ...actorAfterExGain, cooldowns: cooldownResult.cooldowns };
  working = working.map((u) => (u.battleUnitId === actorId ? actorWithCooldown : u));

  const skillUseStarted = recorder.record({
    eventType: "SkillUseStarted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    resolutionScopeId: actionScope,
    parentEventId: cooldownResult.lastEventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    targetUnitIds,
    payload: {
      skillDefinitionId: skill.skillDefinitionId,
      costResource: skill.cost.resource,
      costAmount: skill.cost.amount,
    },
  });

  working = applyEffectActionGroups(plan, working, {
    definitions,
    actorId,
    random,
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    actionScope,
    rootEventId: actionStarted.eventId,
    parentEventId: skillUseStarted.eventId,
    skillDefinitionId: skill.skillDefinitionId,
    onFactEventForPassiveChain: (event, units) => passiveRuntime.onFactEvent(event, units),
  });

  const skillUseCompleted = recorder.record({
    eventType: "SkillUseCompleted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    resolutionScopeId: actionScope,
    parentEventId: skillUseStarted.eventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    targetUnitIds,
    payload: {
      skillDefinitionId: skill.skillDefinitionId,
      resolvedStepCount: skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps.length : 0,
      targetUnitIds,
    },
  });

  const completion = recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
    },
    effectiveActionType,
    skillUseCompleted.eventId,
    working,
  );

  return {
    units: completion.units,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}
