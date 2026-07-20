import { resolveActionPhase } from "./action-phase-resolver.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import { recordResourceChangeIfAny } from "./action-resolution-shared.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattleStatus } from "../model/battle-status.js";
import { isDefeated, recoverTurnResources, type BattleUnit } from "../model/battle-unit.js";
import { decrementTurnCooldowns } from "../model/cooldown-state.js";
import { decrementTurnEffectDurations } from "../effects/effect-duration-decrement.js";
import { decrementTurnMarkerDurations } from "../effects/marker-duration-decrement.js";
import { expireEffects, type ExpirationRequest } from "../effects/effect-expiration-service.js";
import type { DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent, ResourceRecoveryEntry } from "../events/domain-event.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import { beginNextTurn, createTurnState, isFinalTurn, type TurnState } from "./turn-state.js";
import type { TurnLimit } from "../model/turn-limit.js";
import { resolveVictory, type VictoryResult } from "../outcome/victory-policy.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleId } from "../../shared/ids.js";

export type { BattleStatus } from "../model/battle-status.js";

export type BattleResult = VictoryResult & { readonly completedTurn: number };

/**
 * `05_ドメインモデル.md` の Battle集約。`13_実装計画.md`「M3 最小戦闘縦切り」を扱う。
 * `advanceBattle` 1回はTURN_STARTING〜TURN_ENDINGの1ターン全体に相当し、内部で
 * QUEUE_BUILDING〜ACTION_RESOLUTION（`resolveActionPhase`）を使用可能な行動が
 * 無くなるまで繰り返す。
 */
export interface Battle {
  readonly battleId: BattleId;
  readonly status: BattleStatus;
  readonly turnState: TurnState;
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
  readonly result?: BattleResult;
}

/** Battle集約の主要操作: create（05_ドメインモデル.md）。 */
export function createBattle(
  battleId: BattleId,
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  turnLimit: TurnLimit,
  definitions: BattleDefinitions,
): Battle {
  if (allyUnits.length === 0) {
    throw new DomainValidationError("battle.allyUnits", "must contain at least one BattleUnit");
  }
  if (enemyUnits.length === 0) {
    throw new DomainValidationError("battle.enemyUnits", "must contain at least one BattleUnit");
  }
  return {
    battleId,
    status: "READY",
    turnState: createTurnState(turnLimit),
    allyUnits,
    enemyUnits,
    definitions,
  };
}

/**
 * Battle集約の主要操作: start（06_戦闘状態遷移.md READY→RUNNING）。BattleStartedを
 * 発行し、対応するPSを解決する（Issue #144 follow-up、PR #150で保留した残作業:
 * `resolutionPhase: "BATTLE_START"`を渡し、`RESOLUTION_PHASE`条件を実際に評価
 * 可能にする）。READY→RUNNINGはTURN_STARTINGと異なりAP/PP回復を行わない。
 */
export function startBattle(battle: Battle, random: RandomSource, recorder: EventRecorder): Battle {
  if (battle.status !== "READY") {
    throw new DomainValidationError(
      "battle.status",
      `cannot start a battle in status "${battle.status}"`,
    );
  }
  const battleScope = recorder.nextResolutionScopeId();
  const battleStarted = recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: battleScope,
    payload: {
      turnLimit: battle.turnState.turnLimit,
      allySlotCount: battle.allyUnits.length,
      enemySlotCount: battle.enemyUnits.length,
    },
    stateDelta: { battleStatus: { before: battle.status, after: "RUNNING" } },
  });

  const passiveRuntime = new PassiveActivationRuntime(
    {
      definitions: battle.definitions,
      random,
      recorder,
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: battleScope,
      rootEventId: battleStarted.eventId,
      resolutionPhase: "BATTLE_START",
    },
    [...battle.allyUnits, ...battle.enemyUnits],
  );
  passiveRuntime.onFactEvent(battleStarted, [...battle.allyUnits, ...battle.enemyUnits]);
  const afterPassives = passiveRuntime.finalizeResolutionScope();
  const allyUnits = afterPassives.filter((unit) => unit.side === "ALLY");
  const enemyUnits = afterPassives.filter((unit) => unit.side === "ENEMY");

  return { ...battle, status: "RUNNING", allyUnits, enemyUnits };
}

