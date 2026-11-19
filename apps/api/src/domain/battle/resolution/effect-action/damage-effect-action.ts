import { applyDamageActionSteps } from "../../combat/damage-application-service.js";
import { releaseSubUnitAdditionsSteps } from "../../combat/sub-unit-additional-damage.js";
import { driveRemovalSteps } from "../../combat/damage-hit-chain.js";
import { settleAttackDeathSurvivalsSteps } from "../../combat/damage-hit-point-application.js";
import type { AttackDeathSurvivalLedger } from "../../combat/defensive-intervention-policy.js";
import type { DamageEventContext } from "../../combat/damage-event-context.js";
import { grantEffect } from "../../effects/effect-grant-service.js";
import {
  computeCombatStats,
  recalculateCombatStatsSteps,
} from "../../effects/combat-stat-recalculation-service.js";
import {
  findBlockingImmunity,
  rejectEffectApplication,
} from "../../effects/effect-immunity-service.js";
import { removeFreezeEffectSteps } from "../../effects/freeze-removal-service.js";
import { expireEffectsSteps } from "../../effects/duration-expiry-service.js";
import { applyOneHealSteps } from "../heal-application-service.js";
import { requireUnit } from "../action-resolution-shared.js";
import { evaluateFormula, damageResultsFor } from "../../skill/formula-evaluator.js";
import { isDefeated, type BattleUnit } from "../../model/battle-unit.js";
import { DomainValidationError } from "../../../shared/errors.js";
import type { EffectActionDefinitionId } from "../../../catalog/definitions/catalog-ids.js";
import type { FormulaDefinition } from "../../../catalog/definitions/formula-definition.js";
import type { BattleDomainEvent, EffectActionResultKind } from "../../events/domain-event.js";
import type { DomainEventId, EffectInstanceId } from "../../../shared/event-ids.js";
import type { BattleUnitId } from "../../../shared/ids.js";
import {
  createEffectActionEventCursor,
  type SteppedEffectActionHandler,
} from "./effect-action-handler.js";
import {
  eventContextOf,
  requireActorUnit,
  requireSkillDefinitionId,
  skillTypeOf,
  type EffectActionGroupContext,
  type EffectResolutionStep,
  type UnitsBox,
} from "./effect-action-group-context.js";
import {
  buildConsumeEffectDurationHooks,
  expireHeldAttackConsumptionsSteps,
  holdDeathSurvivalsForSubUnitAdditions,
  instanceKeyOf,
  reservedDeathSurvivalsFor,
  reservedDeathSurvivalsIn,
  suspendedEffectInstanceIdsFor,
  type AttackConsumptionScope,
} from "./effect-duration-consumption.js";
import { grantOnHitEffectSteps } from "./on-hit-effect-grant.js";

/**
 * `combat/`が`lifecycle/`・`effects/`・Catalogの`effectActions`マップへ到達できない
 * （Domain層のmodule境界）ため、DAMAGE解決の途中で必要になる処理を
 * `DamageEventContext`のhookとして注入する。`applyOneHealSteps`/`grantEffect`が
 * `yield`する連鎖境界（`{ units }`）を、`combat/`側の除去ステップ規約
 * （`{ events, units }`）へ変換して中継する形をどちらも共有する。
 */
export type DamageHookSteps = Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
>;

/**
 * R-INT-01 #5（`APPLY_DEATH_SURVIVAL.healAfterSurvival`、DMG-006）: 致死を耐えた直後の
 * 回復をR-HEAL-01の手順（`applyOneHealSteps`）で適用する。回復元・回復対象はどちらも
 * 耐えたユニット自身であり（R-INT-01は付与者の回復量補正を規定しない）、R-HEAL-02の
 * HealingModifier・overheal破棄・R-HEAL-04の回復リンク転送は通常の回復とまったく同じ
 * 経路をたどる。
 */
