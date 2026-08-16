import type { StateDelta } from "../events/state-delta.js";
import {
  consumeAp,
  consumeExGaugeFully,
  finalizeAction,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion, recordCooldownStart } from "./action-completion.js";
import {
  completeActionIfActorDefeatedAtStart,
  fireContinuousHealsOnActionStart,
} from "./continuous-heal-service.js";
import { resolveBindingSelections } from "./action-skill-use-resolver.js";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import {
  collectPreAttackObservations,
  resolveChargeReleaseOrder,
} from "../skill/skill-resolution-service.js";
import { emitPreAttackObservations } from "./pre-attack-observation-service.js";
import { expireEffectsSteps } from "../effects/duration-expiry-service.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { DepletedAbsorberReason } from "../combat/damage-application-service.js";

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
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
  actionId: ActionId,
  actionScope: ResolutionScopeId,
  exercise?: ExerciseRuntime,
): ActionResolutionResult {
  const actorUnitId = actor.battleUnitId;
  let working =
    effectiveActionType === "EX"
      ? consumeExGaugeFully(units, actorUnitId)
      : consumeAp(units, actorUnitId, skill.cost.amount);
  const actorAfterCost = requireUnit(working, actorUnitId);
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
    sourceUnitId: actorUnitId,
    payload: {
      actorUnitId,
      reservedActionType,
      effectiveActionType,
      apBefore: actor.currentAp,
      apAfter: actorAfterCost.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actorAfterCost.currentExtraGauge,
    },
    stateDelta: { units: { [actorUnitId]: stateDeltaEntry } },
  });

  // Issue #184: `PassiveActivationRuntime`の生成を
  // R-HEAL-03の継続回復発火より前へ移し、`HealApplied`もAS/EX経路と同じFACT
  // イベント連鎖へ流す。この時点の`working`はコスト消費を適用済みで、
  // `ChargeStarted`より前に状態を変えるのは継続回復とクールタイム設定だけの
  // ため、生成位置を早めても観測できる差はない。
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
      ...(exercise !== undefined ? { exercise } : {}),
    },
    working,
  );

  // R-HEAL-03（M7-005、Issue #184）: チャージ開始も1つの行動であるため、保持者
  // 自身の`ActionStarted`を契機とする継続回復を行動本体より前に発火させる。
  const continuousHeal = fireContinuousHealsOnActionStart(
    working,
    actorUnitId,
    {
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      effectActions: definitions.effectActions,
      // R-TEX-02 #5: 継続回復が敵HPを戻した分をスコアから減算する。
      ...(exercise !== undefined ? { exercise } : {}),
      // R-DOT-01（DMG-008、Issue #189）: 同じ走査で解決する継続ダメージ。
      continuousDamage: {
        effectActions: definitions.effectActions,
        // R-TEX-02 #3: 継続ダメージも敵HPへ向かう分をスコアへ計上する。
        ...(exercise !== undefined ? { exercise } : {}),
        expireDepletedAbsorbers: (
          targetUnitId: BattleUnitId,
          depletedEffectInstanceIds: readonly EffectInstanceId[],
          expiryReason: DepletedAbsorberReason,
          unitsForExpiry: readonly BattleUnit[],
          expiryParentEventId: DomainEventId,
        ) =>
          expireEffectsSteps(
            {
              recorder,
              turnNumber,
              cycleNumber,
              actionId,
              resolutionScopeId: actionScope,
              rootEventId: actionStarted.eventId,
            },
            unitsForExpiry,
            depletedEffectInstanceIds.map((effectInstanceId) => ({
              battleUnitId: targetUnitId,
              effectInstanceId,
              reason: expiryReason,
            })),
            definitions.effectActions,
            expiryParentEventId,
          ),
      },
    },
    actionStarted.eventId,
    (event, unitsForChain) => passiveRuntime.onFactEvent(event, unitsForChain).units,
  );
  working = continuousHeal.units;

  // START_EVENT #4（`06_戦闘状態遷移.md`）: 継続回復と
  // その`HealApplied`起点のPS連鎖で行動者が戦闘不能になった場合、本体を実行せず
  // `COMPLETING`へ進む。
  const interrupted = completeActionIfActorDefeatedAtStart(
    working,
    actorUnitId,
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorUnitId,
      effectActions: definitions.effectActions,
      onFactEventForPassiveChain: (
        event: BattleDomainEvent,
        unitsForChain: readonly BattleUnit[],
      ) => passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    effectiveActionType,
    continuousHeal.lastEventId,
    actionScope,
    actionStarted.eventId,
    (completedEventId) => passiveRuntime.finalizeResolutionScope(completedEventId).units,
  );
  if (interrupted !== undefined) {
    return interrupted;
  }

  // R-SKL-05 #2: 元スキルへクールタイムを設定し、現在の行動IDを設定スコープとして記録する。
  const cooldownResult = recordCooldownStart(
    recorder,
    { actionId, turnNumber, cycleNumber, resolutionScopeId: actionScope, actorUnitId },
    requireUnit(working, actorUnitId).cooldowns,
    skill,
    continuousHeal.lastEventId,
    actionStarted.eventId,
  );

  const chargingUnit: BattleUnit = {
    ...requireUnit(working, actorUnitId),
    cooldowns: cooldownResult.cooldowns,
    charge: { skill, startedActionId: actionId },
  };
  working = working.map((u) => (u.battleUnitId === actorUnitId ? chargingUnit : u));

  const chargeStarted = recorder.record({
    eventType: "ChargeStarted",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    resolutionScopeId: actionScope,
    parentEventId: cooldownResult.lastEventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorUnitId,
    // このイベントには外部の対象がなく、チャージを
    // 開始した本人自身が観測対象であるため、`targetUnitIds`へ自分自身を含める
    // （`targetSelector: ALLY`等で「ALLYがチャージ開始した」を判定するPS、
    // 例: production Catalog Harriet PS2が候補化できるようにする）。
    targetUnitIds: [actorUnitId],
    payload: {
      actorUnitId,
      skillDefinitionId: skill.skillDefinitionId,
      startedActionId: actionId,
    },
    stateDelta: {
      units: {
        [actorUnitId]: {
          charge: {
            before: undefined,
            after: { skillDefinitionId: skill.skillDefinitionId, startedActionId: actionId },
          },
        },
      },
    },
  });

  // チャージ開始も`ChargeStarted`（例: Harriet PS2
  // 「ALLYがチャージ開始した時」）と`ActionCompleting`/Cooldown更新/
  // `ActionCompleted`を発動タイミングとするPS/counter更新を持ちうるため、上で
  // 生成した`passiveRuntime`へ接続する。
  working = passiveRuntime.onFactEvent(chargeStarted, working).units;

  const completion = recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorUnitId,
      effectActions: definitions.effectActions,
      onFactEventForPassiveChain: (event, unitsForChain) =>
        passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    effectiveActionType,
    chargeStarted.eventId,
    working,
  );

  return finalizeAction(passiveRuntime, completion, actionScope, actionStarted.eventId);
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
  exercise?: ExerciseRuntime,
): ActionResolutionResult {
  const actorUnitId = actor.battleUnitId;
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
    sourceUnitId: actorUnitId,
    payload: {
      actorUnitId,
      reservedActionType,
      effectiveActionType: "CHARGE_RELEASE",
      apBefore: actor.currentAp,
      apAfter: actor.currentAp,
      exBefore: actor.currentExtraGauge,
      exAfter: actor.currentExtraGauge,
    },
  });

  // AS/EX（`resolveSkillUse`）と同様、この行動専用の
  // `PassiveActivationRuntime`を生成し、チャージ解放の効果解決から発行される
  // イベントからもPS即時連鎖を解決できるようにする（従来欠落していた）。
  // Issue #184: 生成をR-HEAL-03の継続回復発火より
  // 前へ移し、`HealApplied`もAS/EX経路と同じFACTイベント連鎖へ流す。チャージ
  // 発動はコストを消費しないため、この時点の`units`は呼び出し時点のままである。
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
      ...(exercise !== undefined ? { exercise } : {}),
    },
    units,
  );

  // R-HEAL-03（M7-005、Issue #184）: チャージ発動も1つの行動であるため、保持者
  // 自身の`ActionStarted`を契機とする継続回復を、対象選択・効果解決より前に
  // 発火させる。
  const continuousHeal = fireContinuousHealsOnActionStart(
    units,
    actorUnitId,
    {
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      effectActions: definitions.effectActions,
      // R-TEX-02 #5: 継続回復が敵HPを戻した分をスコアから減算する。
      ...(exercise !== undefined ? { exercise } : {}),
      // R-DOT-01（DMG-008、Issue #189）: 同じ走査で解決する継続ダメージ。
      continuousDamage: {
        effectActions: definitions.effectActions,
        // R-TEX-02 #3: 継続ダメージも敵HPへ向かう分をスコアへ計上する。
        ...(exercise !== undefined ? { exercise } : {}),
        expireDepletedAbsorbers: (
          targetUnitId: BattleUnitId,
          depletedEffectInstanceIds: readonly EffectInstanceId[],
          expiryReason: DepletedAbsorberReason,
          unitsForExpiry: readonly BattleUnit[],
          expiryParentEventId: DomainEventId,
        ) =>
          expireEffectsSteps(
            {
              recorder,
              turnNumber,
              cycleNumber,
              actionId,
              resolutionScopeId: actionScope,
              rootEventId: actionStarted.eventId,
            },
            unitsForExpiry,
            depletedEffectInstanceIds.map((effectInstanceId) => ({
              battleUnitId: targetUnitId,
              effectInstanceId,
              reason: expiryReason,
            })),
            definitions.effectActions,
            expiryParentEventId,
          ),
      },
    },
    actionStarted.eventId,
    (event, unitsForChain) => passiveRuntime.onFactEvent(event, unitsForChain).units,
  );
  let working = continuousHeal.units;

  // START_EVENT #4（`06_戦闘状態遷移.md`）: 継続回復と
  // その`HealApplied`起点のPS連鎖で行動者が戦闘不能になった場合、本体を実行せず
  // `COMPLETING`へ進む。
  const interrupted = completeActionIfActorDefeatedAtStart(
    working,
    actorUnitId,
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorUnitId,
      effectActions: definitions.effectActions,
      onFactEventForPassiveChain: (
        event: BattleDomainEvent,
        unitsForChain: readonly BattleUnit[],
      ) => passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    "CHARGE_RELEASE",
    continuousHeal.lastEventId,
    actionScope,
    actionStarted.eventId,
    (completedEventId) => passiveRuntime.finalizeResolutionScope(completedEventId).units,
  );
  if (interrupted !== undefined) {
    return interrupted;
  }

  const plan = resolveChargeReleaseOrder(
    skill,
    // 継続回復で使用者自身のHP・combatStatsが変わりうるため、対象選択はこの
    // 時点の最新状態から行う。
    requireUnit(working, actorUnitId),
    working,
    definitions.effectActions,
    definitions.unitDefinitions,
  );
  const targetUnitIds = plan.targetUnitIds;

  const skillUseId = recorder.nextSkillUseId();
  // EFF-006/Issue #212: `resolveSkillUse`と同様、この解決が宣言する
  // `chargeRelease`のEffectSequence自身のcounterUpdates（あれば）を登録する。
  if (skill.resolution.kind === "CHARGE") {
    passiveRuntime.beginEffectSequenceResolution(
      skillUseId,
      actorUnitId,
      skill.skillDefinitionId,
      skill.resolution.chargeRelease.counterUpdates ?? [],
    );
  }
  const targetsSelected = recorder.record({
    eventType: "TargetsSelected",
    category: "FACT",
    turnNumber,
    cycleNumber,
    actionId,
    skillUseId,
    resolutionScopeId: actionScope,
    parentEventId: continuousHeal.lastEventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorUnitId,
    targetUnitIds,
    payload: {
      skillDefinitionId: skill.skillDefinitionId,
      // `plan`(直前の`resolveChargeReleaseOrder`呼び出し)が既にkind==="CHARGE"を検証済み。
      bindings:
        skill.resolution.kind === "CHARGE"
          ? resolveBindingSelections(
              skill.resolution.chargeRelease.targetBindings,
              actor,
              working,
              definitions.unitDefinitions,
            )
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
    sourceUnitId: actorUnitId,
    targetUnitIds,
    payload: {
      actorUnitId,
      skillDefinitionId: skill.skillDefinitionId,
      chargeStartActionId: charge.startedActionId,
      releaseActionId: actionId,
    },
    // `06_戦闘状態遷移.md`「チャージ効果発動」: `ChargeReleased`はトリガー
    // (#1)を示すだけで、チャージ状態を終了する状態差分(#4)は効果解決後に発行する
    // `ChargeReleaseCompleted`/`ChargeReleaseInterrupted`(#5)が所有する
    // （下記`chargeClosingStateDelta`）。
  });
  // `ChargeReleased`はEffectSequence解決開始のトリガーで
  // あり、`chargeRelease.counterUpdates`のtriggerにもなり得る
  // （`08_ドメインイベント.md`「ChargeReleased」）。`applyEffectActionGroups`
  // （実効果解決）より前に`passiveRuntime.onFactEvent`へ渡し、`beginEffectSequenceResolution`
  // で登録済みのEFFECT_SEQUENCEスコープcounterUpdatesとPS/Memory候補の両方へ
  // 届けるとともに、`working`を最新化する。
  working = passiveRuntime.onFactEvent(chargeReleased, working).units;

  // R-ATM-03: 前段フェーズの最後に攻撃前観測を行う（R-ATM-02 #1の表、チャージ解放行）。
  const observation = emitPreAttackObservations(
    {
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      skillUseId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      skillDefinitionId: skill.skillDefinitionId,
      skillType: skill.skillType,
      attackerUnitId: actorUnitId,
    },
    collectPreAttackObservations(
      skill.resolution.kind === "CHARGE" ? skill.resolution.chargeRelease.steps : [],
      plan.resolvedBindings,
      requireUnit(working, actorUnitId),
      working,
      definitions.effectActions,
    ),
    working,
    actorUnitId,
    // R-FUP-01の捕捉はAS/EXスキル使用だけが行うため、チャージ解放にライダーは乗らない。
    undefined,
    chargeReleased.eventId,
    (event, unitsForChain) => passiveRuntime.onFactEvent(event, unitsForChain).units,
  );
  working = observation.units;

  // R-ATM-02 #2: ここから効果処理フェーズ（AS/EX経路と同じ規約）。候補の発動は
  // `ChargeReleaseCompleted`/`ChargeReleaseInterrupted`発行後の後段フェーズまで保留する。
  passiveRuntime.beginEffectProcessingPhase();
  // R-ATM-03 #5: 攻撃前観測で使用者が戦闘不能になったなら効果処理フェーズへ進まない。
  const effectResult = observation.interrupted
    ? {
        units: working,
        outcome: {
          status: "INTERRUPTED" as const,
          reason: "ACTOR_DEFEATED" as const,
          resolvedEffectCount: 0,
          unresolvedEffectCount: 0,
        },
      }
    : applyEffectActionGroups(plan, working, {
        definitions,
        actorUnitId,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        skillUseId,
        actionScope,
        rootEventId: actionStarted.eventId,
        parentEventId: observation.lastEventId,
        skillDefinitionId: skill.skillDefinitionId,
        onFactEventForPassiveChain: (event, unitsForChain) =>
          passiveRuntime.onFactEvent(event, unitsForChain).units,
        // R-SKL-08: `action-skill-use-resolver.ts`と
        // 同じ理由で、この行動専用の`passiveRuntime`が持つregistryをチャージ解放
        // 自身のEffectSequenceにも使い回す。
        damageResults: passiveRuntime.damageResultsRegistry,
        // R-TEX-02: 戦術演習だけが持つ演習状態をDAMAGE経路へ運ぶ。
        ...(exercise !== undefined ? { exercise } : {}),
      });
  // EFF-006/Issue #212: `applyEffectActionGroups`の戻り値は
  // `onFactEventForPassiveChain`経由で既に`passiveRuntime`（`this.units`）へ
  // 同期済みのため、そのまま`finalizeEffectSequenceResolution`（`this.units`を
  // 参照する）を呼べる。`resolveSkillUse`と同様、このEffectSequence自身の
  // 解決が完了した時点で直ちにそのcounterを破棄する。
  working = passiveRuntime.finalizeEffectSequenceResolution(skillUseId);

  // `06_戦闘状態遷移.md`「チャージ効果発動」#4: チャージ状態を終了するのは効果解決
  // （とPS解決、M6）の後（M6でPS解決が入った時に所有者のPSが「チャージ中ではない」と
  // 誤判定するのを防ぐ）。
  //
  // ただし解放中もactorはチャージを保持したままなので、この間のPS連鎖などでactorへ
  // STUNが成立すると`cancelChargeOnStun`（R-STS-02/R-SKL-05）が既に
  // `ChargeCancelled`とcharge削除の`StateDelta`を発行している。charge削除の所有者は
  // 必ず1件でなければならない — 二重に発行すると、2件目の`before`が実状態
  // （既に`undefined`）と食い違い、独立Reducerの再生が落ちる。
  const chargeStillHeld = working.find((u) => u.battleUnitId === actorUnitId)?.charge !== undefined;
  if (chargeStillHeld) {
    working = working.map((u) => {
      if (u.battleUnitId !== actorUnitId) {
        return u;
      }
      const { charge: _charge, ...withoutCharge } = u;
      return withoutCharge;
    });
  }

  // 「チャージ効果発動」#5: 解放が終わったことを表すFACTイベント。AS/EX経路の
  // `SkillUseCompleted`/`SkillUseInterrupted`に相当する — チャージ経路は
  // `SkillUseStarting`/`SkillUseCompleted`を一切発行しないため、これが無いと
  // 「自身がアクティブスキルで攻撃した後に発動」を表すtriggerが
  // `resolution.kind: CHARGE` のスキルからは一度も成立しない（`SKL_SIENA_OFFSTAGE_PS2`）。
  //
  // 発行位置が #1（`ChargeReleased`）でも #2〜#3の途中でもなく**#4の後**なのは、
  // 前2者ではどちらもPSが連鎖できないか、連鎖しても意味が変わるためである:
  // - #1で発行すると、PSが付ける与ダメージバフが解放攻撃自身へ乗ってしまう
  //   （原文の「攻撃した後」に反する）。
  // - #2〜#3の間はまだチャージ状態が残っており、`passive-trigger-matcher.ts` が
  //   「チャージ中は自身のパッシブスキルが使用できない」（R-SKL-05）として保持者の
  //   PSを候補から外すため、一度も発動しない。
  //
  // チャージ終了の状態差分はこのイベント自身が所有する。`ActionCompleting`（さらに
  // 後続）へ持たせると、公開差分を順に当て直す独立Reducerではこの時点でまだ
  // チャージ中に見え、「チャージ状態終了後に発行する」という契約と食い違う。
  // 解放中のSTUNで`ChargeCancelled`が既に削除を所有している場合は付けない（上記）。
  const chargeClosingStateDelta: StateDelta | undefined = chargeStillHeld
    ? {
        units: {
          [actorUnitId]: {
            charge: {
              before: {
                skillDefinitionId: skill.skillDefinitionId,
                startedActionId: charge.startedActionId,
              },
              after: undefined,
            },
          },
        },
      }
    : undefined;

  // Issue #217設計方針B（`action-skill-use-resolver.ts`と同じ）: 完了と中断の選択は
  // `outcome.status`（実際に解決が最後まで進んだか、使用者戦闘不能で打ち切ったか
  // という事実）だけから決める。無条件に完了イベントを出すと、中断された解放を
  // 契機に「攻撃した後」のPSが候補化されてしまう。
  const chargeReleaseFinished =
    effectResult.outcome.status === "INTERRUPTED"
      ? recorder.record({
          eventType: "ChargeReleaseInterrupted",
          category: "FACT",
          turnNumber,
          cycleNumber,
          actionId,
          skillUseId,
          resolutionScopeId: actionScope,
          parentEventId: chargeReleased.eventId,
          rootEventId: actionStarted.eventId,
          sourceUnitId: actorUnitId,
          targetUnitIds,
          ...(chargeClosingStateDelta === undefined ? {} : { stateDelta: chargeClosingStateDelta }),
          payload: {
            actorUnitId,
            skillDefinitionId: skill.skillDefinitionId,
            chargeStartActionId: charge.startedActionId,
            releaseActionId: actionId,
            reason: effectResult.outcome.reason,
            resolvedEffectCount: effectResult.outcome.resolvedEffectCount,
            unresolvedEffectCount: effectResult.outcome.unresolvedEffectCount,
          },
        })
      : recorder.record({
          eventType: "ChargeReleaseCompleted",
          category: "FACT",
          turnNumber,
          cycleNumber,
          actionId,
          skillUseId,
          resolutionScopeId: actionScope,
          parentEventId: chargeReleased.eventId,
          rootEventId: actionStarted.eventId,
          sourceUnitId: actorUnitId,
          targetUnitIds,
          ...(chargeClosingStateDelta === undefined ? {} : { stateDelta: chargeClosingStateDelta }),
          payload: {
            actorUnitId,
            skillDefinitionId: skill.skillDefinitionId,
            skillType: skill.skillType,
            chargeStartActionId: charge.startedActionId,
            releaseActionId: actionId,
            resolvedStepCount:
              skill.resolution.kind === "CHARGE" ? skill.resolution.chargeRelease.steps.length : 0,
            targetUnitIds,
          },
        });
  // R-ATM-02 #3: 完了イベント自身の候補も保留キューの末尾へ積んだうえで、保留分を
  // 発生順に発動させてから最後に解決する。
  working = passiveRuntime.onFactEvent(chargeReleaseFinished, working).units;
  working = passiveRuntime.drainEffectProcessingPhase(chargeReleaseFinished.eventId, working).units;

  const completion = recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorUnitId,
      effectActions: definitions.effectActions,
      // `ActionCompleting`/Cooldown更新/`ActionCompleted`
      // 自身もこの行動専用の`passiveRuntime`へ接続し、それらを契機とする
      // counter更新・PS候補も（あれば）`finalizeResolutionScope`より前に
      // 解決されるようにする。
      onFactEventForPassiveChain: (event, unitsForChain) =>
        passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    "CHARGE_RELEASE",
    chargeReleaseFinished.eventId,
    working,
    // チャージ終了の状態差分は `ChargeReleaseCompleted`/`ChargeReleaseInterrupted`
    // が既に所有している。ここで再度渡すと独立Reducerが同じ差分を二重適用する。
  );

  return finalizeAction(passiveRuntime, completion, actionScope, actionStarted.eventId);
}