function allDefeated(units: readonly BattleUnit[]): boolean {
  return units.every(isDefeated);
}

/**
 * TURN_STARTING #2のAP/PP回復のうち、実際に値が変わったユニットだけを
 * `ResourcesRecovered`のpayloadへ含める。R-ACT-04によりstateDelta自体は
 * `ResourcesRecovered`が所有せず、`ResourceChanged`（reason: TURN_RECOVERY）が
 * リソースごとに個別に所有する（PR #141レビュー[P1]）。
 */
function buildResourceRecovery(
  before: readonly BattleUnit[],
  after: readonly BattleUnit[],
): { entries: readonly ResourceRecoveryEntry[] } {
  const entries: ResourceRecoveryEntry[] = [];
  for (let i = 0; i < before.length; i++) {
    const previous = before[i]!;
    const recovered = after[i]!;
    if (previous.currentAp === recovered.currentAp && previous.currentPp === recovered.currentPp) {
      continue;
    }
    entries.push({
      battleUnitId: previous.battleUnitId,
      apBefore: previous.currentAp,
      apAfter: recovered.currentAp,
      ppBefore: previous.currentPp,
      ppAfter: recovered.currentPp,
    });
  }
  return { entries };
}

/**
 * `06_戦闘状態遷移.md` TURN_ENDING #2-4: PS連鎖完了後（M6未実装のため`TurnCompleting`
 * 直後）に、現在のターンより前に設定されたターン単位クールタイムを全ユニットで
 * 1減らす。現在のターンで設定されたものは対象外（`decrementTurnCooldowns`が判定）。
 */
function applyTurnCooldownDecrements(
  units: readonly BattleUnit[],
  currentTurnNumber: number,
  recorder: EventRecorder,
  turnNumber: number,
  resolutionScopeId: ResolutionScopeId,
  rootEventId: DomainEventId,
  parentEventId: DomainEventId,
): { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId } {
  let working = units;
  let lastEventId = parentEventId;
  for (const unit of units) {
    const decrement = decrementTurnCooldowns(unit.cooldowns, currentTurnNumber);
    if (decrement.changes.length === 0) {
      continue;
    }
    working = working.map((u) =>
      u.battleUnitId === unit.battleUnitId ? { ...u, cooldowns: decrement.cooldowns } : u,
    );
    for (const change of decrement.changes) {
      const reduced = recorder.record({
        eventType: "CooldownReduced",
        category: "FACT",
        turnNumber,
        cycleNumber: 0,
        resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId,
        sourceUnitId: unit.battleUnitId,
        payload: {
          actorUnitId: unit.battleUnitId,
          skillDefinitionId: change.skillDefinitionId,
          unit: change.unit,
          before: change.before,
          after: change.after,
        },
        stateDelta: {
          units: {
            [unit.battleUnitId]: {
              cooldowns: {
                [change.skillDefinitionId]: {
                  unit: change.unit,
                  before: change.before,
                  after: change.after,
                },
              },
            },
          },
        },
      });
      lastEventId = reduced.eventId;
      if (change.after === 0) {
        const completed = recorder.record({
          eventType: "CooldownCompleted",
          category: "FACT",
          turnNumber,
          cycleNumber: 0,
          resolutionScopeId,
          parentEventId: lastEventId,
          rootEventId,
          sourceUnitId: unit.battleUnitId,
          payload: {
            actorUnitId: unit.battleUnitId,
            skillDefinitionId: change.skillDefinitionId,
            unit: change.unit,
          },
        });
        lastEventId = completed.eventId;
      }
    }
  }
  return { units: working, lastEventId };
}

