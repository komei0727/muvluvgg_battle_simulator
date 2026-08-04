import {
  composeResourceGainRate,
  consumeAp,
  consumeExGaugeFully,
  finalizeAction,
  increaseExGauge,
  recordExtraGaugeOverflowDiscardedIfAny,
  recordResourceChangeIfAny,
  requireUnit,
  type ActionResolutionResult,
} from "./action-resolution-shared.js";
import { recordActionCompletion, recordCooldownStart } from "./action-completion.js";
import {
  completeActionIfActorDefeatedAtStart,
  fireContinuousHealsOnActionStart,
} from "./continuous-heal-service.js";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import { resolveSkillOrder } from "../skill/skill-resolution-service.js";
import {
  decrementSkillUseEffectDurations,
  reapplySkillUseDurationDecrement,
} from "../model/applied-effect-duration.js";
import {
  emitEffectDurationReducedEvents,
  expireEffects,
  expireEffectsSteps,
  type ExpirationSeed,
} from "../effects/duration-expiry-service.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { TargetBindingDefinition } from "../../catalog/definitions/effect-sequence.js";
import type { TargetBindingId, UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { DepletedAbsorberReason } from "../combat/damage-application-service.js";

/**
 * `08_ドメインイベント.md`「TargetsSelected」payload: targetBindingごとの解決対象。
 * R-TGT-09/10: `base: BINDING`が同じsequence内の先行bindingを参照できるよう、
 * ここまでに解決済みのbindingを`resolveTargets`へ渡しながら定義順に確定する。
 */
export function resolveBindingSelections(
  targetBindings: readonly TargetBindingDefinition[],
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): readonly { targetBindingId: string; selectedTargetUnitIds: readonly BattleUnitId[] }[] {
  const resolvedBindingUnits = new Map<TargetBindingId, readonly BattleUnit[]>();
  return targetBindings.map((binding) => {
    const units = resolveTargets(
      binding.selector,
      actor,
      allUnits,
      resolvedBindingUnits,
      undefined,
      unitDefinitions,
    );
    resolvedBindingUnits.set(binding.targetBindingId, units);
    return {
      targetBindingId: binding.targetBindingId,
      selectedTargetUnitIds: units.map((unit) => unit.battleUnitId),
    };
  });
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
    effectiveActionType === "AS"
      ? increaseExGauge(
          working,
          actorId,
          skill.cost.amount,
          composeResourceGainRate(actorAfterCost, "EX_GAUGE", definitions.effectActions),
        )
      : undefined;
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
          actorAfterCost.currentExtraGauge - actor.currentExtraGauge,
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
          actorAfterCost.currentAp - actor.currentAp,
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
      exGain.baseDelta,
      "EX_GAIN",
      lastEventId,
      actionStarted.eventId,
    );
    lastEventId = recordExtraGaugeOverflowDiscardedIfAny(
      resourceChangeContext,
      actorId,
      exGain.baseDelta,
      exGain.requestedAmount,
      exGain.after - exGain.before,
      exGain.discardedAmount,
      lastEventId,
    );
  }

  // R-HEAL-03（M7-005、Issue #184）: 保持者自身の`ActionStarted`を契機とする
  // 継続回復を、スキル本体の解決（対象選択・EffectSequence）より前に発火させる。
  const continuousHeal = fireContinuousHealsOnActionStart(
    working,
    actorId,
    {
      ...resourceChangeContext,
      effectActions: definitions.effectActions,
      // R-DOT-01（DMG-008、Issue #189）: 同じ走査で解決する継続ダメージ。
      // 固定継続ダメージがシールドを枯渇させた場合の失効（R-SHD-01第3項）は、
      // `effect-action-group-resolver.ts`のヒット処理とまったく同じ
      // `expireEffectsSteps`経由で行う（R-EFF-09カスケードとCombatStat再計算を共有する）。
      continuousDamage: {
        effectActions: definitions.effectActions,
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
    lastEventId,
    (event, unitsForChain) => passiveRuntime.onFactEvent(event, unitsForChain).units,
  );
  working = continuousHeal.units;
  lastEventId = continuousHeal.lastEventId;

  // START_EVENT #4（`06_戦闘状態遷移.md`、再レビュー[P2] PR #256）: 継続回復と
  // その`HealApplied`起点のPS連鎖で行動者が戦闘不能になった場合、本体を実行せず
  // `COMPLETING`へ進む。
  const interrupted = completeActionIfActorDefeatedAtStart(
    working,
    actorId,
    recorder,
    {
      actionId,
      resolutionScopeId: actionScope,
      rootEventId: actionStarted.eventId,
      turnNumber,
      cycleNumber,
      actorId,
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

  // 継続回復とそのPS連鎖で使用者自身のHP・combatStatsが変わりうるため、対象選択
  // （`plan`）とその監査再解決（`TargetsSelected.bindings`）はどちらもこの時点の
  // 最新状態から行う — 両者が同じ`BattleUnit`を見ないと、イベントpayloadが実際に
  // 解決された対象と食い違いうる。
  const actorBeforeTargeting = requireUnit(working, actorId);
  const plan = resolveSkillOrder(
    skill,
    actorBeforeTargeting,
    working,
    definitions.effectActions,
    undefined,
    definitions.unitDefinitions,
  );
  const targetUnitIds = plan.targetUnitIds;

  const skillUseId = recorder.nextSkillUseId();
  // EFF-006/Issue #212: この解決（`skillUseId`）が宣言するEffectSequence
  // 自身のcounterUpdates（あれば）を、実際のEffectSequence解決前に登録する
  // （`SkillUseStarting`/`SkillUseStarted`のPS即時連鎖からも対象にできる
  // ようにする）。
  passiveRuntime.beginEffectSequenceResolution(
    skillUseId,
    actorId,
    skill.skillDefinitionId,
    skill.resolution.counterUpdates ?? [],
  );
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
          ? resolveBindingSelections(
              skill.resolution.targetBindings,
              actorBeforeTargeting,
              working,
              definitions.unitDefinitions,
            )
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
      skillType: skill.skillType,
      actorUnitId: actorId,
      targetUnitIds,
      costResource: skill.cost.resource,
      costAmount: skill.cost.amount,
    },
  });
  working = passiveRuntime.onFactEvent(skillUseStarting, working).units;

  // R-SKL-04 #4: 使用したスキルへクールタイムを設定し、現在の行動IDを設定
  // スコープとして記録する（SkillUseStarting発行後、SkillUseStarted発行前）。
  // Issue #143: `SkillUseStarting`のPS解決（あれば）で`working`が変化しうる
  // ため、クールタイムはその後の最新状態（`actorBeforeCooldown`）へ重ねる
  // （`actorAfterExGain`という古いスナップショットへ戻して上書きしない）。
  const actorBeforeCooldown = requireUnit(working, actorId);
  const cooldownResult = recordCooldownStart(
    recorder,
    { actionId, turnNumber, cycleNumber, resolutionScopeId: actionScope, actorId },
    actorBeforeCooldown.cooldowns,
    skill,
    skillUseStarting.eventId,
    actionStarted.eventId,
  );
  const actorWithCooldown = { ...actorBeforeCooldown, cooldowns: cooldownResult.cooldowns };
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
  working = passiveRuntime.onFactEvent(skillUseStarted, working).units;

  const effectResult = applyEffectActionGroups(plan, working, {
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
    onFactEventForPassiveChain: (event, units) => passiveRuntime.onFactEvent(event, units).units,
    // R-SKL-08（レビュー再指摘[P1]、PR #214）: `passiveRuntime`はこの行動専用に
    // 1つだけ生成されており（上のコメント参照）、その`damageResultsRegistry`を
    // このAS/EX自身のEffectSequenceにも使い回すことで、この行動内で発生した
    // DAMAGE結果をPS連鎖（カウンター等）からも同じ解決スコープ内として参照できる。
    damageResults: passiveRuntime.damageResultsRegistry,
  });
  // EFF-006/Issue #212: `effectResult.units`は`onFactEventForPassiveChain`経由で
  // 既に`passiveRuntime`（`this.units`）へ同期済みのため、そのまま
  // `finalizeEffectSequenceResolution`（`this.units`を参照する）を呼べる。
  // このEffectSequence自身の解決が完了した時点（中断でも正常終了でも）で、
  // そのcounterを直ちに破棄する（`SkillUseCompleted`/`SkillUseInterrupted`
  // 発行より前 — この解決自身のcounterであり、行動全体の`resolutionScopeId`
  // 単位で破棄する`finalizeResolutionScope`とは異なるscope）。
  working = passiveRuntime.finalizeEffectSequenceResolution(skillUseId);

  // Issue #217設計方針B: `SkillUseInterrupted`/`SkillUseCompleted`の選択は
  // `effectResult.outcome.status`（実際に解決が最後まで進んだか、使用者戦闘
  // 不能で打ち切ったかという事実）だけから決める。`unresolvedEffectCount`の
  // 値からは決して導出しない（`INTERRUPTED`かつ`unresolvedEffectCount: 0`も
  // 正当な結果として扱う）。
  const skillUseCompleted =
    effectResult.outcome.status === "INTERRUPTED"
      ? recorder.record({
          eventType: "SkillUseInterrupted",
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
            actorUnitId: actorId,
            skillDefinitionId: skill.skillDefinitionId,
            reason: effectResult.outcome.reason,
            resolvedEffectCount: effectResult.outcome.resolvedEffectCount,
            unresolvedEffectCount: effectResult.outcome.unresolvedEffectCount,
          },
        })
      : recorder.record({
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
            skillType: skill.skillType,
            resolvedStepCount:
              skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps.length : 0,
            targetUnitIds,
          },
        });
  // TGT-004フェーズ3再々レビュー[P1]（Issue #167、08_ドメインイベント.md
  // 「イベント発行と処理」の順序契約）: 原因イベント（`SkillUseCompleted`）
  // 自身のPS/Memory候補は、他の子イベントより先に直ちに解決しなければならない
  // （前倒しできる明示的な例外は`RuntimeCounterChanged`のみ）。そのため
  // `SKILL_USE`単位期間減算より先に`SkillUseCompleted`自身をPS連鎖へ渡す。
  // ただし、この連鎖解決前のunitsスナップショット（`preCompletionChainWorking`）
  // から減算対象（`battleUnitId`+`effectInstanceId`のキーのみ）を決定する
  // ——`SkillUseCompleted`（sourceSelector: SELF等）に反応するPSがこのAS/EX
  // 自身とは別の`skillUseId`で新たな`SKILL_USE`期間効果を付与し得るため、
  // 連鎖解決後のunitsから対象を決定すると、そのPSが付与したばかりの効果
  // （`grantedSkillUseId`がこの外側の`skillUseId`と一致しない）まで
  // 「直前のAS/EX使用分」として誤って減算・即時失効させてしまう
  // （PR #238再レビュー[P2]）。中断された（`SkillUseInterrupted`）スキル使用
  // はこの減算契機に含めない（`decrementSkillUseEffectDurations`が明示する
  // 仕様固定）。
  const preCompletionChainWorking = working;
  working = passiveRuntime.onFactEvent(skillUseCompleted, working).units;

  if (skillUseCompleted.eventType === "SkillUseCompleted") {
    const skillUseDurationTargets = decrementSkillUseEffectDurations(
      preCompletionChainWorking,
      actorId,
      skillUseId,
    ).changes.map((change) => ({
      battleUnitId: change.battleUnitId,
      effectInstanceId: change.effectInstanceId,
    }));
    // PR #238再々レビュー[P1]: 決定した対象は`reapplySkillUseDurationDecrement`
    // で連鎖解決後のunitsへ適用する——連鎖解決前のスナップショット値
    // （before/after）をそのまま使い回さず、連鎖解決後の現在値から
    // 都度再計算する。`SkillUseCompleted`自身のPS連鎖（上でdispatch済み）の
    // 中で、その子PS自身の`PassiveResolved`が同じ対象へ独立にSKILL_USE単位
    // 減算をかけている場合があるため（このAS/EXとPSはどちらも同じownerの
    // 「1回のスキル使用完了」であり、互いに独立してR-EFF-04と同じ規約で
    // 減算する）——古いスナップショット値をそのまま設定すると、子PSが既に
    // 適用した減算を上書きし、2回分の減算のうち1回を消してしまう
    // （PR #238再々レビュー[P1]）。対象インスタンスが連鎖解決中に既に
    // 除去されていた場合は`reapplySkillUseDurationDecrement`が無視する。
    const skillUseDurationDecrement = reapplySkillUseDurationDecrement(
      working,
      skillUseDurationTargets,
    );
    if (skillUseDurationDecrement.changes.length > 0) {
      working = skillUseDurationDecrement.units;
      // PR #238再々々レビュー[P2]: 最初の`EffectDurationReduced`の親は、直前の
      // `skillUseCompleted`自身のPS連鎖解決で記録された最後のイベント（誘発
      // されたPSの`PassiveResolved`やその子イベント等）ではなく、この減算の
      // 直接の原因である`skillUseCompleted.eventId`自身にする——
      // `08_ドメインイベント.md`「現在処理中のイベントから直接発生したイベント
      // を子とする」契約と、PS自身の完了経路（`passive-activation-service.ts`が
      // `terminalEvent.eventId`を親に使う）との一貫性のため。
      const reducedEventsStart = recorder.getEvents().length;
      const skillUseDurationLastEventId = emitEffectDurationReducedEvents(
        {
          recorder,
          turnNumber,
          cycleNumber,
          actionId,
          skillUseId,
          resolutionScopeId: actionScope,
          rootEventId: actionStarted.eventId,
        },
        working,
        skillUseDurationDecrement.changes,
        skillUseCompleted.eventId,
      );
      for (const event of recorder.getEvents().slice(reducedEventsStart)) {
        working = passiveRuntime.onFactEvent(event, working).units;
      }

      const skillUseExpirySeeds: ExpirationSeed[] = skillUseDurationDecrement.changes
        .filter((change) => change.after === 0)
        .map((change) => ({
          battleUnitId: change.battleUnitId,
          effectInstanceId: change.effectInstanceId,
          reason: "TIME_LIMIT",
        }));
      if (skillUseExpirySeeds.length > 0) {
        // PR #280レビュー[P1]: 通知は`expireEffects`が1インスタンスの失効ごとに行う
        // （R-EFF-09カスケードで巻き込まれた子効果・子Markerを含む）。
        const skillUseExpiry = expireEffects(
          {
            recorder,
            turnNumber,
            cycleNumber,
            actionId,
            skillUseId,
            resolutionScopeId: actionScope,
            rootEventId: actionStarted.eventId,
            onFactEventForPassiveChain: (event, unitsForChain) =>
              passiveRuntime.onFactEvent(event, unitsForChain).units,
          },
          working,
          skillUseExpirySeeds,
          definitions.effectActions,
          skillUseDurationLastEventId,
        );
        working = skillUseExpiry.units;
      }
    }
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
      effectActions: definitions.effectActions,
      // `ActionCompleting`/Cooldown更新/`ActionCompleted`
      // 自身もこの行動専用の`passiveRuntime`へ接続し、それらを契機とする
      // counter更新・PS候補も（あれば）`finalizeResolutionScope`より前に
      // 解決されるようにする。
      onFactEventForPassiveChain: (event, unitsForChain) =>
        passiveRuntime.onFactEvent(event, unitsForChain).units,
    },
    effectiveActionType,
    skillUseCompleted.eventId,
    working,
  );

  return finalizeAction(passiveRuntime, completion, actionScope, actionStarted.eventId);
}
