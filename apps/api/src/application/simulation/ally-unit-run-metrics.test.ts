import { describe, expect, it } from "vitest";
import {
  projectAllyUnitRunMetrics,
  type AllyUnitRunMetricsInput,
} from "./ally-unit-run-metrics.js";
import type { ExerciseBreak } from "./simulation-result-assembler.js";
import type { UnitBattleSummary } from "../observation/unit-battle-summary-projector.js";
import { createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

const ALLY_ONE = createBattleUnitId("ally:1");
const ALLY_TWO = createBattleUnitId("ally:2");
const ENEMY_ONE = createBattleUnitId("enemy:1");

function summary(battleUnitId: BattleUnitId, side: Side, damageDealt: number): UnitBattleSummary {
  return {
    battleUnitId,
    side,
    damageDealt,
    damageTaken: 0,
    healingDone: 0,
    finalHp: 100,
    maximumHp: 100,
    combatStatus: "ACTIVE",
  };
}

function exerciseBreak(breakNumber: number, sourceUnitId?: BattleUnitId): ExerciseBreak {
  return {
    breakNumber,
    turnNumber: 1,
    cumulativeScoreAtBreak: breakNumber * 100,
    ...(sourceUnitId !== undefined ? { sourceUnitId } : {}),
  };
}

function run(overrides: Partial<AllyUnitRunMetricsInput> = {}): AllyUnitRunMetricsInput {
  return {
    unitSummaries: [
      summary(ALLY_ONE, "ALLY", 500),
      summary(ALLY_TWO, "ALLY", 0),
      summary(ENEMY_ONE, "ENEMY", 700),
    ],
    breaks: [],
    ...overrides,
  };
}

describe("projectAllyUnitRunMetrics", () => {
  it("UT-ALLYRUNMETRICS-001: returns one entry per ally participation slot, in roster order, and drops the enemy side", () => {
    const metrics = projectAllyUnitRunMetrics(run());

    expect(metrics.damageTotals).toEqual([500, 0]);
    expect(metrics.breakCounts).toEqual([0, 0]);
  });

  it("UT-ALLYRUNMETRICS-002: attributes each break to the ally slot that caused it", () => {
    const metrics = projectAllyUnitRunMetrics(
      run({
        breaks: [
          exerciseBreak(1, ALLY_TWO),
          exerciseBreak(2, ALLY_TWO),
          exerciseBreak(3, ALLY_ONE),
        ],
      }),
    );

    expect(metrics.breakCounts).toEqual([1, 2]);
  });

  it("UT-ALLYRUNMETRICS-003 [R-MEM-04] (R-MEM-04): leaves a break with no source unit uncounted, so the residual against breakCount stays visible", () => {
    const metrics = projectAllyUnitRunMetrics(
      run({ breaks: [exerciseBreak(1, ALLY_ONE), exerciseBreak(2)] }),
    );

    expect(metrics.breakCounts).toEqual([1, 0]);
  });

  // 敵の枠が発生源になる経路は実在する: R-CFS-01により混乱した敵のASは対象側が反転し、
  // 演習の敵はちょうど1体（R-TEX-01 #3）なので自分自身を撃つ。その自傷でHPが0へ達すれば
  // 発生源が敵の枠のブレイクになる。残差を一律に「メモリー由来」と読めない理由である。
  it("UT-ALLYRUNMETRICS-004: does not count a break whose source is an enemy slot, such as a confused enemy hitting itself", () => {
    const metrics = projectAllyUnitRunMetrics(run({ breaks: [exerciseBreak(1, ENEMY_ONE)] }));

    expect(metrics.breakCounts).toEqual([0, 0]);
  });
});
