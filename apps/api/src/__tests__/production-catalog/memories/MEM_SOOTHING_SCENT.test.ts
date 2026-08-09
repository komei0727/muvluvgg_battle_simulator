import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  MEMORY_COMBAT_STATS,
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_SOOTHING_SCENT`（安心する香り）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * ENアタッカーへEN与ダメージ+3.5%、左列後衛へ攻撃力+2500を**1行動の間**。
 * 盤面では両方が`BACK_LEFT`へ重なるが、片方はROLE、もう片方は行と列の
 * 2フィルタで同じ1体を選んでいる。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_SOOTHING_SCENT";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_SOOTHING_SCENT_BACK_LEFT_ATK_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 2500,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SOOTHING_SCENT_EN_ATTACKER_EN_DMG_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 0.035,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_SOOTHING_SCENT (安心する香り)", () => {
  it("IT-MEM-SOOTHING-SCENT-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 攻撃力の上昇は左列後衛だけ。中央列・右列の後衛には乗らない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_LEFT" ? 2500 : 0),
      );
    }
  });

  it("IT-MEM-SOOTHING-SCENT-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-SOOTHING-SCENT-003: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY").executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-SOOTHING-SCENT-004 (R-MEM-04/R-EFF-01): only the ATTACK buff carries the one-action time limit, and its owner is the holder because a Memory has no granter unit", () => {
    // 原文「左列後衛の味方の攻撃力を1行動の間2500上昇させる」の「1行動の間」は
    // 攻撃力バフだけに掛かる修飾で、EN与ダメージ補正は戦闘終了まで残る。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    const backLeft = observed.started.allyUnits.find(
      (unit) => unit.battleUnitId === "ally:BACK_LEFT",
    );

    const attackBuff = backLeft?.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === "ACT_MEM_SOOTHING_SCENT_BACK_LEFT_ATK_UP",
    );
    expect(attackBuff?.sourceUnitId).toBeUndefined();
    // `owner: EFFECT_SOURCE`は付与者ユニットの行動を減算契機にする宣言で、Memoryでは
    // 付与者が存在しないため期間の所有者は効果の保持者自身になる。
    expect(attackBuff?.duration.definition.timeLimit).toEqual({
      unit: "ACTION",
      count: 1,
      owner: "EFFECT_TARGET",
    });
    expect(attackBuff?.duration.timeLimitRemaining).toBe(1);

    const damageMod = backLeft?.appliedEffects.find(
      (effect) =>
        effect.effectActionDefinitionId === "ACT_MEM_SOOTHING_SCENT_EN_ATTACKER_EN_DMG_UP",
    );
    expect(damageMod?.sourceUnitId).toBeUndefined();
    expect(damageMod?.duration.definition.timeLimit).toEqual({ unit: "BATTLE", count: 1 });
  });
});
