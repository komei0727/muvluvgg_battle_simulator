import { describe, expect, it } from "vitest";
import { selectExerciseResultView } from "./exercise-result-projector.js";
import type {
  BattleSimulationCatalogResponse,
  ExerciseResultResponse,
} from "../../shared/api/api-contract.js";

function catalog(
  units: readonly { readonly unitDefinitionId: string; readonly displayName: string }[],
): BattleSimulationCatalogResponse {
  return {
    schemaVersion: 1,
    catalogRevision: "rev-1",
    units: units.map((unit) => ({
      unitDefinitionId: unit.unitDefinitionId,
      displayName: unit.displayName,
      characterName: unit.displayName,
      attribute: "FIRE",
      unitType: "ATTACKER",
      role: "ATTACKER",
      positionAptitudes: ["FRONT"],
    })),
    memories: [],
  };
}

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

  // UI-AC-021 / R-TEX-03 #2: 発生源ユニットをCatalogの表示名で名指しする。
  it("UI-UT-EXR-001: resolves the break source unit display name from the catalog", () => {
    const view = selectExerciseResultView(
      result({
        breakCount: 1,
        breaks: [
          {
            breakNumber: 1,
            turnNumber: 2,
            cumulativeScoreAtBreak: 1500,
            sourceUnitDefinitionId: "UNIT_ALLY_A",
          },
        ],
      }),
      catalog([{ unitDefinitionId: "UNIT_ALLY_A", displayName: "アライアルファ" }]),
    );

    expect(view.breaks[0]?.sourceLabel).toBe("アライアルファ");
  });

  // Catalog未取得や、Catalog更新で消えた定義でも履歴を出し続ける（`UI-CMP-012`）。
  it("UI-UT-EXR-002: falls back to the raw definition id for an unknown source unit", () => {
    const breaks = [
      {
        breakNumber: 1,
        turnNumber: 2,
        cumulativeScoreAtBreak: 1500,
        sourceUnitDefinitionId: "UNIT_RETIRED",
      },
    ];

    expect(
      selectExerciseResultView(result({ breakCount: 1, breaks }), catalog([])).breaks[0]
        ?.sourceLabel,
    ).toBe("UNIT_RETIRED");
    expect(selectExerciseResultView(result({ breakCount: 1, breaks })).breaks[0]?.sourceLabel).toBe(
      "UNIT_RETIRED",
    );
  });

  // R-MEM-04: 発生源ユニットを持たないブレイクはメモリー由来である。この項目を
  // 返さない旧レスポンスも同じ経路で表示できる（後方互換）。
  it("UI-UT-EXR-003: labels a break without a source unit as a memory effect", () => {
    const view = selectExerciseResultView(result());

    expect(view.breaks.map((row) => row.sourceLabel)).toEqual(["メモリー効果", "メモリー効果"]);
  });

  // UI-AC-021: ブレイク0回でも結果表示が成立する。
  it("projects a zero-break result without rows", () => {
    const view = selectExerciseResultView(result({ totalScore: 0, breakCount: 0, breaks: [] }));

    expect(view.breaks).toEqual([]);
    expect(view.breakCount).toBe(0);
    expect(view.totalScore).toBe(0);
  });
});
