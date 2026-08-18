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
 *
 * `totalScore`は5ターンの相互作用の積み上げであり、ブレイクの解決位置が動くと個別の
 * 数値は単一の原因へ帰属できない。ブレイク保留方式（`R-TEX-03` #5、Issue #523）の導入で
 * 4件すべての`totalScore`が動いた（3件が減少、1件が増加）が、`breakCount`・
 * `completedTurn`・`completionReason`はいずれも不変である。増減の主因は`R-TEX-06` #4.3
 * 末尾が明記する挙動変更 — 保留中（HP0）の敵へ付与された`onHitEffect`・追加デバフ・
 * 継続ダメージは、旧規約では復活後の敵へ付いて残ったが、いまは同じフェーズ末尾の
 * ブレイク解決で解除対象になる。敵が後続ターンへ持ち込む継続ダメージ・デバフが減る分
 * （`CONTINUOUS_DAMAGE_APPLIED`の減少として現れる）だけ後続の与ダメージが下がり、
 * 保留窓のオーバーキル計上（同 #4.1）が増える分と差し引きになる。したがってスコアが
 * **下がる**こと自体は退行ではない。ここが動いたときは、まずこの2つの向きのどちらが
 * 効いたのかを確認する。
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
