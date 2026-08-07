import { describe, expect, it } from "vitest";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";

/**
 * `MEM_ABSOLUTE_ORDER`（絶対命令行使権！）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * PHYSICAL_ATTACKERロールへ物理与ダメージ+2.5%、PHYSICALユニット種別へ会心率+5%。ロール軸とユニット種別軸で対象数が変わる。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_ABSOLUTE_ORDER";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_ABSOLUTE_ORDER_PHYSICAL_ATTACKER_DMG_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 0.025,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_ABSOLUTE_ORDER_PHYSICAL_CRIT_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:BACK_CENTER"],
    magnitude: 0.05,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_ABSOLUTE_ORDER (絶対命令行使権！)", () => {
  it("IT-MEM-ABSOLUTE-ORDER-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY")).toEqual(EXPECTED_GRANTS);
  });

  it("IT-MEM-ABSOLUTE-ORDER-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });
});
