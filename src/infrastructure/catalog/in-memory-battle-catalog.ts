import type { CapabilityDefinition } from "../../domain/catalog/capability-definition.js";
import type {
  CapabilityId,
  EffectActionDefinitionId,
  MemoryDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/catalog-ids.js";
import {
  collectEffectActionReferences,
  type CatalogIndex,
} from "../../domain/catalog/catalog-integrity.js";
import type { EffectActionDefinition } from "../../domain/catalog/effect-action-definition.js";
import type { MemoryDefinition } from "../../domain/catalog/memory-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { toReadonlyMap } from "../../domain/shared/readonly-map.js";
import type { SkillDefinition } from "../../domain/catalog/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/unit-definition.js";

/**
 * `BattleCatalog` Port adapter (`09_アプリケーション設計.md`,
 * `11_インフラストラクチャ設計.md` の InMemoryBattleCatalog). Wraps an
 * already-validated `CatalogIndex` (`catalog-integrity.ts`) so `loadSnapshot`
 * never touches the filesystem — the whole Catalog is read and verified once
 * at process/Worker startup by `catalog-file-loader.ts`.
 */
export class InMemoryBattleCatalog implements BattleCatalog {
  readonly catalogRevision: string;
  private readonly index: CatalogIndex;

  constructor(catalogRevision: string, index: CatalogIndex) {
    this.catalogRevision = catalogRevision;
    this.index = index;
  }

  loadSnapshot(
    unitDefinitionIds: readonly UnitDefinitionId[],
    memoryDefinitionIds: readonly MemoryDefinitionId[],
  ): BattleCatalogSnapshot {
    const units = new Map<UnitDefinitionId, UnitDefinition>();
    const skills = new Map<SkillDefinitionId, SkillDefinition>();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>();
    const memories = new Map<MemoryDefinitionId, MemoryDefinition>();
    const capabilities = new Map<CapabilityId, CapabilityDefinition>();

    const includeCapability = (capabilityId: CapabilityId): void => {
      if (capabilities.has(capabilityId)) {
        return;
      }
      const capability = this.index.capabilities.get(capabilityId);
      if (capability !== undefined) {
        capabilities.set(capabilityId, capability);
      }
    };

    const includeEffectAction = (effectActionId: EffectActionDefinitionId): void => {
      if (effectActions.has(effectActionId)) {
        return;
      }
      const effectAction = this.index.effectActions.get(effectActionId);
      if (effectAction === undefined) {
        return;
      }
      effectActions.set(effectActionId, effectAction);
      for (const capabilityId of effectAction.requiredCapabilities) {
        includeCapability(capabilityId);
      }
    };

    const includeSkill = (skillId: SkillDefinitionId): void => {
      if (skills.has(skillId)) {
        return;
      }
      const skill = this.index.skills.get(skillId);
      if (skill === undefined) {
        return;
      }
      skills.set(skillId, skill);
      const stepGroups =
        skill.resolution.kind === "CHARGE"
          ? [skill.resolution.steps, skill.resolution.chargeRelease.steps]
          : [skill.resolution.steps];
      for (const steps of stepGroups) {
        for (const ref of collectEffectActionReferences(steps)) {
          includeEffectAction(ref.effectActionDefinitionId);
        }
      }
      for (const capabilityId of skill.requiredCapabilities) {
        includeCapability(capabilityId);
      }
    };

    for (const unitId of unitDefinitionIds) {
      const unit = this.index.units.get(unitId);
      if (unit === undefined) {
        continue;
      }
      units.set(unitId, unit);
      for (const capabilityId of unit.requiredCapabilities) {
        includeCapability(capabilityId);
      }
      for (const skillId of [
        ...unit.activeSkillDefinitionIds,
        ...unit.passiveSkillDefinitionIds,
        unit.extraSkillDefinitionId,
      ]) {
        includeSkill(skillId);
      }
    }

    for (const memoryId of memoryDefinitionIds) {
      const memory = this.index.memories.get(memoryId);
      if (memory === undefined) {
        continue;
      }
      memories.set(memoryId, memory);
      for (const capabilityId of memory.requiredCapabilities) {
        includeCapability(capabilityId);
      }
      for (const triggeredEffect of memory.triggeredEffects) {
        for (const ref of collectEffectActionReferences(triggeredEffect.effectSequence.steps)) {
          includeEffectAction(ref.effectActionDefinitionId);
        }
      }
    }

    return {
      catalogRevision: this.catalogRevision,
      units: toReadonlyMap(units),
      skills: toReadonlyMap(skills),
      effectActions: toReadonlyMap(effectActions),
      memories: toReadonlyMap(memories),
      capabilities: toReadonlyMap(capabilities),
    };
  }
}
