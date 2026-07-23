import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { calculateDamage } from "./damage-calculator.js";
import { resolveCritical } from "./critical-policy.js";
import type {
  DomainEventId,
  ActionId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { resolveHit } from "./hit-policy.js";
import { createPercentage } from "../../shared/percentage.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface DamageHitOutcome {
  readonly targetBattleUnitId: BattleUnitId;
  readonly hitIndex: number;
  /** false when the hit was skipped instead of applied (target already defeated, or MISS). */
  readonly applied: boolean;
  readonly isCritical: boolean;
  readonly damage: number;
}

export interface ApplyDamageActionResult {
  readonly units: readonly BattleUnit[];
  readonly hits: readonly DamageHitOutcome[];
  /**
   * PR #141再レビュー[P2]: 使用者が戦闘不能になったことで未処理のまま残った
   * ヒット数。MISSや対象の戦闘不能による通常のスキップ（`DamageHitOutcome.applied`
   * が`false`になる別のケース）は含まない — 使用者(attacker)が戦闘不能になる
   * 前に到達したヒットは、命中/MISSに関わらず「解決済み」として数える。
   */
  readonly interruptedCount: number;
  /**
   * PR #142レビュー[P2]: このEffectAction適用中に実際に記録された最後の
   * イベントID（最終ヒットの`DamageApplied`、致死なら`UnitDefeated`）。
   * 呼び出し側が`EffectActionCompleted.parentEventId`をこれへ設定することで、
   * イベントログの直接因果が実際の解決経路（`EffectActionStarting`固定では
   * ない）を表せるようにする。全ヒットがスキップ・中断されて何も記録されな
   * かった場合は`context.parentEventId`のまま変化しない。
   */
  readonly lastEventId: DomainEventId;
}

/** ヒットイベント（HitConfirmed〜UnitDefeated）が共有する因果関係コンテキスト。全て`ActionStarted`の解決スコープに属する。 */
export interface DamageEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** 各ヒットの直接の契機（`SkillUseStarted.eventId`）。ヒット同士は互いを親としない。 */
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /**
   * Issue #34: `DamageApplied`（および`UnitDefeated`）の確定直後にPS即時連鎖を
   * 同期的に解決するフック。呼び出し側（`lifecycle/`、Domain層のmodule境界に
   * より`combat/`自身は`triggering/`へ依存できない）が注入する。戻り値の
   * `units`をそのまま以後の`working`として使う。未指定ならPS解決を行わない
   * （R-SKL-06のACTION step単位の即時解決は#73のスコープで、本フックは
   * R-SKL-01/02が要求する「ヒットごとの直ちの解決」までを満たす）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
  /**
   * R-EFF-07: `ownerUnitId`が保持する`kind`一致の消費条件効果を1消費する
   * （`EffectConsumptionChanged`発行）。`onFactEventForPassiveChain`と同じ理由
   * （Domain層のmodule境界により`combat/`は`effects/`へ依存できない）で
   * 呼び出し側（`lifecycle/`）が注入する。未指定なら消費条件を評価しない。
   *
   * レビュー再々指摘[P1]（PR #209）: 消費回数が0になったインスタンスの実際の
   * 除去・CombatStat再計算は、この呼び出しの中では行わない場合がある
   * （`NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`は`14_Catalog定義スキーマ.md`
   * 「上限に到達した効果は、該当するEffectActionの解決後に失効する」契約のため、
   * 呼び出し側の実装が`finalizeConsumedEffectDurations`まで遅延させる）。この
   * ヒットの会心・ダメージ計算は、消費し終えた直後の`units`（まだ除去前の
   * combatStats）をそのまま使ってよい。
   */
  readonly consumeEffectDuration?: (
    ownerUnitId: BattleUnitId,
    kind: ConsumptionKind,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId };
  /**
   * レビュー再々指摘[P1]（PR #209）: `consumeEffectDuration`が遅延させた
   * 消費済みインスタンス（`NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`）を、
   * このEffectAction（`applyDamageAction`1回分、全ヒット）の解決完了後に
   * まとめて失効させる（`EffectExpired`発行、CombatStat再計算を含む）。
   * `consumeEffectDuration`と同じ理由で呼び出し側が注入する。未指定、または
   * 遅延対象が無ければ何もしない。
   */
  readonly finalizeConsumedEffectDurations?: (
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId };
}

