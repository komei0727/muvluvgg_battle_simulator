import { describe, expect, it } from "vitest";
import { mapEvaluationViolationsToUiViolations } from "./evaluation-violation-mapper.js";
import type { StatisticsRunSubmission } from "./use-exercise-statistics-run.js";

const SUBMISSION: StatisticsRunSubmission = {
  allyUnitDefinitionIds: ["UNIT_ALLY", "UNIT_ALLY_REAR"],
  allyUnitSlotKeys: ["ally:FRONT:0", "ally:REAR:1"],
  enemyUnitSlotKeys: ["enemy:FRONT:0"],
  allyMemorySlotKeys: ["ally:memory:0"],
  enemyMemorySlotKeys: [],
  allyGearSlotIndices: [[2], []],
  enemyGearSlotIndices: [],
  formationSignature: "sig",
};

// UI-UT-EVL-007: 大量試行の422はケースindexを含むpathで返る（`10_API設計.md`）。ケースは
// 常に1件なので、`/cases/0`を落とせば単一実行と同じ対応づけがそのまま使える。
describe("mapEvaluationViolationsToUiViolations", () => {
  it("resolves a case-prefixed ally unit path to the submitted slot key", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [
        {
          path: "/cases/0/allyFormation/units/1/unitDefinitionId",
          ruleId: "R-TEX-11",
          message: "編成プールが違います",
        },
      ],
      SUBMISSION,
    );

    expect(mapped).toEqual([
      {
        path: "/cases/0/allyFormation/units/1/unitDefinitionId",
        slotKey: "ally:REAR:1",
        code: "R-TEX-11",
        message: "編成プールが違います",
        severity: "error",
      },
    ]);
  });

  it("resolves a case-prefixed enemy formation path", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [{ path: "/cases/0/enemyFormation/units/0/unitDefinitionId", message: "敵が違います" }],
      SUBMISSION,
    );

    expect(mapped[0]?.slotKey).toBe("enemy:FRONT:0");
  });

  it("resolves a case-prefixed gear path back to its gear slot index", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [
        {
          path: "/cases/0/allyFormation/units/0/enhancement/gears/0/grade",
          message: "ギアが違います",
        },
      ],
      SUBMISSION,
    );

    expect(mapped[0]?.slotKey).toBe("ally:FRONT:0");
    expect(mapped[0]?.gearIndex).toBe(2);
  });

  /**
   * `TACTICAL_EXERCISE_EVALUATION_MAX_TOTAL_RUNS`を絞った配備では総試行数の違反が`/cases`で、
   * 試行番号の違反が`/cases/0/runIndices/...`で返る。どちらも利用者が直せるのは実行回数だけ
   * なので、送信前検証（`exercise-draft-validation.ts`）と同じ`/runCount`へ寄せる。
   */
  it.each(["/cases", "/cases/0/runIndices/3"])(
    "moves the run plan violation %s onto the run count input",
    (path) => {
      const mapped = mapEvaluationViolationsToUiViolations(
        [{ path, message: "300 runs exceed the limit" }],
        SUBMISSION,
      );

      expect(mapped).toEqual([
        {
          path: "/runCount",
          code: "SERVER_VIOLATION",
          message: "300 runs exceed the limit",
          severity: "error",
        },
      ]);
    },
  );

  it("leaves a path it cannot resolve without a slot key instead of guessing", () => {
    const mapped = mapEvaluationViolationsToUiViolations(
      [{ path: "/cases/1/allyFormation/units/0", message: "未知の候補" }],
      SUBMISSION,
    );

    expect(mapped[0]?.slotKey).toBeUndefined();
  });
});
