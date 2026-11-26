import type { ExerciseBreak } from "./simulation-result-assembler.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

/** 味方の参加枠1つ分のブレイク回数。枠はリクエストの`allyFormation.units`の添字で指す。 */
export interface AllyUnitBreakCount {
  readonly unitIndex: number;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly breakCount: number;
}

/** 単発の演習結果のロースターのうち、この投影が読む部分だけ。 */
export interface AllyUnitBreaksRosterEntry {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly side: Side;
}

/** `SimulateTacticalExerciseResult`のうち、この投影が読む部分だけ。 */
export interface AllyUnitBreaksInput {
  readonly unitRoster: readonly AllyUnitBreaksRosterEntry[];
  readonly breaks: readonly ExerciseBreak[];
}

/**
 * 演習1試行のブレイクを、それを起こした味方の参加枠ごとに数える。ロースターは陣営ごとに
 * 配置順（リクエストの`units`の順）に並ぶため、味方の何番目かがそのまま`unitIndex`になる
 * — 対応の正しさは同じ試行の`projectEvaluationUnits`が定義IDと数で確かめている。
 *
 * ブレイクは参加枠（`BattleUnitId`）で帰属させる。R-FRM-03により同じ`UnitDefinitionId`を
 * 同一陣営へ複数指定できるため、定義IDでは枠を特定できない。数えるのは味方の枠が起こした
 * ブレイクだけで、発生源を持たないブレイク（メモリー由来の継続ダメージ、R-MEM-04）も、
 * 敵の枠自身が起こしたブレイク（混乱による自傷など、R-CFS-01）もどの枠へも数えない
 * — 利用側は`breakCount`との残差としてまとめて把握する。
 */
export function projectAllyUnitBreaks(run: AllyUnitBreaksInput): AllyUnitBreakCount[] {
  const breaksByUnitId = new Map<BattleUnitId, number>();
  for (const exerciseBreak of run.breaks) {
    const sourceUnitId = exerciseBreak.sourceUnitId;
    if (sourceUnitId === undefined) {
      continue;
    }
    breaksByUnitId.set(sourceUnitId, (breaksByUnitId.get(sourceUnitId) ?? 0) + 1);
  }

  // 敵の枠が起こしたブレイクは、味方の枠を引いた時点で落ちる。
  return run.unitRoster
    .filter((entry) => entry.side === "ALLY")
    .map((entry, unitIndex) => ({
      unitIndex,
      unitDefinitionId: entry.unitDefinitionId,
      breakCount: breaksByUnitId.get(entry.battleUnitId) ?? 0,
    }));
}
