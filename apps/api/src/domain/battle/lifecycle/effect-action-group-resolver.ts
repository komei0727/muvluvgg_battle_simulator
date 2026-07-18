import { requireUnit } from "./action-resolution-shared.js";
import { applyCooldownManipulationAction } from "./cooldown-manipulation-application-service.js";
import { applyDamageAction } from "../combat/damage-application-service.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type {
  EffectActionApplication,
  EffectSequencePlan,
} from "../skill/skill-resolution-service.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder, RecordEventInput } from "../events/event-recorder.js";
import type {
  BattleDomainEvent,
  BattleDomainEventType,
  EffectActionResultKind,
} from "../events/domain-event.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `resolveSkillOrder`/`resolveChargeReleaseOrder`が計画した`EffectSequencePlan`を
 * 解決するために共有される因果関係コンテキスト。`action-skill-use-resolver.ts`
 * （AS/EX使用、チャージ発動）と`passive-activation-service.ts`（PS発動）の両方が
 * 使う。両者の間で循環importを起こさないよう、`applyEffectActionGroups`自体は
 * 独立したこのファイルへ置く。
 */
export interface EffectActionGroupContext {
  readonly definitions: BattleDefinitions;
  readonly actorId: BattleUnitId;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /** Issue #34/#73: FACT/TIMINGイベント確定直後にPS即時連鎖を解決するフック（未指定ならPS解決を行わない）。 */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

export interface EffectActionGroupsResult {
  readonly units: readonly BattleUnit[];
  /** 使用者が戦闘不能になる前に到達し、実際に処理したヒット・適用の総数。 */
  readonly resolvedCount: number;
  /**
   * PR #141再レビュー[P2]: 使用者が戦闘不能になったことで未処理のまま残った
   * ヒット・適用の総数。0より大きい場合だけが「中断」(R-SKL-01)であり、
   * 呼び出し側は`resolvedCount`/`interruptedCount`のどちらもここから得て、
   * 戦闘不能かどうかだけで中断を判定しない。
   */
  readonly interruptedCount: number;
}

function countHits(applications: readonly EffectActionApplication[]): number {
  return applications.reduce((sum, application) => sum + application.hits.length, 0);
}

/**
 * イベントを記録し、DIAGNOSTIC以外は即座にPS即時連鎖フックへ渡す
 * （`onFactEventForPassiveChain`未指定ならPS解決を省略する）。DIAGNOSTICイベント
 * （`EffectStepSkipped`）はPSの発動契機になり得ない
 * (`08_ドメインイベント.md`「DIAGNOSTIC」)。
 */
function emitAndChain<Type extends BattleDomainEventType>(
  context: EffectActionGroupContext,
  working: readonly BattleUnit[],
  input: RecordEventInput<Type>,
): {
  readonly event: Extract<BattleDomainEvent, { eventType: Type }>;
  readonly units: readonly BattleUnit[];
} {
  const event = context.recorder.record(input);
  if (context.onFactEventForPassiveChain === undefined || event.category === "DIAGNOSTIC") {
    return { event, units: working };
  }
  return { event, units: context.onFactEventForPassiveChain(event, working) };
}

/** R-SKL-06 #5: DAMAGE適用結果からEffectActionCompletedのresultKindを導く。 */
function damageResultKind(
  targetAlreadyDefeated: boolean,
  interrupted: boolean,
  anyHitApplied: boolean,
): EffectActionResultKind {
  if (interrupted) {
    return "INTERRUPTED";
  }
  if (targetAlreadyDefeated) {
    return "SKIPPED";
  }
  return anyHitApplied ? "APPLIED" : "MISSED";
}

/**
 * R-SKL-06「ACTION step」#3〜#5を、対象1件・EffectAction1件単位で適用する。
 * `EffectActionStarting`直後に対象の生存を再検証し（`08_ドメインイベント.md`
 * 「TIMINGイベント後の再検証」）、既に戦闘不能ならDAMAGE/COOLDOWN_MANIPULATION
 * どちらも呼び出さず`SKIPPED`として`EffectActionCompleted`を発行する。
 */
function applyOneEffectActionApplication(
  application: EffectActionApplication,
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
  lastEventId: DomainEventId,
): {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  readonly resolvedCount: number;
  readonly interruptedCount: number;
  readonly interrupted: boolean;
} {
  const effectAction = context.definitions.effectActions.get(application.effectActionDefinitionId);
  if (effectAction === undefined) {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `effectActionDefinitionId "${application.effectActionDefinitionId}" was not found in the given effectActions (Catalog preflight should already guarantee this reference exists)`,
    );
  }

