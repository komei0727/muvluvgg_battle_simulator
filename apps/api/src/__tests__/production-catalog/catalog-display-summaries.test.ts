import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import { loadBattleCatalogDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { PRODUCTION_CATALOG_DIR } from "../../testing/production-unit/skill-behaviour.js";

/**
 * Catalog一覧の`skills`/`effects`は、UIが戦闘ログの定義IDを表示名へ読み替える
 * 唯一の材料である。要約から漏れた定義はUIで論理名のまま表示されるため、
 * 本番Catalogの全定義が載り、枠ラベルがユニット定義の並び順と一致することを
 * 全件で確かめる。
 */

interface RawUnit {
  readonly unitDefinitionId: string;
  readonly activeSkillDefinitionIds: readonly string[];
  readonly passiveSkillDefinitionIds: readonly string[];
  readonly extraSkillDefinitionId: string;
}

function readJson<T>(fileName: string): T {
  return JSON.parse(readFileSync(`${PRODUCTION_CATALOG_DIR}/${fileName}`, "utf8")) as T;
}

const result = new GetBattleSimulationCatalogUseCase({
  battleCatalogDirectory: loadBattleCatalogDirectory(PRODUCTION_CATALOG_DIR),
}).execute();

describe("production Catalog display summaries", () => {
  it("UT-CATALOG-LABEL-008: publishes a summary for every production Skill and EffectAction", () => {
    const skillIds = readJson<{ skillDefinitionId: string }[]>("skills.json").map(
      (skill) => skill.skillDefinitionId,
    );
    const effectIds = readJson<{ effectActionDefinitionId: string }[]>("effects.json").map(
      (effect) => effect.effectActionDefinitionId,
    );

    expect(result.skills.map((skill) => skill.skillDefinitionId)).toEqual(
      [...skillIds].sort((a, b) => a.localeCompare(b)),
    );
    expect(result.effects.map((effect) => effect.effectActionDefinitionId)).toEqual(
      [...effectIds].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("UT-CATALOG-LABEL-009: gives every production Skill the owner and slot label of its declaring unit's skill lists", () => {
    const expected = new Map<string, { ownerUnitDefinitionId: string; slotLabel: string }>();
    for (const unit of readJson<RawUnit[]>("units.json")) {
      const owner = unit.unitDefinitionId;
      unit.activeSkillDefinitionIds.forEach((id, index) => {
        expected.set(id, { ownerUnitDefinitionId: owner, slotLabel: `AS${String(index + 1)}` });
      });
      unit.passiveSkillDefinitionIds.forEach((id, index) => {
        expected.set(id, { ownerUnitDefinitionId: owner, slotLabel: `PS${String(index + 1)}` });
      });
      expected.set(unit.extraSkillDefinitionId, { ownerUnitDefinitionId: owner, slotLabel: "EX" });
    }

    for (const skill of result.skills) {
      expect(
        { ownerUnitDefinitionId: skill.ownerUnitDefinitionId, slotLabel: skill.slotLabel },
        skill.skillDefinitionId,
      ).toEqual(expected.get(skill.skillDefinitionId));
    }
  });
});
