import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import {
  runProductionUnitBattle,
  allProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * `08_ドメインイベント.md` 不変条件#5後段（`R-ATM-03` 攻撃前観測、Issue #480）:
 * `UnitBeingAttacked` は**スキル使用ごと・対象ごとにちょうど1回**発行される。
 *
 * ヒット単位の発行を消したこと自体は個々のunit levelテストが押さえるが、「実
 * production Catalogのどの攻撃でも、多くも少なくもならない」ことはそこでは表せない。
 *
 * - **多い方**（重複）: 複数ヒット・複数DAMAGE step・`REPEAT`・サブユニット追加
 *   ダメージ・追撃はどれも同じ対象へ何度も攻撃を届ける形であり、そのどれかが観測を
 *   再発行すれば「攻撃される直前」のPSが1回の攻撃で複数回候補化して実行ガードを
 *   押し上げる（`12_テスト戦略.md`「SKL_SHIRANA_SORA_PS2」の記録が指す退行）。
 * - **少ない方**（欠落）: ある経路（AS/EX・チャージ解放・PS）が観測を発行しなく
 *   なっても、重複と発行位置の検査だけは通ってしまう。実際に攻撃を受けた対象が
 *   その攻撃の観測を持つことを併せて要求し、経路ごと丸ごと欠落する退行を弾く。
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

function scopeOf(event: BattleLogEvent): string {
  return String(event.skillUseId ?? "no-skill-use");
}

function detailsOf(event: BattleLogEvent): Record<string, unknown> {
  return event.details as Record<string, unknown>;
}

/** 観測・ヒットを突き合わせる単位（同じスキル使用の同じ対象）。 */
function pairKey(event: BattleLogEvent, targetField: string): string {
  return `${scopeOf(event)}:${String(detailsOf(event)[targetField])}`;
}

describe("pre-attack observation audit (R-ATM-03)", () => {
  it("IT-AUDIT-ATM-001 [R-ATM-03] (R-ATM-03 #1/#3/#6, 08_ドメインイベント.md 不変条件#5): every production battle emits UnitBeingAttacked exactly once per skill use per attacked target, always before that skill use's first hit", () => {
    const duplicates: string[] = [];
    const lateObservations: string[] = [];
    const unobservedHits: string[] = [];
    let observations = 0;
    let hits = 0;
    // 空振り防止をスキル種別ごとに立てる。ある経路だけが観測を止めた退行は、
    // 合計件数（`observations > 0`）では検出できない。
    const observedSkillTypes = new Set<string>();

    for (const battle of BATTLES) {
      const seen = new Set<string>();
      // スキル使用ごとに、そのスキル使用が最初にヒットへ到達した位置（命中判定）。
      const firstHitSequence = new Map<string, number>();
      // R-ATM-03 #6: 引き寄せ・肩代わり（`DamageRedirected`）で途中から被弾する
      // ユニットは観測対象に含めない。そのヒットは観測を持たなくてよい。
      const redirectedTargets = new Set<string>();

      for (const event of battle.result.events) {
        if (event.type === "DAMAGE_REDIRECTED") {
          redirectedTargets.add(pairKey(event, "newTargetUnitId"));
          continue;
        }
        if (event.type !== "HIT_CONFIRMED" && event.type !== "EVASION_ACTIVATED") {
          continue;
        }
        if (!firstHitSequence.has(scopeOf(event))) {
          firstHitSequence.set(scopeOf(event), event.sequence);
        }
      }

      for (const event of battle.result.events) {
        if (event.type !== "UNIT_BEING_ATTACKED") {
          continue;
        }
        observations++;
        const skillType = detailsOf(event)["skillType"];
        observedSkillTypes.add(typeof skillType === "string" ? skillType : "none");
        const key = pairKey(event, "targetUnitId");
        if (seen.has(key)) {
          duplicates.push(`${battle.unitDefinitionId} seq=${event.sequence} ${key}`);
        }
        seen.add(key);
        // R-ATM-03 #1: 効果処理フェーズの開始前 — つまりそのスキル使用のどのヒットよりも前。
        const firstHit = firstHitSequence.get(scopeOf(event));
        if (firstHit !== undefined && event.sequence > firstHit) {
          lateObservations.push(
            `${battle.unitDefinitionId} seq=${event.sequence} ${key} follows the first hit at seq=${firstHit}`,
          );
        }
      }

      // 逆向き: 実際にヒット列へ到達した対象は、同じスキル使用の観測を持つ。
      // リンク・反射（`R-LNK-02`／`R-INT-03`）は確定済みダメージの転写でヒット列
      // （`HitConfirmed`）を通らないためこの走査に現れない。`LAST_ACTION_TARGETS`／
      // `LAST_DAMAGED_TARGETS` でDAMAGEを撃つ定義は現行production Catalogに存在
      // しないため（存在すればR-ATM-03 #6により観測を持たず、ここで検出される）、
      // 例外は`DamageRedirected`だけを許す。
      for (const event of battle.result.events) {
        if (event.type !== "HIT_CONFIRMED" && event.type !== "EVASION_ACTIVATED") {
          continue;
        }
        hits++;
        const key = pairKey(event, "targetUnitId");
        if (!seen.has(key) && !redirectedTargets.has(key)) {
          unobservedHits.push(`${battle.unitDefinitionId} seq=${event.sequence} ${key}`);
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
    expect(
      unobservedHits,
      `hits whose target was never observed by the same skill use: ${JSON.stringify(unobservedHits.slice(0, 20))}`,
    ).toEqual([]);
    // 空振り防止: 観測とヒットの両方が実データに存在し、AS・EX・PSのどの経路でも
    // 観測が発行されていること（チャージ解放は`skillType`が元スキルのAS/EXのままで
    // ログから切り分けられないため、`action-charge-resolver.test.ts`の
    // `UT-R-ATM-03-011`が実経路の発行を直接固定する）。
    expect(observations).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    expect([...observedSkillTypes].sort()).toEqual(["AS", "EX", "PS"]);
  });
});
