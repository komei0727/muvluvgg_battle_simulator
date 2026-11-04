import type { Side } from "../../shared/side.js";

/**
 * R-TWR-06 #4: 戦闘履歴の1要素。出撃した編成の組み合わせ1つ分で、全滅した陣営を発生順に持つ。
 * 決着せずに戦闘が終わった組み合わせでは`defeatedSides`は空になる。
 */
export interface TotalWarStage {
  readonly stageNumber: number;
  readonly allyFormationNumber: number;
  readonly enemyFormationNumber: number;
  readonly startTurn: number;
  readonly endTurn: number;
  readonly defeatedSides: readonly Side[];
}

/**
 * 戦闘中の戦闘履歴の1要素。`endTurn`は全滅を記録した時点で決まり、決着しないまま続く
 * 組み合わせでは戦闘の終了（`closeStageHistory`）まで決まらない。
 */
export interface TotalWarStageRecord extends Omit<TotalWarStage, "endTurn"> {
  readonly endTurn?: number;
}

/** R-TWR-03 #1: 戦闘開始時は、両陣営の1番目の編成どうしが1ターン目から戦う。 */
export function startStageHistory(): readonly TotalWarStageRecord[] {
  return [
    {
      stageNumber: 1,
      allyFormationNumber: 1,
      enemyFormationNumber: 1,
      startTurn: 1,
      defeatedSides: [],
    },
  ];
}

/**
 * 判定タイミングで検出した編成の全滅を、現在の組み合わせへ記録する。同じ組み合わせの全滅は
 * どれも同じターンに起こる（全滅で行動フェーズを打ち切り、次ターンの冒頭で出撃させるため。
 * R-TWR-03 #4〜#6）ので、終了ターンは最後に記録した全滅のターンになる。
 */
export function recordStageDefeat(
  history: readonly TotalWarStageRecord[],
  side: Side,
  turnNumber: number,
): readonly TotalWarStageRecord[] {
  return updateCurrentStage(history, (stage) => ({
    ...stage,
    endTurn: turnNumber,
    defeatedSides: [...stage.defeatedSides, side],
  }));
}

/** R-TWR-04 #2: 出撃スコープで編成が入れ替わったら、そのターンから新しい組み合わせを始める。 */
export function openNextStage(
  history: readonly TotalWarStageRecord[],
  formations: { readonly allyFormationNumber: number; readonly enemyFormationNumber: number },
  turnNumber: number,
): readonly TotalWarStageRecord[] {
  return [
    ...history,
    {
      stageNumber: history.length + 1,
      ...formations,
      startTurn: turnNumber,
      defeatedSides: [],
    },
  ];
}

/** 戦闘の終了時に、まだ終わっていない組み合わせを終了ターンで閉じる。 */
export function closeStageHistory(
  history: readonly TotalWarStageRecord[],
  completedTurn: number,
): readonly TotalWarStage[] {
  return history.map((stage) => ({ ...stage, endTurn: stage.endTurn ?? completedTurn }));
}

function updateCurrentStage(
  history: readonly TotalWarStageRecord[],
  update: (stage: TotalWarStageRecord) => TotalWarStageRecord,
): readonly TotalWarStageRecord[] {
  const current = history.at(-1);
  if (current === undefined) {
    return history;
  }
  return [...history.slice(0, -1), update(current)];
}