export function* applyDeathSurvivalHealSteps(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  effectActionDefinitionId: EffectActionDefinitionId,
  formula: FormulaDefinition,
  parentEventId: DomainEventId,
): DamageHookSteps {
  let working = units;
  const survivor = requireUnit(working, targetUnitId);
  const healGen = applyOneHealSteps(
    { effectActionDefinitionId, formula },
    survivor,
    survivor,
    working,
    {
      ...eventContextOf(context),
      parentEventId,
      sourceUnitId: targetUnitId,
      effectActions: context.definitions.effectActions,
      ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
      ...(context.triggerSkillUseId !== undefined
        ? { triggerSkillUseId: context.triggerSkillUseId }
        : {}),
      ...(context.onFactEventForPassiveChain !== undefined
        ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
        : {}),
    },
    parentEventId,
  );
  let eventsStart = context.recorder.getEvents().length;
  let healStep = healGen.next();
  while (!healStep.done) {
    const injected = yield {
      events: context.recorder.getEvents().slice(eventsStart),
      units: healStep.value.units,
    };
    eventsStart = context.recorder.getEvents().length;
    working = injected ?? healStep.value.units;
    healStep = healGen.next(working);
  }
  const healResult = healStep.value;
  return {
    units: healResult?.units ?? working,
    lastEventId: healResult?.lastEventId ?? parentEventId,
  };
}

/**
 * R-SUB-02第3項（`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`、DMG-005）: サブユニットの追加
 * ダメージに付随するデバフを、追加ダメージを受けた対象へ付与する。
 *
 * 参照先が`APPLY_STAT_MOD`であることは`catalog-integrity.ts`がCatalogロード時点で保証する
 * （production例は`SKL_SHIRANA_SORA_AS1`「攻撃対象の行動速度を20低下させるデバフ（重複可）」）。
 * 付与そのものは通常の`APPLY_STAT_MOD`解決と同じ経路を通り、`EffectApplied`・CombatStat
 * 再計算（`CombatStatChanged`/`EffectiveEffectChanged`）まで行う — 追加デバフだけが別の
 * ライフサイクルを持たないようにするためである。R-EFF-03の免疫（`EFFECT_IMMUNITY`）判定も
 * 通常の付与と同じく行う。
 */
function* grantSubUnitAdditionalDamageDebuffSteps(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  debuffEffectActionDefinitionId: EffectActionDefinitionId,
  ownerUnitId: BattleUnitId,
  parentEventId: DomainEventId,
): DamageHookSteps {
  const definition = context.definitions.effectActions.get(debuffEffectActionDefinitionId);
  if (definition === undefined || definition.kind !== "APPLY_STAT_MOD") {
    throw new DomainValidationError(
      "subUnit.additionalDamage.debuff.effectActionDefinitionId",
      `references "${debuffEffectActionDefinitionId}", which must be an APPLY_STAT_MOD EffectActionDefinition present in the Catalog (catalog-integrity.ts rejects anything else at load time)`,
    );
  }
  const eventContext = eventContextOf(context);
  const eventsStart = context.recorder.getEvents().length;
  const owner = requireUnit(units, ownerUnitId);
  const target = requireUnit(units, targetUnitId);
  const magnitude = evaluateFormula(definition.payload.formula, {
    skillSource: owner,
    target,
    allUnits: units,
    ...(context.exercise !== undefined ? { exercise: context.exercise } : {}),
    lastResults: damageResultsFor(
      context.damageResults,
      ownerUnitId,
      context.skillUseId,
      context.triggerSkillUseId,
    ),
  });
  const blockingImmunity = findBlockingImmunity(
    target,
    { effectActionDefinitionId: debuffEffectActionDefinitionId, magnitude },
    definition,
  );
  if (blockingImmunity !== undefined) {
    const rejection = rejectEffectApplication(
      eventContext,
      units,
      {
        effectActionDefinitionId: debuffEffectActionDefinitionId,
        sourceUnitId: ownerUnitId,
        targetUnitId,
        blockingEffect: blockingImmunity,
      },
      parentEventId,
    );
    const injected = yield {
      events: context.recorder.getEvents().slice(eventsStart),
      units: rejection.units,
    };
    return { units: injected ?? rejection.units, lastEventId: rejection.lastEventId };
  }
  const grantResult = grantEffect(
    eventContext,
    units,
    {
      definition,
      sourceUnitId: ownerUnitId,
      targetUnitId,
      duplicate: definition.payload.stacking.mode === "STACKABLE",
      magnitude,
      durationDefinition: definition.payload.duration,
    },
    parentEventId,
  );
  // R-TEX-03 #2: 再計算がHP上限を下げて演習の敵をブレイクさせた場合、その中間stepを
  // 連鎖driverへ返して撃破トリガーを解除より前に解決させる（同期wrapperを使うと
  // 解除・強化・全回復まで済ませてからまとめて通知され、順序が逆転する）。
  //
  // 通常戦闘では`recalculateCombatStatsSteps`が一度も`yield`しないため、ループ本体は
  // 実行されず、末尾の1回だけの通知（従来と同じ粒度）になる。
  let cursor = eventsStart;
  const recalculationSteps = recalculateCombatStatsSteps(
    eventContext,
    units,
    grantResult.units,
    targetUnitId,
    context.definitions.effectActions,
    grantResult.lastEventId,
    "EFFECT_APPLIED",
  );
  let step = recalculationSteps.next();
  while (!step.done) {
    // 記録済みで未通知のイベントをまとめて渡す（`step.value.events`はその部分集合）。
    // cursorを進めることで、次のstepと末尾の通知が同じイベントを二度渡さない。
    const injectedMidway = yield {
      events: context.recorder.getEvents().slice(cursor),
      units: step.value.units,
    };
    cursor = context.recorder.getEvents().length;
    step = recalculationSteps.next(injectedMidway ?? step.value.units);
  }
  const injected = yield {
    events: context.recorder.getEvents().slice(cursor),
    units: step.value.units,
  };
  return { units: injected ?? step.value.units, lastEventId: step.value.lastEventId };
}

