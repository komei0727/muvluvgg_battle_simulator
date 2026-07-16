import { createActionQueue, type ReservedActionKind } from "./action-queue.js";
import { isExUsable, selectAsCandidate } from "./action-selection-policy.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import { isDefeated, type BattleUnit } from "./battle-unit.js";
import { decrementActionCooldowns, startCooldown, type CooldownMap } from "./cooldown-state.js";
import { applyDamageAction } from "./damage-application-service.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "./events/event-ids.js";
import type { EventRecorder } from "./events/event-recorder.js";
import { createActionPoint, createExtraGauge } from "./resource-gauge.js";
import { resolveTargets } from "./target-selection-policy.js";
import {
  resolveChargeReleaseOrder,
  resolveSkillOrder,
  type ResolvedEffectApplication,
} from "./skill-resolution-service.js";
import { resolveVictory, type VictoryResult } from "./victory-policy.js";
import type { EffectActionDefinitionId } from "../catalog/catalog-ids.js";
import type { TargetBindingDefinition } from "../catalog/effect-sequence.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";
import type { RandomSource } from "../ports/random-source.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";

export interface ActionPhaseResult {
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  /** `undefined` means the phase drained naturally without a victory being resolved. */
  readonly result: VictoryResult | undefined;
}

function requireUnit(units: readonly BattleUnit[], id: BattleUnitId): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === id);
  if (unit === undefined) {
    throw new DomainValidationError("battleUnitId", `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

function consumeAp(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentAp: createActionPoint(unit.currentAp - amount, unit.maximumAp) }
      : unit,
  );
}

/** R-ACT-03（EX行）: APは消費せず、EXゲージを全量消費する。 */
function consumeExGaugeFully(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentExtraGauge: createExtraGauge(0, unit.maximumExtraGauge) }
      : unit,
  );
}

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

/** `08_ドメインイベント.md`「TargetsSelected」payload: targetBindingごとの解決対象。 */
function resolveBindingSelections(
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

/** 1行動の解決結果。呼び出し側（`resolveActionPhase`）が`ActionReservationRemoved`を同じ解決スコープへ連鎖させるために使う。 */
interface ActionResolutionResult {
  readonly units: readonly BattleUnit[];
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly completedEventId: DomainEventId;
}

type ResolvableEffectiveActionType = "AS" | "EX" | "WAIT" | "CHARGE_RELEASE";

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
 */
function recordActionCompletion(
  recorder: EventRecorder,
  context: ActionCompletionContext,
  effectiveActionType: ResolvableEffectiveActionType,
  triggeringEventId: DomainEventId,
  units: readonly BattleUnit[],
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
 * `CooldownStarted`を発行しない（`startCooldown`が既に判定済み）。
 */
function recordCooldownStart(
  recorder: EventRecorder,
  context: CooldownStartContext,
  cooldowns: CooldownMap,
  skill: SkillDefinition,
  scope: { readonly actionId: ActionId } | { readonly turnNumber: number },
  parentEventId: DomainEventId,
  rootEventId: DomainEventId,
): CooldownStartResult {
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
            },
          },
        },
      },
    },
  });
  return { cooldowns: result.cooldowns, lastEventId: started.eventId };
}

/**
 * `06_戦闘状態遷移.md`「待機」: `通常の待機`（AP1消費）と、`Q-BTL-06`の
 * 「AP0・EX満タン・行動不能」（EXゲージ全量消費）の2通りを共通で扱う。
 * どちらもEXゲージ増加(R-ACT-04)は対象外（M6スコープ）。
 */
function resolveWait(
  actor: BattleUnit,
  reservedActionType: ReservedActionKind,
  waitReason: string,
  consumedResource: "AP" | "EX_GAUGE",
  units: readonly BattleUnit[],
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
  actionId: ActionId,
  actionScope: ResolutionScopeId,
): ActionResolutionResult {
  const actorId = actor.battleUnitId;
  const consumedAmount = consumedResource === "AP" ? 1 : actor.currentExtraGauge;
  const working =
    consumedResource === "AP"
      ? consumeAp(units, actorId, consumedAmount)
      : consumeExGaugeFully(units, actorId);
  const actorAfter = requireUnit(working, actorId);
  const stateDeltaEntry =
    consumedResource === "AP"
      ? { ap: { before: actor.currentAp, after: actorAfter.currentAp } }
      : { extraGauge: { before: actor.currentExtraGauge, after: actorAfter.currentExtraGauge } };

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
      effectiveActionType: "WAIT",
      apBefore: actor.currentAp,
      apAfter: actorAfter.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actorAfter.currentExtraGauge,
      waitReason,
    },
    stateDelta: { units: { [actorId]: stateDeltaEntry } },
  });

  const actionWaited = recorder.record({
    eventType: "ActionWaited",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    parentEventId: actionStarted.eventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    payload: {
      actorUnitId: actorId,
      waitReason,
      consumedResource,
      consumedAmount,
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
    "WAIT",
    actionWaited.eventId,
    working,
  );

  return {
    units: completion.units,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}

/**
 * `06_戦闘状態遷移.md` のRESOURCE_CONSUMING〜COMPLETINGのうちAS/EXが共有する
 * 手順（`EX` はASと同じイベント・効果解決手順を使用し、APを消費せず開始時に
 * EXゲージを全量消費する点だけが異なる）。DAMAGE以外のEffectActionKindの解決は
 * 対象外（M6/M7）。
 */
function resolveSkillUse(
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
    { actionId },
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

  for (const group of groupConsecutiveByEffectAction(plan)) {
    const effectAction = definitions.effectActions.get(group.effectActionDefinitionId);
    if (effectAction === undefined || effectAction.kind !== "DAMAGE") {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `EffectAction kind other than "DAMAGE" is not supported by this basic turn action resolver (M6/M7 scope)`,
      );
    }
    const currentActor = requireUnit(working, actorId);
    const result = applyDamageAction(currentActor, group.hits, effectAction, working, random, {
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      skillUseId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      parentEventId: skillUseStarted.eventId,
      skillDefinitionId: skill.skillDefinitionId,
    });
    working = result.units;
  }

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

/**
 * `06_戦闘状態遷移.md`「チャージ開始」: 元スキルのコストはRESOURCE_CONSUMINGで
 * 既に消費済みとして扱い、`ActionStarted`直後にクールタイムを設定し、ユニットを
 * チャージ中にする。気絶・凍結によるキャンセル/保持はStunned/Frozenが未実装
 * （M7）のため対象外。チャージ開始自体は予約種別(AS/EX)と同じeffectiveActionType
 * として完了する（R-ACT-03「チャージ開始時に元スキルのコストを消費済み」）。
 */
function resolveChargeStart(
  actor: BattleUnit,
  skill: SkillDefinition,
  effectiveActionType: "AS" | "EX",
  reservedActionType: ReservedActionKind,
  units: readonly BattleUnit[],
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

  // R-SKL-05 #2: 元スキルへクールタイムを設定し、現在の行動IDを設定スコープとして記録する。
  const cooldownResult = recordCooldownStart(
    recorder,
    { actionId, turnNumber, cycleNumber, resolutionScopeId: actionScope, actorId },
    actorAfterCost.cooldowns,
    skill,
    { actionId },
    actionStarted.eventId,
    actionStarted.eventId,
  );

  const chargingUnit: BattleUnit = {
    ...actorAfterCost,
    cooldowns: cooldownResult.cooldowns,
    charge: { skill, startedActionId: actionId },
  };
  working = working.map((u) => (u.battleUnitId === actorId ? chargingUnit : u));

  const chargeStarted = recorder.record({
    eventType: "ChargeStarted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    parentEventId: cooldownResult.lastEventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
    payload: {
      actorUnitId: actorId,
      skillDefinitionId: skill.skillDefinitionId,
      startedActionId: actionId,
    },
    stateDelta: {
      units: {
        [actorId]: {
          charge: {
            before: undefined,
            after: { skillDefinitionId: skill.skillDefinitionId, startedActionId: actionId },
          },
        },
      },
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
    chargeStarted.eventId,
    working,
  );

  return {
    units: completion.units,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}

/**
 * `06_戦闘状態遷移.md`「チャージ効果発動」: AP・EXゲージを消費せず、
 * `chargeRelease` EffectSequenceを解決する。チャージ開始とは別の一つの行動
 * として完了する（`completedEventId`のActionIdは呼び出し元が新規採番した
 * ものであり、`charge.startedActionId`とは異なる）。
 */
function resolveChargeRelease(
  actor: BattleUnit,
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
  const charge = actor.charge;
  if (charge === undefined) {
    throw new DomainValidationError(
      "actor.charge",
      "resolveChargeRelease requires a pending charge",
    );
  }
  const skill = charge.skill;

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
      effectiveActionType: "CHARGE_RELEASE",
      apBefore: actor.currentAp,
      apAfter: actor.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actor.currentExtraGauge,
    },
  });

  let working = units;
  const plan = resolveChargeReleaseOrder(skill, actor, working, definitions.effectActions);
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
      // `plan`(直前の`resolveChargeReleaseOrder`呼び出し)が既にkind==="CHARGE"を検証済み。
      bindings:
        skill.resolution.kind === "CHARGE"
          ? resolveBindingSelections(skill.resolution.chargeRelease.targetBindings, actor, working)
          : [],
    },
  });

  const chargeReleased = recorder.record({
    eventType: "ChargeReleased",
    category: "FACT",
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
      actorUnitId: actorId,
      skillDefinitionId: skill.skillDefinitionId,
      chargeStartActionId: charge.startedActionId,
      releaseActionId: actionId,
    },
    stateDelta: {
      units: {
        [actorId]: {
          charge: {
            before: {
              skillDefinitionId: skill.skillDefinitionId,
              startedActionId: charge.startedActionId,
            },
            after: undefined,
          },
        },
      },
    },
  });

  // R-SKL-05 #4: チャージ状態を終了する（効果解決前に、以降の解決対象からは除く）。
  working = working.map((u) => {
    if (u.battleUnitId !== actorId) {
      return u;
    }
    const { charge: _charge, ...withoutCharge } = u;
    return withoutCharge;
  });

  for (const group of groupConsecutiveByEffectAction(plan)) {
    const effectAction = definitions.effectActions.get(group.effectActionDefinitionId);
    if (effectAction === undefined || effectAction.kind !== "DAMAGE") {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `EffectAction kind other than "DAMAGE" is not supported by this basic turn action resolver (M6/M7 scope)`,
      );
    }
    const currentActor = requireUnit(working, actorId);
    const result = applyDamageAction(currentActor, group.hits, effectAction, working, random, {
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      skillUseId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      parentEventId: chargeReleased.eventId,
      skillDefinitionId: skill.skillDefinitionId,
    });
    working = result.units;
  }

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
    "CHARGE_RELEASE",
    chargeReleased.eventId,
    working,
  );

  return {
    units: completion.units,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}

/**
 * `06_戦闘状態遷移.md` のDECIDING〜COMPLETINGの基本形。R-ACT-01の優先順のうち
 * 気絶・凍結(M7)を除いた「発動待ちのチャージ効果があれば予約より優先して発動する
 * ／EX予約ならEXスキルを使用する／AS予約なら使用可能なASを選ぶ／なければ待機
 * する」を実装する。R-ACT-03の一部（AS/EXのコスト消費、通常の待機によるAP1消費、
 * `Q-BTL-06`のEXゲージ全量消費による待機、チャージ開始・発動の無消費）だけを
 * 実装する。EXゲージ増加(R-ACT-04)、気絶・凍結(M7)、PS/Memory連鎖(M6)はこの関数の
 * 対象外。`ActionStarted`が自身の解決スコープを開き（`08_ドメインイベント.md`
 * 「resolutionScopeId」はActionIdと対応する）、`ActionCompleted`までの全イベント
 * がそのrootEventIdを共有する。
 */
function resolveOneAction(
  actorId: BattleUnitId,
  reservedActionType: ReservedActionKind,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
): ActionResolutionResult {
  const actor = requireUnit(units, actorId);
  const actionId = recorder.nextActionId();
  const actionScope = recorder.nextResolutionScopeId();

  // R-ACT-01 #3（気絶・凍結による阻害はM7）: 発動待ちのチャージ効果は予約
  // されたAS/EXより優先して発動する。
  if (actor.charge !== undefined) {
    return resolveChargeRelease(
      actor,
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  if (reservedActionType === "EX") {
    const exSkill = definitions.exSkillByUnit.get(actor.unitDefinitionId);
    if (exSkill === undefined) {
      throw new DomainValidationError(
        "unitDefinitionId",
        `references a UnitDefinitionId absent from the given exSkillByUnit: "${actor.unitDefinitionId}"`,
      );
    }
    // R-ACT-01 #5 / Q-BTL-06: 対象候補がなければEXは使用不能とし、EXゲージ全量を
    // 消費して待機する。
    if (!isExUsable(exSkill, actor, units)) {
      return resolveWait(
        actor,
        reservedActionType,
        "EX_UNUSABLE",
        "EX_GAUGE",
        units,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        actionScope,
      );
    }
    if (exSkill.resolution.kind === "CHARGE") {
      return resolveChargeStart(
        actor,
        exSkill,
        "EX",
        reservedActionType,
        units,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        actionScope,
      );
    }
    return resolveSkillUse(
      actor,
      exSkill,
      "EX",
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  const activeSkills = definitions.activeSkillsByUnit.get(actor.unitDefinitionId) ?? [];
  const selection = selectAsCandidate(activeSkills, actor, units);

  if (selection.kind === "WAIT") {
    return resolveWait(
      actor,
      reservedActionType,
      "NO_USABLE_ACTIVE_SKILL",
      "AP",
      units,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  if (selection.skill.resolution.kind === "CHARGE") {
    return resolveChargeStart(
      actor,
      selection.skill,
      "AS",
      reservedActionType,
      units,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  return resolveSkillUse(
    actor,
    selection.skill,
    "AS",
    reservedActionType,
    units,
    definitions,
    random,
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    actionScope,
  );
}

function splitBySide(units: readonly BattleUnit[]): {
  ally: readonly BattleUnit[];
  enemy: readonly BattleUnit[];
} {
  return {
    ally: units.filter((unit) => unit.side === "ALLY"),
    enemy: units.filter((unit) => unit.side === "ENEMY"),
  };
}

/**
 * `06_戦闘状態遷移.md` のQUEUE_BUILDING〜ACTION_RESOLUTIONを、使用可能な行動が
 * 無くなるまで繰り返す（`createActionQueue` が空を返した時点で終了）。各1行動
 * 完了後にR-END-01タイミング#1（ユニットの1行動完了後）の勝敗判定を行い、
 * 確定した時点で残りの行動を打ち切る。PS/Memory連鎖(M6)は行わない。
 * `ActionQueueCreated`は周回ごとに発行し、ターンの解決スコープ（`turnRootEventId`）
 * を共有する。行動自体（`ActionStarted`以降）は自分自身の解決スコープを新しく開く。
 */
export function resolveActionPhase(
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  turnRootEventId: DomainEventId,
  turnScopeParentEventId: DomainEventId,
): ActionPhaseResult {
  let units: readonly BattleUnit[] = [...allyUnits, ...enemyUnits];
  let cycleNumber = 0;
  let turnScopeParent = turnScopeParentEventId;

  // R-ACT-03: AS・PS・EXのコストは1以上であり、Catalog検証（`createCost`/
  // JSON Schema）がコスト0の定義を生成前に拒否する。このガードは、それでも
  // コスト0相当のASが紛れ込んだ場合(不正データ、将来のバグ)への多層防御。
  // costが0だと`consumeAp`が no-op になり、そのユニットのAPはキュー適格判定
  // (`isQueueEligible`)を通過し続け、周回を再生成するたびに再度選ばれてしまう。
  // 通常規則(cost>=1、WAITは必ずAP 1を消費)ではターン内の総周回数は開始時APの
  // 合計を超えないため、それを上回った時点で無限周回と判断し、規定ターン上限を
  // 経由せずこのターン内で即座に検出する(`resolveActionPhase`はターンをまたがない)。
  // R-SKL-05: チャージ効果発動はAP・EXゲージを消費しないため、チャージ開始の
  // AP消費1回につき最大2周回（開始+発動）を要する。安全上限を2倍にして、
  // 正当なチャージ多用を誤検知しないようにする。
  const maxCyclesPerTurn = units.reduce((sum, unit) => sum + unit.maximumAp, 0) * 2 + 1;

  for (;;) {
    const queue = createActionQueue(units);
    if (queue.entries.length === 0) {
      break;
    }
    cycleNumber += 1;
    if (cycleNumber > maxCyclesPerTurn) {
      throw new DomainValidationError(
        "resolveActionPhase.cycleNumber",
        `exceeded the maximum possible cycles for this turn (${maxCyclesPerTurn}, derived from the total starting AP across all units); a 0-cost action is preventing forward progress`,
      );
    }

    const queueCreated = recorder.record({
      eventType: "ActionQueueCreated",
      category: "FACT",
      turnNumber,
      cycleNumber,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      parentEventId: turnScopeParent,
      rootEventId: turnRootEventId,
      payload: {
        cycleNumber,
        reservations: queue.entries.map((entry) => ({
          battleUnitId: entry.battleUnitId,
          reservedActionKind: entry.reservedActionKind,
          actionSpeed: requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
        })),
      },
    });
    turnScopeParent = queueCreated.eventId;

    // `remaining`は「まだ処理していないこの周回の予約」。`06_戦闘状態遷移.md`
    // 「戦闘不能者の除去」: 行動完了ごとにここから戦闘不能者を即時除去する
    // （dequeue時の`isDefeated`判定は本来届かないはずの防御的判定として残す）。
    let remaining = queue.entries;

    while (remaining.length > 0) {
      const reservation = remaining[0]!;
      remaining = remaining.slice(1);

      if (isDefeated(requireUnit(units, reservation.battleUnitId))) {
        continue;
      }

      const resolution = resolveOneAction(
        reservation.battleUnitId,
        reservation.reservedActionKind,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
      );
      units = resolution.units;

      const newlyDefeated = remaining.filter((entry) =>
        isDefeated(requireUnit(units, entry.battleUnitId)),
      );
      if (newlyDefeated.length > 0) {
        for (const removed of newlyDefeated) {
          recorder.record({
            eventType: "ActionReservationRemoved",
            category: "FACT",
            turnNumber,
            cycleNumber,
            resolutionScopeId: resolution.actionScope,
            parentEventId: resolution.completedEventId,
            rootEventId: resolution.rootEventId,
            sourceUnitId: removed.battleUnitId,
            payload: { battleUnitId: removed.battleUnitId, reason: "DEFEATED" },
          });
        }
        const removedIds = new Set(newlyDefeated.map((entry) => entry.battleUnitId));
        remaining = remaining.filter((entry) => !removedIds.has(entry.battleUnitId));
      }

      const { ally, enemy } = splitBySide(units);
      const victory = resolveVictory({
        allAlliesDefeated: ally.every(isDefeated),
        allEnemiesDefeated: enemy.every(isDefeated),
        turnLimitReached: false,
      });
      if (victory !== undefined) {
        return { allyUnits: ally, enemyUnits: enemy, result: victory };
      }
    }
  }

  const { ally, enemy } = splitBySide(units);
  return { allyUnits: ally, enemyUnits: enemy, result: undefined };
}
