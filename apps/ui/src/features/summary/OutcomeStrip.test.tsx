import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutcomeStrip } from "./OutcomeStrip.js";

describe("OutcomeStrip", () => {
  it("shows the outcome, completion reason, completed turn, battle ID, and catalog revision (UI-AC-007)", () => {
    render(
      <OutcomeStrip
        result={{ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 5 }}
        turnLimit={10}
        battleId="battle-01J-EXAMPLE"
        catalogRevision="2026-06-28.1"
      />,
    );

    expect(screen.getByText("ALLY WIN / 味方勝利")).toBeInTheDocument();
    expect(screen.getByText("敵陣営全滅")).toBeInTheDocument();
    expect(screen.getByText("5 / 10")).toBeInTheDocument();
    expect(screen.getByText("battle-01J-EXAMPLE")).toBeInTheDocument();
    expect(screen.getByText("2026-06-28.1")).toBeInTheDocument();
  });

  it("shows the raw code for an unknown outcome or completion reason instead of failing (§7.1)", () => {
    render(
      <OutcomeStrip
        result={{ outcome: "FUTURE_OUTCOME", completionReason: "FUTURE_REASON", completedTurn: 1 }}
        turnLimit={10}
        battleId="battle-2"
        catalogRevision="rev-2"
      />,
    );

    expect(screen.getByText("FUTURE_OUTCOME")).toBeInTheDocument();
    expect(screen.getByText("FUTURE_REASON")).toBeInTheDocument();
  });
});