/**
 * R-EFF-07: 同じstepの別の攻撃が使い切って失効を待っている効果（この攻撃は消費していない
 * もの）を除き、能力値を計算し直したユニットを返すview。攻撃側・被攻撃側の別を問わない。
 * 除く効果を保持していなければユニットをそのまま返す。
 */
function unitViewWithout(
  suspendedEffectInstanceIds: ReadonlySet<EffectInstanceId>,
  context: EffectActionGroupContext,
): (unit: BattleUnit) => BattleUnit {
  return (unit) => {
    const appliedEffects = unit.appliedEffects.filter(
      (effect) => !suspendedEffectInstanceIds.has(effect.effectInstanceId),
    );
    if (appliedEffects.length === unit.appliedEffects.length) {
      return unit;
    }
    const withoutSuspended = { ...unit, appliedEffects };
    return {
      ...withoutSuspended,
      combatStats: computeCombatStats(
        withoutSuspended,
        context.definitions.effectActions,
        context.exercise,
      ).combatStats,
    };
  };
}

/** R-SKL-06 #5: DAMAGE適用結果から`EffectActionCompleted`のresultKindを導く。 */
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
 * R-SKL-06「ACTION step」#3〜#5のDAMAGE適用。`combat/damage-application-service.ts`へ
 * 委譲し、`combat/`が到達できない`effects/`・`lifecycle/`・Catalog依存の処理をhookとして
 * 注入する（凍結解除カスケード・枯渇吸収体の失効・サブユニット追加デバフ・致死耐え回復・
 * 効果期間の消費）。
 *
 * `applyDamageActionSteps`は`context.onFactEventForPassiveChain`未指定
 * （= PS自身のEffectSequence解決）の場合のみ凍結解除のlinkedEffectGroupカスケードの
 * ステップを`yield`しうる。そのステップをこのハンドラ自身の`EFFECT_RESOLVED`として
 * そのまま`yield`し、`driveActivation`の共有stateへ正しく参加させる — ここで消費した分だけ
 * 内部イベントの捕捉位置を前進させ、二重処理を防ぐ。
 *
 * `yield`するのはカスケード自身のイベントだけではなく未通知イベント全体である —
 * カスケードが始まる前に記録済みの`HitConfirmed`/`CriticalCheckResolved`/
 * `DamageCalculated`（他のkindと同じ「先行FACTイベントも同じEFFECT_RESOLVEDへ含める」慣例）
 * も、この最初のyieldで一緒に即時連鎖へ届ける。これが無いと、これらのイベントは
 * どちらの経路にも含まれず、対応するPS/Memory/RuntimeCounterが発動しなくなる。
 */
