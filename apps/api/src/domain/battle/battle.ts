import { resolveActionPhase } from "./action-phase-resolver.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import type { BattleStatus } from "./battle-status.js";
import { isDefeated, recoverTurnResources, type BattleUnit } from "./battle-unit.js";
import { decrementTurnCooldowns } from "./cooldown-state.js";
import type { DomainEventId, ResolutionScopeId } from "./events/event-ids.js";
import type { EventRecorder } from "./events/event-recorder.js";
import type { ResourceRecoveryEntry } from "./events/domain-event.js";
import type { StateDelta, UnitStateDelta } from "./events/state-delta.js";
import { beginNextTurn, createTurnState, isFinalTurn, type TurnState } from "./turn-state.js";
import type { TurnLimit } from "./turn-limit.js";
import { resolveVictory, type VictoryResult } from "./victory-policy.js";
import type { RandomSource } from "../ports/random-source.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleId, BattleUnitId } from "../shared/ids.js";

export type { BattleStatus } from "./battle-status.js";

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

/** Battle集約の主要操作: start（06_戦闘状態遷移.md READY→RUNNING）。BattleStartedを発行する。 */
export function startBattle(battle: Battle, recorder: EventRecorder): Battle {
  if (battle.status !== "READY") {
    throw new DomainValidationError(
      "battle.status",
      `cannot start a battle in status "${battle.status}"`,
    );
  }
  recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: {
      turnLimit: battle.turnState.turnLimit,
      allySlotCount: battle.allyUnits.length,
      enemySlotCount: battle.enemyUnits.length,
    },
    stateDelta: { battleStatus: { before: battle.status, after: "RUNNING" } },
  });
  return { ...battle, status: "RUNNING" };
}

function allDefeated(units: readonly BattleUnit[]): boolean {
  return units.every(isDefeated);
}

/** TURN_STARTING #2のAP/PP回復のうち、実際に値が変わったユニットだけをpayload/StateDeltaへ含める。 */
function buildResourceRecovery(
  before: readonly BattleUnit[],
  after: readonly BattleUnit[],
): { entries: readonly ResourceRecoveryEntry[]; unitDeltas: Record<BattleUnitId, UnitStateDelta> } {
  const entries: ResourceRecoveryEntry[] = [];
  const unitDeltas: Record<BattleUnitId, UnitStateDelta> = {};
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
    unitDeltas[previous.battleUnitId] = {
      ap: { before: previous.currentAp, after: recovered.currentAp },
      pp: { before: previous.currentPp, after: recovered.currentPp },
    };
  }
  return { entries, unitDeltas };
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
  const allyUnits = battle.allyUnits.map(recoverTurnResources);
  const enemyUnits = battle.enemyUnits.map(recoverTurnResources);
  const recovery = buildResourceRecovery(
    [...battle.allyUnits, ...battle.enemyUnits],
    [...allyUnits, ...enemyUnits],
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
    ...(Object.keys(recovery.unitDeltas).length > 0
      ? { stateDelta: { units: recovery.unitDeltas } satisfies StateDelta }
      : {}),
  });
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

  // R-SKL-04 TURN_ENDING #2-4: ターン単位クールタイムを全ユニットで1減らす
  // （現在のターンで設定されたものを除く）。
  const cooldownDecrement = applyTurnCooldownDecrements(
    [...actionPhase.allyUnits, ...actionPhase.enemyUnits],
    nextTurnNumber,
    recorder,
    nextTurnNumber,
    turnEndScope,
    turnCompleting.eventId,
    turnCompleting.eventId,
  );
  const cooldownById = new Map(cooldownDecrement.units.map((u) => [u.battleUnitId, u]));
  const progressedWithCooldown: Battle = {
    ...progressed,
    allyUnits: actionPhase.allyUnits.map((u) => cooldownById.get(u.battleUnitId) ?? u),
    enemyUnits: actionPhase.enemyUnits.map((u) => cooldownById.get(u.battleUnitId) ?? u),
  };

  recorder.record({
    eventType: "TurnCompleted",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnEndScope,
    parentEventId: cooldownDecrement.lastEventId,
    rootEventId: turnCompleting.eventId,
    payload: { turnNumber: nextTurnNumber },
  });

  const afterTurnEnd = resolveVictory({
    allAlliesDefeated: allDefeated(actionPhase.allyUnits),
    allEnemiesDefeated: allDefeated(actionPhase.enemyUnits),
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
