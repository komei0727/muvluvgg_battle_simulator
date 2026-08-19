import { activeStatusEffect, isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { calculateDamage, type ConfusionDamageInput } from "./damage-calculator.js";
import { composePiercing } from "./piercing-policy.js";
import { damageResultsFor, recordDamageResult } from "../skill/formula-evaluator.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { resolveDamageImmunity } from "./damage-immunity-policy.js";
import { composeDamageModifiers } from "./damage-modifier-policy.js";
import { resolveThresholdDamageReduction } from "./threshold-damage-reduction-policy.js";
import { guardedDamage } from "./defensive-intervention-policy.js";
import type {
  ApplyDamageActionResult,
  DamageEventContext,
  DamageHitOutcome,
  DamageStep,
} from "./damage-event-context.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import { consumeAndExpire, driveRemovalSteps, findUnit } from "./damage-hit-chain.js";
import { removeFreezeEffectSteps } from "./damage-effect-expiry.js";
import { observeHitSteps } from "./damage-hit-observation.js";
import { resolveDefensiveInterventionsSteps } from "./damage-defensive-intervention.js";
import { applyConfirmedDamageSteps } from "./damage-hit-point-application.js";
import { applyLinkedDamageSteps, applyReflectedDamageSteps } from "./damage-propagation.js";
import { applySubUnitAdditionalDamageSteps } from "./sub-unit-additional-damage.js";
import { applyAttackBonusAttacksSteps } from "./attack-bonus-attack.js";
import {
  applyDamageToHealConversionSteps,
  resolveDamageToHealRate,
} from "./damage-to-heal-conversion.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { SkillType } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { RandomSource } from "../../ports/random-source.js";

export type {
  ApplyDamageActionResult,
  DamageEventContext,
  DamageHitOutcome,
  DamageStep,
  DepletedAbsorberReason,
  FollowUpAttackCapture,
} from "./damage-event-context.js";
export { emptyFollowUpAttackCapture } from "./damage-event-context.js";

/**
 * R-CFS-02（DMG-009）: このヒットへ適用する混乱の数値。ASでない攻撃、混乱を保持しない
 * 攻撃側では`undefined`（＝混乱倍率1・基礎ダメージ差し替えなし）。
 *
 * 「複数の混乱を保持する場合は付与順で最初の1件だけを適用する」は`activeStatusEffect`
 * （`appliedEffects`を付与順に走査して最初の一致を返す）がそのまま満たす。
 * 混乱は`STATUS_KINDS`のうちCatalog factoryが`confusion`を必須にしている唯一の
 * statusのため、`statusDetails.confusion`が欠けるのはCatalogを経由しない構築だけで、
 * その場合は混乱なしとして扱う（silentに既定値へ落とすより安全側）。
 */
function resolveConfusion(
  attacker: BattleUnit,
  skillType: SkillType | undefined,
): ConfusionDamageInput | undefined {
  if (skillType !== "AS") {
    return undefined;
  }
  return activeStatusEffect(attacker, "CONFUSION")?.statusDetails?.confusion;
}

function skip(hit: ResolvedEffectApplication): DamageHitOutcome {
  return {
    targetUnitId: hit.targetUnitId,
    hitIndex: hit.hitIndex,
    applied: false,
    isCritical: false,
    damage: 0,
  };
}

/**
 * `DamageApplicationService` の基本形 (`05_ドメインモデル.md`)。`SkillResolutionService`が
 * 解決した1つのDAMAGE EffectActionのヒット列を、R-DMG-05の順序（命中→会心→
 * ダメージ適用直前TIMING→ダメージ計算→HP適用→戦闘不能判定）でヒットごとに処理する
 * **ディスパッチャ**であり、各段の実装は責務別モジュールが持つ。
 *
 * | 段 | モジュール |
 * | --- | --- |
 * | R-DMG-05 #1〜#4 の観測（命中・会心・`DamageWillBeApplied`） | `damage-hit-observation.ts` |
 * | R-INT-01 の防御介入（引き寄せ・肩代わり・リンク/反射の成立判定） | `damage-defensive-intervention.ts` |
 * | R-STS-03 の凍結解除・R-SHD-01/R-SUB-01 の枯渇失効 | `damage-effect-expiry.ts` |
 * | R-SHD-02/R-SUB-01 の吸収 | `damage-absorption.ts` |
 * | R-DMG-05 #6〜#8 のHP適用・致死耐え・イベント記録 | `damage-hit-point-application.ts` |
 * | R-LNK-01〜03 のリンク・R-INT-03 の反射 | `damage-propagation.ts` |
 * | R-SUB-02 のサブユニット追加ダメージ | `sub-unit-additional-damage.ts` |
 * | R-DTH-01 の幻惑（ダメージ→回復変換） | `damage-to-heal-conversion.ts` |
 * | PS/Memory即時連鎖の通知・再検証の共通規約 | `damage-hit-chain.ts` |
 *
 * この関数自身が持つのは、ヒット列のループ・R-DMG-01/02/03/04の基本ダメージ計算と
 * `DamageCalculated`の発行・中断カウントの集計だけである。
 *
 * R-ACTN-01/R-SKL-03: 参照時点で既に戦闘不能な対象へのヒットは、`context.includeDefeated`
 * （選択元`TargetSelectorDefinition.includeDefeated`）が`true`でない限り適用をスキップ
 * する（非DAMAGE種別と同じ明示指定を尊重する）。R-SKL-01/R-SKL-03: 使用者(attacker)自身が
 * 途中で戦闘不能になった場合、以降の未解決ヒットをすべて中断する（対象が異なるヒットも
 * 含む）。スキップしたヒットは命中が確定していないためイベントを発行しない
 * （`08_ドメインイベント.md`「HitConfirmed」）。
 *
 * 1ヒットが発行する内部イベントは、記録直後にPS/Memory即時連鎖へ届けて次の判定へ
 * 進む前に解決し切る（`notifyOrYieldNewEvents`）。解決経路は2通り。
 *
 * - `context.onFactEventForPassiveChain`あり（AS/EX・チャージ解放）: その場で
 *   同期通知する。この経路では`effect-action-group-resolver.ts`の`innerEvents`が
 *   常に空になるため、ここで通知しないイベントは連鎖へ一度も届かない
 * - 未指定（PS/Memory自身のEffectSequence解決）: 1ステップ`yield`し、driver
 *   （`resolveOneEffectActionApplication`）が子連鎖を解決して更新した`units`を
 *   `.next()`で注入する
 *
 * `applyDamageAction`（下の同期wrapper）は`yield`された値を読み捨てるため、
 * 連鎖driverを持たない呼び出し元・テストでは従来どおりの振る舞いになる。
 */
export function* applyDamageActionSteps(
  attacker: BattleUnit,
  hits: readonly ResolvedEffectApplication[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  units: readonly BattleUnit[],
  random: RandomSource,
  context: DamageEventContext,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  ApplyDamageActionResult,
  readonly BattleUnit[] | undefined
> {
  const working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  const outcomes: DamageHitOutcome[] = [];
  let interruptedCount = 0;
  // R-SKL-01: 使用者の戦闘不能で未解決の効果を残したかどうか。`hits`に含まれない
  // サブユニット追加ヒット（R-SUB-02）の中断も表せるよう`interruptedCount`とは別に持つ。
  let interrupted = false;
  let lastEventId = context.parentEventId;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const currentAttacker = findUnit(working, attacker.battleUnitId, "attacker.battleUnitId");

    // R-SKL-01/R-SKL-03: 使用者が戦闘不能になったら残りの未解決ヒットを中断する。
    if (isDefeated(currentAttacker)) {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }

    const target = findUnit(working, hit.targetUnitId, "hits[].targetUnitId");

    if (!(context.includeDefeated ?? false) && isDefeated(target)) {
      outcomes.push(skip(hit));
      // R-SKL-08: 対象不在で適用されなかったこのヒットも「同じ解決スコープ内の直前結果」に
      // なる。以前の成功したDAMAGE結果を透けて見せ続けないよう0として記録する
      // （例外にはしない — MISS等は有効な定義のもとで通常発生し得る実行時の結果であり、
      // R-NUM-04が拒否対象とするCatalog定義エラーではないため）。
      recordDamageResult(
        context.damageResults,
        currentAttacker.battleUnitId,
        target.battleUnitId,
        0,
        context.skillUseId,
      );
      continue;
    }

    // R-FUP-01（Issue #474）: このヒットは命中判定へ到達する（直下の`observeHitSteps`が
    // `NEXT_OUTGOING_ATTACK`を消費する）ため、その時点で攻撃側が保持している追撃バフと
    // 攻撃対象を捕捉する。消費と同じ到達点で捕捉することで、「相乗りする攻撃」と
    // 「バフを消費する攻撃」が常に一致する。命中/会心の集計（`anyApplied`/`anyCritical`）は
    // ループ後にoutcomesから合算する。
    if (context.followUpAttackCapture !== undefined) {
      const capture = context.followUpAttackCapture;
      for (const effect of currentAttacker.appliedEffects) {
        if (effect.isFollowUpAttack === true && !capture.riders.has(effect.effectInstanceId)) {
          capture.riders.set(effect.effectInstanceId, {
            effectActionDefinitionId: effect.effectActionDefinitionId,
            ...(effect.sourceUnitId !== undefined ? { sourceUnitId: effect.sourceUnitId } : {}),
          });
        }
      }
      if (!capture.attackedTargetUnitIds.includes(hit.targetUnitId)) {
        capture.attackedTargetUnitIds.push(hit.targetUnitId);
      }
    }

    // R-DMG-05 #1〜#4／R-SKL-03: 1ヒットの観測（`UnitBeingAttacked`→消費→回避判定→
    // `HitConfirmed`→会心判定→`CriticalCheckResolved`→`DamageWillBeApplied`）は、
    // サブユニット追加ダメージ（R-SUB-02）と共有する`observeHitSteps`が解決する。
    const observation = yield* observeHitSteps(
      context,
      working,
      random,
      attacker.battleUnitId,
      hit.targetUnitId,
      {
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        damageType: damageAction.payload.damageType,
        accuracyMode: damageAction.payload.accuracy.mode,
        criticalMode: damageAction.payload.critical.mode,
        // R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003）: この定義自身の静的な貫通率へ、
        // 攻撃側が保持している`APPLY_PIERCING_MOD`の一時貫通を合成する。ヒットごとに
        // 評価するのは、同じEffectActionの途中でPS連鎖が新たな貫通を付与・解除しうるため
        // （`composeDamageModifiers`と同じ粒度）。`NEXT_OUTGOING_ATTACK`で消費された
        // インスタンスは`finalizeConsumedEffectDurations`まで除去されないため、この
        // ヒットの計算にはまだ有効なものとして参加する。
        piercing: composePiercing(damageAction.payload.piercing, currentAttacker),
      },
      lastEventId,
    );
    lastEventId = observation.lastEventId;
    if (observation.kind === "INTERRUPT") {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }
    if (observation.kind === "SKIP") {
      outcomes.push(skip(hit));
      continue;
    }
    // R-INT-01（DMG-006）: `DamageWillBeApplied`の後・ダメージ確定前に防御介入を規定順で
    // 評価する。引き寄せ・肩代わりはこのヒットの防御側そのものを差し替えるため、以降の
    // 計算・吸収・HP適用はすべて`defenderUnitId`を使う。
    const intervention = yield* resolveDefensiveInterventionsSteps(
      context,
      working,
      attacker.battleUnitId,
      hit.targetUnitId,
      {
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
      },
      lastEventId,
    );
    lastEventId = intervention.lastEventId;
    if (intervention.kind === "INTERRUPT") {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }
    if (intervention.kind === "SKIP") {
      recordDamageResult(
        context.damageResults,
        attacker.battleUnitId,
        hit.targetUnitId,
        0,
        context.skillUseId,
      );
      outcomes.push(skip(hit));
      continue;
    }
    const defenderUnitId = intervention.defenderUnitId;

    const critical = observation.critical;
    // 介入の`DamageRedirected`連鎖が能力値を変え得るため、攻撃側も差し替え後の防御側も
    // 連鎖解決後の最新状態から取り直す（`observeHitSteps`の各再検証と同じ規約）。
    const attackerBeforeDamage = findUnit(working, attacker.battleUnitId, "attacker.battleUnitId");
    const targetBeforeDamage = findUnit(working, defenderUnitId, "hits[].targetUnitId");

    // R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003）: このヒットで実際に使う貫通率を、
    // `DamageWillBeApplied`のsnapshotではなく再検証後の攻撃側（`attackerBeforeDamage`）
    // から改めて合成する。`willBeAppliedMultipliers`と`damageModifierMultipliers`が
    // 同じ理由で二段構えになっているのと同じ扱い —— `DamageWillBeApplied`起点のPS連鎖が
    // 貫通を付け外ししうるため、確定値はここで採り直す必要がある。
    //
    // 以降の防御力無視・軽減無視・シールド無視・HP適用は、必ずこの1つの
    // `piercing`を参照する（`damageAction.payload.piercing`を直接読み直すと、
    // 一時付与が`DamageWillBeApplied`のpayloadにしか現れない）。
    const piercing = composePiercing(damageAction.payload.piercing, attackerBeforeDamage);
    const defenseIgnoreRate = piercing.defenseIgnoreRate;
    // R-NUM-04: `triggerSource`/`triggerTarget`はRES-005が
    // `context.triggerSourceUnitId`/`triggerTargetUnitIds`（`TRIGGER_TARGET`は
    // 複数ユニットを指しうるが、Formula側は単一参照のため先頭の1体を使う、
    // R-TGT-10と同じ規約）から配線する。`bindings`はこの呼び出し元では
    // 引き続き用意できない。`lastResults`（R-SKL-08）は`context.damageResults`
    // （呼び出し側が1解決スコープごとに新規生成する共有registry）から、この攻撃者自身の
    // 直前DAMAGE結果と、`context.skillUseId`が識別するEffectSequence解決の累計DAMAGE結果
    // （`SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`、G-10／RES-003A）を取り出す。
    // IDから`working`（このヒット時点の最新状態、先行するヒットやPS連鎖による変更を
    // 反映済み）へ都度引き直す。R-DMG-02の`damageThreshold`（`resolveDamageImmunity`）も
    // 同じcontextを再利用する（`CURRENT_HP_RATIO(source: TARGET)`は
    // 対象=`targetBeforeDamage`自身の現在HPを参照する）。
    const formulaContext = {
      skillSource: attackerBeforeDamage,
      target: targetBeforeDamage,
      allUnits: Array.from(working.values()),
      lastResults: damageResultsFor(
        context.damageResults,
        attackerBeforeDamage.battleUnitId,
        context.skillUseId,
      ),
      ...(context.triggerSourceUnitId !== undefined
        ? {
            triggerSource: findUnit(
              working,
              context.triggerSourceUnitId,
              "context.triggerSourceUnitId",
            ),
          }
        : {}),
      ...(context.triggerTargetUnitIds?.[0] !== undefined
        ? {
            triggerTarget: findUnit(
              working,
              context.triggerTargetUnitIds[0],
              "context.triggerTargetUnitIds[0]",
            ),
          }
        : {}),
    };
    // R-DMG-04（DMG-002）: 与/被ダメージ倍率は`DamageWillBeApplied`の連鎖後の最新状態
    // （`attackerBeforeDamage`/`targetBeforeDamage`）から集計する — 連鎖が被ダメージ
    // 軽減効果を付与・解除し得るため、snapshotを使い回さない。R-DMG-03の
    // `damageReductionIgnoreRate`は、この集計の中で負の被ダメージ補正だけへ適用する。
    const damageModifierMultipliers = composeDamageModifiers({
      attacker: attackerBeforeDamage,
      defender: targetBeforeDamage,
      damageType: damageAction.payload.damageType,
      damageReductionIgnoreRate: piercing.damageReductionIgnoreRate,
    });
    const confusionInput = resolveConfusion(attackerBeforeDamage, context.skillType);
    const rawDamageResult = calculateDamage({
      attackerAttack: attackerBeforeDamage.combatStats.attack,
      attackerAttribute: attackerBeforeDamage.attribute,
      attackerAffinityBonus: attackerBeforeDamage.combatStats.affinityBonus,
      defenderDefense: targetBeforeDamage.combatStats.defense,
      defenderAttribute: targetBeforeDamage.attribute,
      defenseIgnoreRate,
      skillPowerFormula: damageAction.payload.formula,
      damageModifiers: damageAction.payload.damageModifiers,
      criticalMultiplier: critical.multiplier,
      outgoingDamageMultiplier: damageModifierMultipliers.outgoingMultiplier,
      incomingDamageMultiplier: damageModifierMultipliers.incomingMultiplier,
      formulaContext,
      // R-CFS-02（DMG-009）: 混乱の有無も`composeDamageModifiers`と同じくヒットごとに、
      // 連鎖解決後の最新の攻撃側から取り直す（`DamageWillBeApplied`起点のPS連鎖が混乱を
      // 付け外ししうるため）。
      ...(confusionInput !== undefined ? { confusion: confusionInput } : {}),
    });
    // R-STS-03「新たな攻撃スキルによるダメージで解除する」「解除契機となった
    // ダメージを凍結効果定義の増幅率だけ増加させる（既定値+50%）」: 対象が凍結中なら、
    // この確定済みヒット（DAMAGE EffectAction、継続ダメージ・デバフのみのスキルは
    // `applyDamageAction`自体を経由しないため構造的に対象外）へ増幅を適用し凍結を
    // 解除する。`14_Catalog定義スキーマ.md`「凍結のダメージ解除倍率」の規約どおり
    // `damageAmplificationOnBreak`は加算率（+50%を`0.5`で表す）であり、倍率
    // そのものではない — `1 + damageAmplificationOnBreak`が実際の倍率になる。
    // Q-DMG-01「ダメージ計算の途中では丸めず、最終結果で小数部分を切り捨てる」:
    // 増幅は`calculateDamage`が既に切り捨てた`finalDamage`にではなく、丸め前の
    // `preTruncationDamage`に適用し、この関数全体でただ一度だけ最終切り捨て・
    // 最低1ダメージ（R-DMG-02 #1/#3/#4）を行う。
    const frozenEffect = activeStatusEffect(targetBeforeDamage, "FREEZE");
    const freezeMultiplier =
      frozenEffect !== undefined
        ? 1 + (frozenEffect.statusDetails?.damageAmplificationOnBreak ?? 0.5)
        : 1;
    // R-INT-02第2項（DMG-006）: 肩代わりが成立していれば、その軽減率を最終切り捨ての
    // **前**に適用する（Q-DMG-01「計算の途中では丸めない」）。
    const combinedPreTruncationDamage = guardedDamage(
      rawDamageResult.preTruncationDamage * freezeMultiplier,
      intervention.guardRate,
    );
    const combinedFinalDamage = Math.max(1, Math.floor(combinedPreTruncationDamage));
    // R-DMG-07: 閾値付き被ダメージ軽減はR-DMG-04の合成（`composeDamageModifiers`）から
    // 除外されており、切り捨て済みの入射ダメージを判定素材として、成立したヒットにだけ
    // 独立倍率を掛ける。再切り捨て・最低1ダメージは通常規則（R-DMG-02 #1）と同じ。
    // 消費（`INCOMING_HIT`）は実際に軽減を適用したインスタンスへ、`DamageCalculated`
    // 発行後にインスタンス指定で行う（R-HIT-04のNヒット回避と同じ機構）。
    const thresholdReduction = resolveThresholdDamageReduction({
      attacker: attackerBeforeDamage,
      defender: targetBeforeDamage,
      damageType: damageAction.payload.damageType,
      incomingDamage: combinedFinalDamage,
      damageReductionIgnoreRate: piercing.damageReductionIgnoreRate,
      formulaContext,
    });
    const thresholdReducedDamage = Math.max(
      1,
      Math.floor(combinedFinalDamage * thresholdReduction.multiplier),
    );
    // R-DMG-02「ダメージ無効効果がある場合も結果を1とする」: `calculateDamage`
    // 自身は`AppliedEffect`を知らない純粋な数値計算のため、ここで対象の
    // 有効なDAMAGE_IMMUNITYを判定し、成立すれば`finalDamage`を1へ上書きする。
    // R-DMG-02の順序どおり（#1切り捨て→#2無効化）、切り捨て・R-DMG-07軽減済みの
    // `thresholdReducedDamage`を「incoming raw damage」として判定する（無効化は
    // 常に最後の砦 — 閾値軽減と共存する場合、G-06の判定素材は軽減後の値になる）。
    const damageImmunity = resolveDamageImmunity(
      targetBeforeDamage,
      thresholdReducedDamage,
      formulaContext,
    );
    const damageResult = {
      ...rawDamageResult,
      preTruncationDamage: combinedPreTruncationDamage,
      finalDamage: damageImmunity.nullified ? 1 : thresholdReducedDamage,
    };

    const damageCalculated = context.recorder.record({
      eventType: "DamageCalculated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      // R-DMG-05 #4→#6（DMG-001）: 直接の契機は`CriticalCheckResolved`ではなく、その後に
      // 発行した`DamageWillBeApplied`（このTIMINGイベントの連鎖が計算前提を変え得るため、
      // 因果としてもこの間に挟まる）。
      parentEventId: observation.damageWillBeAppliedEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attacker.battleUnitId,
      // R-INT-01/02（DMG-006）: 引き寄せ・肩代わりの後は、確定したダメージが向かう先
      // （`defenderUnitId`）が対象である。差し替え自体は直前の`DamageRedirected`が
      // 元対象と併せて表す。
      targetUnitIds: [defenderUnitId],
      payload: {
        skillDefinitionId: context.skillDefinitionId,
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        targetUnitId: defenderUnitId,
        attackerAttack: attackerBeforeDamage.combatStats.attack,
        defenderDefense: targetBeforeDamage.combatStats.defense,
        effectiveDefense: damageResult.effectiveDefense,
        defenseIgnoreRate,
        shieldIgnoreRate: piercing.shieldIgnoreRate,
        damageReductionIgnoreRate: piercing.damageReductionIgnoreRate,
        baseDamage: damageResult.baseDamage,
        skillPower: damageResult.skillPower,
        skillPowerFormulaKind: damageResult.skillPowerFormulaKind,
        attributeMultiplier: damageResult.attributeMultiplier,
        attackerAttribute: attackerBeforeDamage.attribute,
        defenderAttribute: targetBeforeDamage.attribute,
        isFavorableAttribute: damageResult.isFavorableAttribute,
        attackerAffinityBonus: attackerBeforeDamage.combatStats.affinityBonus,
        criticalMultiplier: critical.multiplier,
        outgoingDamageMultiplier: damageResult.outgoingDamageMultiplier,
        incomingDamageMultiplier: damageResult.incomingDamageMultiplier,
        actionDamageMultiplier: damageResult.actionDamageMultiplier,
        // R-CFS-02（DMG-009）: 混乱倍率は与ダメージ倍率とは別枠で公開する。
        confusionDamageMultiplier: damageResult.confusionDamageMultiplier,
        // DMG-012: 倍率群だけの積と、そこへ凍結増幅・肩代わりを適用した後の値を
        // 別の欄で公開する。前者が無いと記録済みの倍率から`preTruncationDamage`へ
        // 到達できない。
        rawPreTruncationDamage: rawDamageResult.preTruncationDamage,
        preTruncationDamage: damageResult.preTruncationDamage,
        freezeMultiplier,
        guardRate: intervention.guardRate,
        thresholdReductionMultiplier: thresholdReduction.multiplier,
        damageImmunityNullified: damageImmunity.nullified,
        finalDamage: damageResult.finalDamage,
        damageType: damageAction.payload.damageType,
      },
    });

    let lastEventIdBeforeHp = damageCalculated.eventId;

    // R-DMG-07: 軽減を実際に適用したインスタンスだけを、このヒットで`INCOMING_HIT`消費
    // する。一括消費（R-EFF-07、`applyConfirmedDamageSteps`末尾）は閾値付き補正を常に
    // 除外するため、閾値未満のヒットで残数を失うことはない。消費（とそれを契機とする
    // PS連鎖）は`DamageApplied`（幻惑時は`DamageConvertedToHeal`）の後 — 失効起点の
    // 連鎖が付与するシールド・サブユニットが、計算済みのこのヒット自身の吸収先に
    // なってはならない（R-EFF-07の一括消費と同じ順序）。
    const consumeThresholdReductions = function* (
      parentEventId: DomainEventId,
    ): Generator<DamageStep, DomainEventId, readonly BattleUnit[] | undefined> {
      let eventId = parentEventId;
      for (const applied of thresholdReduction.appliedEffects) {
        eventId = yield* consumeAndExpire(
          context,
          working,
          targetBeforeDamage.battleUnitId,
          "INCOMING_HIT",
          eventId,
          applied.effectInstanceId,
        );
      }
      return eventId;
    };

    // R-DTH-01（DMG-009）: 幻惑を保持する攻撃側のヒットは、ここまでのR-DMG-05 #1〜#6を
    // そのまま経たうえで#7の適用だけを回復へ差し替える。ダメージを適用しないため、
    // この下の凍結解除（R-STS-03の解除契機は「攻撃スキルによるダメージ」）・
    // シールド/サブユニット吸収・`DamageApplied`・`UnitDefeated`・リンク（R-LNK-*）・
    // 反射（R-INT-03）はいずれも通らない。
    const damageToHealRate = resolveDamageToHealRate(attackerBeforeDamage);
    if (damageToHealRate !== undefined) {
      lastEventId = yield* applyDamageToHealConversionSteps(
        context,
        working,
        attackerBeforeDamage.battleUnitId,
        targetBeforeDamage.battleUnitId,
        {
          effectActionDefinitionId: damageAction.effectActionDefinitionId,
          hitIndex: hit.hitIndex,
        },
        damageResult.finalDamage,
        damageToHealRate,
        lastEventIdBeforeHp,
      );
      lastEventId = yield* consumeThresholdReductions(lastEventId);
      // R-INT-02第2項と同じく、後続stepやR-SUB-02の追加ダメージが参照する対象は
      // 引き寄せ・肩代わり後の防御側にする。ダメージは与えていないため`damage`は0。
      outcomes.push({
        targetUnitId: targetBeforeDamage.battleUnitId,
        hitIndex: hit.hitIndex,
        applied: true,
        isCritical: critical.isCritical,
        damage: 0,
      });
      continue;
    }

    // R-STS-03: このヒットが凍結を解除する契機になった場合、`DamageCalculated`
    // （増幅済みの`finalDamage`を確定済み）の直後に凍結を除去する。R-EFF-09の
    // linkedEffectGroupカスケードは`context.removeFreezeEffect`（呼び出し側が注入、
    // `combat/`は`effects/`へ依存できないため）へ委譲し、未指定なら`AppliedEffect`を
    // 直接filterする簡易版（カスケードなし）にfallbackする。`duplicate: true`固定
    // （`freeze-grant-service.ts`）のためR-EFF-05の最強選択対象にならず、`isEffective`は
    // 常にtrue。除去1件ごとの通知（またはcallback未指定なら`yield`）は
    // `driveRemovalSteps`が他の除去経路と同じ規約で行う。
    if (frozenEffect !== undefined) {
      const removal = yield* driveRemovalSteps(
        context,
        working,
        removeFreezeEffectSteps(
          context,
          Array.from(working.values()),
          targetBeforeDamage.battleUnitId,
          frozenEffect,
          damageResult.finalDamage,
          lastEventIdBeforeHp,
        ),
      );
      lastEventIdBeforeHp = removal.lastEventId;
    }

    // R-DMG-05 #6〜#8: 確定したダメージ量の適用（吸収先への振り分け→HP→
    // `HitPointReduced`→`DamageApplied`→`UnitDefeated`→連鎖→R-EFF-07のヒット消費）も、
    // サブユニット追加ダメージ（R-SUB-02）と共有する`applyConfirmedDamageSteps`が行う。
    const application = yield* applyConfirmedDamageSteps(
      context,
      working,
      attackerBeforeDamage.battleUnitId,
      targetBeforeDamage.battleUnitId,
      {
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        damageType: damageAction.payload.damageType,
        piercing,
      },
      damageResult.finalDamage,
      lastEventIdBeforeHp,
    );
    lastEventId = application.lastEventId;
    // 吸収の連鎖が使用者を戦闘不能にしたなら、このヒットのHP適用ごと中断して残りの
    // ヒットも解決しない（R-SKL-01/R-SKL-03）。対象側の戦闘不能はこのヒットだけを
    // 不成立にする（R-ACTN-01 #2）。
    if (application.kind === "INTERRUPT") {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }
    if (application.kind === "SKIP") {
      outcomes.push(skip(hit));
      continue;
    }
    lastEventId = yield* consumeThresholdReductions(lastEventId);

    // R-INT-01 #3／R-LNK-01〜03（DMG-007）: 元ダメージの確定後、反射より前に
    // リンク先ダメージを発生させる（R-INT-01の評価順 #3 → #4）。
    const linked = yield* applyLinkedDamageSteps(
      context,
      working,
      targetBeforeDamage.battleUnitId,
      damageAction.payload.damageType,
      damageResult.finalDamage,
      intervention.damageLinks,
      application.damageAppliedEventId ?? lastEventId,
      lastEventId,
    );
    lastEventId = linked.lastEventId;

    // R-INT-01 #4／R-INT-03（DMG-006）: 元ダメージの確定後に反射を発生させる。
    const reflected = yield* applyReflectedDamageSteps(
      context,
      working,
      attackerBeforeDamage.battleUnitId,
      targetBeforeDamage.battleUnitId,
      damageAction.payload.damageType,
      damageResult.finalDamage,
      intervention.reflects,
      application.damageAppliedEventId ?? lastEventId,
      lastEventId,
    );
    lastEventId = reflected.lastEventId;

    // R-INT-02第2項「元の攻撃対象を参照する後続効果は…最終的にダメージを受けた対象を
    // 参照する」: 後続step・R-SUB-02の追加ダメージ対象・`lastResult.targetUnitIds`が
    // 参照する対象は、引き寄せ・肩代わり後の防御側にする。
    outcomes.push({
      targetUnitId: targetBeforeDamage.battleUnitId,
      hitIndex: hit.hitIndex,
      applied: true,
      isCritical: critical.isCritical,
      damage: damageResult.finalDamage,
    });

    // リンク・反射の適用（およびその連鎖）が使用者を戦闘不能にしていれば、残りのヒットを
    // 中断する（R-SKL-01）。このヒット自身は既に適用済みのため`outcomes`へは残す。
    if (linked.kind === "INTERRUPT" || reflected.kind === "INTERRUPT") {
      interruptedCount = hits.length - (i + 1);
      interrupted = true;
      outcomes.push(...hits.slice(i + 1).map(skip));
      break;
    }
  }

  // R-SUB-02（DMG-005）: 使用者がサブユニットを保持していれば、この攻撃の対象ごとに
  // 追加ダメージを1ヒットずつ加える。全ヒットの解決が終わったこの時点で行うのは、
  // R-SUB-02が数える単位が「ヒット」ではなく「攻撃対象」だからである
  // （5ヒット単体攻撃でも追加ダメージは1回、2体攻撃なら各1回）。
  const additional = yield* applySubUnitAdditionalDamageSteps(
    context,
    working,
    random,
    attacker.battleUnitId,
    outcomes,
    damageAction,
    interrupted,
    lastEventId,
  );
  lastEventId = additional.lastEventId;
  // 追加ヒットは`hits`に含まれないため`interruptedCount`へは足せない。中断の事実だけを
  // `interrupted`として外側へ伝える。
  interrupted = interrupted || additional.interrupted;

  // R-DMG-06: 保持者が追加攻撃バフを持っていれば、この攻撃で実際に当てた対象ごとに
  // 独立した1ヒットを加える。R-SUB-02と同じ位置（全ヒットの解決後）に置くのは、数える
  // 単位がヒットではなくDAMAGE EffectActionと攻撃対象だからである。`outcomes`へは
  // 積まないため、R-FUP-01の命中・会心集計とR-SKL-08の直前結果は汚れない。
  const bonusAttacks = yield* applyAttackBonusAttacksSteps(
    context,
    working,
    random,
    attacker.battleUnitId,
    outcomes,
    damageAction,
    interrupted,
    lastEventId,
  );
  lastEventId = bonusAttacks.lastEventId;
  interrupted = interrupted || bonusAttacks.interrupted;

  // `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`の消費で0になったインスタンスは、
  // このEffectAction（全ヒット）の解決が終わった今ここで初めて実際に失効させる
  // （`consumeEffectDuration`は消費の記録だけを行い、除去とCombatStat再計算をここまで
  // 遅延させている）。中断（使用者の戦闘不能）でループを抜けた場合も、既に消費済みの分は
  // ここで確定させる。遅延させた失効の確定も、除去1件ごとに通知（またはcallback未指定なら
  // `yield`）する。
  if (context.finalizeConsumedEffectDurations !== undefined) {
    const finalized = yield* driveRemovalSteps(
      context,
      working,
      context.finalizeConsumedEffectDurations(Array.from(working.values()), lastEventId),
    );
    lastEventId = finalized.lastEventId;
  }

  // R-FUP-01: 追撃の発生可否（1発でも命中したか）と会心継承（1発でも会心になったか）は
  // スキル使用内の全DAMAGE EffectActionを合算する。サブユニット追加ヒット（R-SUB-02）は
  // `outcomes`に含まれないため集計対象にならない — 会心PREVENTED固定の追加ヒットが
  // 継承判定を汚すことも、追撃が追撃を誘発することもない。
  if (context.followUpAttackCapture !== undefined) {
    const capture = context.followUpAttackCapture;
    for (const outcome of outcomes) {
      if (outcome.applied) {
        capture.anyApplied = true;
        if (outcome.isCritical) {
          capture.anyCritical = true;
        }
      }
    }
  }

  return {
    units: units.map((unit) => working.get(unit.battleUnitId)!),
    hits: outcomes,
    interruptedCount,
    interrupted,
    lastEventId,
  };
}

/**
 * `applyDamageActionSteps`を同期的に完了まで駆動する薄いwrapper。generatorが
 * `yield`する場面は`context.onFactEventForPassiveChain`未指定（PS/Memory自身の
 * EffectSequence解決）の時だけであり、その経路をこのwrapperで駆動する呼び出し元は
 * 連鎖driverを持たない。ここでは`yield`された値を単に読み捨てて`.next()`する —
 * 全ての既存呼び出し元・テストと完全に同じ振る舞いを保つ。production経路
 * （`effect-action-group-resolver.ts`）はこのwrapperではなく`applyDamageActionSteps`を
 * 直接駆動し、各`yield`を`EFFECT_RESOLVED`として`driveActivation`の共有stateへ
 * 参加させる。
 */
export function applyDamageAction(
  attacker: BattleUnit,
  hits: readonly ResolvedEffectApplication[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  units: readonly BattleUnit[],
  random: RandomSource,
  context: DamageEventContext,
): ApplyDamageActionResult {
  const gen = applyDamageActionSteps(attacker, hits, damageAction, units, random, context);
  let step = gen.next();
  while (!step.done) {
    step = gen.next();
  }
  return step.value;
}
