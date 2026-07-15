import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExecutionParameterForm } from "./ExecutionParameterForm.js";

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
        logLevel="DETAILED"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={onLogLevelChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText("ログレベル"), "DIAGNOSTIC");

    expect(onLogLevelChange).toHaveBeenCalledWith("DIAGNOSTIC");
  });

  it("shows a size warning description when DIAGNOSTIC is selected", () => {
    render(
      <ExecutionParameterForm
        turnLimit={10}
        logLevel="DIAGNOSTIC"
        endpoint="POST /api/v1/battle-simulations"
        disabled={false}
        onTurnLimitChange={vi.fn()}
        onLogLevelChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/レスポンス/)).toBeInTheDocument();
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
});
