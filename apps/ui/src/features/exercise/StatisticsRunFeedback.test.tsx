import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatisticsRunFeedback } from "./StatisticsRunFeedback.js";
import type { EvaluationAggregate } from "./evaluation-chunk-plan.js";
import type { ExerciseStatisticsRunState } from "./use-exercise-statistics-run.js";

function aggregate(completedRuns: number): EvaluationAggregate {
  const indices = Array.from({ length: completedRuns }, (_value, index) => index);
  return {
    requestedRuns: completedRuns,
    completedRuns,
    catalogRevision: "rev-1",
    sample: {
      scores: indices.map(() => 1000),
      breakCounts: indices.map(() => 1),
      completedTurns: indices.map(() => 5),
      completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
      allyUnitDamageTotals: indices.map(() => [500]),
      allyUnitBreakCounts: indices.map(() => [1]),
    },
  };
}

function renderFeedback(state: ExerciseStatisticsRunState, onCancel = vi.fn()) {
  render(<StatisticsRunFeedback state={state} onCancel={onCancel} />);
  return onCancel;
}

// UI-CT-085: 統計実行の進捗・中断・結果件数・失敗理由を出す。
describe("StatisticsRunFeedback", () => {
  it("renders nothing before a run has started", () => {
    const { container } = render(
      <StatisticsRunFeedback state={{ status: "idle" }} onCancel={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the completed runs, the current chunk and a progress bar while running", () => {
    renderFeedback({
      status: "running",
      runId: "run-1",
      seed: "abc",
      progress: { requestedRuns: 1000, completedRuns: 300, completedChunks: 1, chunkCount: 4 },
    });

    const progress = screen.getByRole("progressbar", { name: "統計実行の進捗" });
    expect(progress).toHaveAttribute("value", "300");
    expect(progress).toHaveAttribute("max", "1000");
    expect(screen.getByText(/300\s*\/\s*1,000/)).toBeInTheDocument();
    expect(screen.getByText(/2\s*\/\s*4/)).toBeInTheDocument();
  });

  it("reports progress inside a polite live region", () => {
    renderFeedback({
      status: "running",
      runId: "run-1",
      seed: "abc",
      progress: { requestedRuns: 10, completedRuns: 0, completedChunks: 0, chunkCount: 1 },
    });

    expect(screen.getByText(/0\s*\/\s*10/).closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("cancels the run with a button that says the completed results are kept", async () => {
    const onCancel = renderFeedback({
      status: "running",
      runId: "run-1",
      seed: "abc",
      progress: { requestedRuns: 10, completedRuns: 5, completedChunks: 1, chunkCount: 2 },
    });

    await userEvent.click(screen.getByRole("button", { name: "中断して結果を見る" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows the completed run count and the seed of a finished run", () => {
    renderFeedback({
      status: "succeeded",
      runId: "run-1",
      seed: "abc123",
      progress: { requestedRuns: 1000, completedRuns: 1000, completedChunks: 4, chunkCount: 4 },
      aggregate: aggregate(1000),
    });

    expect(screen.getByText(/1,000試行を集計しました/)).toBeInTheDocument();
    expect(screen.getByText(/seed: abc123/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "中断して結果を見る" })).not.toBeInTheDocument();
  });

  // 部分結果は「要求どおり終わった」と読ませない。実際に集計へ入った試行数を示す。
  it("distinguishes a partial result from a complete one", () => {
    renderFeedback({
      status: "succeeded",
      runId: "run-1",
      seed: "abc",
      progress: { requestedRuns: 1000, completedRuns: 720, completedChunks: 4, chunkCount: 4 },
      aggregate: aggregate(720),
    });

    expect(screen.getByText(/720試行を集計しました/)).toBeInTheDocument();
    expect(screen.getByText(/要求 1,000試行/)).toBeInTheDocument();
  });

  it("presents a cancelled run as a result that stands, not as a failure", () => {
    renderFeedback({
      status: "cancelled",
      runId: "run-1",
      seed: "abc",
      progress: { requestedRuns: 1000, completedRuns: 300, completedChunks: 1, chunkCount: 4 },
      aggregate: aggregate(300),
    });

    expect(screen.getByText(/中断/)).toBeInTheDocument();
    expect(screen.getByText(/300試行を集計しました/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failure as an alert explaining the cause", () => {
    renderFeedback({
      status: "failed",
      runId: "run-1",
      seed: "abc",
      progress: { requestedRuns: 1000, completedRuns: 0, completedChunks: 0, chunkCount: 4 },
      error: { kind: "ENDPOINT_DISABLED" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("この環境では統計実行を利用できません");
  });
});
