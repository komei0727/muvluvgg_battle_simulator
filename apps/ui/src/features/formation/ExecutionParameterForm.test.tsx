import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExecutionParameterForm } from "./ExecutionParameterForm.js";
import type { ExerciseExecutionFormProps } from "./ExecutionParameterForm.js";
import type { ExerciseExecutionInput } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";

// The component is a fully controlled input; a fixed prop value would snap
// back on every keystroke and produce meaningless intermediate digits, so
// typing scenarios render through a small stateful harness instead.
function TurnLimitHarness({
  onTurnLimitChange,
}: {
  readonly onTurnLimitChange: (value: number | "") => void;
}) {
  const [turnLimit, setTurnLimit] = useState<number | "">(10);
  return (
    <ExecutionParameterForm
      turnLimit={turnLimit}
      logLevel="DETAILED"
      endpoint="POST /api/v1/battle-simulations"
      disabled={false}
      onTurnLimitChange={(value) => {
        setTurnLimit(value);
        onTurnLimitChange(value);
      }}
      onLogLevelChange={vi.fn()}
    />
  );
}

describe("ExecutionParameterForm", () => {
  it("shows the current turnLimit and logLevel", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("ターン上限")).toHaveValue(10);
    expect(screen.getByLabelText("ログレベル")).toHaveValue("DETAILED");
    expect(screen.getByText("POST /api/v1/battle-simulations")).toBeInTheDocument();
  });

  it("reports a numeric change on the turn limit input", async () => {
    const user = userEvent.setup();
    const onTurnLimitChange = vi.fn();
    render(<TurnLimitHarness onTurnLimitChange={onTurnLimitChange} />);

    await user.clear(screen.getByLabelText("ターン上限"));
    await user.type(screen.getByLabelText("ターン上限"), "42");

    expect(onTurnLimitChange).toHaveBeenLastCalledWith(42);
  });

  it("reports the empty-input sentinel when the turn limit is cleared", async () => {
    const user = userEvent.setup();
    const onTurnLimitChange = vi.fn();
    render(<TurnLimitHarness onTurnLimitChange={onTurnLimitChange} />);

    await user.clear(screen.getByLabelText("ターン上限"));

    expect(onTurnLimitChange).toHaveBeenLastCalledWith("");
  });

  it("reports a logLevel change", async () => {
    const user = userEvent.setup();
    const onLogLevelChange = vi.fn();
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="SUMMARY"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={onLogLevelChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText("ログレベル"), "DETAILED");

    expect(onLogLevelChange).toHaveBeenCalledWith("DETAILED");
  });

  // UI-CT-061: ログ方針刷新2/3（Issue #464）。用途は「大量実行して勝敗と
  // ユニット別集計だけを見る」と「効果発動を追う」の2つしかない。
  it("UI-CT-061: offers exactly SUMMARY and DETAILED, so the retired DIAGNOSTIC value cannot be selected", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="SUMMARY"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    const options = screen.getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(options).toEqual(["SUMMARY", "DETAILED"]);
  });

  it("shows a size warning description when DETAILED is selected, and none for SUMMARY", () => {
    const { rerender } = render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/レスポンス/)).toBeInTheDocument();

    rerender(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="SUMMARY"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/レスポンス/)).not.toBeInTheDocument();
  });

  it("disables both inputs when disabled is true", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={true}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("ターン上限")).toBeDisabled();
    expect(screen.getByLabelText("ログレベル")).toBeDisabled();
  });

  it("UI-API-004/UI-CT-016: marks the turn limit input invalid and shows the message for a /turnLimit violation", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        violations={[
          {
            path: "/turnLimit",
            code: "SERVER_VIOLATION",
            message: "上限は99以下です。",
            severity: "error",
          },
        ]}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("ターン上限")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("上限は99以下です。")).toBeInTheDocument();
  });

  it("marks the log level select invalid and shows the message for an /options/logLevel violation", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        violations={[
          {
            path: "/options/logLevel",
            code: "SERVER_VIOLATION",
            message: "対応していないログレベルです。",
            severity: "error",
          },
        ]}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("ログレベル")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("対応していないログレベルです。")).toBeInTheDocument();
  });

  it("does not mark inputs invalid when there are no matching violations", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        violations={[]}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("ターン上限")).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByLabelText("ログレベル")).toHaveAttribute("aria-invalid", "false");
  });
});

