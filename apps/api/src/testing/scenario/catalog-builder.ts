import {
  createSkillDefinitionId,
  type EffectActionDefinitionId,
  type MemoryDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { exSkillDefinition } from "./definition-builders.js";

/**
 * `BattleCatalog` ポートを満たす、テスト専用のインメモリCatalog。合成した定義グラフを
 * そのまま返し、`loadSnapshot`の呼び出し回数を記録する（Applicationテストが
 * 「Catalogを戦闘中に再取得しない」ことを検証できる）。`CatalogBuilder.build()`が生成する。
 */
export class TestBattleCatalog implements BattleCatalog {
  loadSnapshotCallCount = 0;
  private readonly snapshot: BattleCatalogSnapshot;

  constructor(snapshot: BattleCatalogSnapshot) {
    this.snapshot = snapshot;
  }

  get catalogRevision(): string {
    return this.snapshot.catalogRevision;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    this.loadSnapshotCallCount++;
    return this.snapshot;
  }
}

/**
 * 合成Catalogを組み立てるBuilder（`12_テスト戦略.md`「テストCatalog」）。Unit/Skill/
 * EffectAction/Memory を宣言的に追加し、`build()` で `TestBattleCatalog` を返す。
 * Unitが参照するEXスキルが未登録の場合、副作用のない既定EXスキルを自動補完する
 * （最小戦闘の記述量を減らすための便宜。`DefaultUnitDefinitionMap`と同じ思想）。
 */
export class CatalogBuilder {
  private readonly units = new Map<UnitDefinitionId, UnitDefinition>();
  private readonly skills = new Map<SkillDefinitionId, SkillDefinition>();
  private readonly effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>();
  private readonly memories = new Map<MemoryDefinitionId, MemoryDefinition>();
  private catalogRevision = "test-rev-1";

  withRevision(revision: string): this {
    this.catalogRevision = revision;
    return this;
  }

  withUnit(...units: readonly UnitDefinition[]): this {
    for (const unit of units) {
      this.units.set(unit.unitDefinitionId, unit);
    }
    return this;
  }

  withSkill(...skills: readonly SkillDefinition[]): this {
    for (const skill of skills) {
      this.skills.set(skill.skillDefinitionId, skill);
    }
    return this;
  }

  withEffectAction(...effectActions: readonly EffectActionDefinition[]): this {
    for (const effectAction of effectActions) {
      this.effectActions.set(effectAction.effectActionDefinitionId, effectAction);
    }
    return this;
  }

  withMemory(...memories: readonly MemoryDefinition[]): this {
    for (const memory of memories) {
      this.memories.set(memory.memoryDefinitionId, memory);
    }
    return this;
  }

  build(): TestBattleCatalog {
    for (const unit of this.units.values()) {
      if (!this.skills.has(unit.extraSkillDefinitionId)) {
        this.skills.set(
          unit.extraSkillDefinitionId,
          exSkillDefinition(String(unit.extraSkillDefinitionId)),
        );
      }
    }
    return new TestBattleCatalog({
      catalogRevision: this.catalogRevision,
      units: new Map(this.units),
      skills: new Map(this.skills),
      effectActions: new Map(this.effectActions),
      memories: new Map(this.memories),
    });
  }
}

/** `createSkillDefinitionId` を再輸出（Builder利用側の import を1本化する）。 */
export { createSkillDefinitionId };
