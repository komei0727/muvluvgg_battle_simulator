import { describe, expect, it } from "vitest";
import {
  buildScoreDistribution,
  buildScoreStatisticsReport,
  buildUnitStatisticsReport,
  resolveAllyUnitLabels,
} from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";

function aggregate(overrides: Partial<EvaluationAggregate> = {}): EvaluationAggregate {
  const scores = [100, 300, 200, 400];
  return {
    completedRuns: 4,
    catalogRevision: "rev-1",
    chunkSize: 4,
    sentRuns: 4,
    runs: scores.map((_score, index) => ({
      chunkIndex: 0,
      chunkSeed: "seed#0",
      runIndexInChunk: index,
    })),
    sample: {
      scores,
      breakCounts: [1, 3, 2, 4],
      completedTurns: [5, 5, 5, 5],
      completionReasons: [
        "TURN_LIMIT_REACHED",
        "TURN_LIMIT_REACHED",
        "ALLY_DEFEATED",
        "TURN_LIMIT_REACHED",
      ],
      allyUnitDamageTotals: [
        [60, 40],
        [200, 100],
        [140, 60],
        [300, 100],
      ],
      allyUnitBreakCounts: [
        [1, 0],
        [2, 1],
        [1, 1],
        [3, 1],
      ],
    },
    ...overrides,
  };
}

const catalog = {
  units: [
    { unitDefinitionId: "UNIT_KOTOHA", displayName: "【世界への反逆者】コトハ" },
    { unitDefinitionId: "UNIT_SHIRANA", displayName: "【白銀の閃き】シラナ" },
  ],
} as unknown as BattleSimulationCatalogResponse;

// UI-UT-STR-001: 列の名前は送信時の編成からしか付けられない。Catalog未取得でも列は
// 出す（`selectExerciseResultView`と同じ方針）。
describe("resolveAllyUnitLabels", () => {
  it("labels each formation column with the catalog display name", () => {
    expect(resolveAllyUnitLabels(["UNIT_KOTOHA", "UNIT_SHIRANA"], catalog)).toEqual([
      { unitIndex: 0, unitDefinitionId: "UNIT_KOTOHA", displayName: "【世界への反逆者】コトハ" },
      { unitIndex: 1, unitDefinitionId: "UNIT_SHIRANA", displayName: "【白銀の閃き】シラナ" },
    ]);
  });

  it("falls back to the definition id when the catalog is not loaded", () => {
    expect(resolveAllyUnitLabels(["UNIT_KOTOHA"])).toEqual([
      { unitIndex: 0, unitDefinitionId: "UNIT_KOTOHA", displayName: "UNIT_KOTOHA" },
    ]);
  });

  // 同じ定義を2枠へ置ける（`m4-success-duplicate-definition`）。同名の行が並ぶと
  // どちらの列を読んでいるか決められないため、枠の順番で読み分けられるようにする。
  it("numbers the columns of a definition placed in more than one slot", () => {
    expect(
      resolveAllyUnitLabels(["UNIT_KOTOHA", "UNIT_SHIRANA", "UNIT_KOTOHA"], catalog).map(
        (label) => label.displayName,
      ),
    ).toEqual([
      "【世界への反逆者】コトハ #1",
      "【白銀の閃き】シラナ",
      "【世界への反逆者】コトハ #2",
    ]);
  });
});

// UI-UT-STR-002: サマリの数値はすべて`exercise-stats`の統計から出す。ここが持つのは
// 「どの試行数を要求し、何試行が集計へ入ったか」という再現条件の対応づけだけである。
describe("buildScoreStatisticsReport", () => {
  it("summarizes the sample and carries the reproduction conditions", () => {
    const report = buildScoreStatisticsReport(aggregate(), { seed: "seed-1", requestedRuns: 4 });

    expect(report.seed).toBe("seed-1");
    expect(report.catalogRevision).toBe("rev-1");
    expect(report.requestedRuns).toBe(4);
    expect(report.completedRuns).toBe(4);
    expect(report.partial).toBe(false);
    expect(report.score.mean).toBe(250);
    expect(report.score.count).toBe(4);
    expect(report.dailyBest.bestOf).toBe(5);
    expect(report.breaks.mean).toBe(2.5);
    expect(report.completionReasons.defeatRate).toBe(0.25);
    expect(report.distribution.length).toBeGreaterThan(0);
  });

  // 統計は`completedRuns`ではなく配列長から出る。要求との差はそのまま部分結果として
  // 示すため、要求数へ丸めない。
  it("marks a sample shorter than the requested runs as partial", () => {
    const report = buildScoreStatisticsReport(aggregate(), { seed: "seed-1", requestedRuns: 10 });

    expect(report.requestedRuns).toBe(10);
    expect(report.completedRuns).toBe(4);
    expect(report.partial).toBe(true);
  });

  // 中断すると、送らなかったチャンクの分だけ集約の`sentRuns`が要求を下回る。要求として
  // `sentRuns`を読むと「要求どおり完走した」ことになってしまう。
  it("keeps the requested runs of the user apart from the runs actually sent", () => {
    const cancelled = buildScoreStatisticsReport(aggregate({ sentRuns: 4 }), {
      seed: "seed-1",
      requestedRuns: 12,
    });

    expect(cancelled.requestedRuns).toBe(12);
    expect(cancelled.sentRuns).toBe(4);
    expect(cancelled.completedRuns).toBe(4);
    expect(cancelled.partial).toBe(true);
  });

  // 有効サンプルが下限未満の実行は、値そのものを読ませてはいけない。
  it("reports the daily best metrics as unreliable for a small sample", () => {
    const report = buildScoreStatisticsReport(aggregate(), { seed: "seed-1", requestedRuns: 4 });

    expect(report.dailyBest.effectiveSamples).toBeCloseTo(4 * (9 / 25));
    expect(report.dailyBest.reliable).toBe(false);
  });
});