// UI-CT-083 / UI-CT-084: Issue #539。演習ではログレベルの選択を実行モードの
// 切替が置き換える（単一実行は常に`DETAILED`で送るため選ばせるものが無い）。
describe("ExecutionParameterForm — 戦術演習の実行モード (UI-CT-083/084)", () => {
  function exerciseExecutionProps(
    value: ExerciseExecutionInput,
    overrides: Partial<ExerciseExecutionFormProps> = {},
  ): ExerciseExecutionFormProps {
    return {
      value,
      onModeChange: vi.fn(),
      onRunCountChange: vi.fn(),
      onSeedChange: vi.fn(),
      ...overrides,
    };
  }

  function renderExercise(
    value: ExerciseExecutionInput,
    overrides: Partial<ExerciseExecutionFormProps> = {},
    violations: readonly UiViolation[] = [],
  ) {
    return render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="SUMMARY"
        endpoint="POST /api/v1/tactical-exercises"
        disabled={false}
        fixedTurnLimit={5}
        violations={violations}
        exerciseExecution={exerciseExecutionProps(value, overrides)}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );
  }

  it("UI-CT-104: replaces the log level select with the execution mode switch", () => {
    renderExercise({ mode: "SINGLE", runCount: 100, seed: "" });

    expect(screen.queryByLabelText("ログレベル")).not.toBeInTheDocument();
    expect(screen.getByLabelText("実行モード")).toHaveValue("SINGLE");
    expect(screen.queryByLabelText("実行回数")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("シード")).not.toBeInTheDocument();
  });

  it("UI-CT-105: shows the run count and seed only in the statistics mode", () => {
    renderExercise({ mode: "STATISTICS", runCount: 100, seed: "abc123" });

    expect(screen.getByLabelText("実行回数")).toHaveValue(100);
    expect(screen.getByLabelText("シード")).toHaveValue("abc123");
  });

  it("UI-CT-106: reports the selected execution mode", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    renderExercise({ mode: "SINGLE", runCount: 100, seed: "" }, { onModeChange });

    await user.selectOptions(screen.getByLabelText("実行モード"), "STATISTICS");

    expect(onModeChange).toHaveBeenCalledWith("STATISTICS");
  });

  // 入力は完全な制御コンポーネントなので、固定propで打鍵すると値が毎回巻き戻る。
  // 打鍵する検証は`TurnLimitHarness`と同じくstateを持たせて回す。
  function StatisticsHarness({
    onRunCountChange,
    onSeedChange,
  }: {
    readonly onRunCountChange: (value: number | "") => void;
    readonly onSeedChange: (value: string) => void;
  }) {
    const [execution, setExecution] = useState<ExerciseExecutionInput>({
      mode: "STATISTICS",
      runCount: 100,
      seed: "",
    });
    return (
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="SUMMARY"
        endpoint="POST /api/v1/tactical-exercises"
        disabled={false}
        fixedTurnLimit={5}
        exerciseExecution={{
          value: execution,
          onModeChange: vi.fn(),
          onRunCountChange: (value) => {
            setExecution((current) => ({ ...current, runCount: value }));
            onRunCountChange(value);
          },
          onSeedChange: (value) => {
            setExecution((current) => ({ ...current, seed: value }));
            onSeedChange(value);
          },
        }}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />
    );
  }

  it("UI-CT-107: reports the numeric run count and the empty-input sentinel", async () => {
    const user = userEvent.setup();
    const onRunCountChange = vi.fn();
    render(<StatisticsHarness onRunCountChange={onRunCountChange} onSeedChange={vi.fn()} />);

    await user.clear(screen.getByLabelText("実行回数"));
    expect(onRunCountChange).toHaveBeenLastCalledWith("");

    await user.type(screen.getByLabelText("実行回数"), "500");
    expect(onRunCountChange).toHaveBeenLastCalledWith(500);
  });

  it("UI-CT-108: reports the seed as free text", async () => {
    const user = userEvent.setup();
    const onSeedChange = vi.fn();
    render(<StatisticsHarness onRunCountChange={vi.fn()} onSeedChange={onSeedChange} />);

    await user.type(screen.getByLabelText("シード"), "abc123");

    expect(onSeedChange).toHaveBeenLastCalledWith("abc123");
  });

  it("UI-CT-111: marks the run count invalid and shows the message for a /runsPerCandidate violation", () => {
    renderExercise({ mode: "STATISTICS", runCount: 5000, seed: "" }, {}, [
      {
        path: "/runsPerCandidate",
        code: "RUN_COUNT_OUT_OF_RANGE",
        message: "実行回数は1～2,000の整数で入力してください。",
        severity: "error",
      },
    ]);

    expect(screen.getByLabelText("実行回数")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("実行回数は1～2,000の整数で入力してください。")).toBeInTheDocument();
  });

  it("disables the execution mode inputs when disabled is true", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="SUMMARY"
        endpoint="POST /api/v1/tactical-exercises"
        disabled={true}
        fixedTurnLimit={5}
        exerciseExecution={exerciseExecutionProps({ mode: "STATISTICS", runCount: 100, seed: "" })}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("実行モード")).toBeDisabled();
    expect(screen.getByLabelText("実行回数")).toBeDisabled();
    expect(screen.getByLabelText("シード")).toBeDisabled();
  });
});
