import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BreakTimeline } from "./BreakTimeline.js";

// UI-AC-021 / UI-CMP-012: ブレイク履歴を発生順に描画し、0回でも成立する。
describe("BreakTimeline", () => {
  it("renders one row per break in break-number order", () => {
    render(
      <BreakTimeline
        breaks={[
          { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 1500 },
          { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 3600 },
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

  it("states that no break happened instead of rendering an empty table", () => {
    render(<BreakTimeline breaks={[]} />);

    expect(screen.getByText("ブレイクは発生しませんでした。")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
