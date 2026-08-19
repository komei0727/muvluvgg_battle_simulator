// 統計実行の結果を表示用の1つの形へまとめる投影。統計量そのものはこの module では
// 計算せず、`descriptive-statistics` / `daily-best` / `unit-statistics` の結果を並べ
// 直すだけにする —— 定義の正本は `tools/exercise-lab` であり、表示の都合で式を触ると
// Python実装との一致（`__fixtures__/python-parity.ts`）から外れる。

import {
  buildScoreHistogram,
  summarizeBreakCounts,
  summarizeCompletionReasons,
  summarizeScores,
} from "./descriptive-statistics.js";
import type {
  BreakCountSummary,
  CompletionReasonSummary,
  HistogramBin,
  ScoreSummary,
} from "./descriptive-statistics.js";
import { DEFAULT_BEST_OF, summarizeDailyBest } from "./daily-best.js";
import type { DailyBestSummary } from "./daily-best.js";
import {
  summarizeAllyUnitBreaks,
  summarizeAllyUnitDamage,
  summarizeTopRuns,
} from "./unit-statistics.js";
import type { AllyUnitBreakSummary, AllyUnitDamageSummary } from "./unit-statistics.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";

/** ベストスコア比較で選べる上位run数。既定は先頭の10。 */
export const TOP_RUN_CHOICES = [10, 25, 50] as const;
export const DEFAULT_TOP_RUN_COUNT = TOP_RUN_CHOICES[0];

export interface AllyUnitLabel {
  /** 応答の`allyUnit*`の列番号。編成順であり、表の行の同一性でもある。 */
  readonly unitIndex: number;
  readonly unitDefinitionId: string;
  readonly displayName: string;
}

export interface ScoreDistributionBin extends HistogramBin {
  /** このビンへ入った試行の割合。ビンの高さは試行数ではなく割合で読ませる。 */
  readonly runShare: number;
  /**
   * 1日k回挑戦した日のベストがこのビンへ入る割合。日次ベストのCDFが `F(x)^k`
   * （`buildDailyBestDistribution`）なので、ビンの上端と下端の差として出る。
   * 単発の割合と同じ縦軸で読めるため、同じ図へ重ねられる。
   */
  readonly dailyBestShare: number;
}

export interface ScoreStatisticsReport {
  readonly seed: string;
  /** 実行を再現する鍵は（seed, チャンクサイズ, 実行回数）の3つである。 */
  readonly chunkSize: number;
  readonly catalogRevision: string;
  readonly requestedRuns: number;
  readonly completedRuns: number;
  /** 集計へ入った試行が要求に満たないこと（中断・期限到達、Q-TEX-18）。 */
  readonly partial: boolean;
  readonly score: ScoreSummary;
  readonly dailyBest: DailyBestSummary;
  readonly distribution: readonly ScoreDistributionBin[];
  readonly completionReasons: CompletionReasonSummary;
  readonly breaks: BreakCountSummary;
}

export interface UnitStatisticsRow {
  readonly label: AllyUnitLabel;
  readonly damage: AllyUnitDamageSummary;
  readonly breaks: AllyUnitBreakSummary;
  readonly topMeanDamage: number;
  /** 全run平均に対する上位N平均の増減。全run平均が0のときは0（増減を出せない）。 */
  readonly topMeanDamageRatio: number;
  readonly topMeanBreakCount: number;
}

export interface UnitStatisticsReport {
  /** 要求したN。試行数がNに満たないときも要求値のまま残す。 */
  readonly requestedTopN: number;
  readonly topRuns: number;
  readonly topMeanScore: number;
  readonly topMeanScoreDelta: number;
  readonly topMeanScoreRatio: number;
  readonly rows: readonly UnitStatisticsRow[];
  /** 分布バーの共通スケール。行ごとに伸縮させると寄与の差が読めなくなる。 */
  readonly damageScaleMax: number;
  readonly breakMean: number;
  readonly unitBreakMeanTotal: number;
  readonly unattributedBreakMean: number;
}

/**
 * 応答の列へ送信時の編成から名前を付ける。Catalogが未取得・reload中でも列は出す
 * （`selectExerciseResultView`と同じ方針）。同じ定義を複数の枠へ置ける以上、表示名
 * だけでは行を読み分けられないため、重複する定義には枠の順番を添える。
 */
export function resolveAllyUnitLabels(
  unitDefinitionIds: readonly string[],
  catalog?: BattleSimulationCatalogResponse,
): readonly AllyUnitLabel[] {
  const displayNameByDefinitionId = new Map(
    (catalog?.units ?? []).map((unit) => [unit.unitDefinitionId, unit.displayName] as const),
  );
  const columnsByDefinitionId = new Map<string, number>();
  for (const unitDefinitionId of unitDefinitionIds) {
    columnsByDefinitionId.set(
      unitDefinitionId,
      (columnsByDefinitionId.get(unitDefinitionId) ?? 0) + 1,
    );
  }

  const ordinals = new Map<string, number>();
  return unitDefinitionIds.map((unitDefinitionId, unitIndex) => {
    const name = displayNameByDefinitionId.get(unitDefinitionId) ?? unitDefinitionId;
    const ordinal = (ordinals.get(unitDefinitionId) ?? 0) + 1;
    ordinals.set(unitDefinitionId, ordinal);
    const duplicated = (columnsByDefinitionId.get(unitDefinitionId) ?? 0) > 1;
    return {
      unitIndex,
      unitDefinitionId,
      displayName: duplicated ? `${name} #${ordinal.toString()}` : name,
    };
  });
}

