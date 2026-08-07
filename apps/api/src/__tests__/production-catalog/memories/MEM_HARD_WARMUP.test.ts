import { describe, expect, it } from "vitest";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";

/**
 * `MEM_HARD_WARMUP`（ハードな準備運動……？）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 前衛へ攻撃力+4%、後衛へ+2.5%。行を分ける2件の`APPLY_STAT_MOD`だけで構成され、両者の対象集合は重ならない。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_HARD_WARMUP";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_HARD_WARMUP_BACK_ATK_UP",
    unitIds: ["ally:BACK_LEFT", "ally:BACK_CENTER", "ally:BACK_RIGHT"],
    magnitude: 0.025,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_HARD_WARMUP_FRONT_ATK_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:FRONT_CENTER", "ally:FRONT_RIGHT"],
    magnitude: 0.04,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_HARD_WARMUP (ハードな準備運動……？)", () => {
  it("IT-MEM-HARD-WARMUP-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY")).toEqual(EXPECTED_GRANTS);
  });

  it("IT-MEM-HARD-WARMUP-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });
});