// UI-UT-STR-004: 単発ヒストグラムと日次ベスト分布は同じビン・同じ縦軸（割合）で
// 重ねる。日次ベスト側は経験CDFの`F(x)^k`をビン境界で差分したものである。
describe("buildScoreDistribution", () => {
  it("puts the single-run share and the daily best share on the same bins", () => {
    // n=4 のビン数はSturgesで3。境界は [0,1) [1,2) [2,3]。
    const bins = buildScoreDistribution([0, 1, 2, 3], 2);

    expect(bins.map((bin) => bin.runs)).toEqual([1, 1, 2]);
    expect(bins.map((bin) => bin.runShare)).toEqual([0.25, 0.25, 0.5]);
    // 経験CDFは境界で 0 → .25 → .5 → 1。日次ベスト側はその2乗の差分で、
    // 同じ標本でも上位のビンへ大きく寄る。
    expect(bins.map((bin) => bin.dailyBestShare)).toEqual([0.0625, 0.1875, 0.75]);
  });

  // 全試行が同値だと幅0の1本しか作れない。その日は必ずその値なので、日次ベストも1になる。
  it("keeps a degenerate single-value sample as one full bin", () => {
    expect(buildScoreDistribution([7, 7, 7], 5)).toEqual([
      { lowerBound: 7, upperBound: 7, runs: 3, runShare: 1, dailyBestShare: 1 },
    ]);
  });
});

// UI-UT-STR-003: キャラ別統計は全run統計と上位N部分集計を1行へ並べる。上位Nの
// 切り替えは再計算だけで済む（再実行しない）ため、Nを引数に取る。
describe("buildUnitStatisticsReport", () => {
  const labels = resolveAllyUnitLabels(["UNIT_KOTOHA", "UNIT_SHIRANA"], catalog);

  it("joins the全run statistics and the top-N subset per formation column", () => {
    const report = buildUnitStatisticsReport(aggregate(), labels, 2);

    expect(report.requestedTopN).toBe(2);
    expect(report.topRuns).toBe(2);
    expect(report.topMeanScore).toBe(350);
    expect(report.topMeanScoreDelta).toBe(100);
    expect(report.topMeanScoreRatio).toBeCloseTo(0.4);
    expect(report.rows.map((row) => row.label.displayName)).toEqual([
      "【世界への反逆者】コトハ",
      "【白銀の閃き】シラナ",
    ]);
    const [first] = report.rows;
    expect(first?.damage.mean).toBe(175);
    expect(first?.topMeanDamage).toBe(250);
    expect(first?.topMeanDamageRatio).toBeCloseTo(250 / 175 - 1);
    expect(first?.breaks.mean).toBe(1.75);
    expect(first?.breaks.maximum).toBe(3);
    expect(first?.topMeanBreakCount).toBe(2.5);
  });

  // 分布バーは全ユニット共通スケール。行ごとに伸縮すると、寄与の小さいユニットの
  // 箱が最大の列と同じ幅に見える。与ダメージとブレイク回数は桁が違うので、
  // スケールは別々に持つ。
  it("exposes one damage scale and one break scale shared by every row", () => {
    const report = buildUnitStatisticsReport(aggregate(), labels, 2);

    expect(report.damageScaleMax).toBe(300);
    expect(report.breakScaleMax).toBe(3);
  });

  // メモリー由来の継続ダメージ（R-MEM-04）と敵の枠自身のブレイク（R-CFS-01）は
  // ユニット列に載らない。合計と全体平均の差として脚注へ出せるようにする。
  it("splits the overall break mean into the unit columns and the unattributed residual", () => {
    const report = buildUnitStatisticsReport(
      aggregate({
        sample: {
          ...aggregate().sample,
          breakCounts: [2, 4, 3, 5],
        },
      }),
      labels,
      2,
    );

    expect(report.unitBreakMeanTotal).toBe(2.5);
    expect(report.unattributedBreakMean).toBe(1);
    expect(report.breakMean).toBe(3.5);
  });

  // 応答の列数が送信した編成の枠数と食い違っても表そのものは出す。列の存在は応答が
  // 決めるので、名前が付かない列は位置で示す。
  it("labels a response column that the submitted formation does not name", () => {
    const report = buildUnitStatisticsReport(aggregate(), labels.slice(0, 1), 2);

    expect(report.rows.map((row) => row.label.displayName)).toEqual([
      "【世界への反逆者】コトハ",
      "ユニット2",
    ]);
  });
});
