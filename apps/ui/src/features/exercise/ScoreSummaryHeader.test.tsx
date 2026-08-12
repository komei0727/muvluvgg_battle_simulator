import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreSummaryHeader } from "./ScoreSummaryHeader.js";
import type { ExerciseResultResponse } from "../simulation/api-contract.js";

function result(overrides: Partial<ExerciseResultResponse> = {}): ExerciseResultResponse {
  return {
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    totalScore: 4200,
    breakCount: 2,
    breaks: [],
    ...overrides,
  };
}

// UI-AC-021 / UI-CMP-012: 総スコア・ブレイク回数・終了理由を表示する。
describe("ScoreSummaryHeader", () => {
  it("shows the total score, break count and completion reason", () => {
    render(
      <ScoreSummaryHeader result={result()} battleId="exercise-01J" catalogRevision="rev-1" />,
    );

    expect(screen.getByText("TOTAL SCORE").parentElement).toHaveTextContent("4,200");
    expect(screen.getByText("BREAK COUNT").parentElement).toHaveTextContent("2");
    expect(screen.getByText("COMPLETION REASON").parentElement).toHaveTextContent("ターン上限到達");
  });

  it("shows the completed turn against the fixed five-turn limit", () => {
    render(
      <ScoreSummaryHeader
        result={result({ completedTurn: 3, completionReason: "ALLY_DEFEATED" })}
        battleId="exercise-01J"
        catalogRevision="rev-1"
      />,
    );

    expect(screen.getByText("COMPLETED TURN").parentElement).toHaveTextContent("3 / 5");
  });

  it("never shows a win/lose outcome", () => {
    render(
      <ScoreSummaryHeader result={result()} battleId="exercise-01J" catalogRevision="rev-1" />,
    );

    expect(screen.queryByText("OUTCOME")).not.toBeInTheDocument();
  });

  it("shows the battle id and catalog revision", () => {
    render(
      <ScoreSummaryHeader result={result()} battleId="exercise-01J" catalogRevision="rev-9" />,
    );

    expect(screen.getByText("BATTLE ID").parentElement).toHaveTextContent("exercise-01J");
    expect(screen.getByText("CATALOG REVISION").parentElement).toHaveTextContent("rev-9");
  });

  it("renders a zero-score, zero-break result", () => {
    render(
      <ScoreSummaryHeader
        result={result({ totalScore: 0, breakCount: 0 })}
        battleId="exercise-01J"
        catalogRevision="rev-1"
      />,
    );

    expect(screen.getByText("TOTAL SCORE").parentElement).toHaveTextContent("0");
    expect(screen.getByText("BREAK COUNT").parentElement).toHaveTextContent("0");
  });
});