function skip(hit: ResolvedEffectApplication): DamageHitOutcome {
  return {
    targetBattleUnitId: hit.targetBattleUnitId,
    hitIndex: hit.hitIndex,
    applied: false,
    isCritical: false,
    damage: 0,
  };
}

function findUnit(
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
  id: BattleUnitId,
  path: string,
): BattleUnit {
  const unit = units.get(id);
  if (unit === undefined) {
    throw new DomainValidationError(path, `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

/**
 * R-EFF-07: `context.consumeEffectDuration`（呼び出し側が注入する、`combat/`は
 * `effects/`へ依存できないため）へ委譲し、`ownerUnitId`が保持する`kind`一致の
 * 消費条件効果を1消費・必要なら失効させる。フック未指定、または該当効果が
 * 無い場合は`workingMap`を変更せず`parentEventId`をそのまま返す。
 */
function consumeAndExpire(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  ownerUnitId: BattleUnitId,
  kind: ConsumptionKind,
  parentEventId: DomainEventId,
): DomainEventId {
  if (context.consumeEffectDuration === undefined) {
    return parentEventId;
  }
  const result = context.consumeEffectDuration(
    ownerUnitId,
    kind,
    Array.from(workingMap.values()),
    parentEventId,
  );
  for (const unit of result.units) {
    workingMap.set(unit.battleUnitId, unit);
  }
  return result.lastEventId;
}

/** `08_ドメインイベント.md`の一般的な流儀: 記録済みの新規イベントをPS即時連鎖フックへ順に転送する。 */
function notifyNewEvents(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  eventsStart: number,
): void {
  if (context.onFactEventForPassiveChain === undefined) {
    return;
  }
  for (const event of context.recorder.getEvents().slice(eventsStart)) {
    const updatedUnits = context.onFactEventForPassiveChain(event, Array.from(workingMap.values()));
    for (const unit of updatedUnits) {
      workingMap.set(unit.battleUnitId, unit);
    }
  }
}

/**
 * `DamageApplicationService` の基本形 (`05_ドメインモデル.md`)。`SkillResolutionService`が
 * 解決した1つのDAMAGE EffectActionのヒット列を、R-DMG-05の順序（命中→会心→
 * ダメージ計算→HP適用→戦闘不能判定）でヒットごとに処理する。R-ACTN-01/R-SKL-03:
 * 参照時点で既に戦闘不能な対象へのヒットは適用をスキップする。R-SKL-01/R-SKL-03:
 * 使用者(attacker)自身が途中で戦闘不能になった場合、以降の未解決ヒットをすべて
 * 中断する（対象が異なるヒットも含む）。シールド・サブユニット・リンクダメージへの
 * 適用調整(R-SHD-*、R-SUB-*、R-LNK-*)はM8未実装のため、HPへ直接適用する。
 * 適用されたヒットごとに `HitConfirmed`→`CriticalCheckResolved`→`DamageCalculated`→
 * `DamageApplied`（→`UnitDefeated`）を発行する。スキップしたヒットは命中が確定して
 * いないためイベントを発行しない（`08_ドメインイベント.md`「HitConfirmed」）。
 */
export function applyDamageAction(
  attacker: BattleUnit,
  hits: readonly ResolvedEffectApplication[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  units: readonly BattleUnit[],
  random: RandomSource,
  context: DamageEventContext,
): ApplyDamageActionResult {
  const working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  const outcomes: DamageHitOutcome[] = [];
  let interruptedCount = 0;
  let lastEventId = context.parentEventId;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const currentAttacker = findUnit(working, attacker.battleUnitId, "attacker.battleUnitId");

    // R-SKL-01/R-SKL-03: 使用者が戦闘不能になったら残りの未解決ヒットを中断する。
    if (isDefeated(currentAttacker)) {
      interruptedCount = hits.length - i;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }

    const target = findUnit(working, hit.targetBattleUnitId, "hits[].targetBattleUnitId");

    if (isDefeated(target)) {
      outcomes.push(skip(hit));
      continue;
    }

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
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [hit.targetBattleUnitId],
      payload: {
        skillDefinitionId: context.skillDefinitionId,
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        targetUnitId: hit.targetBattleUnitId,
      },
    });
    lastEventId = unitBeingAttacked.eventId;
    lastEventId = consumeAndExpire(
      context,
      working,
      target.battleUnitId,
      "NEXT_INCOMING_ATTACK",
      lastEventId,
    );
    notifyNewEvents(context, working, unitBeingAttackedEventsStart);

    // R-EFF-07: `NEXT_OUTGOING_ATTACK`は攻撃者が命中判定に到達した時点
    // （MISS/命中を問わない）で消費する。専用のドメインイベントは持たない。
    const judgmentEventsStart = context.recorder.getEvents().length;
    lastEventId = consumeAndExpire(
      context,
      working,
      currentAttacker.battleUnitId,
      "NEXT_OUTGOING_ATTACK",
      lastEventId,
    );
    notifyNewEvents(context, working, judgmentEventsStart);

    // レビュー再指摘 PR #209[P1]: `UnitBeingAttacked`／`NEXT_OUTGOING_ATTACK`消費が
    // 発火したPS連鎖は`working`を書き換え得る（対象を回復・戦闘不能にする等）。
    // `08_ドメインイベント.md`のTIMINGイベント契約どおり、命中・会心・ダメージ計算
    // に入る前に発生源・対象の生存を再検証し、計算用ステータスも`working`から
    // 取り直す。対象変更・挑発・肩代わり（R-SHD-*/R-SUB-*/R-LNK-*）はM8未実装の
    // ため、このヒットの対象自体を差し替える処理は行わない（関数冒頭コメント参照）。
    const attackerAfterTiming = findUnit(working, attacker.battleUnitId, "attacker.battleUnitId");
    if (isDefeated(attackerAfterTiming)) {
      interruptedCount = hits.length - i;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }

    const targetAfterTiming = findUnit(
      working,
      hit.targetBattleUnitId,
      "hits[].targetBattleUnitId",
    );
    if (isDefeated(targetAfterTiming)) {
      outcomes.push(skip(hit));
      continue;
    }

    if (!resolveHit()) {
      outcomes.push(skip(hit));
      continue;
    }

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
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [hit.targetBattleUnitId],
      payload: {
        skillDefinitionId: context.skillDefinitionId,
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        targetUnitId: hit.targetBattleUnitId,
      },
    });

    const critical = resolveCritical(
      damageAction.payload.critical.mode,
      createPercentage(attackerAfterTiming.combatStats.criticalRate),
      attackerAfterTiming.combatStats.criticalDamageBonus,
      random,
    );

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
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [hit.targetBattleUnitId],
      payload: {
        mode: damageAction.payload.critical.mode,
        baseCriticalRate: critical.baseRate,
        effectiveCriticalRate: critical.effectiveRate,
        result: critical.isCritical,
      },
    });

    const defenseIgnoreRate = damageAction.payload.piercing.defenseIgnoreRate;
    const damageResult = calculateDamage({
      attackerAttack: attackerAfterTiming.combatStats.attack,
      attackerAttribute: attackerAfterTiming.attribute,
      attackerAffinityBonus: attackerAfterTiming.combatStats.affinityBonus,
      defenderDefense: targetAfterTiming.combatStats.defense,
      defenderAttribute: targetAfterTiming.attribute,
      defenseIgnoreRate,
      skillPowerFormula: damageAction.payload.formula,
      damageModifiers: damageAction.payload.damageModifiers,
      criticalMultiplier: critical.multiplier,
      // R-NUM-04: `triggerSource`/`triggerTarget`/`bindings`は
      // RES-005（Issue #172）が実ライフサイクルへ配線するまでこの呼び出し元
      // では用意できない。production CatalogのDAMAGE Formulaは現時点で
      // SKILL_SOURCE/TARGET参照のみを使うため、それらを要求するFormulaは
      // `FormulaEvaluator`が明確な例外で拒否する。`lastResults`（`LAST_DAMAGE_DEALT`/
      // `LAST_DAMAGE_RECEIVED`）はレビュー指摘[P1]（PR #214）により、この
      // 攻撃者自身が直前に発生させた/受けたDAMAGE結果（`BattleUnit.lastDamageDealt`/
      // `lastDamageReceived`）を渡す。`SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`
      // （EffectSequence実行中の累計）は未配線のまま（RES-002/RES-003、
      // Issue #174/#173） — 現時点で参照するproduction定義がないため。
      formulaContext: {
        skillSource: attackerAfterTiming,
        target: targetAfterTiming,
        allUnits: Array.from(working.values()),
        lastResults: {
          ...(attackerAfterTiming.lastDamageDealt !== undefined
            ? { LAST_DAMAGE_DEALT: attackerAfterTiming.lastDamageDealt }
            : {}),
          ...(attackerAfterTiming.lastDamageReceived !== undefined
            ? { LAST_DAMAGE_RECEIVED: attackerAfterTiming.lastDamageReceived }
            : {}),
        },
      },
    });

    const damageCalculated = context.recorder.record({
      eventType: "DamageCalculated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: criticalCheckResolved.eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [hit.targetBattleUnitId],
      payload: {
        skillDefinitionId: context.skillDefinitionId,
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        targetUnitId: hit.targetBattleUnitId,
        attackerAttack: attackerAfterTiming.combatStats.attack,
        defenderDefense: targetAfterTiming.combatStats.defense,
        effectiveDefense: damageResult.effectiveDefense,
        defenseIgnoreRate,
        skillPower: damageResult.skillPower,
        attributeMultiplier: damageResult.attributeMultiplier,
        criticalMultiplier: critical.multiplier,
        actionDamageMultiplier: damageResult.actionDamageMultiplier,
        preTruncationDamage: damageResult.preTruncationDamage,
        finalDamage: damageResult.finalDamage,
        damageType: damageAction.payload.damageType,
      },
    });

    // `targetAfterTiming`取得後、ここまでは`recorder.record`のみでPS連鎖の
    // 介在がないため、HPも`targetAfterTiming`からそのまま起点にできる。
    const hpBefore = targetAfterTiming.currentHp;
    const hpAfter = Math.max(0, hpBefore - damageResult.finalDamage);
    // R-NUM-04（レビュー指摘[P1]、PR #214）: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`
    // が参照する「直前の確定済みダメージ結果」を、攻撃者・対象それぞれの
    // `lastDamageDealt`/`lastDamageReceived`へ上書きする。自傷（攻撃者=対象）
    // では同じユニットへ両方を重ねて書き込む必要があるため、target更新後に
    // `working`から取り直してからattacker側を更新する。
    const lastDamageDealtBefore = attackerAfterTiming.lastDamageDealt;
    const lastDamageReceivedBefore = targetAfterTiming.lastDamageReceived;
    const updatedTarget: BattleUnit = {
      ...targetAfterTiming,
      currentHp: createHitPoint(hpAfter, targetAfterTiming.combatStats.maximumHp),
      lastDamageReceived: damageResult.finalDamage,
    };
    working.set(targetAfterTiming.battleUnitId, updatedTarget);
    const attackerBeforeDealtUpdate = working.get(attackerAfterTiming.battleUnitId)!;
    working.set(attackerAfterTiming.battleUnitId, {
      ...attackerBeforeDealtUpdate,
      lastDamageDealt: damageResult.finalDamage,
    });

    const targetStateDelta = {
      hp: { before: hpBefore, after: hpAfter },
      lastDamageReceived: { before: lastDamageReceivedBefore, after: damageResult.finalDamage },
    };
    const attackerStateDelta = {
      lastDamageDealt: { before: lastDamageDealtBefore, after: damageResult.finalDamage },
    };
    const damageStateDeltaUnits =
      attackerAfterTiming.battleUnitId === targetAfterTiming.battleUnitId
        ? { [targetAfterTiming.battleUnitId]: { ...targetStateDelta, ...attackerStateDelta } }
        : {
            [targetAfterTiming.battleUnitId]: targetStateDelta,
            [attackerAfterTiming.battleUnitId]: attackerStateDelta,
          };

    const damageApplied = context.recorder.record({
      eventType: "DamageApplied",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: damageCalculated.eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [hit.targetBattleUnitId],
      payload: {
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        targetUnitId: hit.targetBattleUnitId,
        calculatedDamage: damageResult.finalDamage,
        hitPointDamage: hpBefore - hpAfter,
        hpBefore,
        hpAfter,
        defeated: isDefeated(updatedTarget),
      },
      stateDelta: {
        units: damageStateDeltaUnits,
      },
    });

    // R-SKL-01/02: このヒットが発行した事実イベントそれぞれからのPS即時連鎖を、
    // 発生順に（DamageApplied→UnitDefeatedがあればその後）次のヒットへ進む前に
    // 解決する（`onFactEventForPassiveChain`未指定ならPS解決を省略する）。
    // 致死ヒットでも`DamageApplied`起点のPS（例:「味方がダメージを受けた時」）を
    // `UnitDefeated`だけに上書きして見逃さないよう、両方を個別にフックへ渡す
    // （PR #141レビュー[P1]）。`targetAfterTiming`はこの直前の生存再検証で既に
    // 生存確定済みのため、新規致死判定は`updatedTarget`のみで足りる。
    lastEventId = damageApplied.eventId;
    const factEvents: BattleDomainEvent[] = [damageApplied];
    if (isDefeated(updatedTarget)) {
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
        sourceUnitId: attacker.battleUnitId,
        targetUnitIds: [targetAfterTiming.battleUnitId],
        payload: { unitId: targetAfterTiming.battleUnitId, causeEventId: damageApplied.eventId },
      });
      factEvents.push(unitDefeated);
      lastEventId = unitDefeated.eventId;
    }

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

    // R-EFF-07: このヒットがMISSでなく確定した時点でOUTGOING_HIT（攻撃者側）/
    // INCOMING_HIT（対象側）を消費する。
    const hitEventsStart = context.recorder.getEvents().length;
    lastEventId = consumeAndExpire(
      context,
      working,
      attackerAfterTiming.battleUnitId,
      "OUTGOING_HIT",
      lastEventId,
    );
    lastEventId = consumeAndExpire(
      context,
      working,
      targetAfterTiming.battleUnitId,
      "INCOMING_HIT",
      lastEventId,
    );
    notifyNewEvents(context, working, hitEventsStart);

    outcomes.push({
      targetBattleUnitId: hit.targetBattleUnitId,
      hitIndex: hit.hitIndex,
      applied: true,
      isCritical: critical.isCritical,
      damage: damageResult.finalDamage,
    });
  }

  // レビュー再々指摘[P1]（PR #209）: `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`
  // の消費で0になったインスタンスは、このEffectAction（全ヒット）の解決が
  // 終わった今ここで初めて実際に失効させる（`consumeEffectDuration`は消費の
  // 記録だけを行い、除去とCombatStat再計算をここまで遅延させている）。
  // 中断（使用者の戦闘不能）でループを抜けた場合も、既に消費済みの分は
  // ここで確定させる。
  if (context.finalizeConsumedEffectDurations !== undefined) {
    const finalizeEventsStart = context.recorder.getEvents().length;
    const finalized = context.finalizeConsumedEffectDurations(
      Array.from(working.values()),
      lastEventId,
    );
    for (const unit of finalized.units) {
      working.set(unit.battleUnitId, unit);
    }
    lastEventId = finalized.lastEventId;
    notifyNewEvents(context, working, finalizeEventsStart);
  }

  return {
    units: units.map((unit) => working.get(unit.battleUnitId)!),
    hits: outcomes,
    interruptedCount,
    lastEventId,
  };
}