export const resolveDamage: SteppedEffectActionHandler<"DAMAGE"> = function* (input) {
  const { context, box, application, effectAction, startingEventId, cursor } = input;
  const currentActor = requireActorUnit(context, box);
  // R-ACTN-01 #2: `includeDefeated`が明示された対象は、開始時点で戦闘不能であっても
  // `applyDamageAction`がヒットを適用するため、resultKind算出上も「既に戦闘不能」として
  // 扱わない。
  const targetAlreadyDefeated =
    !application.includeDefeated && isDefeated(requireUnit(box.units, application.targetUnitId));
  const { consumeEffectDuration, finalizeConsumedEffectDurations } =
    buildConsumeEffectDurationHooks(context, input.attack?.scope);
  // R-EFF-07: 範囲攻撃は対象ごとの適用にまたがる1回の攻撃のため、消費で0になった効果の
  // 失効はその攻撃の最後の適用まで待つ（途中で失効させると2体目以降・肩代わりの2回目に
  // 効かない）。その間、同じstepの別のDAMAGEの計算からは除く。
  const finalizesAttack = input.attack === undefined || input.attack.final;
  const suspendedEffectInstanceIds =
    input.attack === undefined
      ? new Set<EffectInstanceId>()
      : suspendedEffectInstanceIdsFor(input.attack.scope, context.heldAttackConsumptions);
  const skillType = skillTypeOf(context);
  const damageGen = applyDamageActionSteps(
    currentActor,
    application.hits,
    effectAction,
    box.units,
    context.random,
    {
      ...eventContextOf(context),
      parentEventId: startingEventId,
      skillDefinitionId: requireSkillDefinitionId(context),
      // R-CFS-02（DMG-009）: 混乱はASの攻撃だけに働く。
      ...(skillType !== undefined ? { skillType } : {}),
      consumeEffectDuration,
      ...(finalizesAttack ? { finalizeConsumedEffectDurations } : {}),
      holdAttackDeathSurvivals: (ledger) => holdDeathSurvivalsForSubUnitAdditions(context, ledger),
      // R-INT-01 #5: 範囲攻撃の各対象への適用は同じ1回の攻撃のため、致死耐えの台帳を共有する。
      ...(input.attack === undefined
        ? {}
        : {
            attackDeathSurvivals: input.attack.scope.deathSurvivals,
            attackStartHitPointRatios: input.attack.scope.startHitPointRatios,
          }),
      reservedDeathSurvivals: reservedDeathSurvivalsFor(context, input.attack?.scope),
      ...(suspendedEffectInstanceIds.size > 0
        ? {
            suspendedEffectInstanceIds,
            unitView: unitViewWithout(suspendedEffectInstanceIds, context),
          }
        : {}),
      includeDefeated: application.includeDefeated,
      // R-TEX-02／R-TEX-03: 演習状態とブレイク解決hookは`eventContextOf`が組で載せる
      // （上の spread に含まれる）。ここで個別に足すと片方だけ渡す配線ミスを許してしまう。
      // R-STS-03＋R-EFF-09: `combat/`は`effects/`へ依存できないため、凍結解除の
      // linkedEffectGroupカスケード（`duration-expiry-service.ts`と同じ
      // `collectLinkedGroupCascade`）とCombatStat再計算をここから注入する。
      // `removeFreezeEffectSteps`（generator）をそのまま返す —
      // `applyDamageActionSteps`が`context.onFactEventForPassiveChain`の有無に応じて
      // 同期駆動/`yield`のどちらでも正しく駆動できる。
      removeFreezeEffect: (
        targetUnitId,
        freezeEffectInstanceId,
        triggeringDamage,
        units,
        parentEventId,
      ) =>
        removeFreezeEffectSteps(
          eventContextOf(context),
          units,
          targetUnitId,
          freezeEffectInstanceId,
          triggeringDamage,
          context.definitions.effectActions,
          parentEventId,
        ),
      // R-SHD-01第3項＋R-SUB-01＋R-EFF-09（DMG-004／DMG-005）: 枯渇したシールド・
      // サブユニットの失効も`removeFreezeEffect`とまったく同じ理由でここから注入する。
      // `expireEffectsSteps`をそのまま使うため、`linkedEffectGroupId`カスケード
      // （production例: `LILY_SINGER_PS2_LINK`「シールドの消滅と共に攻撃力バフも消滅する」）と
      // CombatStat再計算は他の失効契機と完全に同じ経路をたどる。
      expireDepletedAbsorbers: (
        targetUnitId,
        depletedEffectInstanceIds,
        reason,
        units,
        parentEventId,
      ) =>
        expireEffectsSteps(
          eventContextOf(context),
          units,
          depletedEffectInstanceIds.map((effectInstanceId) => ({
            battleUnitId: targetUnitId,
            effectInstanceId,
            reason,
          })),
          context.definitions.effectActions,
          parentEventId,
        ),
      grantSubUnitAdditionalDamageDebuff: (
        targetUnitId,
        debuffEffectActionDefinitionId,
        ownerUnitId,
        units,
        parentEventId,
      ) =>
        grantSubUnitAdditionalDamageDebuffSteps(
          context,
          units,
          targetUnitId,
          debuffEffectActionDefinitionId,
          ownerUnitId,
          parentEventId,
        ),
      applyDeathSurvivalHeal: (
        targetUnitId,
        effectActionDefinitionId,
        formula,
        units,
        parentEventId,
      ) =>
        applyDeathSurvivalHealSteps(
          context,
          units,
          targetUnitId,
          effectActionDefinitionId,
          formula,
          parentEventId,
        ),
      // R-DMG-05 #2a: 命中確定時付与は追撃のonHitEffectsと同じ付与経路を使う。帰属先は攻撃者。
      grantHitConfirmedEffect: (
        targetUnitId,
        effectActionDefinitionId,
        attackerUnitId,
        units,
        parentEventId,
      ) =>
        grantOnHitEffectSteps(
          context,
          units,
          targetUnitId,
          effectActionDefinitionId,
          attackerUnitId,
          undefined,
          parentEventId,
        ),
      ...(context.onFactEventForPassiveChain !== undefined
        ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
        : {}),
      ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
      ...(context.triggerSkillUseId !== undefined
        ? { triggerSkillUseId: context.triggerSkillUseId }
        : {}),
      ...(context.subUnitAdditions !== undefined
        ? { subUnitAdditions: context.subUnitAdditions }
        : {}),
      // R-FUP-01: AS/EXスキル使用だけが渡す追撃捕捉をヒット処理へ素通しする。
      ...(context.followUpAttackCapture !== undefined
        ? { followUpAttackCapture: context.followUpAttackCapture }
        : {}),
      ...(context.triggerSourceUnitId !== undefined
        ? { triggerSourceUnitId: context.triggerSourceUnitId }
        : {}),
      ...(context.triggerTargetUnitIds !== undefined
        ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
        : {}),
      ...(context.triggerProcessedTargetUnitIds !== undefined
        ? { triggerProcessedTargetUnitIds: context.triggerProcessedTargetUnitIds }
        : {}),
      ...(context.triggerSkillUseId !== undefined
        ? { triggerSkillUseId: context.triggerSkillUseId }
        : {}),
    },
  );
  let damageStep = damageGen.next();
  while (!damageStep.done) {
    // このカスケードステップの`units`を`box.units`へ反映してから`yield`する
    // （`passive-activation-service.ts`の`this.units = box.units`と同じsync-out）。
    // これにより、この`yield`を処理する`driveActivation`側の子PS候補検出・発動が
    // この時点の正しい中間状態を参照できる。
    box.units = damageStep.value.units;
    yield { kind: "EFFECT_RESOLVED", events: cursor.takePending() };
    // 再開時点のrecorder末尾までは、driverがこの`yield`で既に解決した子連鎖。
    // 拾い直すと同じイベントが2度`resolveEvent`へ渡る（`consumeResolvedByDriver`）。
    cursor.consumeResolvedByDriver();
    // 子PS連鎖（あれば）が`box.units`を書き換えている可能性があるため、一時停止していた
    // generatorを再開する前に取り込む（sync-in）。
    damageStep = damageGen.next(box.units);
  }
  const damageResult = damageStep.value;
  box.units = damageResult.units;
  // R-SUB-02＋R-EFF-07: 保留した追加ヒットが、その対象を攻撃したこの攻撃の消費済み効果だけを
  // 見られるよう、実際に向かった防御側ごとに攻撃を記録する。
  if (input.attack !== undefined && context.attackScopesByDefender !== undefined) {
    for (const hit of damageResult.hits) {
      const scopes = context.attackScopesByDefender.get(hit.targetUnitId) ?? [];
      if (!scopes.includes(input.attack.scope)) {
        scopes.push(input.attack.scope);
      }
      context.attackScopesByDefender.set(hit.targetUnitId, scopes);
    }
  }
  return {
    // 中断の判定は`interruptedCount > 0`ではなく`interrupted`を見る。R-SUB-02の
    // サブユニット追加ヒットは`application.hits`に含まれないため、追加ヒットの解決中に
    // 使用者が戦闘不能になっても`interruptedCount`は0のままであり、そのままでは
    // `APPLIED`として後続stepまで進んでしまう（HEALの`healResult.interrupted`と同じ扱い）。
    resultKind: damageResultKind(
      targetAlreadyDefeated,
      damageResult.interrupted,
      damageResult.hits.some((hit) => hit.applied),
    ),
    resolvedCount: application.hits.length - damageResult.interruptedCount,
    interruptedCount: damageResult.interruptedCount,
    // MISS・対象戦闘不能でスキップされたヒット（`applied === false`）は会心判定自体を
    // 行っていないため数えない（DMG-003）。
    criticalHitCount: damageResult.hits.filter((hit) => hit.applied && hit.isCritical).length,
    // R-INT-02第2項: 後続の命中条件付き効果は、最終的にダメージを受けた対象へ付ける。
    hitDefenderUnitIds: [
      ...new Set(damageResult.hits.filter((hit) => hit.applied).map((hit) => hit.targetUnitId)),
    ],
    lastEventId: damageResult.lastEventId,
  };
};

