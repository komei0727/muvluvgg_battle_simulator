import {
  consumeAp,
  consumeExGaugeFully,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion, recordCooldownStart } from "./action-completion.js";
import { resolveBindingSelections } from "./action-skill-use-resolver.js";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
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
    // レビュー再々々レビュー[P2]: このイベントには外部の対象がなく、チャージを
    // 開始した本人自身が観測対象であるため、`targetUnitIds`へ自分自身を含める
    // （`targetSelector: ALLY`等で「ALLYがチャージ開始した」を判定するPS、
    // 例: production Catalog Harriet PS2が候補化できるようにする）。
    targetUnitIds: [actorId],
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

  // レビュー再々々レビュー[P2]: チャージ開始も`ChargeStarted`（例: Harriet PS2
  // 「ALLYがチャージ開始した時」）と`ActionCompleting`/Cooldown更新/
  // `ActionCompleted`を発動タイミングとするPS/counter更新を持ちうるため、
  // この行動専用の`PassiveActivationRuntime`を生成して接続する。
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
  working = passiveRuntime.onFactEvent(chargeStarted, working);

  const completion = recordActionCompletion(
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
      effectActions: definitions.effectActions,
      onFactEventForPassiveChain: (event, unitsForChain) =>
        passiveRuntime.onFactEvent(event, unitsForChain),
    },
    effectiveActionType,
    chargeStarted.eventId,
    working,
  );
  const finalUnits = passiveRuntime.finalizeResolutionScope();

  return {
    units: finalUnits,
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
  const plan = resolveChargeReleaseOrder(
    skill,
    actor,
    working,
    definitions.effectActions,
    definitions.unitDefinitions,
  );
  const targetUnitIds = plan.targetUnitIds;

  // PR #142レビュー[P1]: AS/EX（`resolveSkillUse`）と同様、この行動専用の
  // `PassiveActivationRuntime`を生成し、チャージ解放の効果解決から発行される
  // イベントからもPS即時連鎖を解決できるようにする（従来欠落していた）。
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

  const skillUseId = recorder.nextSkillUseId();
  // EFF-006/Issue #212: `resolveSkillUse`と同様、この解決が宣言する
  // `chargeRelease`のEffectSequence自身のcounterUpdates（あれば）を登録する。
  if (skill.resolution.kind === "CHARGE") {
    passiveRuntime.beginEffectSequenceResolution(
      skillUseId,
      actorId,
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
    parentEventId: actionStarted.eventId,
    rootEventId: actionStarted.eventId,
    sourceUnitId: actorId,
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
  // PR #213レビュー[P2]: `ChargeReleased`はEffectSequence解決開始のトリガーで
  // あり、`chargeRelease.counterUpdates`のtriggerにもなり得る
  // （`08_ドメインイベント.md`「ChargeReleased」）。`applyEffectActionGroups`
  // （実効果解決）より前に`passiveRuntime.onFactEvent`へ渡し、`beginEffectSequenceResolution`
  // で登録済みのEFFECT_SEQUENCEスコープcounterUpdatesとPS/Memory候補の両方へ
  // 届けるとともに、`working`を最新化する。
  working = passiveRuntime.onFactEvent(chargeReleased, working);

  applyEffectActionGroups(plan, working, {
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
    onFactEventForPassiveChain: (event, unitsForChain) =>
      passiveRuntime.onFactEvent(event, unitsForChain),
    // R-SKL-08（レビュー再指摘[P1]、PR #214）: `action-skill-use-resolver.ts`と
    // 同じ理由で、この行動専用の`passiveRuntime`が持つregistryをチャージ解放
    // 自身のEffectSequenceにも使い回す。
    lastDamageResults: passiveRuntime.lastDamageResultsRegistry,
  });
  // EFF-006/Issue #212: `applyEffectActionGroups`の戻り値は
  // `onFactEventForPassiveChain`経由で既に`passiveRuntime`（`this.units`）へ
  // 同期済みのため、そのまま`finalizeEffectSequenceResolution`（`this.units`を
  // 参照する）を呼べる。`resolveSkillUse`と同様、このEffectSequence自身の
  // 解決が完了した時点で直ちにそのcounterを破棄する。
  working = passiveRuntime.finalizeEffectSequenceResolution(skillUseId);

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
      effectActions: definitions.effectActions,
      // レビュー再々レビュー[P2]: `ActionCompleting`/Cooldown更新/`ActionCompleted`
      // 自身もこの行動専用の`passiveRuntime`へ接続し、それらを契機とする
      // counter更新・PS候補も（あれば）`finalizeResolutionScope`より前に
      // 解決されるようにする。
      onFactEventForPassiveChain: (event, unitsForChain) =>
        passiveRuntime.onFactEvent(event, unitsForChain),
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
  // レビュー指摘再レビュー[P2]: `06_戦闘状態遷移.md`のCOMPLETING順序では
  // `ActionCompleted`とそのPS連鎖をすべて解決した後にスコープを終了するため、
  // `finalizeResolutionScope`（`resetScope: "RESOLUTION_SCOPE"`のcounter破棄・
  // `RuntimeCounterReset`発行）は`recordActionCompletion`より後で呼び出す。
  // `onFactEventForPassiveChain`が`recordActionCompletion`内の各イベントで
  // `passiveRuntime`を同期済みのため、追加の同期は不要。
  const finalUnits = passiveRuntime.finalizeResolutionScope();

  return {
    units: finalUnits,
    actionScope,
    rootEventId: actionStarted.eventId,
    completedEventId: completion.completedEventId,
  };
}
