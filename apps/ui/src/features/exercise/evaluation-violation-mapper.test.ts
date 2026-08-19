import { describe, expect, it } from "vitest";
import { mapEvaluationViolationsToUiViolations } from "./evaluation-violation-mapper.js";
import type { StatisticsRunSubmission } from "./use-exercise-statistics-run.js";

const SUBMISSION: StatisticsRunSubmission = {
  allyUnitSlotKeys: ["ally:FRONT:0", "ally:REAR:1"],
  enemyUnitSlotKeys: ["enemy:FRONT:0"],
  allyMemorySlotKeys: ["ally:memory:0"],
  enemyMemorySlotKeys: [],
  allyGearSlotIndices: [[2], []],
  enemyGearSlotIndices: [],
  formationSignature: "sig",
};

// UI-UT-EVL-007: 一括評価の422は候補indexを含むpathで返る（`10_API設計.md`）。候補は
// 常に1件なので、`/candidates/0`を落とせば単一実行と同じ対応づけがそのまま使える。
describe("mapEvaluationViolationsToUiViolations", () => {
  it("resolves a candidate-prefixed ally unit path to the submitted slot key", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [
        {
          path: "/candidates/0/allyFormation/units/1/unitDefinitionId",
          ruleId: "R-TEX-11",
          message: "編成プールが違います",
        },
      ],
      SUBMISSION,
    );

    expect(mapped).toEqual([
      {
        path: "/candidates/0/allyFormation/units/1/unitDefinitionId",
        slotKey: "ally:REAR:1",
        code: "R-TEX-11",
        message: "編成プールが違います",
        severity: "error",
      },
    ]);
  });

  it("resolves the shared enemy formation path, which carries no candidate index", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [{ path: "/enemyFormation/units/0/unitDefinitionId", message: "敵が違います" }],
      SUBMISSION,
    );

    expect(mapped[0]?.slotKey).toBe("enemy:FRONT:0");
  });

  it("resolves a candidate-prefixed gear path back to its gear slot index", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [
        {
          path: "/candidates/0/allyFormation/units/0/enhancement/gears/0/grade",
          message: "ギアが違います",
        },
      ],
      SUBMISSION,
    );

    expect(mapped[0]?.slotKey).toBe("ally:FRONT:0");
    expect(mapped[0]?.gearIndex).toBe(2);
  });

  /**
   * `EVALUATION_MAX_TOTAL_RUNS`を絞った配備では総試行数の違反がこのpathで返る。
   * 送信前検証（`exercise-draft-validation.ts`）と同じpathなので、そのまま実行回数入力へ出る。
   */
  it("keeps the runsPerCandidate path untouched so it lands on the run count input", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [{ path: "/runsPerCandidate", message: "300 runs exceed the limit" }],
      SUBMISSION,
    );

    expect(mapped).toEqual([
      {
        path: "/runsPerCandidate",
        code: "SERVER_VIOLATION",
        message: "300 runs exceed the limit",
        severity: "error",
      },
    ]);
  });

  it("leaves a path it cannot resolve without a slot key instead of guessing", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [{ path: "/candidates/1/allyFormation/units/0", message: "未知の候補" }],
      SUBMISSION,
    );

    expect(mapped[0]?.slotKey).toBeUndefined();
  });
});
