import type { BattleUnit } from "../model/battle-unit.js";
import {
  resolveCritical,
  resolveEffectiveCriticalMode,
  type CriticalResult,
} from "./critical-policy.js";
import { recordDamageResult } from "../skill/formula-evaluator.js";
import { resolveEffectiveAccuracyMode, resolveEvasion } from "./hit-policy.js";
import { composeDamageModifiers } from "./damage-modifier-policy.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import {
  consumeAndExpire,
  findUnit,
  notifyOrYieldNewEvents,
  revalidateHit,
} from "./damage-hit-chain.js";
import { createPercentage } from "../../shared/percentage.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type {
  AccuracyMode,
  CriticalMode,
  DamageType,
} from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-SKL-03「MISSでなければ、対象固有の特別な回避、会心、ダメージ、シールド、
 * 戦闘不能、PS/Memory連鎖をヒットごとに解決する」が要求する、1ヒットの**観測**部分。
 * `observeHitSteps`が攻撃側定義から必要とする値だけをまとめる。
 *
 * DAMAGE EffectActionのヒットは`damageAction.payload`からそのまま作り、サブユニットの
 * 追加ダメージ（R-SUB-02）は「1ヒットとして扱われます」（`戦闘システム.md`）に従い、
 * 契機になった攻撃の`accuracy`を引き継ぎつつ会心・貫通を持たないprofileを作る。
 */
export interface HitObservationProfile {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hitIndex: number;
  readonly damageType: DamageType;
  readonly accuracyMode: AccuracyMode;
  readonly criticalMode: CriticalMode;
  readonly piercing: {
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
  };
}

/**
 * `observeHitSteps`の結果。`INTERRUPT`は使用者の戦闘不能（R-SKL-01/R-SKL-03により
 * 残りのヒットも中断する）、`SKIP`はこのヒットが成立しなかった場合
 * （対象の戦闘不能・回避）で、どちらもR-SKL-08の直前結果への0記録は済んでいる。
 */
export type HitObservation =
  | { readonly kind: "INTERRUPT"; readonly lastEventId: DomainEventId }
  | { readonly kind: "SKIP"; readonly lastEventId: DomainEventId }
  | {
      readonly kind: "CONFIRMED";
      readonly attacker: BattleUnit;
      readonly target: BattleUnit;
      readonly critical: CriticalResult;
      readonly lastEventId: DomainEventId;
      /** `DamageCalculated`の直接の契機になる`DamageWillBeApplied`のID。 */
      readonly damageWillBeAppliedEventId: DomainEventId;
    };

/**
 * R-DMG-05 #1〜#4 ＋ R-SKL-03: 1ヒットのダメージ計算に入るまでの観測を解決する
 * （`UnitBeingAttacked` → R-EFF-07の`NEXT_*_ATTACK`消費 → 回避判定 → `HitConfirmed`
 * → 会心判定 → `CriticalCheckResolved` → `DamageWillBeApplied`）。各イベントの記録
 * 直後にPS/Memory即時連鎖を解決し、その連鎖後の最新stateで前提を再検証してから次へ
 * 進む（`08_ドメインイベント.md`「TIMINGイベント後の再検証」）。
 *
 * この観測列は通常ヒットとサブユニット追加ダメージ（R-SUB-02、DMG-005）で共有する。
 * 共有しないと追加ダメージが`DamageCalculated`から始まり、Nヒット回避（R-HIT-04）・
 * 被ヒット消費条件（R-EFF-07の`OUTGOING_HIT`/`INCOMING_HIT`）・`HitConfirmed`起点のPSが
 * 追加ヒットを一度も観測できない。raw原文（`戦闘システム.md`）は追加ダメージを明示的に
 * 「1ヒットとして扱われます」と規定しているため、観測側に例外を設けない。
 */
