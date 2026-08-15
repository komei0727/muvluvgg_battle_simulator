import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import {
  runProductionUnitBattle,
  allProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * `08_ドメインイベント.md` 不変条件#5後段（`R-ATM-03` 攻撃前観測、Issue #480）:
 * `UnitBeingAttacked` は**スキル使用ごと・対象ごとに1回だけ**発行される。
 *
 * ヒット単位の発行を消したこと自体は個々のunit levelテストが押さえるが、「実
 * production Catalogのどの攻撃でも二重に発行されない」ことはそこでは表せない。
 * 複数ヒット・複数DAMAGE step・`REPEAT`・サブユニット追加ダメージ・追撃はどれも
 * 同じ対象へ何度も攻撃を届ける形であり、そのどれかが観測を再発行すれば「攻撃
 * される直前」のPSが1回の攻撃で複数回候補化して実行ガードを押し上げる
 * （`12_テスト戦略.md`「SKL_SHIRANA_SORA_PS2」の記録が指す退行そのもの）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PRODUCTION_UNIT_IDS = allProductionUnitIds(CATALOG_DIR);

const BATTLES = PRODUCTION_UNIT_IDS.map((unitDefinitionId) => ({
  unitDefinitionId,
  result: runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
    turnLimit: 5,
    randomValue: 0.5,
  }),
}));

function observationKey(event: BattleLogEvent): string {
  const details = event.details as { targetUnitId?: string };
  return `${String(event.skillUseId ?? "no-skill-use")}:${details.targetUnitId ?? "no-target"}`;
}

describe("pre-attack observation audit (R-ATM-03)", () => {
  it("IT-AUDIT-ATM-001 (R-ATM-03 #1/#3, 08_ドメインイベント.md 不変条件#5): every production battle emits UnitBeingAttacked at most once per skill use per target, always before that skill use's first hit", () => {
    const duplicates: string[] = [];
    const lateObservations: string[] = [];
    let observations = 0;

    for (const battle of BATTLES) {
      const seen = new Set<string>();
      // スキル使用ごとに、そのスキル使用が最初にヒットへ到達した位置（命中判定）。
      const firstHitSequence = new Map<string, number>();
      for (const event of battle.result.events) {
        if (event.type !== "HIT_CONFIRMED" && event.type !== "EVASION_ACTIVATED") {
          continue;
        }
        const scope = String(event.skillUseId ?? "no-skill-use");
        if (!firstHitSequence.has(scope)) {
          firstHitSequence.set(scope, event.sequence);
        }
      }

      for (const event of battle.result.events) {
        if (event.type !== "UNIT_BEING_ATTACKED") {
          continue;
        }
        observations++;
        const key = observationKey(event);
        if (seen.has(key)) {
          duplicates.push(`${battle.unitDefinitionId} seq=${event.sequence} ${key}`);
        }
        seen.add(key);
        // R-ATM-03 #1: 効果処理フェーズの開始前 — つまりそのスキル使用のどのヒットよりも前。
        const firstHit = firstHitSequence.get(String(event.skillUseId ?? "no-skill-use"));
        if (firstHit !== undefined && event.sequence > firstHit) {
          lateObservations.push(
            `${battle.unitDefinitionId} seq=${event.sequence} ${key} follows the first hit at seq=${firstHit}`,
          );
        }
      }
    }

    expect(
      duplicates,
      `UnitBeingAttacked emitted more than once for the same (skillUseId, target): ${JSON.stringify(duplicates.slice(0, 20))}`,
    ).toEqual([]);
    expect(
      lateObservations,
      `UnitBeingAttacked emitted after a hit of the same skill use: ${JSON.stringify(lateObservations.slice(0, 20))}`,
    ).toEqual([]);
    // 空振り防止: 実データで観測が発行されていること。
    expect(observations).toBeGreaterThan(0);
  });
});