/**
 * R-SUB-02（Issue #836）: DAMAGE区間の終わりに、スキル使用の台帳へ保留した追加ヒットを
 * 対象の初出順でまとめて解決し、その後で元攻撃が消費して0にした効果を失効させる。
 *
 * 追加ヒットは元攻撃の一部であり、攻撃単位の消費（`NEXT_INCOMING_ATTACK`／
 * `NEXT_OUTGOING_ATTACK`）は元攻撃のDAMAGEで済んでいる。ここで新しい攻撃として数え直すと
 * 「次の攻撃」効果を追加ヒットだけで1回分消費してしまうため、攻撃単位の消費は行わない。
 * 元攻撃が消費した効果は`heldAttackConsumptions`がまだ失効させずに残しているため、
 * 追加ヒットにも元攻撃と同じく乗る（R-EFF-07）。ヒット単位の消費（`OUTGOING_HIT`／
 * `INCOMING_HIT`等）は通常のヒットと同じく行う。
 *
 * `releaseAdditions`が偽（使用者の戦闘不能で中断した解決の後始末）なら追加ヒットは解決せず、
 * 残していた効果の失効だけを行う。
 *
 * `onFactEventForPassiveChain`未指定（PS自身のEffectSequence）の経路では、`resolveDamage`と
 * 同じく未通知イベントを`EFFECT_RESOLVED`として`yield`し、driverへ連鎖を委ねる。
 */
