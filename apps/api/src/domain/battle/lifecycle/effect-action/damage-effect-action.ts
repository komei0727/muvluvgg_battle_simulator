import { applyDamageActionSteps } from "../../combat/damage-application-service.js";
import { grantEffect } from "../../effects/effect-grant-service.js";
import { recalculateCombatStats } from "../../effects/combat-stat-recalculation-service.js";
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
import type { DomainEventId } from "../../../shared/event-ids.js";
import type { BattleUnitId } from "../../../shared/ids.js";
import type { SteppedEffectActionHandler } from "./effect-action-handler.js";
import {
  eventContextOf,
  requireActorUnit,
  requireSkillDefinitionId,
  skillTypeOf,
  type EffectActionGroupContext,
} from "./effect-action-group-context.js";
import { buildConsumeEffectDurationHooks } from "./effect-duration-consumption.js";

/**
 * `combat/`が`lifecycle/`・`effects/`・Catalogの`effectActions`マップへ到達できない
 * （Domain層のmodule境界）ため、DAMAGE解決の途中で必要になる処理を
 * `DamageEventContext`のhookとして注入する。`applyOneHealSteps`/`grantEffect`が
 * `yield`する連鎖境界（`{ units }`）を、`combat/`側の除去ステップ規約
 * （`{ events, units }`）へ変換して中継する形をどちらも共有する。
 */
type DamageHookSteps = Generator<
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
function* applyDeathSurvivalHealSteps(
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
    lastResults: damageResultsFor(context.damageResults, ownerUnitId, context.skillUseId),
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
  const recalculation = recalculateCombatStats(
    eventContext,
    units,
    grantResult.units,
    targetUnitId,
    context.definitions.effectActions,
    grantResult.lastEventId,
    "EFFECT_APPLIED",
  );
  const injected = yield {
    events: context.recorder.getEvents().slice(eventsStart),
    units: recalculation.units,
  };
  return { units: injected ?? recalculation.units, lastEventId: recalculation.lastEventId };
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
    buildConsumeEffectDurationHooks(context);
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
      finalizeConsumedEffectDurations,
      includeDefeated: application.includeDefeated,
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
      ...(context.onFactEventForPassiveChain !== undefined
        ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
        : {}),
      ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
      ...(context.triggerSourceUnitId !== undefined
        ? { triggerSourceUnitId: context.triggerSourceUnitId }
        : {}),
      ...(context.triggerTargetUnitIds !== undefined
        ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
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
    lastEventId: damageResult.lastEventId,
  };
};
