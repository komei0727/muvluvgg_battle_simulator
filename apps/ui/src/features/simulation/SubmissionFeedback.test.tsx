import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubmissionFeedback } from "./SubmissionFeedback.js";
import type { ExecutionState, SuccessfulExecutionSnapshot } from "./execution-reducer.js";
import type { BattleSimulationRequest } from "../formation/request-mapper.js";
import type { BattleSimulationResponse } from "./api-contract.js";

function request(): BattleSimulationRequest {
  return {
    allyFormation: { units: [], memoryDefinitionIds: [] },
    enemyFormation: { units: [], memoryDefinitionIds: [] },
    turnLimit: 10,
    options: { logLevel: "DETAILED" },
  };
}

function response(): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-01J",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: [] },
    finalState: { units: [] },
    events: [],
    stateTransitions: [],
  };
}

function successSnapshot(): SuccessfulExecutionSnapshot {
  return {
    executionId: "exec-1",
    request: request(),
    response: response(),
    requestId: "srv-req-1",
    completedAt: 1000,
  };
}

describe("SubmissionFeedback — idle", () => {
  it("renders nothing when idle", () => {
    const state: ExecutionState = { status: "idle" };
    const { container } = render(
      <SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("SubmissionFeedback — submitting (UI-UC-002)", () => {
  it("shows an in-progress message inside an aria-live polite region", () => {
    const state: ExecutionState = {
      status: "submitting",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    const region = screen.getByText(/実行中/).closest("[aria-live]");
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});

describe("SubmissionFeedback — succeeded (UI-UC-003)", () => {
  it("shows the battle id, catalog revision, and outcome", () => {
    const state: ExecutionState = {
      status: "succeeded",
      executionId: "exec-1",
      request: request(),
      response: response(),
      requestId: "srv-req-1",
      completedAt: 1000,
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.getByText(/battle-01J/)).toBeInTheDocument();
    expect(screen.getByText(/rev-1/)).toBeInTheDocument();
    expect(screen.getByText(/srv-req-1/)).toBeInTheDocument();
  });

  it("shows a dirty indicator when the draft has changed since the shown result (UI-CMP-003)", () => {
    const state: ExecutionState = {
      status: "succeeded",
      executionId: "exec-1",
      request: request(),
      response: response(),
      completedAt: 1000,
    };
    render(<SubmissionFeedback state={state} isDirty={true} onReloadCatalog={vi.fn()} />);

    expect(screen.getByText(/変更前の条件/)).toBeInTheDocument();
  });

  it("does not show a dirty indicator when not dirty", () => {
    const state: ExecutionState = {
      status: "succeeded",
      executionId: "exec-1",
      request: request(),
      response: response(),
      completedAt: 1000,
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.queryByText(/変更前の条件/)).not.toBeInTheDocument();
  });
});

describe("SubmissionFeedback — failed (UI-UC-002, UI-AC-012)", () => {
  it("shows the error message, code, and requestId for a generic server error", () => {
    const state: ExecutionState = {
      status: "failed",
      executionId: "exec-1",
      error: {
        kind: "SERVER",
        message: "Unexpected failure.",
        code: "INTERNAL_INVARIANT_VIOLATION",
        diagnosticId: "diag-1",
      },
      requestId: "srv-req-err",
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.getByText(/Unexpected failure\./)).toBeInTheDocument();
    expect(screen.getByText(/INTERNAL_INVARIANT_VIOLATION/)).toBeInTheDocument();
    expect(screen.getByText(/diag-1/)).toBeInTheDocument();
    expect(screen.getByText(/srv-req-err/)).toBeInTheDocument();
  });

  it("retains and shows the previous success snapshot alongside the error", () => {
    const state: ExecutionState = {
      status: "failed",
      executionId: "exec-2",
      error: { kind: "CAPACITY", message: "Server busy." },
      previousSuccess: successSnapshot(),
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.getByText(/battle-01J/)).toBeInTheDocument();
    expect(screen.getByText(/Server busy\./)).toBeInTheDocument();
  });

  it("prompts a catalog reload for a DEFINITION_NOT_FOUND validation error (UI-API-004)", async () => {
    const user = userEvent.setup();
    const onReloadCatalog = vi.fn();
    const state: ExecutionState = {
      status: "failed",
      executionId: "exec-1",
      error: {
        kind: "VALIDATION",
        code: "DEFINITION_NOT_FOUND",
        message: "Definition not found.",
      },
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={onReloadCatalog} />);

    const reloadButton = screen.getByRole("button", { name: /Catalogを再読込/ });
    await user.click(reloadButton);

    expect(onReloadCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not prompt a catalog reload for an unrelated validation error", () => {
    const state: ExecutionState = {
      status: "failed",
      executionId: "exec-1",
      error: { kind: "VALIDATION", code: "INVALID_COMMAND", message: "Invalid." },
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Catalogを再読込/ })).not.toBeInTheDocument();
  });
});

describe("SubmissionFeedback — cancelled (UI-UC-002)", () => {
  it("shows a cancellation message", () => {
    const state: ExecutionState = { status: "cancelled", executionId: "exec-1" };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.getByText(/キャンセル/)).toBeInTheDocument();
  });

  it("retains the previous success snapshot", () => {
    const state: ExecutionState = {
      status: "cancelled",
      executionId: "exec-2",
      previousSuccess: successSnapshot(),
    };
    render(<SubmissionFeedback state={state} isDirty={false} onReloadCatalog={vi.fn()} />);

    expect(screen.getByText(/battle-01J/)).toBeInTheDocument();
  });
});