export function* releasePendingSubUnitAdditionsSteps(
  context: EffectActionGroupContext,
  box: UnitsBox,
  parentEventId: DomainEventId,
  releaseAdditions = true,
): Generator<
  EffectResolutionStep,
  { readonly lastEventId: DomainEventId; readonly interrupted: boolean },
  void
> {
  const ledger = context.subUnitAdditions;
  if (
    ledger === undefined ||
    (ledger.pending.size === 0 &&
      (context.heldAttackConsumptions?.length ?? 0) === 0 &&
      (context.heldDeathSurvivals?.length ?? 0) === 0)
  ) {
    return { lastEventId: parentEventId, interrupted: false };
  }
  const { consumeEffectDuration, finalizeConsumedEffectDurations } =
    buildConsumeEffectDurationHooks(context);
  const skillType = skillTypeOf(context);
  const damageContext: DamageEventContext = {
    ...eventContextOf(context),
    parentEventId,
    skillDefinitionId: requireSkillDefinitionId(context),
    ...(skillType !== undefined ? { skillType } : {}),
    consumeEffectDuration: (ownerUnitId, kind, units, callParentEventId, ...rest) =>
      kind === "NEXT_INCOMING_ATTACK" || kind === "NEXT_OUTGOING_ATTACK"
        ? noConsumption(units, callParentEventId)
        : consumeEffectDuration(ownerUnitId, kind, units, callParentEventId, ...rest),
    finalizeConsumedEffectDurations,
    expireDepletedAbsorbers: (
      targetUnitId,
      depletedEffectInstanceIds,
      reason,
      units,
      expiryParentEventId,
    ) =>
      expireEffectsSteps(
        eventContextOf(context),
        units,
        depletedEffectInstanceIds.map((effectInstanceId) => ({
          battleUnitId: targetUnitId,
          effectInstanceId,
          reason,
        })),
        context.definitions.effectActions,
        expiryParentEventId,
      ),
    grantSubUnitAdditionalDamageDebuff: (
      targetUnitId,
      debuffEffectActionDefinitionId,
      ownerUnitId,
      units,
      grantParentEventId,
    ) =>
      grantSubUnitAdditionalDamageDebuffSteps(
        context,
        units,
        targetUnitId,
        debuffEffectActionDefinitionId,
        ownerUnitId,
        grantParentEventId,
      ),
    applyDeathSurvivalHeal: (
      targetUnitId,
      effectActionDefinitionId,
      formula,
      units,
      healParentEventId,
    ) =>
      applyDeathSurvivalHealSteps(
        context,
        units,
        targetUnitId,
        effectActionDefinitionId,
        formula,
        healParentEventId,
      ),
    ...(context.onFactEventForPassiveChain !== undefined
      ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
      : {}),
    ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
    ...(context.triggerSkillUseId !== undefined
      ? { triggerSkillUseId: context.triggerSkillUseId }
      : {}),
    subUnitAdditions: ledger,
  };

  const cursor = createEffectActionEventCursor(context, box);
  const working = new Map(box.units.map((unit) => [unit.battleUnitId, unit]));
  const drive = function* <T>(
    gen: Generator<{ readonly units: readonly BattleUnit[] }, T, readonly BattleUnit[] | undefined>,
  ): Generator<EffectResolutionStep, T, void> {
    let step = gen.next();
    while (!step.done) {
      // `resolveDamage`のdriverと同じsync-out → yield → sync-in。
      box.units = step.value.units;
      yield { kind: "EFFECT_RESOLVED", events: cursor.takePending() };
      cursor.consumeResolvedByDriver();
      step = gen.next(box.units);
    }
    return step.value;
  };
  // R-SUB-02＋R-EFF-07: 対象ごとに、その対象を攻撃した攻撃が消費した効果だけを乗せる。
  // 保留中の消費済み効果のうち、その対象への攻撃のどれも消費していないものは除いて計算する
  // （通常のDAMAGE経路の`suspendedEffectInstanceIdsFor`と同じ扱い）。
  const heldScopes = context.heldAttackConsumptions ?? [];
  // R-INT-01 #5: 追加ヒットは元攻撃の一部のため、その対象を攻撃した攻撃（DAMAGE）の台帳で
  // 耐えを共有する。元攻撃で耐えたユニット（リンク・反射の派生ダメージで耐えたユニットを含む）は
  // 同じ耐えでHPを止め、追加ヒット（とその派生）で初めて耐えた分はその攻撃の台帳へ書き戻して、
  // 同じ攻撃の残る対象の追加ヒットへ引き継ぐ。別のDAMAGEの台帳は混ぜない（別の攻撃だからである）。
  // 精算は全対象の追加ヒットを解決し終えてから1回だけ行う（攻撃の終わりはそこだからである）。
  const settlementLedgers = new Set<AttackDeathSurvivalLedger>(context.heldDeathSurvivals ?? []);
  const allAttackLedgers = new Set<AttackDeathSurvivalLedger>([
    ...(context.heldDeathSurvivals ?? []),
    ...[...(context.attackScopesByDefender?.values() ?? [])].flatMap((scopes) =>
      scopes.map((scope) => scope.deathSurvivals),
    ),
  ]);
  let released: { lastEventId: DomainEventId; interrupted: boolean } = {
    lastEventId: parentEventId,
    interrupted: false,
  };
  if (releaseAdditions && context.actorUnitId !== undefined) {
    for (const targetUnitId of [...ledger.pending.keys()]) {
      const attackingScopes = context.attackScopesByDefender?.get(targetUnitId) ?? [];
      const suspended = new Set<EffectInstanceId>();
      for (const held of heldScopes) {
        for (const seed of held.pendingExpirySeeds) {
          const key = instanceKeyOf(seed);
          if (!attackingScopes.some((scope) => scope.consumedInstanceKeys.has(key))) {
            suspended.add(seed.effectInstanceId);
          }
        }
      }
      const attackLedgers = attackingScopes.map((scope) => scope.deathSurvivals);
      const targetSurvivals: AttackDeathSurvivalLedger = new Map();
      for (const attackLedger of attackLedgers) {
        settlementLedgers.add(attackLedger);
        for (const [unitId, entry] of attackLedger) {
          if (!targetSurvivals.has(unitId)) {
            targetSurvivals.set(unitId, entry);
          }
        }
      }
      const targetContext: DamageEventContext = {
        ...damageContext,
        attackDeathSurvivals: targetSurvivals,
        // 別の攻撃が使い、まだ精算していない耐えは、ここで新たに耐える場合も除く。先行する
        // 対象の追加ヒットで初めて使った分も含めるため、対象ごとに数え直す。
        reservedDeathSurvivals: reservedDeathSurvivalsIn(
          [...allAttackLedgers].filter((attackLedger) => !attackLedgers.includes(attackLedger)),
        ),
        ...(suspended.size === 0
          ? {}
          : {
              suspendedEffectInstanceIds: suspended,
              unitView: unitViewWithout(suspended, context),
            }),
      };
      released = yield* drive(
        releaseSubUnitAdditionsSteps(
          targetContext,
          working,
          context.random,
          context.actorUnitId,
          ledger,
          [targetUnitId],
          released.lastEventId,
        ),
      );
      for (const [unitId, entry] of targetSurvivals) {
        for (const attackLedger of attackLedgers) {
          if (!attackLedger.has(unitId)) {
            attackLedger.set(unitId, entry);
          }
        }
      }
      if (released.interrupted) {
        break;
      }
    }
  }
  ledger.pending.clear();
  // R-INT-01 #5: 追加ヒットまで含めた攻撃の終わりとして、各攻撃の致死耐えを精算する（複数の
  // 台帳に載る同じエントリは1回だけ精算される）。
  context.heldDeathSurvivals?.splice(0);
  for (const settlementLedger of settlementLedgers) {
    released = {
      ...released,
      lastEventId: yield* drive(
        settleAttackDeathSurvivalsSteps(
          damageContext,
          working,
          settlementLedger,
          released.lastEventId,
        ),
      ),
    };
  }
  const finalized = yield* drive(
    driveRemovalSteps(
      damageContext,
      working,
      finalizeConsumedEffectDurations(Array.from(working.values()), released.lastEventId),
    ),
  );
  const expired = yield* drive(
    driveRemovalSteps(
      damageContext,
      working,
      expireHeldAttackConsumptionsSteps(
        context,
        Array.from(working.values()),
        finalized.lastEventId,
      ),
    ),
  );
  box.units = box.units.map((unit) => working.get(unit.battleUnitId) ?? unit);
  const pending = cursor.takePending();
  if (pending.length > 0 && context.onFactEventForPassiveChain === undefined) {
    yield { kind: "EFFECT_RESOLVED", events: pending };
  }
  return { lastEventId: expired.lastEventId, interrupted: released.interrupted };
}

