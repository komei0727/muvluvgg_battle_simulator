import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatisticsRunFeedback } from "./StatisticsRunFeedback.js";
import type { StatisticsRunFeedbackProps } from "./StatisticsRunFeedback.js";
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

const SUBMISSION = {
  allyUnitSlotKeys: ["ally:FRONT:0"],
  enemyUnitSlotKeys: ["enemy:FRONT:0"],
  allyMemorySlotKeys: [],
  enemyMemorySlotKeys: [],
  allyGearSlotIndices: [],
  enemyGearSlotIndices: [],
  formationSignature: "signature-1",
};

function renderFeedback(
  state: ExerciseStatisticsRunState,
  props: Partial<Omit<StatisticsRunFeedbackProps, "state">> = {},
) {
  const onCancel = props.onCancel ?? vi.fn();
  render(<StatisticsRunFeedback {...props} state={state} onCancel={onCancel} />);
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
      submission: SUBMISSION,
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
      submission: SUBMISSION,
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
      submission: SUBMISSION,
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
      submission: SUBMISSION,
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
      submission: SUBMISSION,
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
      submission: SUBMISSION,
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
      submission: SUBMISSION,
      progress: { requestedRuns: 1000, completedRuns: 0, completedChunks: 0, chunkCount: 4 },
      error: { kind: "ENDPOINT_DISABLED" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("この環境では統計実行を利用できません");
  });

  // 単一実行と同じく、種別ごとの案内を先に出し、サーバーの生message・violationsを
  // その下へそのままtextとして添える（03_API・データ連携設計.md §13）。
  it("shows the kind guidance above the raw server message and violations", () => {
    renderFeedback({
      status: "failed",
      runId: "run-1",
      seed: "abc",
      submission: SUBMISSION,
      progress: { requestedRuns: 1000, completedRuns: 0, completedChunks: 0, chunkCount: 4 },
      error: {
        kind: "API",
        error: {
          kind: "VALIDATION",
          status: 422,
          code: "INVALID_COMMAND",
          message: "invalid",
          violations: [{ path: "/runsPerCandidate", message: "300 runs exceed the limit" }],
        },
      },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("入力内容を確認してください。");
    expect(alert).toHaveTextContent("invalid");
    expect(alert).toHaveTextContent("/runsPerCandidate");
    expect(alert).toHaveTextContent("300 runs exceed the limit");
  });

  // 実行後は編成を編集できる。結果はそのまま残るため、現在の編成の結果に見えてしまう。
  it("marks a finished result as produced by a formation that has since changed", () => {
    renderFeedback(
      {
        status: "succeeded",
        runId: "run-1",
        seed: "abc",
        submission: SUBMISSION,
        progress: { requestedRuns: 100, completedRuns: 100, completedChunks: 1, chunkCount: 1 },
        aggregate: aggregate(100),
      },
      { isDirty: true },
    );

    expect(screen.getByText(/変更前の条件/)).toBeInTheDocument();
  });

  // Catalogが切り替わった後の結果は、いま表示している定義と対応しない。
  it("replaces the result summary with a reload prompt when the Catalog revision no longer matches", () => {
    renderFeedback(
      {
        status: "succeeded",
        runId: "run-1",
        seed: "abc",
        submission: SUBMISSION,
        progress: { requestedRuns: 100, completedRuns: 100, completedChunks: 1, chunkCount: 1 },
        aggregate: aggregate(100),
      },
      { catalogRevisionMismatch: true },
    );

    expect(screen.getByText(/Catalogが更新された/)).toBeInTheDocument();
    expect(screen.queryByText(/100試行を集計しました/)).not.toBeInTheDocument();
  });
});
