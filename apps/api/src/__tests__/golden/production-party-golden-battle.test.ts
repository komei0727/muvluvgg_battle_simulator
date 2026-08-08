import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBattleInvariants } from "../../testing/scenario/run-scenario.js";
import {
  allProductionUnitIds,
  runProductionPartyBattle,
} from "../../testing/scenario/run-production-battle.js";

/**
 * Golden battle 回帰層の**混成編成**（`12_テスト戦略.md`「Golden battle 回帰層」）。
 *
 * 既存の golden は同一ユニットを味方・敵に据えたミラー戦のため、「**異なる
 * production ユニットの定義同士が同じ盤面で噛み合うか**」はどの層も見ていなかった。
 * 機能軸が押さえているのはエンジンのルールであって編成の組み合わせではなく、
 * ユニット効果軸は1定義のスコープに閉じている。
 *
 * 組み合わせは N×N を避け、全ユニットIDをsortして5体ずつ（編成上限）のpartyへ分割し、
 * `party[k]` 対 `party[k+1]` を回す。**全ユニットが味方として1回・敵として1回**、
 * 必ず混成編成の中で実戦闘を経験し、ユニット追加時も自動的にケースが増える
 * （snapshot未登録なら失敗する強制関数）。
 *
 * snapshotはイベント型ごとの件数マップに落とす。5対5の全イベント列は1対1の比では
 * なく大きい一方、**イベントの順序**は全 production ユニットに対して
 * `IT-AUDIT-M8-001` が既に検査しているため、ここで重複させない。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PARTY_SIZE = 5;

function parties(): readonly (readonly string[])[] {
  const ids = allProductionUnitIds(CATALOG_DIR);
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += PARTY_SIZE) {
    chunks.push([...ids.slice(index, index + PARTY_SIZE)]);
  }
  return chunks;
}

const PARTIES = parties();
const MATCHUPS = PARTIES.map((ally, index) => ({
  index,
  ally,
  enemy: PARTIES[(index + 1) % PARTIES.length]!,
}));

describe("production party golden battles", () => {
  it("E2E-GOLDEN-PARTY-000: every production Unit appears once as an ally and once as an enemy", () => {
    const allyAppearances = MATCHUPS.flatMap((matchup) => matchup.ally).sort();
    const enemyAppearances = MATCHUPS.flatMap((matchup) => matchup.enemy).sort();
    expect(allyAppearances).toEqual(allProductionUnitIds(CATALOG_DIR));
    expect(enemyAppearances).toEqual(allProductionUnitIds(CATALOG_DIR));
  });

  it.each(MATCHUPS)(
    "E2E-GOLDEN-PARTY: matchup $index completes a deterministic mixed-party battle and holds battle invariants",
    ({ index, ally, enemy }) => {
      // 混成編成では、ミラー戦では起こらないPS連鎖の重なりが実行ガード
      // （`maxEffectsPerScope: 50`、`passive-activation-service.ts`）へ届くことがある。
      // 到達した組み合わせを握り潰さず snapshot へ残し、「どの編成がガードに触れるか」
      // 自体を回帰対象にする（増減したらレビューに乗る）。
      let result: ReturnType<typeof runProductionPartyBattle>;
      try {
        result = runProductionPartyBattle(
          CATALOG_DIR,
          { ally, enemy },
          { turnLimit: 5, randomValue: 0.5, battleId: `B_GOLDEN_PARTY_${index}` },
        );
      } catch (error) {
        expect({ ally, enemy, executionGuard: (error as Error).message }).toMatchSnapshot();
        return;
      }

      expect(typeof result.outcome).toBe("string");
      assertBattleInvariants(result);

      const eventTypeCounts: Record<string, number> = {};
      for (const event of result.events) {
        eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
      }
      expect({
        ally,
        enemy,
        outcome: result.outcome,
        completionReason: result.completionReason,
        completedTurn: result.completedTurn,
        eventTypeCounts: Object.fromEntries(
          Object.entries(eventTypeCounts).sort(([left], [right]) => left.localeCompare(right)),
        ),
      }).toMatchSnapshot();
    },
  );
});