/**
 * R-EFF-06/R-EFF-10: PS連鎖完了後、現在のターンより前に付与されたターン単位
 * 効果・Markerを全ユニットで1減らす（現在のターンで付与されたものは対象外、
 * `decrementTurnEffectDurations`/`decrementTurnMarkerDurations`が判定する）。
 * 0になった効果・Markerは`expireEffects`が失効させ、重複なし効果グループの
 * 採用対象が変わった場合は`EffectiveEffectChanged`も合わせて発行する
 * （R-EFF-05）。記録した全イベントを`events`として返し、呼び出し側が
 * PS/Memory候補解決へ通知できるようにする（PR #155レビュー[P2]）。
 */
function applyTurnEffectDurationDecrements(
  units: readonly BattleUnit[],
  currentTurnNumber: number,
  recorder: EventRecorder,
  turnNumber: number,
  resolutionScopeId: ResolutionScopeId,
  rootEventId: DomainEventId,
  parentEventId: DomainEventId,
  notify?: (event: BattleDomainEvent, units: readonly BattleUnit[]) => readonly BattleUnit[],
): {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  readonly events: readonly BattleDomainEvent[];
} {
  let working = units;
  let lastEventId = parentEventId;
  const recordedEvents: BattleDomainEvent[] = [];
  for (const unit of units) {
    const effectDecrement = decrementTurnEffectDurations(unit.appliedEffects, currentTurnNumber);
    const markerDecrement = decrementTurnMarkerDurations(unit.markers, currentTurnNumber);
    if (effectDecrement.changes.length === 0 && markerDecrement.changes.length === 0) {
      continue;
    }
    // PR #155再レビュー[P1]（Finding A）: 0に達しない変化も`EffectDurationReduced`
    // として記録する（`action-completion.ts`のACTION単位減算と対称）。
    for (const change of effectDecrement.changes) {
      const beforeEffect = unit.appliedEffects.find(
        (e) => e.effectInstanceId === change.effectInstanceId,
      );
      const afterEffect = effectDecrement.effects.find(
        (e) => e.effectInstanceId === change.effectInstanceId,
      );
      const reduced = recorder.record({
        eventType: "EffectDurationReduced",
        category: "FACT",
        turnNumber,
        cycleNumber: 0,
        resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId,
        targetUnitIds: [unit.battleUnitId],
        payload: {
          effectInstanceId: change.effectInstanceId,
          targetUnitId: unit.battleUnitId,
          unit: "TURN",
          before: change.before,
          after: change.after,
        },
        ...(beforeEffect !== undefined && afterEffect !== undefined
          ? {
              stateDelta: {
                units: {
                  [unit.battleUnitId]: {
                    effects: {
                      [change.effectInstanceId]: {
                        before: toEffectSnapshot(beforeEffect),
                        after: toEffectSnapshot(afterEffect),
                      },
                    },
                  },
                },
              },
            }
          : {}),
      });
      lastEventId = reduced.eventId;
    }
    working = working.map((u) =>
      u.battleUnitId === unit.battleUnitId
        ? { ...u, appliedEffects: effectDecrement.effects, markers: markerDecrement.markers }
        : u,
    );
    const toExpire: readonly ExpirationRequest[] = [
      ...effectDecrement.changes
        .filter((change) => change.after === 0)
        .map(
          (change): ExpirationRequest => ({
            kind: "EFFECT",
            effectInstanceId: change.effectInstanceId,
            reason: "TIME_LIMIT",
          }),
        ),
      ...markerDecrement.changes
        .filter((change) => change.after === 0)
        .map(
          (change): ExpirationRequest => ({
            kind: "MARKER",
            markerId: change.markerId,
            reason: "TIME_LIMIT",
          }),
        ),
    ];
    if (toExpire.length === 0) {
      continue;
    }
    const expireResult = expireEffects(
      {
        recorder,
        turnNumber,
        cycleNumber: 0,
        resolutionScopeId,
        rootEventId,
        // PR #155再レビュー[P2]: `expireEffects`自身が各イベント直後にPS候補
        // 解決を挟むため、呼び出し側での事後一括notifyは行わない。
        ...(notify !== undefined ? { notify } : {}),
      },
      working,
      unit.battleUnitId,
      toExpire,
      lastEventId,
    );
    working = expireResult.units;
    lastEventId = expireResult.lastEventId;
    recordedEvents.push(...expireResult.events);
  }
  return { units: working, lastEventId, events: recordedEvents };
}

