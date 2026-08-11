import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { shieldBypassedDamage } from "./shield-policy.js";
import { selectDeathSurvival } from "./defensive-intervention-policy.js";
import { evaluateFormula, recordDamageResult } from "../skill/formula-evaluator.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { recordExerciseScoreIfAny } from "../events/exercise-score-recording.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import { consumeAndExpire, driveRemovalSteps, findUnit } from "./damage-hit-chain.js";
import { absorbBeforeHitPointsSteps } from "./damage-absorption.js";
import type { HitObservationProfile } from "./damage-hit-observation.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `applyConfirmedDamageSteps`の結果。`APPLIED`以外は吸収の途中でPS/Memory連鎖が前提を
 * 崩したことを表し、`INTERRUPT`（使用者の戦闘不能）は残りのヒットも中断させる。
 */
export type ConfirmedDamageApplication = {
  readonly kind: "APPLIED" | "INTERRUPT" | "SKIP";
  readonly lastEventId: DomainEventId;
  /**
   * R-INT-03（DMG-006）: この適用が発行した`DamageApplied`のID。反射は「元ダメージの
   * 確定後」に発生するため、`ReflectedDamageGenerated`の直接の契機（`parentEventId`）と
   * してこれを使う。`kind`が`APPLIED`の場合だけ存在する。
   */
  readonly damageAppliedEventId?: DomainEventId;
};

/**
 * R-DMG-05 #6〜#8 ＋ R-SHD-02/R-SUB-01: 確定した1ヒットのダメージ量を実際に適用する
 * （吸収先への振り分け → HP → `HitPointReduced` → `DamageApplied` →（致死なら）
 * `UnitDefeated` → PS/Memory連鎖 → R-EFF-07の`OUTGOING_HIT`/`INCOMING_HIT`消費）。
 *
 * `observeHitSteps`と同じ理由で、通常ヒットとサブユニット追加ダメージ（DMG-005）が
 * **同じ適用経路**を共有する。呼び出し側の違いは`finalDamage`をどう計算したかだけである。
 */
