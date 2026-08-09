import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_MOMOZONO_NEW_YEAR`（桃園家のお正月）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 物理型の味方へ攻撃力+1250、敏捷型の味方へ攻撃力+1250。同じstat・同じ効果量を
 * ユニット種別だけで振り分けるため、片方の対象集合がもう片方へ漏れないことが要点になる
 * （EN型の2スロットはどちらの効果も受け取らない）。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_MOMOZONO_NEW_YEAR";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_MOMOZONO_NEW_YEAR_AGILE_ATK_UP",
    unitIds: ["ally:FRONT_CENTER", "ally:BACK_RIGHT"],
    magnitude: 1250,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_MOMOZONO_NEW_YEAR_PHYSICAL_ATK_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:BACK_CENTER"],
    magnitude: 1250,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_MOMOZONO_NEW_YEAR (桃園家のお正月)", () => {
  it("IT-MEM-MOMOZONO-NEW-YEAR-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-MOMOZONO-NEW-YEAR-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-MOMOZONO-NEW-YEAR-003: every EffectAction this Memory declares was actually executed", () => {
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
});
