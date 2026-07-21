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
   * R-EFF-07: `ownerUnitId`が保持する`kind`一致の消費条件効果を1消費し、0に
   * なったインスタンスを即時に失効させる（`EffectConsumptionChanged`/
   * `EffectExpired`発行、CombatStat再計算を含む）。`onFactEventForPassiveChain`と
   * 同じ理由（Domain層のmodule境界により`combat/`は`effects/`へ依存できない）で
   * 呼び出し側（`lifecycle/`）が注入する。未指定なら消費条件を評価しない。
   */
  readonly consumeEffectDuration?: (
    ownerUnitId: BattleUnitId,
    kind: ConsumptionKind,
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

    // R-EFF-07: 命中判定に到達した時点（MISS/命中を問わない）で
    // NEXT_OUTGOING_ATTACK（攻撃者側）/NEXT_INCOMING_ATTACK（対象側）を消費する。
    const judgmentEventsStart = context.recorder.getEvents().length;
    lastEventId = consumeAndExpire(
      context,
      working,
      currentAttacker.battleUnitId,
      "NEXT_OUTGOING_ATTACK",
      lastEventId,
    );
    lastEventId = consumeAndExpire(
      context,
      working,
      target.battleUnitId,
      "NEXT_INCOMING_ATTACK",
      lastEventId,
    );
    notifyNewEvents(context, working, judgmentEventsStart);

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
      createPercentage(currentAttacker.combatStats.criticalRate),
      currentAttacker.combatStats.criticalDamageBonus,
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
      attackerAttack: currentAttacker.combatStats.attack,
      attackerAttribute: currentAttacker.attribute,
      attackerAffinityBonus: currentAttacker.combatStats.affinityBonus,
      defenderDefense: target.combatStats.defense,
      defenderAttribute: target.attribute,
      defenseIgnoreRate,
      skillPowerFormula: damageAction.payload.formula,
      damageModifiers: damageAction.payload.damageModifiers,
      criticalMultiplier: critical.multiplier,
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
        attackerAttack: currentAttacker.combatStats.attack,
        defenderDefense: target.combatStats.defense,
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

    const hpBefore = target.currentHp;
    const hpAfter = Math.max(0, target.currentHp - damageResult.finalDamage);
    // R-EFF-07レビュー修正: `target`は命中判定時点のスナップショット（ダメージ
    // 計算はこの時点の値を使うのが正しい、攻撃者側と同じ理由）だが、HPの
    // 書き戻し先は`working`の現在状態（NEXT_INCOMING_ATTACK消費による
    // `appliedEffects`変化を含む）でなければならない。stale `target`を直接
    // spreadすると、命中判定〜ダメージ確定の間に`consumeAndExpire`が
    // `working`へ加えた変更を上書きして消してしまう。
    const currentTarget = findUnit(working, target.battleUnitId, "hits[].targetBattleUnitId");
    const updatedTarget: BattleUnit = {
      ...currentTarget,
      currentHp: createHitPoint(hpAfter, target.combatStats.maximumHp),
    };
    working.set(target.battleUnitId, updatedTarget);

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
        units: { [target.battleUnitId]: { hp: { before: hpBefore, after: hpAfter } } },
      },
    });

    // R-SKL-01/02: このヒットが発行した事実イベントそれぞれからのPS即時連鎖を、
    // 発生順に（DamageApplied→UnitDefeatedがあればその後）次のヒットへ進む前に
    // 解決する（`onFactEventForPassiveChain`未指定ならPS解決を省略する）。
    // 致死ヒットでも`DamageApplied`起点のPS（例:「味方がダメージを受けた時」）を
    // `UnitDefeated`だけに上書きして見逃さないよう、両方を個別にフックへ渡す
    // （PR #141レビュー[P1]）。
    lastEventId = damageApplied.eventId;
    const factEvents: BattleDomainEvent[] = [damageApplied];
    if (!isDefeated(target) && isDefeated(updatedTarget)) {
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
        targetUnitIds: [target.battleUnitId],
        payload: { unitId: target.battleUnitId, causeEventId: damageApplied.eventId },
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
      currentAttacker.battleUnitId,
      "OUTGOING_HIT",
      lastEventId,
    );
    lastEventId = consumeAndExpire(
      context,
      working,
      target.battleUnitId,
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

  return {
    units: units.map((unit) => working.get(unit.battleUnitId)!),
    hits: outcomes,
    interruptedCount,
    lastEventId,
  };
}
