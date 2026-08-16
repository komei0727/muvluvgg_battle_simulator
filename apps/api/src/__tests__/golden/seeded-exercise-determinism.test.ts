import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import {
  allExerciseEnemyProductionUnitIds,
  allProductionUnitIds,
  runProductionExerciseBattle,
} from "../../testing/scenario/run-production-battle.js";

/**
 * `SeededRandomSourceProvider`が実Catalog・実エンジン上で再現性を満たすことの確認層。
 *
 * golden battle（`production-exercise-golden-battle.test.ts`）はconstant sourceで
 * 完走させるため、乱数値が散る経路を一度も踏まない。ここでは実際に散る乱数列を
 * 与えたうえで、同一`(seed, runIndex)`が同一結果を再現することを固定する。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PARTY_SIZE = 5;
const SEED = "issue-506";

const ALLY_PARTY = allProductionUnitIds(CATALOG_DIR).slice(0, PARTY_SIZE);
const ENEMY_UNIT_DEFINITION_ID = allExerciseEnemyProductionUnitIds(CATALOG_DIR)[0];

const provider = new Mulberry32SeededRandomSourceProvider();

function runSeededExercise(runIndex: number): {
  totalScore: number;
  breakCount: number;
  completedTurn: number;
  completionReason: string;
  eventCount: number;
} {
  const result = runProductionExerciseBattle(
    CATALOG_DIR,
    { ally: ALLY_PARTY, enemyUnitDefinitionId: ENEMY_UNIT_DEFINITION_ID! },
    {
      randomSourceFactory: provider.forRun(SEED, runIndex),
      battleId: `B_SEEDDET_${runIndex}`,
    },
  );
  return {
    totalScore: result.totalScore,
    breakCount: result.breakCount,
    completedTurn: result.completedTurn,
    completionReason: result.completionReason,
    eventCount: result.events.length,
  };
}

describe("seeded tactical exercise determinism", () => {
  it("E2E-SEEDDET-001: the same (seed, runIndex) reproduces an identical exercise result", () => {
    expect(runSeededExercise(0)).toEqual(runSeededExercise(0));
  });

  it("E2E-SEEDDET-002: different run indices reach different results, so the reproduction above is not vacuous", () => {
    const outcomes = [0, 1, 2].map((runIndex) => JSON.stringify(runSeededExercise(runIndex)));

    expect(new Set(outcomes).size).toBeGreaterThan(1);
  });
});
