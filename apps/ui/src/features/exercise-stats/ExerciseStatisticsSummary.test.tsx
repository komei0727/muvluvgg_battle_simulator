import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExerciseStatisticsSummary } from "./ExerciseStatisticsSummary.js";
import { buildScoreStatisticsReport } from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";

function aggregate(
  runs: number,
  overrides: Partial<EvaluationAggregate> = {},
): EvaluationAggregate {
  const indices = Array.from({ length: runs }, (_value, index) => index);
  return {
    sentRuns: runs,
    completedRuns: runs,
    catalogRevision: "rev-1",
    chunkSize: 300,
    runs: indices.map((index) => ({
      chunkIndex: 0,
      chunkSeed: "seed#0",
      runIndexInChunk: index,
    })),
    sample: {
      scores: indices.map((index) => 1000 + index * 10),
      breakCounts: indices.map((index) => index % 4),
      completedTurns: indices.map(() => 5),
      completionReasons: indices.map((index) =>
        index % 10 === 0 ? "ALLY_DEFEATED" : "TURN_LIMIT_REACHED",
      ),
      allyUnitDamageTotals: indices.map((index) => [500 + index, 300]),
      allyUnitBreakCounts: indices.map(() => [1, 0]),
    },
    ...overrides,
  };
}

function renderSummary(
  evaluation: EvaluationAggregate,
  { seed = "seed-1", requestedRuns = evaluation.sentRuns } = {},
) {
  return render(
    <ExerciseStatisticsSummary
      report={buildScoreStatisticsReport(evaluation, { seed, requestedRuns })}
    />,
  );
}

// UI-CT-087: 統計実行の結果はスコア統計・日次ベスト指標・分布・完走内訳として出る。
describe("ExerciseStatisticsSummary", () => {
  it("shows the score statistics of the completed runs", () => {
    renderSummary(aggregate(100));

    expect(screen.getByText("完了 RUN").closest("div")).toHaveTextContent("100");
    expect(screen.getByText("平均").closest("div")).toHaveTextContent("1,495");
    expect(screen.getByText("中央値").closest("div")).toHaveTextContent("1,495");
    expect(screen.getByText("最小 / 最大").closest("div")).toHaveTextContent("1,000");
    expect(screen.getByText("最小 / 最大").closest("div")).toHaveTextContent("1,990");
  });

  // 日次ベスト指標が主役なので、平均と同じ扱いで並べず強調枠へ置く。
  it("shows the daily best metrics with the guaranteed lines", () => {
    renderSummary(aggregate(100));

    expect(screen.getByText(/期待日次ベスト/)).toBeInTheDocument();
    expect(screen.getByText("75% 保証ライン")).toBeInTheDocument();
    expect(screen.getByText("90% 保証ライン")).toBeInTheDocument();
    expect(screen.getByText("有効サンプル").closest("div")).toHaveTextContent("36");
  });

  // 有効サンプルが下限（10）未満の値は上位数試行に引きずられる。数値だけを出すと
  // 実行回数の不足に気づけない。
  it("warns when the effective sample size is below the reliable minimum", () => {
    renderSummary(aggregate(20));

    expect(screen.getByText(/実行回数を増やしてください/)).toBeInTheDocument();
  });

  it("does not warn once the effective sample size is reliable", () => {
    renderSummary(aggregate(100));

    expect(screen.queryByText(/実行回数を増やしてください/)).not.toBeInTheDocument();
  });

  // 中断・期限到達の部分結果を「要求どおり終わった」と読ませない。
  it("shows a partial result banner when fewer runs completed than requested", () => {
    renderSummary(aggregate(50), { requestedRuns: 200 });

    expect(screen.getByText(/200試行の要求に対し50試行/)).toBeInTheDocument();
  });

  it("shows no partial result banner for a complete run", () => {
    renderSummary(aggregate(100));

    expect(screen.queryByText(/の要求に対し/)).not.toBeInTheDocument();
  });

  it("shows the completion reason breakdown as pills", () => {
    renderSummary(aggregate(100));

    expect(screen.getByText(/TURN_LIMIT_REACHED/)).toHaveTextContent("90.0%");
    expect(screen.getByText(/ALLY_DEFEATED/)).toHaveTextContent("10.0%");
  });

  it("shows the break count distribution with its mean and a table", () => {
    renderSummary(aggregate(100));

    expect(screen.getByText(/ブレイク回数分布/)).toHaveTextContent("平均 1.50");
    const table = screen.getByRole("table", { name: /ブレイク回数/ });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
  });

  // 再現に要る条件（seed・Catalog revision）は結果と一緒でなければ意味がない。
  it("shows the seed and catalog revision the run used", () => {
    renderSummary(aggregate(100), { seed: "my-seed" });

    expect(screen.getByText("SEED").closest("div")).toHaveTextContent("my-seed");
    expect(screen.getByText("CATALOG REVISION").closest("div")).toHaveTextContent("rev-1");
  });

  // 1試行あたりの総ブレイクが20〜30に達すると、回数ごとの棒が15本以上並ぶ。目盛りを
  // 全部の棒へ付けると文字が重なって読めなくなるため、間引いて両端は必ず残す。
  it("thins the tick labels when many distinct break counts appear", () => {
    const wide = aggregate(100, {
      sample: {
        ...aggregate(100).sample,
        breakCounts: Array.from({ length: 100 }, (_value, index) => 18 + (index % 15)),
      },
    });
    const { container } = renderSummary(wide);

    const chart = container.querySelector("svg[aria-label*='ブレイク回数']");
    expect(chart?.querySelectorAll("rect")).toHaveLength(15);
    const ticks = [...(chart?.querySelectorAll("text") ?? [])].map((node) => node.textContent);
    expect(ticks).toContain("18");
    expect(ticks).toContain("32");
    expect(ticks.length).toBeLessThan(15);
  });

  // 間引きは必要なときだけにする。棒が少ないうちは全部の回数に目盛りを付ける。
  it("labels every bar while the distinct break counts stay few", () => {
    const { container } = renderSummary(aggregate(100));

    const chart = container.querySelector("svg[aria-label*='ブレイク回数']");
    const ticks = [...(chart?.querySelectorAll("text") ?? [])].map((node) => node.textContent);
    expect(ticks).toEqual(expect.arrayContaining(["0", "1", "2", "3"]));
  });

  it("draws without any inline style attribute", () => {
    const { container } = renderSummary(aggregate(100));

    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
});