/**
 * R-INT-01 #5: 最後の適用が開始されなかった攻撃（命中条件で除外・使用者の戦闘不能で中断）で
 * 致死を耐えた分を、stepの終わりに精算する。耐えの回数を次の攻撃へ持ち越さないためである。
 */
export function* settleUnfinishedAttackDeathSurvivalsSteps(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  scope: AttackConsumptionScope,
  parentEventId: DomainEventId,
): DamageHookSteps {
  const { consumeEffectDuration } = buildConsumeEffectDurationHooks(context, scope);
  const damageContext: DamageEventContext = {
    ...eventContextOf(context),
    parentEventId,
    skillDefinitionId: requireSkillDefinitionId(context),
    consumeEffectDuration,
    applyDeathSurvivalHeal: (
      targetUnitId,
      effectActionDefinitionId,
      formula,
      unitsForHeal,
      healParentEventId,
    ) =>
      applyDeathSurvivalHealSteps(
        context,
        unitsForHeal,
        targetUnitId,
        effectActionDefinitionId,
        formula,
        healParentEventId,
      ),
  };
  const working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  const lastEventId = yield* settleAttackDeathSurvivalsSteps(
    damageContext,
    working,
    scope.deathSurvivals,
    parentEventId,
  );
  return { units: units.map((unit) => working.get(unit.battleUnitId) ?? unit), lastEventId };
}

function* noConsumption(
  units: readonly BattleUnit[],
  parentEventId: DomainEventId,
): ReturnType<NonNullable<DamageEventContext["consumeEffectDuration"]>> {
  // 消費しないため除去ステップも無い。
  yield* [];
  return { units, lastEventId: parentEventId };
}
