import { isDefeated, type BattleUnit } from "./battle-unit.js";
import type { MemoryDefinition } from "../../catalog/definitions/memory-definition.js";
import type { Side } from "../../shared/side.js";
import type { TotalWarStageRecord } from "./total-war-stages.js";

/**
 * R-TWR-01 #5: 総力戦の規定ターン数は15で固定であり、リクエストでは指定できない。
 * `09_アプリケーション設計.md`の`TOTAL_WAR_TURN_LIMIT`と同じ値を、集約の生成時不変条件
 * （`createTotalWarBattle`）が参照できるようDomain側の正本として持つ。
 */
export const TOTAL_WAR_TURN_LIMIT = 15;

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
  /**
   * R-TWR-05 #1: 編成ごとのメモリー（添字＝編成番号−1）。並びはAPI指定順のまま保つ
   * （R-MEM-02 #1）。候補化の対象は `activeMemoriesBySide` が出撃中の編成のものに絞る。
   */
  readonly memoriesByFormation: readonly (readonly MemoryDefinition[])[];
}

/** `05_ドメインモデル.md`「編成状態（総力戦のみ）」: 陣営ごとの編成状態と戦闘履歴。 */
export interface TotalWarFormations {
  readonly ALLY: TotalWarSideFormations;
  readonly ENEMY: TotalWarSideFormations;
  /** R-TWR-06 #4: 戦闘履歴の正本。出撃と全滅の検出に合わせて組み合わせごとに積む。 */
  readonly stages: readonly TotalWarStageRecord[];
}

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

/**
 * R-TWR-05 #1: 各陣営で候補化してよいメモリー。出撃中の編成のものだけを返し、全滅を
 * 検出して交代を待つ陣営は空にする — 全滅した編成のメモリーは、次の編成が出撃するまでの
 * ターン終了処理でも候補化しない。
 */
export function activeMemoriesBySide(
  formations: TotalWarFormations,
): Readonly<Record<Side, readonly MemoryDefinition[]>> {
  const activeOf = (side: TotalWarSideFormations): readonly MemoryDefinition[] =>
    isAwaitingDeployment(side)
      ? []
      : (side.memoriesByFormation[side.activeFormationNumber - 1] ?? []);
  return { ALLY: activeOf(formations.ALLY), ENEMY: activeOf(formations.ENEMY) };
}
