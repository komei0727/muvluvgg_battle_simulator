import { describe, expect, it } from "vitest";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";

/**
 * `MEM_TIMID_REINDEER_EVE`（臆病トナカイの聖夜）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 後衛へ会心ダメージ+15%、陣営全体へ会心率+5%。行で絞る効果と全体効果が重なり、後衛は2件を同時に保持する。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_TIMID_REINDEER_EVE";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_TIMID_REINDEER_EVE_ALL_CRIT_UP",
    unitIds: [
      "ally:FRONT_LEFT",
      "ally:FRONT_CENTER",
      "ally:FRONT_RIGHT",
      "ally:BACK_LEFT",
      "ally:BACK_CENTER",
      "ally:BACK_RIGHT",
    ],
    magnitude: 0.05,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_TIMID_REINDEER_EVE_BACK_CRIT_DMG_UP",
    unitIds: ["ally:BACK_LEFT", "ally:BACK_CENTER", "ally:BACK_RIGHT"],
    magnitude: 0.15,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_TIMID_REINDEER_EVE (臆病トナカイの聖夜)", () => {
  it("IT-MEM-TIMID-REINDEER-EVE-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY")).toEqual(EXPECTED_GRANTS);
  });

  it("IT-MEM-TIMID-REINDEER-EVE-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });
});
