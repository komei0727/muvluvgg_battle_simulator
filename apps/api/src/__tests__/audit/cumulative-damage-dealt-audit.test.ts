import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allProductionUnitIds,
  runProductionPartyBattle,
  runProductionUnitBattle,
} from "../../testing/scenario/run-production-battle.js";
import type { FullObservationBattleResult } from "../../testing/scenario/run-scenario.js";

/**
 * Issue #700: `BattleUnit.cumulativeDamageDealt`（順位キー`HIGHEST_CUMULATIVE_DAMAGE_DEALT`が
 * 読む値）は、戦闘結果の`unitSummaries[].damageDealt`と同じ定義でなければならない。
 * 両者は別の場所（ダメージ適用時の加算と、イベント列からの事後集計）で計算されるため、
 * どちらかの経路だけに与ダメージの種類が増えると、表示上の与ダメージと
 * 「最も累計ダメージの多い味方」として選ばれる対象が食い違う。
 *
 * 直接ダメージ・継続ダメージ・反射・リンク・サブユニット追加ダメージ・自傷のいずれも
 * production Catalog のどこかに現れるため、全ユニットのミラー戦と混成編成で突き合わせる。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PRODUCTION_UNIT_IDS = allProductionUnitIds(CATALOG_DIR);
const PARTY_SIZE = 5;

function mixedParties(): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  for (let index = 0; index < PRODUCTION_UNIT_IDS.length; index += PARTY_SIZE) {
    chunks.push([...PRODUCTION_UNIT_IDS.slice(index, index + PARTY_SIZE)]);
  }
  return chunks;
}

function mismatchesOf(label: string, result: FullObservationBattleResult): readonly string[] {
  const mismatches: string[] = [];
  for (const summary of result.unitSummaries) {
    const accumulated = result.finalState.units[summary.battleUnitId]?.cumulativeDamageDealt ?? 0;
    if (accumulated !== summary.damageDealt) {
      mismatches.push(
        `${label} ${summary.battleUnitId}: cumulativeDamageDealt=${accumulated} damageDealt=${summary.damageDealt}`,
      );
    }
  }
  return mismatches;
}

// 既存のaudit（`pre-attack-observation-audit.test.ts`）と同じく、戦闘はモジュール読み込み時に
// 回す。全ユニット分の実戦闘はカバレッジ計測下でテスト1件のタイムアウトを超えるため。
const PARTIES = mixedParties();
const BATTLES: readonly { readonly label: string; readonly result: FullObservationBattleResult }[] =
  [
    ...PRODUCTION_UNIT_IDS.map((unitDefinitionId) => ({
      label: `mirror ${unitDefinitionId}`,
      result: runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
        turnLimit: 5,
        randomValue: 0.5,
      }),
    })),
    ...PARTIES.map((ally, index) => ({
      label: `party ${index}`,
      result: runProductionPartyBattle(
        CATALOG_DIR,
        { ally, enemy: PARTIES[(index + 1) % PARTIES.length]! },
        { turnLimit: 5, randomValue: 0.5, battleId: `B_AUDIT_DMGDEALT_${index}` },
      ),
    })),
  ];

describe("cumulative damage dealt audit (Issue #700)", () => {
  it("IT-AUDIT-DMGDEALT-001 (Issue #700): every production battle ends with BattleUnit.cumulativeDamageDealt equal to unitSummaries[].damageDealt for every unit", () => {
    const mismatches = BATTLES.flatMap(({ label, result }) => mismatchesOf(label, result));
    const totalDamageDealt = BATTLES.reduce(
      (sum, { result }) => sum + result.unitSummaries.reduce((acc, s) => acc + s.damageDealt, 0),
      0,
    );

    // 空振り防止: 与ダメージが1件も無ければ一致は自明に成立してしまう。
    expect(totalDamageDealt).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});
