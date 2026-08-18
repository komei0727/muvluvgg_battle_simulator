import type { ExerciseBreak } from "./simulation-result-assembler.js";
import type { UnitBattleSummary } from "../observation/unit-battle-summary-projector.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";

/** 演習1試行から取り出す、味方の参加枠ごとの生値。編成順（ロースター順）に並ぶ。 */
export interface AllyUnitRunMetrics {
  readonly damageTotals: readonly number[];
  readonly breakCounts: readonly number[];
}

/** `SimulateTacticalExerciseResult`のうち、この投影が読む部分だけ。 */
export interface AllyUnitRunMetricsInput {
  readonly unitSummaries: readonly UnitBattleSummary[];
  readonly breaks: readonly ExerciseBreak[];
}

/**
 * 一括評価（`10_API設計.md`「TacticalExerciseCandidateEvaluationResponse」）が試行ごとに
 * 返す、味方ユニット別の与ダメージ合計とブレイク回数を取り出す。
 *
 * 与ダメージは単発の演習が返す`unitSummaries`をそのまま使う。集計セマンティクス
 * （どこまでを与ダメージへ数えるか）を再実装せず、両エンドポイントの数値が食い違わない
 * ことを構成で保証するためである。
 *
 * ブレイクは参加枠（`BattleUnitId`）で帰属させる。R-FRM-03により同じ`UnitDefinitionId`を
 * 同一陣営へ複数指定できるため、定義IDでは枠を特定できない。発生源を持たないブレイク
 * （メモリー由来の継続ダメージ、R-MEM-04）と味方以外が起こしたブレイクはどの枠へも
 * 数えない — 利用側は`breakCount`との残差としてそれらを把握する。
 */
export function projectAllyUnitRunMetrics(run: AllyUnitRunMetricsInput): AllyUnitRunMetrics {
  const breaksByUnitId = new Map<BattleUnitId, number>();
  for (const exerciseBreak of run.breaks) {
    const sourceUnitId = exerciseBreak.sourceUnitId;
    if (sourceUnitId === undefined) {
      continue;
    }
    breaksByUnitId.set(sourceUnitId, (breaksByUnitId.get(sourceUnitId) ?? 0) + 1);
  }

  // 敵の枠が起こしたブレイクは、味方の枠を引いた時点で落ちる。
  const allySummaries = run.unitSummaries.filter((summary) => summary.side === "ALLY");
  return {
    damageTotals: allySummaries.map((summary) => summary.damageDealt),
    breakCounts: allySummaries.map((summary) => breaksByUnitId.get(summary.battleUnitId) ?? 0),
  };
}
