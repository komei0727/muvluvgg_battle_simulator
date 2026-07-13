import { createActionQueue, type ReservedActionKind } from "./action-queue.js";
import { selectAsCandidate } from "./action-selection-policy.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import { isDefeated, type BattleUnit } from "./battle-unit.js";
import { applyDamageAction } from "./damage-application-service.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "./events/event-ids.js";
import type { EventRecorder } from "./events/event-recorder.js";
import { createActionPoint } from "./resource-gauge.js";
import { resolveTargets } from "./target-selection-policy.js";
import { resolveSkillOrder, type ResolvedEffectApplication } from "./skill-resolution-service.js";
import { resolveVictory, type VictoryResult } from "./victory-policy.js";
import type { EffectActionDefinitionId } from "../catalog/catalog-ids.js";
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

/** `08_ドメインイベント.md`「TargetsSelected」payload: targetBindingごとの解決対象。skillの解決はIMMEDIATE前提（resolveSkillOrderが既に検証済み）。 */
function resolveTargetBindingSelections(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): readonly { targetBindingId: string; selectedTargetUnitIds: readonly BattleUnitId[] }[] {
  if (skill.resolution.kind !== "IMMEDIATE") {
    return [];
  }
  return skill.resolution.targetBindings.map((binding) => ({
    targetBindingId: binding.targetBindingId,
    selectedTargetUnitIds: resolveTargets(binding.selector, actor, allUnits).map(
      (unit) => unit.battleUnitId,
    ),
  }));
}

/**
 * `06_戦闘状態遷移.md` のDECIDING〜COMPLETINGの基本形。R-ACT-03の一部
 * （ASのAPコスト消費、通常の待機によるAP1消費）だけを実装する。EXゲージ増加
 * (R-ACT-04)、クールタイム・気絶・凍結・チャージ(M7)、PS/Memory連鎖(M6)は
 * この関数の対象外。DAMAGE以外のEffectActionKindの解決も対象外（M6/M7）。
 * `ActionStarted`が自身の解決スコープを開き（`08_ドメインイベント.md`「resolutionScopeId」
 * はActionIdと対応する）、`ActionCompleted`までの全イベントがそのrootEventIdを共有する。
 */
function resolveOneAsAction(
  actorId: BattleUnitId,
  reservedActionType: ReservedActionKind,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
): readonly BattleUnit[] {
  const actor = requireUnit(units, actorId);
  const activeSkills = definitions.activeSkillsByUnit.get(actor.unitDefinitionId) ?? [];
  const selection = selectAsCandidate(activeSkills, actor, units);

  const actionId = recorder.nextActionId();
  const actionScope = recorder.nextResolutionScopeId();

  if (selection.kind === "WAIT") {
    const working = consumeAp(units, actorId, 1);
    const actorAfter = requireUnit(working, actorId);
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
        waitReason: "NO_USABLE_ACTIVE_SKILL",
      },
      stateDelta: {
        units: { [actorId]: { ap: { before: actor.currentAp, after: actorAfter.currentAp } } },
      },
    });
    recordActionCompletion(
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
      actionStarted.eventId,
    );
    return working;
  }

  const skill = selection.skill;
  let working = consumeAp(units, actorId, skill.cost.amount);
  const actorAfterCost = requireUnit(working, actorId);
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
      effectiveActionType: "AS",
      apBefore: actor.currentAp,
      apAfter: actorAfterCost.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actorAfterCost.currentExtraGauge,
    },
    stateDelta: {
      units: { [actorId]: { ap: { before: actor.currentAp, after: actorAfterCost.currentAp } } },
    },
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
      bindings: resolveTargetBindingSelections(skill, actorAfterCost, working),
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

  const skillUseStarted = recorder.record({
    eventType: "SkillUseStarted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    resolutionScopeId: actionScope,
    parentEventId: skillUseStarting.eventId,
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

  recorder.record({
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

  recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
    },
    "AS",
    skillUseStarted.eventId,
  );

  return working;
}

interface ActionCompletionContext {
  readonly actionId: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actorId: BattleUnitId;
}

/** `ActionCompleting`/`ActionCompleted`。WAITはActionStartedから、ASはSkillUseCompleted相当（skillUseStarted）から直接連鎖する。 */
function recordActionCompletion(
  recorder: EventRecorder,
  context: ActionCompletionContext,
  effectiveActionType: "AS" | "WAIT",
  triggeringEventId: DomainEventId,
): void {
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
  recorder.record({
    eventType: "ActionCompleted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    actionId: context.actionId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: actionCompleting.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { actorUnitId: context.actorId, effectiveActionType },
  });
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

  for (;;) {
    const queue = createActionQueue(units);
    if (queue.entries.length === 0) {
      break;
    }
    cycleNumber += 1;

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

    for (const reservation of queue.entries) {
      // Q-BTL-04/06_戦闘状態遷移.md「戦闘不能者の除去」: このキュー生成後、
      // 自分の番が来るまでの間に戦闘不能になった予約者は、防御的にそのまま
      // 破棄する（DECIDING #1「戦闘不能なら処理せず終了する」）。
      if (isDefeated(requireUnit(units, reservation.battleUnitId))) {
        continue;
      }

      if (reservation.reservedActionKind === "EX") {
        throw new DomainValidationError(
          "reservedActionKind",
          '"EX" action resolution is not supported by this basic turn action resolver (M6 scope)',
        );
      }

      units = resolveOneAsAction(
        reservation.battleUnitId,
        reservation.reservedActionKind,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
      );

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
