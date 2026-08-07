import { describe, expect, it } from "vitest";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";

/**
 * `MEM_EURO_TOWER_DAY`（１日ユーロ・タワー体験）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * SUPPORTロールへ攻撃力+4%（割合）、後衛の中央・右へ攻撃力+1250（固定値）。ロール絞りと位置絞りが別々の集合を選ぶ。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_EURO_TOWER_DAY";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_EURO_TOWER_DAY_BACK_CENTER_RIGHT_ATK_UP",
    unitIds: ["ally:BACK_CENTER", "ally:BACK_RIGHT"],
    magnitude: 1250,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_EURO_TOWER_DAY_SUPPORT_ATK_UP",
    unitIds: ["ally:FRONT_RIGHT", "ally:BACK_CENTER"],
    magnitude: 0.04,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_EURO_TOWER_DAY (１日ユーロ・タワー体験)", () => {
  it("IT-MEM-EURO-TOWER-DAY-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY")).toEqual(EXPECTED_GRANTS);
  });

  it("IT-MEM-EURO-TOWER-DAY-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });
});
