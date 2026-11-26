import { describe, expect, it } from "vitest";
import {
  projectAllyUnitBreaks,
  type AllyUnitBreaksInput,
  type AllyUnitBreaksRosterEntry,
} from "./ally-unit-run-metrics.js";
import type { ExerciseBreak } from "./simulation-result-assembler.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

const ALLY_ONE = createBattleUnitId("ally:1");
const ALLY_TWO = createBattleUnitId("ally:2");
const ENEMY_ONE = createBattleUnitId("enemy:1");

function rosterEntry(
  battleUnitId: BattleUnitId,
  side: Side,
  unitDefinitionId: string,
): AllyUnitBreaksRosterEntry {
  return { battleUnitId, side, unitDefinitionId: createUnitDefinitionId(unitDefinitionId) };
}

function exerciseBreak(breakNumber: number, sourceUnitId?: BattleUnitId): ExerciseBreak {
  return {
    breakNumber,
    turnNumber: 1,
    cumulativeScoreAtBreak: breakNumber * 100,
    ...(sourceUnitId !== undefined ? { sourceUnitId } : {}),
  };
}

function run(overrides: Partial<AllyUnitBreaksInput> = {}): AllyUnitBreaksInput {
  return {
    unitRoster: [
      rosterEntry(ALLY_ONE, "ALLY", "UNIT_A"),
      rosterEntry(ENEMY_ONE, "ENEMY", "UNIT_ENEMY"),
      rosterEntry(ALLY_TWO, "ALLY", "UNIT_A"),
    ],
    breaks: [],
    ...overrides,
  };
}

function counts(input: AllyUnitBreaksInput): number[] {
  return projectAllyUnitBreaks(input).map((entry) => entry.breakCount);
}

describe("projectAllyUnitBreaks", () => {
  it("UT-ALLYRUNMETRICS-001: returns one entry per ally participation slot by unit index, and drops the enemy side", () => {
    expect(projectAllyUnitBreaks(run())).toEqual([
      { unitIndex: 0, unitDefinitionId: "UNIT_A", breakCount: 0 },
      { unitIndex: 1, unitDefinitionId: "UNIT_A", breakCount: 0 },
    ]);
  });

  it("UT-ALLYRUNMETRICS-002: attributes each break to the ally slot that caused it, even when two slots hold the same unit", () => {
    expect(
      counts(
        run({
          breaks: [
            exerciseBreak(1, ALLY_TWO),
            exerciseBreak(2, ALLY_TWO),
            exerciseBreak(3, ALLY_ONE),
          ],
        }),
      ),
    ).toEqual([1, 2]);
  });

  it("UT-ALLYRUNMETRICS-003 [R-MEM-04] (R-MEM-04): leaves a break with no source unit uncounted, so the residual against breakCount stays visible", () => {
    expect(counts(run({ breaks: [exerciseBreak(1, ALLY_ONE), exerciseBreak(2)] }))).toEqual([1, 0]);
  });

  // 敵の枠が発生源になる経路は実在する: R-CFS-01により混乱した敵のASは対象側が反転し、
  // 演習の敵はちょうど1体（R-TEX-01 #3）なので自分自身を撃つ。その自傷でHPが0へ達すれば
  // 発生源が敵の枠のブレイクになる。残差を一律に「メモリー由来」と読めない理由である。
  it("UT-ALLYRUNMETRICS-004: does not count a break whose source is an enemy slot, such as a confused enemy hitting itself", () => {
    expect(counts(run({ breaks: [exerciseBreak(1, ENEMY_ONE)] }))).toEqual([0, 0]);
  });
});
