import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreDistributionChart } from "./ScoreDistributionChart.js";
import { buildScoreDistribution } from "./statistics-report.js";

const bins = buildScoreDistribution([100, 200, 200, 300, 400, 500, 600, 700]);

function renderChart() {
  return render(<ScoreDistributionChart bins={bins} median={350} expectedBest={620} bestOf={5} />);
}

// UI-CT-088: チャートは`role="img"`と説明文を持ち、同じ数値を表としても出す
// （図だけが持つ情報を作らない）。
describe("ScoreDistributionChart", () => {
  it("describes the chart for assistive technology", () => {
    renderChart();

    const chart = screen.getByRole("img");
    expect(chart).toHaveAccessibleName(/スコア分布/);
    expect(chart).toHaveAccessibleName(/中央値350/);
    expect(chart).toHaveAccessibleName(/期待日次ベスト620/);
  });

  it("offers the same bins as a table", () => {
    renderChart();

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // ヘッダー行 + ビンの数。
    expect(rows).toHaveLength(bins.length + 1);
    expect(rows[1]).toHaveTextContent("100 – 250");
  });

  // CSPが`style-src 'self'`のため、inline styleを持つ図はブラウザで描画されない。
  it("draws without any inline style attribute", () => {
    const { container } = renderChart();

    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("draws one bar per bin and one daily best polyline", () => {
    const { container } = renderChart();

    expect(container.querySelectorAll("rect")).toHaveLength(bins.length);
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
  });

  // 全試行が同じスコアだと幅0のビンしか作れない。横軸が潰れても図と表は出す。
  it("renders a single-value sample as one bin", () => {
    render(
      <ScoreDistributionChart
        bins={buildScoreDistribution([7, 7, 7])}
        median={7}
        expectedBest={7}
        bestOf={5}
      />,
    );

    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });
});