/**
 * Battle集約の主要操作: advance。1回の呼び出しでTURN_STARTING〜TURN_ENDINGを
 * 進め、R-END-01の2つの判定タイミング区分（行動外のトップレベル解決スコープ
 * 完了後＝ターン開始・終了／ユニットの1行動完了後＝`resolveActionPhase`内部）を
 * 順に評価する。勝敗が確定した時点で以後の処理を打ち切る
 * （05_ドメインモデル.md「結果が確定した後は、未処理の...を処理しない」）。
 */
export function advanceBattle(
  battle: Battle,
  random: RandomSource,
  recorder: EventRecorder,
): Battle {
  if (battle.status !== "RUNNING") {
    throw new DomainValidationError(
      "battle.status",
      `cannot advance a battle in status "${battle.status}"`,
    );
  }

  const nextTurnNumber = battle.turnState.currentTurn + 1;
  const turnScope = recorder.nextResolutionScopeId();
  const turnStarted = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    payload: { turnNumber: nextTurnNumber },
    stateDelta: { turnNumber: { before: battle.turnState.currentTurn, after: nextTurnNumber } },
  });

  const turnState = beginNextTurn(battle.turnState);
  const recoveredAllyUnits = battle.allyUnits.map(recoverTurnResources);
  const recoveredEnemyUnits = battle.enemyUnits.map(recoverTurnResources);
  const recovery = buildResourceRecovery(
    [...battle.allyUnits, ...battle.enemyUnits],
    [...recoveredAllyUnits, ...recoveredEnemyUnits],
  );
  const resourcesRecovered = recorder.record({
    eventType: "ResourcesRecovered",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    parentEventId: turnStarted.eventId,
    rootEventId: turnStarted.eventId,
    payload: { units: recovery.entries },
  });

  // R-ACT-04: 回復で変化した各リソースを`ResourceChanged`(reason: TURN_RECOVERY)
  // として個別に所有・観測できるようにする（PR #141レビュー[P1]）。
  const recoveryResourceChangeContext = {
    recorder,
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    rootEventId: turnStarted.eventId,
  };
  let lastRecoveryEventId = resourcesRecovered.eventId;
  for (const entry of recovery.entries) {
    lastRecoveryEventId = recordResourceChangeIfAny(
      recoveryResourceChangeContext,
      entry.battleUnitId,
      "AP",
      entry.apBefore,
      entry.apAfter,
      "TURN_RECOVERY",
      lastRecoveryEventId,
      resourcesRecovered.eventId,
    );
    lastRecoveryEventId = recordResourceChangeIfAny(
      recoveryResourceChangeContext,
      entry.battleUnitId,
      "PP",
      entry.ppBefore,
      entry.ppAfter,
      "TURN_RECOVERY",
      lastRecoveryEventId,
      resourcesRecovered.eventId,
    );
  }

  // `06_戦闘状態遷移.md` TURN_STARTING #5: `TurnStarted`をイベントとして持つPSを
  // 解決する（回復適用後）。Issue #34 (R-PS-07): PS発動済み集合はこのトップ
  // レベルイベント専用に1つだけ生成する。行動外のため`actionId`は持たない。
  // Issue #144 (TRIGGER_EXCLUSION_TIMING): このトップレベルイベントのroot自体が
  // `TurnStarted`のため、`resolutionPhase: "TURN_START"`を渡す。
  const passiveRuntime = new PassiveActivationRuntime(
    {
      definitions: battle.definitions,
      random,
      recorder,
      turnNumber: nextTurnNumber,
      cycleNumber: 0,
      resolutionScopeId: turnScope,
      rootEventId: turnStarted.eventId,
      resolutionPhase: "TURN_START",
    },
    [...recoveredAllyUnits, ...recoveredEnemyUnits],
  );
  passiveRuntime.onFactEvent(turnStarted, [...recoveredAllyUnits, ...recoveredEnemyUnits]);
  // レビュー指摘[P2]: このトップレベルイベント専用の解決スコープが終わるたびに、
  // `resetScope: "RESOLUTION_SCOPE"`のcounterを破棄・`RuntimeCounterReset`発行する。
  const afterPassives = passiveRuntime.finalizeResolutionScope();
  const allyUnits = afterPassives.filter((unit) => unit.side === "ALLY");
  const enemyUnits = afterPassives.filter((unit) => unit.side === "ENEMY");
  const started: Battle = { ...battle, turnState, allyUnits, enemyUnits };

  // R-END-01 判定タイミング区分「ターン開始・終了など、行動外のトップレベル解決スコープ完了後」その1: TURN_STARTING完了後。
  const afterTurnStart = resolveVictory({
    allAlliesDefeated: allDefeated(allyUnits),
    allEnemiesDefeated: allDefeated(enemyUnits),
    turnLimitReached: false,
  });
  if (afterTurnStart !== undefined) {
    return complete(started, afterTurnStart, recorder);
  }

  // QUEUE_BUILDING〜ACTION_RESOLUTION: R-END-01「ユニットの1行動完了後」の判定は
  // `resolveActionPhase` 内部で各行動ごとに行う。
  const actionPhase = resolveActionPhase(
    allyUnits,
    enemyUnits,
    battle.definitions,
    random,
    recorder,
    nextTurnNumber,
    turnStarted.eventId,
    resourcesRecovered.eventId,
  );
  const progressed: Battle = {
    ...started,
    allyUnits: actionPhase.allyUnits,
    enemyUnits: actionPhase.enemyUnits,
  };
  if (actionPhase.result !== undefined) {
    return complete(progressed, actionPhase.result, recorder);
  }

  // R-END-01 判定タイミング区分「ターン開始・終了など、行動外のトップレベル解決スコープ完了後」その2: TURN_ENDING完了後。
  const turnEndScope = recorder.nextResolutionScopeId();
  const turnCompleting = recorder.record({
    eventType: "TurnCompleting",
    category: "TIMING",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnEndScope,
    payload: { turnNumber: nextTurnNumber },
  });

  // `06_戦闘状態遷移.md` TURN_ENDING #1: `TurnCompleting`をイベントとして持つPSを
  // 解決する（Issue #144 follow-up、PR #150で保留した残作業:
  // `resolutionPhase: "TURN_END"`を渡す）。行動外のため`actionId`は持たない。
  const turnEndPassiveRuntime = new PassiveActivationRuntime(
    {
      definitions: battle.definitions,
      random,
      recorder,
      turnNumber: nextTurnNumber,
      cycleNumber: 0,
      resolutionScopeId: turnEndScope,
      rootEventId: turnCompleting.eventId,
      resolutionPhase: "TURN_END",
    },
    [...actionPhase.allyUnits, ...actionPhase.enemyUnits],
  );
  // PR #155再レビュー[P1]: `TurnCompleting`のPS解決直後に`finalizeResolutionScope`
  // を呼ぶと、その後のクールタイム・効果・Marker減算やそれらが誘発するPS、
  // 最後の`TurnCompleted`自体が同じ`resolutionScopeId`（`turnEndScope`）の
  // `RESOLUTION_SCOPE`カウンタを参照できるうちに破棄してしまう。TURN_ENDING
  // スコープ全体（`TurnCompleting`PS→クールタイム減算→効果/Marker減算とその
  // PS→`TurnCompleted`PS）を1本の連鎖として通知し終えてから、最後に1回だけ
  // `finalizeResolutionScope`を呼ぶ。
  let turnEndUnits = turnEndPassiveRuntime.onFactEvent(turnCompleting, [
    ...actionPhase.allyUnits,
    ...actionPhase.enemyUnits,
  ]);

  // R-SKL-04 TURN_ENDING #2-4: PS連鎖完了後の現在状態から対象を再取得し、
  // ターン単位クールタイムを全ユニットで1減らす（現在のターンで設定された
  // ものを除く）。`CooldownReduced`/`CooldownCompleted`のPS通知は本レビューの
  // 指摘範囲外の既存挙動のため変更しない。
  const cooldownDecrement = applyTurnCooldownDecrements(
    turnEndUnits,
    nextTurnNumber,
    recorder,
    nextTurnNumber,
    turnEndScope,
    turnCompleting.eventId,
    turnCompleting.eventId,
  );
  turnEndUnits = cooldownDecrement.units;
  // R-EFF-06: クールタイム減算と同じ「PS連鎖完了後の現在状態」から対象を
  // 再取得し、ターン単位効果・Markerを全ユニットで1減らす。`EffectExpired`/
  // `EffectiveEffectChanged`/`MarkerRemoved`それぞれに対応するPS/Memory候補を
  // 直ちに解決する（仕様「各イベントに対応する候補を直ちに解決する」）。
  const effectDurationDecrement = applyTurnEffectDurationDecrements(
    turnEndUnits,
    nextTurnNumber,
    recorder,
    nextTurnNumber,
    turnEndScope,
    turnCompleting.eventId,
    cooldownDecrement.lastEventId,
    (event, unitsAtCall) => turnEndPassiveRuntime.onFactEvent(event, unitsAtCall),
  );
  turnEndUnits = effectDurationDecrement.units;

  const turnCompleted = recorder.record({
    eventType: "TurnCompleted",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnEndScope,
    parentEventId: effectDurationDecrement.lastEventId,
    rootEventId: turnCompleting.eventId,
    payload: { turnNumber: nextTurnNumber },
  });
  turnEndPassiveRuntime.onFactEvent(turnCompleted, turnEndUnits);

  // レビュー指摘[P2]: このトップレベル解決スコープ（`turnEndScope`）が完全に
  // 終わった後で、`resetScope: "RESOLUTION_SCOPE"`のcounterを一度だけ破棄・
  // `RuntimeCounterReset`発行する。
  const afterTurnEndPassives = turnEndPassiveRuntime.finalizeResolutionScope();
  const afterTurnEndPassivesById = new Map(afterTurnEndPassives.map((u) => [u.battleUnitId, u]));
  const progressedWithCooldown: Battle = {
    ...progressed,
    allyUnits: progressed.allyUnits.map((u) => afterTurnEndPassivesById.get(u.battleUnitId) ?? u),
    enemyUnits: progressed.enemyUnits.map((u) => afterTurnEndPassivesById.get(u.battleUnitId) ?? u),
  };

  const afterTurnEnd = resolveVictory({
    allAlliesDefeated: allDefeated(progressedWithCooldown.allyUnits),
    allEnemiesDefeated: allDefeated(progressedWithCooldown.enemyUnits),
    turnLimitReached: isFinalTurn(turnState),
  });
  if (afterTurnEnd !== undefined) {
    return complete(progressedWithCooldown, afterTurnEnd, recorder);
  }

  return progressedWithCooldown;
}

/** BattleCompletedを発行する。勝敗確定契機が複数あるため、単一の親イベントには紐付けずルート化する。 */
function complete(battle: Battle, result: VictoryResult, recorder: EventRecorder): Battle {
  const completedTurn = battle.turnState.currentTurn;
  const fullResult: BattleResult = { ...result, completedTurn };
  recorder.record({
    eventType: "BattleCompleted",
    category: "FACT",
    turnNumber: completedTurn,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: {
      outcome: result.outcome,
      completionReason: result.completionReason,
      completedTurn,
    },
    stateDelta: {
      battleStatus: { before: battle.status, after: "COMPLETED" },
      result: { before: battle.result, after: fullResult },
    },
  });
  return {
    ...battle,
    status: "COMPLETED",
    result: fullResult,
  };
}
