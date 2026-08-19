import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnitStatisticsSection } from "./UnitStatisticsSection.js";
import { buildScoreStatisticsReport, resolveAllyUnitLabels } from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";

// 上位runほど1体目の与ダメージとブレイクが伸びる標本。上位N切り替えで数値が動くこと
// を見るために、スコアと1体目のダメージを連動させる。
function aggregate(runs = 40): EvaluationAggregate {
  const indices = Array.from({ length: runs }, (_value, index) => index);
  return {
    requestedRuns: runs,
    completedRuns: runs,
    catalogRevision: "rev-1",
    chunkSize: 300,
    runs: indices.map((index) => ({
      chunkIndex: 0,
      chunkSeed: "seed#0",
      runIndexInChunk: index,
    })),
    sample: {
      scores: indices.map((index) => 1000 + index * 100),
      // 1体目は20回台のブレイクを取り、2体目は0〜2回に留まる。1試行あたりの総ブレイクは
      // 20〜30に達するので、少数のバケットへ畳むとこの差が消える。
      breakCounts: indices.map((index) => 22 + (index % 5)),
      completedTurns: indices.map(() => 5),
      completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
      allyUnitDamageTotals: indices.map((index) => [100 + index * 10, 200]),
      allyUnitBreakCounts: indices.map((index) => [18 + (index % 5), index % 2]),
    },
  };
}

const labels = resolveAllyUnitLabels(["UNIT_KOTOHA", "UNIT_SHIRANA"]);

function renderSection(evaluation = aggregate()) {
  return render(
    <UnitStatisticsSection
      aggregate={evaluation}
      labels={labels}
      score={buildScoreStatisticsReport(evaluation, "seed-1")}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

function damageTable() {
  return screen.getByRole("table", { name: /与ダメージ/ });
}

function breakTable() {
  return screen.getByRole("table", { name: /ブレイク回数/ });
}

// UI-CT-089: キャラ別統計は全run統計と上位N部分集計を並べ、Nの切り替えは再計算
// だけで済む（再実行しない）。
describe("UnitStatisticsSection", () => {
  it("lists one row per formation column in both tables", () => {
    renderSection();

    expect(within(damageTable()).getAllByRole("row")).toHaveLength(labels.length + 1);
    expect(within(breakTable()).getAllByRole("row")).toHaveLength(labels.length + 1);
    expect(within(damageTable()).getByRole("rowheader", { name: "UNIT_KOTOHA" })).toBeVisible();
  });

  it("shows the全run mean with its contribution share", () => {
    renderSection();

    const row = within(damageTable()).getByRole("row", { name: /UNIT_KOTOHA/ });
    // 1体目の平均は295、2体目は200。寄与率は295/495。
    expect(row).toHaveTextContent("295");
    expect(row).toHaveTextContent("寄与 59.6%");
  });

  it("defaults the best score comparison to the top 10 runs", () => {
    renderSection();

    expect(screen.getByRole("radio", { name: "上位 10 run" })).toBeChecked();
    expect(screen.getByText(/スコア上位10runの平均スコア/)).toHaveTextContent("4,450");
  });

  // Nの切り替えは手元の生値の再集計だけで済む。再実行すると同じseedで同じ試行を
  // やり直すことになり、待ち時間だけが増える。
  it("recomputes the top-N columns without asking for another run", async () => {
    const user = userEvent.setup();
    renderSection();

    const before = within(damageTable()).getByRole("row", { name: /UNIT_KOTOHA/ }).textContent;
    await user.click(screen.getByRole("radio", { name: "上位 25 run" }));

    expect(screen.getByRole("radio", { name: "上位 25 run" })).toBeChecked();
    expect(within(damageTable()).getByRole("row", { name: /UNIT_KOTOHA/ }).textContent).not.toBe(
      before,
    );
    expect(screen.getByText(/スコア上位25runの平均スコア/)).toBeInTheDocument();
  });

  // 試行数がNに満たないときは、要求Nのまま「実際は何run」を示す。上位50runと
  // 書いたまま全40runの平均を出すと、全体平均との差が0になった理由が読めない。
  it("shows how many runs the requested top-N actually covered", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("radio", { name: "上位 50 run" }));

    expect(screen.getByText(/スコア上位50runの平均スコア/)).toHaveTextContent("全40run");
  });

  // メモリー由来の継続ダメージ（R-MEM-04）と敵の枠自身のブレイク（R-CFS-01）は
  // ユニット列に載らない。合計が全体平均と合わない理由を脚注で示す。
  it("footnotes the break mean that no ally column accounts for", () => {
    renderSection();

    // ユニット合計 20.00 + 0.50、全体平均 24.00 → 残差 3.50。
    const footnote = screen.getByText(/ユニット平均の合計/);
    expect(footnote).toHaveTextContent("20.50");
    expect(footnote).toHaveTextContent("3.50");
    expect(footnote).toHaveTextContent("24.00");
  });

  // ブレイク回数は与ダメージと同じ分位点の分布バーで出す。1試行あたり20〜30回に達し、
  // ユニットによって1〜2回と20回以上に分かれるため、0/1/2/3+のバケットでは差が消える。
  it("shows the break spread as a quantile distribution, not a fixed set of buckets", () => {
    renderSection();

    const bar = within(breakTable()).getByRole("img", { name: /UNIT_KOTOHAのブレイク回数分布/ });
    expect(bar).toHaveAccessibleName(/最小18/);
    expect(bar).toHaveAccessibleName(/最大22/);
    expect(screen.queryByText("3回以上")).not.toBeInTheDocument();
  });

  // 共通スケールは20回以上取る枠に合わせて伸びるため、数回しか取らない枠の箱は潰れる。
  // 「この枠が1回も関与しなかった試行の割合」は数値として別に出す。
  it("shows how often each unit caused no break at all", () => {
    renderSection();

    const row = within(breakTable()).getByRole("row", { name: /UNIT_SHIRANA/ });
    // 2体目は index % 2 === 0 の試行、つまり40runの半分で0回。
    expect(row).toHaveTextContent("0回 50.0%");
  });

  it("draws the distribution bars without any inline style attribute", () => {
    const { container } = renderSection();

    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });
});

// UI-CT-090: 全run生データCSVと統計サマリJSONを持ち出せる。
describe("UnitStatisticsSection — export", () => {
  it("downloads the raw runs as a csv with one row per completed run", async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:generated";
      }),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderSection();

    await user.click(screen.getByRole("button", { name: /CSVでダウンロード/ }));

    const csv = await blobs[0]?.text();
    expect(csv?.split("\n")[0]).toContain("unit_1_damage");
    expect(csv?.trimEnd().split("\n")).toHaveLength(41);
  });

  it("copies the statistics summary as json", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSection();

    await user.click(screen.getByRole("button", { name: /JSONでコピー/ }));

    expect(screen.getByText("コピーしました")).toBeVisible();
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] ?? "{}") as Record<string, unknown>;
    expect(copied["seed"]).toBe("seed-1");
    expect(copied["units"]).toHaveLength(2);
  });
});
