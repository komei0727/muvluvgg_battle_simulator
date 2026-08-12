import { describe, expect, it } from "vitest";
import { selectExerciseResultView } from "./exercise-result-projector.js";
import type { ExerciseResultResponse } from "../simulation/api-contract.js";

function result(overrides: Partial<ExerciseResultResponse> = {}): ExerciseResultResponse {
  return {
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    totalScore: 4200,
    breakCount: 2,
    breaks: [
      { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 1500 },
      { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 3600 },
    ],
    ...overrides,
  };
}

// UI-CMP-012: 総スコア・ブレイク回数・終了理由と、発生順のブレイク履歴。
describe("selectExerciseResultView", () => {
  it("carries the score, break count and completed turn through", () => {
    const view = selectExerciseResultView(result());

    expect(view.totalScore).toBe(4200);
    expect(view.breakCount).toBe(2);
    expect(view.completedTurn).toBe(5);
    expect(view.turnLimit).toBe(5);
  });

  it("labels the known completion reasons in Japanese", () => {
    expect(selectExerciseResultView(result()).completionReasonLabel).toBe("ターン上限到達");
    expect(
      selectExerciseResultView(result({ completionReason: "ALLY_DEFEATED" })).completionReasonLabel,
    ).toBe("味方陣営全滅");
  });

  // UI-AC-011の方針を演習にも適用する: 未知の列挙値はコードのまま出す。
  it("falls back to the raw code for an unknown completion reason", () => {
    const view = selectExerciseResultView(result({ completionReason: "FUTURE_REASON" }));

    expect(view.completionReasonLabel).toBe("FUTURE_REASON");
  });

  it("orders the break rows by break number regardless of the array order", () => {
    const view = selectExerciseResultView(
      result({
        breaks: [
          { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 3600 },
          { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 1500 },
        ],
      }),
    );

    expect(view.breaks.map((row) => row.breakNumber)).toEqual([1, 2]);
  });

  // UI-AC-021: ブレイク0回でも結果表示が成立する。
  it("projects a zero-break result without rows", () => {
    const view = selectExerciseResultView(result({ totalScore: 0, breakCount: 0, breaks: [] }));

    expect(view.breaks).toEqual([]);
    expect(view.breakCount).toBe(0);
    expect(view.totalScore).toBe(0);
  });
});