/**
 * ヒストグラムの各ビンへ、単発の割合と日次ベストの割合を並べる。日次ベスト側は
 * 経験CDF `F(x)^k` の階段をビンの境界で差分したもので、標本の外へ外挿しない。
 * 最上位のビンだけ上端を含める（`buildScoreHistogram`と同じ扱い）。
 */
export function buildScoreDistribution(
  scores: readonly number[],
  bestOf: number = DEFAULT_BEST_OF,
): readonly ScoreDistributionBin[] {
  const bins = buildScoreHistogram(scores);
  const ordered = [...scores].sort((left, right) => left - right);
  const cdf = (bound: number, inclusive: boolean): number => {
    const runs = ordered.filter((score) => (inclusive ? score <= bound : score < bound)).length;
    return runs / ordered.length;
  };

  return bins.map((bin, index) => {
    const last = index === bins.length - 1;
    const lowerCdf = index === 0 ? 0 : cdf(bin.lowerBound, false);
    const upperCdf = last ? 1 : cdf(bin.upperBound, false);
    return {
      ...bin,
      runShare: bin.runs / ordered.length,
      dailyBestShare: upperCdf ** bestOf - lowerCdf ** bestOf,
    };
  });
}

export function buildScoreStatisticsReport(
  aggregate: EvaluationAggregate,
  seed: string,
): ScoreStatisticsReport {
  const { sample } = aggregate;
  return {
    seed,
    chunkSize: aggregate.chunkSize,
    catalogRevision: aggregate.catalogRevision,
    requestedRuns: aggregate.requestedRuns,
    completedRuns: sample.scores.length,
    partial: sample.scores.length < aggregate.requestedRuns,
    score: summarizeScores(sample.scores),
    dailyBest: summarizeDailyBest(sample.scores),
    distribution: buildScoreDistribution(sample.scores),
    completionReasons: summarizeCompletionReasons(sample.completionReasons),
    breaks: summarizeBreakCounts(sample.breakCounts),
  };
}

export function buildUnitStatisticsReport(
  aggregate: EvaluationAggregate,
  labels: readonly AllyUnitLabel[],
  topN: number,
): UnitStatisticsReport {
  const { sample } = aggregate;
  const damage = summarizeAllyUnitDamage(sample.allyUnitDamageTotals);
  const breaks = summarizeAllyUnitBreaks(sample.allyUnitBreakCounts, sample.breakCounts);
  const top = summarizeTopRuns(sample, topN);
  const overallMeanScore = summarizeScores(sample.scores).mean;
  const breakMean = summarizeBreakCounts(sample.breakCounts).mean;

  const rows = damage.map((unitDamage, unitIndex) => {
    const unitBreaks = breaks.units[unitIndex];
    const topUnit = top.units[unitIndex];
    if (unitBreaks === undefined || topUnit === undefined) {
      // 3つの集計はいずれも同じ応答の同じ列から出る。欠けるのは統計側の契約違反で
      // あり、行を落として表を出すと欠落に気づけない。
      throw new Error("ユニット別集計の列が揃っていない");
    }
    return {
      // 応答の列数が送信した編成の枠数と食い違っても表は出す。列があるという事実は
      // 応答が決めるため、名前を付けられない列は位置で示す。
      label: labels[unitIndex] ?? {
        unitIndex,
        unitDefinitionId: "",
        displayName: `ユニット${(unitIndex + 1).toString()}`,
      },
      damage: unitDamage,
      breaks: unitBreaks,
      topMeanDamage: topUnit.meanDamage,
      topMeanDamageRatio: unitDamage.mean === 0 ? 0 : topUnit.meanDamage / unitDamage.mean - 1,
      topMeanBreakCount: topUnit.meanBreakCount,
    };
  });

  return {
    requestedTopN: top.requestedTopN,
    topRuns: top.runs,
    topMeanScore: top.meanScore,
    topMeanScoreDelta: top.meanScoreDelta,
    topMeanScoreRatio: overallMeanScore === 0 ? 0 : top.meanScore / overallMeanScore - 1,
    rows,
    damageScaleMax: Math.max(
      0,
      ...rows.map((row) => row.damage.maximum),
      ...rows.map((row) => row.topMeanDamage),
    ),
    breakMean,
    unitBreakMeanTotal: breaks.units.reduce((total, unit) => total + unit.mean, 0),
    unattributedBreakMean: breaks.unattributedBreakMean,
  };
}
