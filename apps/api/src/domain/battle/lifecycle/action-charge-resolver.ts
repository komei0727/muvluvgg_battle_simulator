import {
  consumeAp,
  consumeExGaugeFully,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion, recordCooldownStart } from "./action-completion.js";
import { applyEffectActionGroups, resolveBindingSelections } from "./action-skill-use-resolver.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { resolveChargeReleaseOrder } from "../skill/skill-resolution-service.js";
import type { ActionId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnit } from "../model/battle-unit.js";

/**
 * `06_戦闘状態遷移.md`「チャージ開始」: 元スキルのコストはRESOURCE_CONSUMINGで
 * 既に消費済みとして扱い、`ActionStarted`直後にクールタイムを設定し、ユニットを
 * チャージ中にする。気絶・凍結によるキャンセル/保持はStunned/Frozenが未実装
 * （M7）のため対象外。チャージ開始自体は予約種別(AS/EX)と同じeffectiveActionType
 * として完了する（R-ACT-03「チャージ開始時に元スキルのコストを消費済み」）。
 */
export function resolveChargeStart(
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
export function resolveChargeRelease(
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
    // `06_戦闘状態遷移.md`「チャージ効果発動」: `ChargeReleased`はトリガー
    // (#1)を示すだけで、チャージ状態を終了する状態差分(#4)は効果解決後の
    // `ActionCompleting`が所有する（下記`closingStateDelta`）。
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
    parentEventId: chargeReleased.eventId,
    skillDefinitionId: skill.skillDefinitionId,
  });

  // `06_戦闘状態遷移.md`「チャージ効果発動」#4: チャージ状態を終了するのは効果解決
  // （とPS解決、M6）の後（M5レビュー2巡目[P2]: 内部の`working`だけでなく、公開
  // される`stateTransitions`上でも効果解決後に観測される必要があるため、
  // 終了の状態差分自体を`ChargeReleased`ではなく`ActionCompleting`（効果解決の
  // 後に発行される）へ持たせる。M6でPS解決が入った時に所有者のPSが
  // 「チャージ中ではない」と誤判定するのを防ぐ）。
  working = working.map((u) => {
    if (u.battleUnitId !== actorId) {
      return u;
    }
    const { charge: _charge, ...withoutCharge } = u;
    return withoutCharge;
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
    "CHARGE_RELEASE",
    chargeReleased.eventId,
    working,
    {
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
  );

  return {
    units: completion.units,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}