  const starting = emitAndChain(context, units, {
    eventType: "EffectActionStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    targetUnitIds: [application.targetBattleUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      kind: effectAction.kind,
      targetUnitIds: [application.targetBattleUnitId],
    },
  });
  let working = starting.units;
  let currentLastEventId = starting.event.eventId;

  // TIMINGイベント後の再検証: 使用者がPS/Memory連鎖で戦闘不能になった場合、
  // このEffectActionへは進まず中断として計上する（R-SKL-01）。
  if (isDefeated(requireUnit(working, context.actorId))) {
    return {
      units: working,
      lastEventId: currentLastEventId,
      resolvedCount: 0,
      interruptedCount: application.hits.length,
      interrupted: true,
    };
  }

  let resultKind: EffectActionResultKind;
  let resolvedCount: number;
  let interruptedCount: number;

  if (effectAction.kind === "DAMAGE") {
    const currentActor = requireUnit(working, context.actorId);
    const targetAlreadyDefeated = isDefeated(requireUnit(working, application.targetBattleUnitId));
    const damageResult = applyDamageAction(
      currentActor,
      application.hits,
      effectAction,
      working,
      context.random,
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        parentEventId: currentLastEventId,
        skillDefinitionId: context.skillDefinitionId,
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
    );
    working = damageResult.units;
    resolvedCount = application.hits.length - damageResult.interruptedCount;
    interruptedCount = damageResult.interruptedCount;
    resultKind = damageResultKind(
      targetAlreadyDefeated,
      damageResult.interruptedCount > 0,
      damageResult.hits.some((hit) => hit.applied),
    );
  } else if (effectAction.kind === "COOLDOWN_MANIPULATION") {
    const cooldownResult = applyCooldownManipulationAction(
      application.hits,
      effectAction,
      working,
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        parentEventId: currentLastEventId,
        sourceUnitId: context.actorId,
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
    );
    working = cooldownResult.units;
    // COOLDOWN_MANIPULATIONは使用者戦闘不能による中断の対象外（Issue #129
    // 時点で自傷を伴わない純粋な状態操作のため）。全件解決済みとして数える。
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    resultKind = cooldownResult.changed ? "APPLIED" : "SKIPPED";
  } else {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `EffectAction kind other than "DAMAGE"/"COOLDOWN_MANIPULATION" is not supported by this basic turn action resolver (M6/M7/M8 scope)`,
    );
  }

  const completed = emitAndChain(context, working, {
    eventType: "EffectActionCompleted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: currentLastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    targetUnitIds: [application.targetBattleUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      effectActionKind: effectAction.kind,
      targetUnitIds: [application.targetBattleUnitId],
      resultKind,
    },
  });
  working = completed.units;
  currentLastEventId = completed.event.eventId;

  return {
    units: working,
    lastEventId: currentLastEventId,
    resolvedCount,
    interruptedCount,
    interrupted: resultKind === "INTERRUPTED",
  };
}

/**
 * AS/EX使用（`resolveSkillUse`）とチャージ発動（`resolveChargeRelease`）、PS発動
 * （`passive-activation-service.ts`）が使う、`EffectSequencePlan`の適用ループ。
 * R-SKL-06「ACTION step」を、stepごとに`EffectStepStarting`/`EffectStepSkipped`/
 * `EffectStepCompleted`、EffectAction(target)ごとに`EffectActionStarting`/
 * `EffectActionCompleted`を発行しながら解決し、各イベント確定直後にPS即時連鎖
 * （`onFactEventForPassiveChain`）を解決する。使用者の戦闘不能を各step開始前・
 * 各EffectAction適用前後に再確認し、検出した時点でそのstep以降（当stepの
 * 残りのapplicationsと、後続のstep全て）を静かに中断へ計上する
 * （R-SKL-01「使用者が戦闘不能になった場合、未解決効果を中断する」）。
 * 中断されたstepでは`EffectStepStarting`が既に発行済みでも`EffectStepCompleted`
 * は発行しない（step自体が完了していないため）。
 */
export function applyEffectActionGroups(
  plan: EffectSequencePlan,
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
): EffectActionGroupsResult {
  let working = units;
  let resolvedCount = 0;
  let interruptedCount = 0;
  let lastEventId = context.parentEventId;
  let sequenceInterrupted = false;

  for (const step of plan.steps) {
    if (sequenceInterrupted || isDefeated(requireUnit(working, context.actorId))) {
      sequenceInterrupted = true;
      interruptedCount += countHits(step.applications);
      continue;
    }

    const stepStarting = emitAndChain(context, working, {
      eventType: "EffectStepStarting",
      category: "TIMING",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: {
        stepIndex: step.stepIndex,
        stepKind: step.stepKind,
        conditionKind: step.conditionKind,
      },
    });
    working = stepStarting.units;
    lastEventId = stepStarting.event.eventId;

    if (!step.satisfied) {
      const stepSkipped = emitAndChain(context, working, {
        eventType: "EffectStepSkipped",
        category: "DIAGNOSTIC",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        sourceUnitId: context.actorId,
        payload: { stepIndex: step.stepIndex, conditionKind: step.conditionKind, result: false },
      });
      working = stepSkipped.units;
      lastEventId = stepSkipped.event.eventId;
      continue;
    }

    let stepCutShort = false;
    let resolvedActionCount = 0;

    for (const application of step.applications) {
      if (isDefeated(requireUnit(working, context.actorId))) {
        stepCutShort = true;
        sequenceInterrupted = true;
        interruptedCount += application.hits.length;
        continue;
      }

      const applied = applyOneEffectActionApplication(application, working, context, lastEventId);
      working = applied.units;
      lastEventId = applied.lastEventId;
      resolvedCount += applied.resolvedCount;
      interruptedCount += applied.interruptedCount;
      if (applied.interrupted) {
        stepCutShort = true;
        sequenceInterrupted = true;
      } else {
        resolvedActionCount += 1;
      }
    }

    if (!stepCutShort) {
      const stepCompleted = emitAndChain(context, working, {
        eventType: "EffectStepCompleted",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        sourceUnitId: context.actorId,
        payload: { stepIndex: step.stepIndex, resolvedActionCount },
      });
      working = stepCompleted.units;
      lastEventId = stepCompleted.event.eventId;
    }
  }

  return { units: working, resolvedCount, interruptedCount };
}
