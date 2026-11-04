import { isDefeated, type BattleUnit } from "./battle-unit.js";
import type { Side } from "../../shared/side.js";

/** R-TWR-03 #2: 出撃前の編成。そのユニットは盤面（`Battle.allyUnits`／`enemyUnits`）に置かない。 */
export interface TotalWarReserveFormation {
  readonly formationNumber: number;
  readonly units: readonly BattleUnit[];
}

/**
 * `05_ドメインモデル.md`「編成状態（総力戦のみ）」の陣営1つ分。
 *
 * 出撃中の編成が全滅を検出済みかどうかは `defeatedCount >= activeFormationNumber` で表す。
 * 編成は出撃順にしか全滅しないため、撃破された編成数が出撃中の編成番号に追いついた時点で
 * 出撃中の編成は全滅済みであり、次の出撃（`activeFormationNumber` の更新）で再び下回る。
 */
export interface TotalWarSideFormations {
  readonly formationCount: number;
  readonly activeFormationNumber: number;
  readonly defeatedCount: number;
  /** 控えの編成を出撃順に並べたもの。先頭が次に出撃する。 */
  readonly reserves: readonly TotalWarReserveFormation[];
}

export type TotalWarFormations = Readonly<Record<Side, TotalWarSideFormations>>;

/** 判定タイミングで味方、敵の順に評価する（R-TWR-03 #7・R-TWR-04 #3）。 */
export const TOTAL_WAR_SIDE_ORDER: readonly Side[] = ["ALLY", "ENEMY"];

/** R-TWR-03 #3: 出撃中の編成の全滅を既に検出し、交代を待っている。 */
export function isAwaitingDeployment(side: TotalWarSideFormations): boolean {
  return side.defeatedCount >= side.activeFormationNumber;
}

/**
 * R-TWR-03 #3: 出撃中の編成のユニットが全員戦闘不能か。全滅した過去の編成のユニットは
 * 戦闘不能のまま同じ一覧に残るため（R-TWR-03 #8）、編成番号で出撃中の編成だけに絞る。
 */
export function isActiveFormationWiped(
  side: TotalWarSideFormations,
  sideUnits: readonly BattleUnit[],
): boolean {
  return sideUnits
    .filter((unit) => unit.formationNumber === side.activeFormationNumber)
    .every(isDefeated);
}
