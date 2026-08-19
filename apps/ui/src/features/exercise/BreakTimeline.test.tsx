import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BreakTimeline } from "./BreakTimeline.js";

// UI-AC-021 / UI-CMP-012: ブレイク履歴を発生順に描画し、0回でも成立する。
describe("BreakTimeline", () => {
  it("renders one row per break in break-number order", () => {
    render(
      <BreakTimeline
        breaks={[
          {
            breakNumber: 1,
            turnNumber: 2,
            cumulativeScoreAtBreak: 1500,
            sourceLabel: "アライアルファ",
          },
          {
            breakNumber: 2,
            turnNumber: 4,
            cumulativeScoreAtBreak: 3600,
            sourceLabel: "メモリー効果",
          },
        ]}
      />,
    );

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("1");
    expect(rows[0]).toHaveTextContent("2");
    expect(rows[0]).toHaveTextContent("1,500");
    expect(rows[1]).toHaveTextContent("3,600");
  });

  // UI-CT-082 / UI-AC-021: 誰の攻撃でブレイクしたかを列として名指しする。
  it("names the break source unit in its own labelled column (UI-CT-082)", () => {
    render(
      <BreakTimeline
        breaks={[
          {
            breakNumber: 1,
            turnNumber: 2,
            cumulativeScoreAtBreak: 1500,
            sourceLabel: "アライアルファ",
          },
          {
            breakNumber: 2,
            turnNumber: 4,
            cumulativeScoreAtBreak: 3600,
            sourceLabel: "メモリー効果",
          },
        ]}
      />,
    );

    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "BREAK",
      "TURN",
      "累計スコア",
      "発生源",
    ]);

    const rows = table.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getAllByRole("cell")[3]).toHaveTextContent(
      "アライアルファ",
    );
    expect(within(rows[1] as HTMLElement).getAllByRole("cell")[3]).toHaveTextContent(
      "メモリー効果",
    );
  });

  it("states that no break happened instead of rendering an empty table", () => {
    render(<BreakTimeline breaks={[]} />);

    expect(screen.getByText("ブレイクは発生しませんでした。")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
