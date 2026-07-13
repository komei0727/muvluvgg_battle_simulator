import { isDefeated, recoverTurnResources, type BattleUnit } from "./battle-unit.js";
import { beginNextTurn, createTurnState, isFinalTurn, type TurnState } from "./turn-state.js";
import type { TurnLimit } from "./turn-limit.js";
import { resolveVictory, type VictoryResult } from "./victory-policy.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleId } from "../shared/ids.js";

export type BattleStatus = "READY" | "RUNNING" | "COMPLETED";

export type BattleResult = VictoryResult & { readonly completedTurn: number };

/**
 * `05_ドメインモデル.md` の Battle集約。`13_実装計画.md`「M3 最小戦闘縦切り」の
 * ライフサイクル部分（`ActionQueue`以降は#14/#9/#10で拡張する）だけを扱う。
 * ActionQueueがまだ存在しないため、`advanceBattle` 1回が
 * TURN_STARTING〜TURN_ENDINGの1ターン全体（06_戦闘状態遷移.mdの2つの
 * トップレベル解決スコープ境界）に相当する。ActionQueue導入後、この境界は
 * より細かい解決スコープ単位へ分割される。
 */
export interface Battle {
  readonly battleId: BattleId;
  readonly status: BattleStatus;
  readonly turnState: TurnState;
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  readonly result?: BattleResult;
}

/** Battle集約の主要操作: create（05_ドメインモデル.md）。 */
export function createBattle(
  battleId: BattleId,
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  turnLimit: TurnLimit,
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
  };
}

/** Battle集約の主要操作: start（06_戦闘状態遷移.md READY→RUNNING）。 */
export function startBattle(battle: Battle): Battle {
  if (battle.status !== "READY") {
    throw new DomainValidationError(
      "battle.status",
      `cannot start a battle in status "${battle.status}"`,
    );
  }
  return { ...battle, status: "RUNNING" };
}

function allDefeated(units: readonly BattleUnit[]): boolean {
  return units.every(isDefeated);
}

/**
 * Battle集約の主要操作: advance。1回の呼び出しでTURN_STARTING〜TURN_ENDINGを
 * 進め、R-END-01の2つの判定タイミング（ターン開始後・ターン終了後）を
 * 順に評価する。勝敗が確定した時点で以後の処理を打ち切る
 * （05_ドメインモデル.md「結果が確定した後は、未処理の...を処理しない」）。
 */
export function advanceBattle(battle: Battle): Battle {
  if (battle.status !== "RUNNING") {
    throw new DomainValidationError(
      "battle.status",
      `cannot advance a battle in status "${battle.status}"`,
    );
  }

  const turnState = beginNextTurn(battle.turnState);
  const allyUnits = battle.allyUnits.map(recoverTurnResources);
  const enemyUnits = battle.enemyUnits.map(recoverTurnResources);
  const progressed: Battle = { ...battle, turnState, allyUnits, enemyUnits };

  const allAlliesDefeated = allDefeated(allyUnits);
  const allEnemiesDefeated = allDefeated(enemyUnits);

  // R-END-01 第1判定タイミング: ターン開始（TURN_STARTING）というトップレベル解決スコープの完了後。
  const afterTurnStart = resolveVictory({
    allAlliesDefeated,
    allEnemiesDefeated,
    turnLimitReached: false,
  });
  if (afterTurnStart !== undefined) {
    return complete(progressed, afterTurnStart);
  }

  // ActionQueueが未実装のため、この時点で使用可能な行動は存在せず、常にTURN_ENDINGへ進む。
  // R-END-01 第2判定タイミング: ターン終了（TURN_ENDING）というトップレベル解決スコープの完了後。
  const afterTurnEnd = resolveVictory({
    allAlliesDefeated,
    allEnemiesDefeated,
    turnLimitReached: isFinalTurn(turnState),
  });
  if (afterTurnEnd !== undefined) {
    return complete(progressed, afterTurnEnd);
  }

  return progressed;
}

function complete(battle: Battle, result: VictoryResult): Battle {
  return {
    ...battle,
    status: "COMPLETED",
    result: { ...result, completedTurn: battle.turnState.currentTurn },
  };
}
