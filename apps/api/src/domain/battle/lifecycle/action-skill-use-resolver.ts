import {
  consumeAp,
  consumeExGaugeFully,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion, recordCooldownStart } from "./action-completion.js";
import { applyCooldownManipulationAction } from "./cooldown-manipulation-application-service.js";
import { applyDamageAction } from "../combat/damage-application-service.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import {
  resolveSkillOrder,
  type ResolvedEffectApplication,
} from "../skill/skill-resolution-service.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { TargetBindingDefinition } from "../../catalog/definitions/effect-sequence.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";

interface EffectActionGroup {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hits: ResolvedEffectApplication[];
}

/** `resolveSkillOrder` の定義順出力を、同一EffectActionDefinitionIdの連続runでまとめる。 */
function groupConsecutiveByEffectAction(
  plan: readonly ResolvedEffectApplication[],
): readonly EffectActionGroup[] {
  const groups: EffectActionGroup[] = [];
  for (const entry of plan) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.effectActionDefinitionId === entry.effectActionDefinitionId) {
      last.hits.push(entry);
    } else {
      groups.push({ effectActionDefinitionId: entry.effectActionDefinitionId, hits: [entry] });
    }
  }
  return groups;
}

/** `groupConsecutiveByEffectAction`が生成したgroupを解決するために共有される因果関係コンテキスト。 */
interface EffectActionGroupContext {
  readonly definitions: BattleDefinitions;
  readonly actorId: BattleUnitId;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId: ActionId;
  readonly skillUseId: SkillUseId;
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
}

/**
 * AS/EX使用（`resolveSkillUse`）とチャージ発動（`resolveChargeRelease`）の両方が
 * 使う、EffectActionDefinitionId単位groupの適用ループ。Issue #129:
 * `DAMAGE`に加えて`COOLDOWN_MANIPULATION`（対象スキルのクールタイムを
 * 短縮・リセットする純粋な状態操作）を解釈する。それ以外のkindはM6/M7/M8
 * スコープのため未対応のまま拒否する。
 */
export function applyEffectActionGroups(
  plan: readonly ResolvedEffectApplication[],
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
): readonly BattleUnit[] {
  let working = units;
  for (const group of groupConsecutiveByEffectAction(plan)) {
    const effectAction = context.definitions.effectActions.get(group.effectActionDefinitionId);
    if (effectAction === undefined) {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `effectActionDefinitionId "${group.effectActionDefinitionId}" was not found in the given effectActions (Catalog preflight should already guarantee this reference exists)`,
      );
    }
    if (effectAction.kind === "DAMAGE") {
      const currentActor = requireUnit(working, context.actorId);
      const result = applyDamageAction(
        currentActor,
        group.hits,
        effectAction,
        working,
        context.random,
        {
          recorder: context.recorder,
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          actionId: context.actionId,
          skillUseId: context.skillUseId,
          resolutionScopeId: context.actionScope,
          rootEventId: context.rootEventId,
          parentEventId: context.parentEventId,
          skillDefinitionId: context.skillDefinitionId,
        },
      );
      working = result.units;
    } else if (effectAction.kind === "COOLDOWN_MANIPULATION") {
      const result = applyCooldownManipulationAction(group.hits, effectAction, working, {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        actionId: context.actionId,
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        parentEventId: context.parentEventId,
        sourceUnitId: context.actorId,
      });
      working = result.units;
    } else {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `EffectAction kind other than "DAMAGE"/"COOLDOWN_MANIPULATION" is not supported by this basic turn action resolver (M6/M7/M8 scope)`,
      );
    }
  }
  return working;
}

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
  let working =
    effectiveActionType === "EX"
      ? consumeExGaugeFully(units, actorId)
      : consumeAp(units, actorId, skill.cost.amount);
  const actorAfterCost = requireUnit(working, actorId);
  const stateDeltaEntry =
    effectiveActionType === "EX"
      ? { extraGauge: { before: actor.currentExtraGauge, after: actorAfterCost.currentExtraGauge } }
      : { ap: { before: actor.currentAp, after: actorAfterCost.currentAp } };

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
      exAfter: actorAfterCost.currentExtraGauge,
    },
    stateDelta: { units: { [actorId]: stateDeltaEntry } },
  });

  const plan = resolveSkillOrder(skill, actorAfterCost, working, definitions.effectActions);
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
    parentEventId: actionStarted.eventId,
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
    actorAfterCost.cooldowns,
    skill,
    skillUseStarting.eventId,
    actionStarted.eventId,
  );
  const actorWithCooldown = { ...actorAfterCost, cooldowns: cooldownResult.cooldowns };
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
