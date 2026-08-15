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

/**
 * 実行ガード（`maxEffectsPerScope`、`passive-activation-service.ts`）へ到達し、
 * 完走しない組み合わせ。golden（完走）軸の契約は「完走・不変条件」なので、
 * 例外を完走ケースの成功として飲み込まず、**既知の到達**として別のテストへ分離する。
 * ここが増減した場合はガードの水準か production 定義が変わったということなので、
 * どちらのテストも失敗してレビューに乗る。
 *
 * REL-005（Issue #198）の実測で、この編成が到達していたのは「暴走した定義」では
 * なく正常な混成編成の効果解決であり、全29編成の実測必要量54件を上限50が
 * 下回っていたことが原因と分かった。上限を実測値の約1.9倍（100）へ
 * 引き上げたため、ガードへ到達する編成は無くなった。
 */
const GUARD_LIMITED_MATCHUP_INDICES: readonly number[] = [];

const COMPLETING_MATCHUPS = MATCHUPS.filter(
  (matchup) => !GUARD_LIMITED_MATCHUP_INDICES.includes(matchup.index),
);
const GUARD_LIMITED_MATCHUPS = MATCHUPS.filter((matchup) =>
  GUARD_LIMITED_MATCHUP_INDICES.includes(matchup.index),
);

describe("production party golden battles", () => {
  it("E2E-GOLDEN-PARTY-000: every production Unit appears once as an ally and once as an enemy", () => {
    const allyAppearances = MATCHUPS.flatMap((matchup) => matchup.ally).sort();
    const enemyAppearances = MATCHUPS.flatMap((matchup) => matchup.enemy).sort();
    expect(allyAppearances).toEqual(allProductionUnitIds(CATALOG_DIR));
    expect(enemyAppearances).toEqual(allProductionUnitIds(CATALOG_DIR));
  });

  it.each(COMPLETING_MATCHUPS)(
    "E2E-GOLDEN-PARTY: matchup $index completes a deterministic mixed-party battle and holds battle invariants",
    ({ index, ally, enemy }) => {
      const result = runProductionPartyBattle(
        CATALOG_DIR,
        { ally, enemy },
        { turnLimit: 5, randomValue: 0.5, battleId: `B_GOLDEN_PARTY_${index}` },
      );

      expect(typeof result.outcome).toBe("string");
      expect(typeof result.completionReason).toBe("string");
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

  it.each(GUARD_LIMITED_MATCHUPS)(
    "E2E-GOLDEN-PARTY-GUARD: matchup $index is a known mixed-party combination that reaches the PS chain execution guard instead of completing",
    ({ index, ally, enemy }) => {
      // 完走保証とは別枠の「既知の到達」テスト。ミラー戦では起こらないPS連鎖の重なりが
      // ガードへ届くこと自体を追跡し、解消されたら（=例外が出なくなったら）失敗させて
      // `GUARD_LIMITED_MATCHUP_INDICES` の更新を強制する。
      expect(() =>
        runProductionPartyBattle(
          CATALOG_DIR,
          { ally, enemy },
          { turnLimit: 5, randomValue: 0.5, battleId: `B_GOLDEN_PARTY_${index}` },
        ),
      ).toThrow(/MAX_EFFECTS_PER_SCOPE_EXCEEDED/);
    },
  );
});
