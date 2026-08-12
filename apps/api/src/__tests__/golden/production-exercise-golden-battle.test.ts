import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBattleInvariants } from "../../testing/scenario/run-scenario.js";
import {
  allExerciseEnemyProductionUnitIds,
  allProductionUnitIds,
  runProductionExerciseBattle,
} from "../../testing/scenario/run-production-battle.js";

/**
 * Golden battle 回帰層の**戦術演習**（`12_テスト戦略.md`「Golden battle 回帰層」）。
 *
 * ミラー戦・混成編成のgoldenは通常戦闘（`NORMAL`）でPLAYABLEユニットだけを流すため、
 * `EXERCISE_ENEMY`ユニットの定義は実戦闘をどの層でも経験しない（R-TEX-11で通常戦闘へ
 * 編成できない）。ここでは各演習ユニットを敵に据えた演習（`TACTICAL_EXERCISE`）を
 * 完走させ、スコア・ブレイクを含む結果をsnapshotへ固定する。
 *
 * 味方はPLAYABLEのID昇順先頭5体で固定する——演習ユニット追加時に既存matchupの
 * snapshotが変わらず、追加分のケースだけが増える（snapshot未登録なら失敗する強制関数）。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PARTY_SIZE = 5;

const ALLY_PARTY = allProductionUnitIds(CATALOG_DIR).slice(0, PARTY_SIZE);
const MATCHUPS = allExerciseEnemyProductionUnitIds(CATALOG_DIR).map((enemyUnitDefinitionId) => ({
  enemyUnitDefinitionId,
}));

describe("production tactical exercise golden battles", () => {
  it("E2E-GOLDEN-TEX-000: every EXERCISE_ENEMY production Unit appears exactly once as the exercise enemy", () => {
    expect(MATCHUPS.map((matchup) => matchup.enemyUnitDefinitionId)).toEqual(
      allExerciseEnemyProductionUnitIds(CATALOG_DIR),
    );
    expect(MATCHUPS.length).toBeGreaterThan(0);
  });

  it.each(MATCHUPS)(
    "E2E-GOLDEN-TEX: exercise against $enemyUnitDefinitionId completes deterministically and holds battle invariants",
    ({ enemyUnitDefinitionId }) => {
      const result = runProductionExerciseBattle(
        CATALOG_DIR,
        { ally: ALLY_PARTY, enemyUnitDefinitionId },
        { randomValue: 0.5, battleId: `B_GOLDEN_TEX_${enemyUnitDefinitionId}` },
      );

      expect(typeof result.completionReason).toBe("string");
      assertBattleInvariants(result);

      const eventTypeCounts: Record<string, number> = {};
      for (const event of result.events) {
        eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
      }
      expect({
        ally: ALLY_PARTY,
        enemyUnitDefinitionId,
        completionReason: result.completionReason,
        completedTurn: result.completedTurn,
        totalScore: result.totalScore,
        breakCount: result.breakCount,
        breaks: result.breaks,
        eventTypeCounts: Object.fromEntries(
          Object.entries(eventTypeCounts).sort(([left], [right]) => left.localeCompare(right)),
        ),
      }).toMatchSnapshot();
    },
  );
});
