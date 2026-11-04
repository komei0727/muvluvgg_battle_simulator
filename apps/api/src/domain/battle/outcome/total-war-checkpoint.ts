import { resolveTotalWarEnd, type TotalWarEndResult } from "./total-war-end-policy.js";
import {
  isActiveFormationWiped,
  isAwaitingDeployment,
  TOTAL_WAR_SIDE_ORDER,
  type TotalWarFormations,
  type TotalWarSideFormations,
} from "../model/total-war-formations.js";
import { recordStageDefeat } from "../model/total-war-stages.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { Side } from "../../shared/side.js";

/** 判定タイミングで新たに全滅を検出した編成。`FormationDefeated`のpayloadになる（R-TWR-03 #7）。 */
export interface FormationDefeat {
  readonly side: Side;
  readonly formationNumber: number;
  readonly remainingReserveCount: number;
  /** 検出前の撃破された編成数。`FormationDefeated`が所有する差分の`before`になる。 */
  readonly defeatedCountBefore: number;
}

export interface TotalWarCheckpointResult {
  readonly formations: TotalWarFormations;
  /** 新たに全滅を検出した編成を、味方、敵の順に並べたもの。 */
  readonly defeats: readonly FormationDefeat[];
  /** 確定した結果。`undefined`は戦闘継続。 */
  readonly completion: TotalWarEndResult | undefined;
  /**
   * R-TWR-03 #4: 出撃中の編成が全滅したまま交代を待つ陣営がある。行動フェーズを打ち切り、
   * ターン開始の判定タイミングなら行動フェーズを開始しない。
   */
  readonly awaitingDeployment: boolean;
}

/**
 * R-TWR-03・R-END-01: 総力戦の判定タイミング1回分。出撃中の編成が新たに全滅した陣営を
 * 味方、敵の順に検出し、撃破された編成数と戦闘履歴を進めてから終了判定（R-TWR-06）を行う。
 * 既に全滅を検出済みの編成は、同じターンの後の判定タイミングで再び数えない。
 *
 * 控えが残る陣営の全滅は負けとせず、編成の交代へ進む（R-TWR-06 #3）。
 */
export function resolveTotalWarCheckpoint(
  formations: TotalWarFormations,
  units: readonly BattleUnit[],
  turnLimitReached: boolean,
  turnNumber: number,
): TotalWarCheckpointResult {
  let next = formations;
  const defeats: FormationDefeat[] = [];
  for (const side of TOTAL_WAR_SIDE_ORDER) {
    const current = next[side];
    if (isAwaitingDeployment(current)) {
      continue;
    }
    const sideUnits = units.filter((unit) => unit.side === side);
    if (!isActiveFormationWiped(current, sideUnits)) {
      continue;
    }
    defeats.push({
      side,
      formationNumber: current.activeFormationNumber,
      remainingReserveCount: current.reserves.length,
      defeatedCountBefore: current.defeatedCount,
    });
    next = {
      ...next,
      [side]: { ...current, defeatedCount: current.defeatedCount + 1 },
      stages: recordStageDefeat(next.stages, side, turnNumber),
    };
  }

  const completion = resolveTotalWarEnd({
    allyOutOfFormations: hasNoFormationLeft(next.ALLY),
    enemyOutOfFormations: hasNoFormationLeft(next.ENEMY),
    turnLimitReached,
  });
  return {
    formations: next,
    defeats,
    completion,
    awaitingDeployment: TOTAL_WAR_SIDE_ORDER.some((side) => isAwaitingDeployment(next[side])),
  };
}

/** R-TWR-06 #1: 出撃中の編成が全滅し、控えも残らない。 */
function hasNoFormationLeft(side: TotalWarSideFormations): boolean {
  return isAwaitingDeployment(side) && side.reserves.length === 0;
}
