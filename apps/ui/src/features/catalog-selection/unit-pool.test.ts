import { describe, expect, it } from "vitest";
import type { CatalogUnitSummary } from "../../shared/api/api-contract.js";
import { isExerciseEnemyUnit, selectUnitPool } from "./unit-pool.js";

const playableWithoutCategory: CatalogUnitSummary = {
  unitDefinitionId: "UNIT_LEGACY",
  displayName: "レガシー",
  characterName: "Legacy",
  attribute: "CUTE",
  unitType: "ATTACKER",
  role: "DPS",
  positionAptitudes: ["FRONT"],
};

const playable: CatalogUnitSummary = {
  ...playableWithoutCategory,
  unitDefinitionId: "UNIT_PLAYABLE",
  displayName: "プレイアブル",
  category: "PLAYABLE",
};

const activeExerciseEnemy: CatalogUnitSummary = {
  ...playableWithoutCategory,
  unitDefinitionId: "UNIT_EXERCISE_ACTIVE",
  displayName: "演習開催中",
  category: "EXERCISE_ENEMY",
  exerciseActive: true,
};

const closedExerciseEnemy: CatalogUnitSummary = {
  ...playableWithoutCategory,
  unitDefinitionId: "UNIT_EXERCISE_CLOSED",
  displayName: "演習開催終了",
  category: "EXERCISE_ENEMY",
  exerciseActive: false,
};

const units: readonly CatalogUnitSummary[] = [
  playableWithoutCategory,
  playable,
  activeExerciseEnemy,
  closedExerciseEnemy,
];

describe("selectUnitPool", () => {
  // R-TEX-11 #2: 演習の敵はEXERCISE_ENEMYのみ。開催終了も選べる（#4）。
  it("selects only exercise enemies for the exercise enemy side", () => {
    expect(selectUnitPool(units, "exercise", "enemy")).toEqual([
      activeExerciseEnemy,
      closedExerciseEnemy,
    ]);
  });

  // R-TEX-11 #1: categoryを持たない定義はPLAYABLE扱い（旧API互換）。
  it.each([
    ["exercise", "ally"],
    ["battle", "ally"],
    ["battle", "enemy"],
  ] as const)("selects only playable units for %s/%s", (mode, side) => {
    expect(selectUnitPool(units, mode, side)).toEqual([playableWithoutCategory, playable]);
  });

  it("keeps the catalog order of the source array", () => {
    expect(selectUnitPool([playable, playableWithoutCategory], "battle", "ally")).toEqual([
      playable,
      playableWithoutCategory,
    ]);
  });
});

describe("isExerciseEnemyUnit", () => {
  it("recognizes only the EXERCISE_ENEMY category", () => {
    expect(isExerciseEnemyUnit(activeExerciseEnemy)).toBe(true);
    expect(isExerciseEnemyUnit(closedExerciseEnemy)).toBe(true);
    expect(isExerciseEnemyUnit(playable)).toBe(false);
    expect(isExerciseEnemyUnit(playableWithoutCategory)).toBe(false);
  });
});