export function* observeHitSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  profile: HitObservationProfile,
  parentEventId: DomainEventId,
): Generator<DamageStep, HitObservation, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  const attackerAtStart = findUnit(working, attackerUnitId, "attacker.battleUnitId");

  // `08_ドメインイベント.md`「UnitBeingAttacked」: 攻撃対象が確定した直後
  // （命中判定・ダメージ計算より前）に発行する。R-EFF-07:
  // `NEXT_INCOMING_ATTACK`はこの発行時点で消費する。
  const unitBeingAttackedEventsStart = context.recorder.getEvents().length;
  const unitBeingAttacked = context.recorder.record({
    eventType: "UnitBeingAttacked",
    category: "TIMING",
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
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      // 「自身がアクティブスキルで攻撃される直前」を`EVENT_PAYLOAD`で読むtriggerが
      // 参照する。スキル種別へ帰属しない経路（継続ダメージ等）では未指定のまま。
      ...(context.skillType === undefined ? {} : { skillType: context.skillType }),
    },
  });
  lastEventId = unitBeingAttacked.eventId;
  // `UnitBeingAttacked`は消費失効より前に記録されているため、状態を書き換える前に
  // ここで通知する。消費失効自身の通知は`consumeAndExpire`が除去1件ごとに行う
  // （またはcallback未指定なら`yield`する）。これもTIMINGイベントであり、下の再検証は
  // その連鎖の結果を見るためのもの。callback未指定の経路でも連鎖をここで解決し切る必要がある。
  yield* notifyOrYieldNewEvents(context, working, unitBeingAttackedEventsStart);
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    targetUnitId,
    "NEXT_INCOMING_ATTACK",
    lastEventId,
  );

  // R-EFF-07: `NEXT_OUTGOING_ATTACK`は攻撃者が命中判定に到達した時点
  // （MISS/命中を問わない）で消費する。専用のドメインイベントは持たない。
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    attackerAtStart.battleUnitId,
    "NEXT_OUTGOING_ATTACK",
    lastEventId,
  );

  // `UnitBeingAttacked`／`NEXT_OUTGOING_ATTACK`消費が発火したPS連鎖は`working`を
  // 書き換え得る（対象を回復・戦闘不能にする等）。`08_ドメインイベント.md`のTIMINGイベント
  // 契約どおり、命中・会心・ダメージ計算に入る前に発生源・対象の生存を再検証し、
  // 計算用ステータスも`working`から取り直す。
  const afterTiming = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (afterTiming.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (afterTiming.kind === "SKIP") {
    // R-SKL-08: TIMING処理後に対象が戦闘不能になった場合も、この不成立結果を
    // 0として直前結果に記録する。
    recordDamageResult(
      context.damageResults,
      afterTiming.attacker.battleUnitId,
      afterTiming.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }
  const attackerAfterTiming = afterTiming.attacker;
  const targetAfterTiming = afterTiming.target;

  // R-HIT-02/R-HIT-04: 対象の有効な回避効果を判定する（暗闇/R-HIT-03は
  // `resolveEffectSequencePlan`のスキル使用単位ゲートで既に判定済み — MISSに
  // なるスキルはこのDAMAGE EffectAction自体に到達しない）。
  // R-HIT-05（M7-018）: 攻撃側定義の`accuracy.mode`と、使用者が持つ必中効果
  // （`GUARANTEED_HIT`）を実効値へ畳み込んでから判定する。使用者はTIMING処理後の
  // 最新状態から取り直す — 直前のPS連鎖が必中効果を付与・失効させ得る。
  const effectiveAccuracyMode = resolveEffectiveAccuracyMode(
    attackerAfterTiming,
    profile.accuracyMode,
  );
  const evasion = resolveEvasion(targetAfterTiming, effectiveAccuracyMode, random);
  if (evasion.evaded) {
    const evasionEventsStart = context.recorder.getEvents().length;
    const evasionActivated = context.recorder.record({
      eventType: "EvasionActivated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: context.parentEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attackerUnitId,
      targetUnitIds: [targetUnitId],
      payload: {
        effectActionDefinitionId: evasion.evadedByEffectActionDefinitionId!,
        effectInstanceId: evasion.evadedByEffectInstanceId!,
        hitIndex: profile.hitIndex,
        targetUnitId,
      },
    });
    lastEventId = evasionActivated.eventId;
    // R-HIT-04（M7-018）: 回避したこの被ヒットで、回避を成立させたインスタンス自身の
    // `INCOMING_HIT`消費を1消費する（Nヒット回避の「Nヒット」はこの消費で数える）。
    // R-EFF-07の一般規則（命中確定で消費）に対する本ルール固有の例外のため、同じ対象が
    // 持つ他の`INCOMING_HIT`消費効果を巻き込まないよう、消費対象をこのインスタンスへ限定する。
    // R-SKL-01/02: `EvasionActivated`もFACTイベントとしてPS/Memoryの即時連鎖の契機に
    // なり得るため、次のヒットへ進む前に通知する。
    yield* notifyOrYieldNewEvents(context, working, evasionEventsStart);
    lastEventId = yield* consumeAndExpire(
      context,
      working,
      targetAfterTiming.battleUnitId,
      "INCOMING_HIT",
      lastEventId,
      evasion.evadedByEffectInstanceId,
    );
    // R-SKL-08: MISSも結果種別を持つ直前結果として記録する（R-SKL-08本文）。
    recordDamageResult(
      context.damageResults,
      attackerAfterTiming.battleUnitId,
      targetAfterTiming.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }

  const hitConfirmedEventsStart = context.recorder.getEvents().length;
  const hitConfirmed = context.recorder.record({
    eventType: "HitConfirmed",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: context.parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
    },
  });

  // R-DMG-05 #2「命中判定」の結果である`HitConfirmed`は、#3「会心判定」へ進む前に
  // 連鎖を解決し切る。callbackありの経路では`effect-action-group-resolver.ts`の
  // `innerEvents`が常に空になるため、ここで通知しないとPS/Memoryへ一度も届かない。
  yield* notifyOrYieldNewEvents(context, working, hitConfirmedEventsStart);

  // `HitConfirmed`の子連鎖はDAMAGEを行いうるため、会心判定へ進む前に生存を再検証して
  // 不要な乱数消費とイベント発行を避ける。
  const afterHitConfirmed = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (afterHitConfirmed.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (afterHitConfirmed.kind === "SKIP") {
    recordDamageResult(
      context.damageResults,
      afterHitConfirmed.attacker.battleUnitId,
      afterHitConfirmed.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }

  // 会心判定は上の連鎖を反映した最新の使用者状態から行う（連鎖が会心率・会心
  // ダメージのバフを付与・失効させ得るため）。
  // R-CRT-03（DMG-003A）: 攻撃側定義の`critical.mode`と、使用者が持つ会心状態効果
  // （`CRITICAL_GUARANTEE`/`CRITICAL_PREVENTION`）を実効値へ畳み込んでから判定する。
  // 使用者を同じ最新状態から取り直すのはR-HIT-05の必中付与と同じ理由で、直前の連鎖が
  // これらの効果を付与・失効させ得るためである。
  const attackerBeforeCritical = afterHitConfirmed.attacker;
  const effectiveCriticalMode = resolveEffectiveCriticalMode(
    attackerBeforeCritical,
    profile.criticalMode,
  );
  const critical = resolveCritical(
    effectiveCriticalMode,
    createPercentage(attackerBeforeCritical.combatStats.criticalRate),
    attackerBeforeCritical.combatStats.criticalDamageBonus,
    random,
  );

  const criticalCheckResolvedEventsStart = context.recorder.getEvents().length;
  const criticalCheckResolved = context.recorder.record({
    eventType: "CriticalCheckResolved",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: hitConfirmed.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      // R-CRT-03: 実際に判定へ使った実効値を通知する（宣言値ではない）。
      mode: effectiveCriticalMode,
      baseCriticalRate: critical.baseRate,
      effectiveCriticalRate: critical.effectiveRate,
      result: critical.isCritical,
    },
  });
  // `CriticalCheckResolved`をtriggerにするproduction PSが実在するため、
  // `DamageWillBeApplied`へ進む前にここで連鎖を解決する。
  yield* notifyOrYieldNewEvents(context, working, criticalCheckResolvedEventsStart);

  // `CriticalCheckResolved`の子連鎖も同様にDAMAGEを行いうるため、`DamageWillBeApplied`を
  // 発行する前に生存を再検証する。
  const afterCriticalCheck = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (afterCriticalCheck.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (afterCriticalCheck.kind === "SKIP") {
    recordDamageResult(
      context.damageResults,
      afterCriticalCheck.attacker.battleUnitId,
      afterCriticalCheck.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }

  // R-DMG-05 #4（DMG-001）: 命中・会心の確定後、ダメージ計算より前に
  // `DamageWillBeApplied`（TIMING）を発行する。
  const willBeAppliedEventsStart = context.recorder.getEvents().length;
  // R-DMG-04（DMG-002）: この時点の集計結果をsnapshotとして載せる。
  // 下の連鎖が軽減効果を付け外しし得るため、確定値は`DamageCalculated`側で改めて集計する。
  const willBeAppliedMultipliers = composeDamageModifiers({
    attacker: afterCriticalCheck.attacker,
    defender: afterCriticalCheck.target,
    damageType: profile.damageType,
    damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
  });
  const damageWillBeApplied = context.recorder.record({
    eventType: "DamageWillBeApplied",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: criticalCheckResolved.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      damageType: profile.damageType,
      isCritical: critical.isCritical,
      criticalMultiplier: critical.multiplier,
      defenseIgnoreRate: profile.piercing.defenseIgnoreRate,
      shieldIgnoreRate: profile.piercing.shieldIgnoreRate,
      damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
      outgoingDamageMultiplier: willBeAppliedMultipliers.outgoingMultiplier,
      incomingDamageMultiplier: willBeAppliedMultipliers.incomingMultiplier,
    },
  });
  lastEventId = damageWillBeApplied.eventId;
  // PS/Memory自身のEffectSequence解決では、この連鎖をここで解決しないと
  // 「TIMINGイベント後に親処理の前提を再検証する」契約を破る。
  yield* notifyOrYieldNewEvents(context, working, willBeAppliedEventsStart);

  // 「TIMINGイベント後の再検証」: 連鎖が使用者を戦闘不能にしたなら残りのヒットを
  // 中断し（R-SKL-01/R-SKL-03）、対象を戦闘不能にしたならこのヒットを適用しない。
  const beforeDamage = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (beforeDamage.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (beforeDamage.kind === "SKIP") {
    recordDamageResult(
      context.damageResults,
      beforeDamage.attacker.battleUnitId,
      beforeDamage.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }
  return {
    kind: "CONFIRMED",
    attacker: beforeDamage.attacker,
    target: beforeDamage.target,
    critical,
    lastEventId,
    damageWillBeAppliedEventId: damageWillBeApplied.eventId,
  };
}
