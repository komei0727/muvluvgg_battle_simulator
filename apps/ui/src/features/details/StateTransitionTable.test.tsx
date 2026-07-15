import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StateTransitionTable } from "./StateTransitionTable.js";
import type { StateTransitionResponse } from "../simulation/api-contract.js";

describe("StateTransitionTable", () => {
  it("renders rows in stateTransitions array order with version/causedBy/target columns (§8.2)", () => {
    const transitions: readonly StateTransitionResponse[] = [
      {
        causedBySequence: 1,
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        delta: { battle: { battleStatus: { before: "READY", after: "RUNNING" } } },
      },
      {
        causedBySequence: 14,
        stateVersionBefore: 8,
        stateVersionAfter: 9,
        delta: { units: { "enemy:1": { hp: { before: 26364, after: 18102 } } } },
      },
    ];

    render(<StateTransitionTable transitions={transitions} />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("0 → 1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("#1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("battle")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("8 → 9")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("#14")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("enemy:1")).toBeInTheDocument();
  });

  it("shows a readable tree line for each changed value by default", () => {
    const transitions: readonly StateTransitionResponse[] = [
      {
        causedBySequence: 1,
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        delta: { battle: { battleStatus: { before: "READY", after: "RUNNING" } } },
      },
    ];

    render(<StateTransitionTable transitions={transitions} />);

    expect(screen.getByText(/battle.battleStatus/)).toBeInTheDocument();
    expect(screen.getByText(/READY.*RUNNING/)).toBeInTheDocument();
  });

  it("toggles a row's delta between tree view and raw JSON view", async () => {
    const user = userEvent.setup();
    const transitions: readonly StateTransitionResponse[] = [
      {
        causedBySequence: 1,
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        delta: { battle: { battleStatus: { before: "READY", after: "RUNNING" } } },
      },
    ];

    render(<StateTransitionTable transitions={transitions} />);

    expect(screen.queryByText(/"battleStatus"/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "JSON表示" }));

    expect(screen.getByText(/"battleStatus"/)).toBeInTheDocument();
  });

  it("does not crash on a transition with an empty or unrecognized delta shape", () => {
    const transitions: readonly StateTransitionResponse[] = [
      { causedBySequence: 1, stateVersionBefore: 0, stateVersionAfter: 1, delta: {} },
    ];

    expect(() => render(<StateTransitionTable transitions={transitions} />)).not.toThrow();
  });

  it("highlights the row matching highlightedIndex", () => {
    const transitions: readonly StateTransitionResponse[] = [
      { causedBySequence: 1, stateVersionBefore: 0, stateVersionAfter: 1, delta: {} },
      { causedBySequence: 2, stateVersionBefore: 1, stateVersionAfter: 2, delta: {} },
    ];

    render(<StateTransitionTable transitions={transitions} highlightedIndex={1} />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[1]).toHaveAttribute("data-highlighted", "true");
    expect(rows[0]).not.toHaveAttribute("data-highlighted", "true");
  });
});