export function* applyConfirmedDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  profile: Pick<
    HitObservationProfile,
    "effectActionDefinitionId" | "hitIndex" | "damageType" | "piercing"
  >,
  finalDamage: number,
  parentEventId: DomainEventId,
  options: {
    /**
     * R-INT-03（DMG-006）: 反射ダメージの適用。`DamageApplied`へ`isReflectedDamage: true`を
     * 載せ、R-EFF-07のヒット消費（`OUTGOING_HIT`/`INCOMING_HIT`）を行わない — 反射は
     * 命中判定を持つヒットではなく（`HitConfirmed`も`DamageWillBeApplied`も伴わない）、
     * 消費条件が数える「攻撃」に当たらないためである。
     */
    readonly isReflectedDamage?: true;
    /**
     * R-LNK-03（DMG-007）: リンクダメージの適用。`DamageApplied`へ`isLinkedDamage: true`を
     * 載せ、`isReflectedDamage`とまったく同じ理由でR-EFF-07のヒット消費
     * （`OUTGOING_HIT`/`INCOMING_HIT`）を行わない — リンクは命中判定を持つヒットではなく、
     * 消費条件が数える「攻撃」に当たらない。
     */
    readonly isLinkedDamage?: true;
    /**
     * R-LNK-01第3項／R-LNK-02第5項: 元ダメージのシールド適用可否を引き継ぐ。
     * `false`ならシールド・サブユニットへ一切振り分けずHPへ直接向かう（毒・炎上など
     * もともとシールドで受けられないダメージのリンク先での扱い）。既定は`true`。
     */
    readonly shieldApplicable?: boolean;
  } = {},
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  const targetBeforeAbsorption = findUnit(working, targetUnitId, "hits[].targetUnitId");

  // R-LNK-02第5項: 元ダメージがシールド対象外なら、リンク先でもシールド対象外にする
  // （全量がHPへ直接向かう。`continuous-damage-service.ts`が炎上・毒を吸収経路へ
  // 渡さないのと同じ扱い）。
  const hpDirectDamage =
    options.shieldApplicable === false
      ? finalDamage
      : shieldBypassedDamage(finalDamage, profile.piercing.shieldIgnoreRate);
  const absorption = yield* absorbBeforeHitPointsSteps(
    context,
    working,
    attackerUnitId,
    targetUnitId,
    profile.damageType,
    finalDamage - hpDirectDamage,
    lastEventId,
    { effectActionDefinitionId: profile.effectActionDefinitionId, hitIndex: profile.hitIndex },
  );
  lastEventId = absorption.lastEventId;
  if (absorption.interruption !== "NONE") {
    // 吸収イベントの連鎖が使用者を戦闘不能にした（R-SKL-01「未解決効果を中断する」）、
    // または対象を戦闘不能にした（R-ACTN-01 #2）場合、このヒットはHPへ到達しない。
    // 既に解決した吸収（`ShieldConsumed`/`SubUnitDamaged`が自身のStateDeltaで記録済み）は
    // そのまま残し、`HitPointReduced`以降のイベントは発行しない。
    // R-SKL-08: 確定した`DamageApplied`を持たないヒットは、他の不成立ヒットと同じく
    // 直前結果へ0を記録する（以前の成功結果を透けて見せないため）。
    recordDamageResult(context.damageResults, attackerUnitId, targetUnitId, 0, context.skillUseId);
    return { kind: absorption.interruption, lastEventId };
  }

  // 吸収の連鎖（`ShieldConsumed`/`SubUnitDamaged`/`EffectExpired`）の解決後の
  // 最新状態からHPを起点にする。
  const targetAfterAbsorption = working.get(targetUnitId) ?? targetBeforeAbsorption;
  const absorbedBeforeHitPoints =
    absorption.typedShieldAbsorbed + absorption.untypedShieldAbsorbed + absorption.subUnitAbsorbed;

  const hpBefore = targetAfterAbsorption.currentHp;
  // R-SHD-02 #5: 吸収先を通り抜けた残りがHPへ向かう（`hpDirectDamage`を含む）。
  const hitPointDamage = finalDamage - absorbedBeforeHitPoints;
  // R-INT-01 #5（DMG-006）: HPが0へ落ちる量が確定したこの時点で致死耐えを評価する
  // （「致死かどうか」はここで初めて決まる）。成立すれば`survivalHp`（Formula評価結果を
  // R-NUM-02で整数化し、1以上・現在HP以下へ収めた値）でHPを止める。
  // 元々0（既に戦闘不能。`includeDefeated: true`で到達しうる）の対象は「致死ダメージを
  // 受けた」に当たらないため耐えの対象にしない — R-INT-01は蘇生規則を持たない。
  //
  // この判定はこの関数を通る全てのダメージ（通常ヒット・R-SUB-02の追加ヒット・
  // R-INT-03の反射）へ一様に効く。継続ダメージ（R-DOT-01〜04、
  // `continuous-damage-service.ts`）はR-INT-01が介入の評価点として定める
  // `DamageWillBeApplied`を発行せず、この適用経路自体を通らないため対象外である
  // （R-DOT-01「ダメージ軽減・増加、属性相性の影響を受けない」と同じ、継続ダメージが
  // ダメージpipelineの外にあることの帰結）。
  const wouldBeLethal = hpBefore > 0 && hpBefore - hitPointDamage <= 0;
  const survival = wouldBeLethal ? selectDeathSurvival(targetAfterAbsorption) : undefined;
  const survivalHp =
    survival === undefined
      ? 0
      : Math.min(
          hpBefore,
          Math.max(
            1,
            truncateFraction(
              evaluateFormula(
                survival.survivalHp,
                {
                  skillSource: targetAfterAbsorption,
                  target: targetAfterAbsorption,
                  allUnits: Array.from(working.values()),
                },
                "deathSurvival.survivalHp",
              ),
            ),
          ),
        );
  const hpAfter = survival !== undefined ? survivalHp : Math.max(0, hpBefore - hitPointDamage);
  // R-SHD-03第2項「HPを0未満にせず、超過分を破棄する」。致死耐えで適用されなかった分も
  // ここが説明する（`08_ドメインイベント.md`ダメージイベント不変条件#6の保存則は
  // そのまま成立する）。
  const discardedDamage = hitPointDamage - (hpBefore - hpAfter);
  const updatedTarget: BattleUnit = {
    ...targetAfterAbsorption,
    // R-NUM-02: `combatStats.maximumHp`は全精度（R-STA-01/R-NUM-01）で保持されるため、
    // HPゲージへ渡す境界で最大値を0方向へ切り捨てて整数化する。
    currentHp: createHitPoint(
      hpAfter,
      truncateFraction(targetAfterAbsorption.combatStats.maximumHp),
    ),
  };
  working.set(targetUnitId, updatedTarget);
  // R-SKL-08＋G-10／RES-003A: 確定した結果を直前結果と`SUM_DAMAGE_*`の累計へ記録する。
  // `BattleUnit`の永続フィールドではないため、StateDelta・独立Reducer復元の対象にはならない。
  recordDamageResult(
    context.damageResults,
    attackerUnitId,
    targetUnitId,
    finalDamage,
    context.skillUseId,
  );

  // `08_ドメインイベント.md`「HitPointReduced」(RES-005): HPを減らした後、R-DMG-05の
  // 並び上は`DamageCalculated`と`DamageApplied`の間に発行する。HP変化のStateDeltaは
  // ここに持たせる — `DamageApplied`にも同じdeltaを付けると独立Reducer復元が同じ変化を
  // 二重適用してしまうため。
  const hitPointReduced = context.recorder.record({
    eventType: "HitPointReduced",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      hitPointDamage: hpBefore - hpAfter,
      hpBefore,
      hpAfter,
    },
    stateDelta: { units: { [targetUnitId]: { hp: { before: hpBefore, after: hpAfter } } } },
  });

  const damageApplied = context.recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: hitPointReduced.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      // 「自身がアクティブスキルで攻撃された後」を`EVENT_PAYLOAD`で読むtriggerが
      // 参照する。スキル種別へ帰属しない経路（継続ダメージ等）では未指定のまま。
      ...(context.skillType === undefined ? {} : { skillType: context.skillType }),
      calculatedDamage: finalDamage,
      // R-SHD-02/03（DMG-004）＋R-SUB-01（DMG-005）: 適用先ごとの内訳。
      // `typedShieldAbsorbed + untypedShieldAbsorbed + subUnitAbsorbed + hitPointDamage +
      // discardedDamage === calculatedDamage`（`08_ドメインイベント.md`不変条件#6）。
      hpDirectDamage,
      typedShieldAbsorbed: absorption.typedShieldAbsorbed,
      untypedShieldAbsorbed: absorption.untypedShieldAbsorbed,
      subUnitAbsorbed: absorption.subUnitAbsorbed,
      discardedDamage,
      hitPointDamage: hpBefore - hpAfter,
      hpBefore,
      hpAfter,
      defeated: isDefeated(updatedTarget),
      ...(options.isReflectedDamage === true ? { isReflectedDamage: true as const } : {}),
      ...(options.isLinkedDamage === true ? { isLinkedDamage: true as const } : {}),
    },
  });

  // R-SKL-01/02: このヒットが発行した事実イベントそれぞれからのPS即時連鎖を、
  // 発生順に（DamageApplied→UnitDefeatedがあればその後）次のヒットへ進む前に解決する。
  // 致死ヒットでも`DamageApplied`起点のPS（例:「味方がダメージを受けた時」）を
  // `UnitDefeated`だけに上書きして見逃さないよう、両方を個別にフックへ渡す。
  // `UnitDefeated`は「HPが0へ遷移した」ヒットだけが発行する — `includeDefeated: true`では
  // 既に戦闘不能な対象へもヒットが続くため、判定基準は吸収連鎖の解決後
  // （`targetAfterAbsorption`）の状態にする。
  // R-TEX-02: HPへ向かった量（オーバーキル・致死耐えで適用されなかった分を含む
  // `hitPointDamage`）を、ブレイク解決（R-TEX-03、`UnitDefeated`相当の位置）より前に
  // 計上する — `UnitBroken`が「その時点の累計スコア」を運ぶためである。計上が
  // 発生しなければ`damageApplied.eventId`がそのまま返る。
  lastEventId = recordExerciseScoreIfAny(
    context.exercise,
    context,
    targetAfterAbsorption,
    hitPointDamage,
    damageApplied.eventId,
  );
  // `FreezeRemoved`（と、あればそのカスケード）と吸収イベント（およびその枯渇失効）は
  // このヒットのHP適用より前に既に連鎖通知済みのため含めない。
  // `ExerciseScoreAccumulated`はPS/Memory連鎖へ通知しない — 契機にできる
  // `TriggerDefinition`が存在しない観測専用のイベントだからである。
  const factEvents: BattleDomainEvent[] = [hitPointReduced, damageApplied];
  if (!isDefeated(targetAfterAbsorption) && isDefeated(updatedTarget)) {
    const unitDefeated = context.recorder.record({
      eventType: "UnitDefeated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: damageApplied.eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attackerUnitId,
      targetUnitIds: [targetUnitId],
      payload: { unitId: targetUnitId, causeEventId: damageApplied.eventId },
    });
    factEvents.push(unitDefeated);
    lastEventId = unitDefeated.eventId;
  } else if (survival !== undefined) {
    // R-INT-01 #5（DMG-006）: 致死耐えが成立したヒットは`UnitDefeated`の代わりに
    // `LethalDamageSurvived`を発行する（両者は排他 — HPは`survivalHp`で止まっているため
    // 上の`isDefeated(updatedTarget)`は常にfalseになる）。
    const survived = context.recorder.record({
      eventType: "LethalDamageSurvived",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: damageApplied.eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attackerUnitId,
      targetUnitIds: [targetUnitId],
      payload: {
        effectInstanceId: survival.effectInstanceId,
        effectActionDefinitionId: survival.effectActionDefinitionId,
        battleUnitId: targetUnitId,
        lethalDamage: hitPointDamage,
        hpBefore,
        survivalHp,
      },
    });
    factEvents.push(survived);
    lastEventId = survived.eventId;
  }

  // PS/Memory自身のEffectSequence解決（callback未指定）では、これらのFACTイベントを
  // `effect-action-group-resolver.ts`が`innerEvents`としてEffectAction完了時に
  // まとめてdriverへ渡すため、ここでは`yield`しない。
  if (context.onFactEventForPassiveChain !== undefined) {
    for (const factEvent of factEvents) {
      const updatedUnits = context.onFactEventForPassiveChain(
        factEvent,
        Array.from(working.values()),
      );
      for (const unit of updatedUnits) {
        working.set(unit.battleUnitId, unit);
      }
    }
  }

  // R-INT-01 #5（DMG-006）: 耐えたインスタンス自身の消費条件（production定義はすべて
  // `consumption.kind: LETHAL_DAMAGE`、`maxCount: 1`）を、`LethalDamageSurvived`と
  // その連鎖の後に1消費する。R-HIT-04のNヒット回避と同じく消費対象をこのインスタンスへ
  // 限定する — 同じ対象が複数の致死耐えを保持していても、実際に耐えた1件だけを消費する
  // ためである。
  if (survival !== undefined) {
    lastEventId = yield* consumeAndExpire(
      context,
      working,
      targetUnitId,
      "LETHAL_DAMAGE",
      lastEventId,
      survival.effectInstanceId,
    );
    // `healAfterSurvival`（`ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL`の最大HP65%回復など）は
    // R-HEAL-01の手順で適用する。`combat/`は`lifecycle/`へ到達できないため、
    // 呼び出し側が注入するhookへ委譲する（未指定なら耐えるだけで回復しない）。
    if (survival.healAfterSurvival !== null && context.applyDeathSurvivalHeal !== undefined) {
      const healed = yield* driveRemovalSteps(
        context,
        working,
        context.applyDeathSurvivalHeal(
          targetUnitId,
          survival.effectActionDefinitionId,
          survival.healAfterSurvival,
          Array.from(working.values()),
          lastEventId,
        ),
      );
      lastEventId = healed.lastEventId;
    }
  }

  // R-EFF-07: このヒットがMISSでなく確定した時点でOUTGOING_HIT（攻撃者側）/
  // INCOMING_HIT（対象側）を消費する。R-HIT-04の回避効果（EVASION/HIT_EVASION）は
  // この一括消費の対象外で、`consumeEffectDurations`が常に除外する — Nヒット回避は
  // 自身が回避した被ヒットでだけ消費するため。
  // R-INT-03（DMG-006）: 反射ダメージは命中判定を持つヒットではないため消費しない。
  if (options.isReflectedDamage !== true && options.isLinkedDamage !== true) {
    lastEventId = yield* consumeAndExpire(
      context,
      working,
      attackerUnitId,
      "OUTGOING_HIT",
      lastEventId,
    );
    lastEventId = yield* consumeAndExpire(
      context,
      working,
      targetUnitId,
      "INCOMING_HIT",
      lastEventId,
    );
  }
  return { kind: "APPLIED", lastEventId, damageAppliedEventId: damageApplied.eventId };
}
