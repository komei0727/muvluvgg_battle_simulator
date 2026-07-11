import type { CapabilityDefinition } from "./capability-definition.js";
import type { CapabilityId, MemoryDefinitionId, UnitDefinitionId } from "./catalog-ids.js";
import { collectEffectActionReferences, type CatalogIndex } from "./catalog-integrity.js";
import type { SkillDefinition } from "./skill-definition.js";

/**
 * `実装済みCapability比較器` (`13_実装計画.md` M1実装項目7). Given a selected
 * Unit/Memory graph, transitively collects every `requiredCapabilities`
 * reachable through Skill and EffectAction references, then compares it
 * against `capabilities.json`'s `IMPLEMENTED` set. The caller (a future
 * `SimulationPreflightValidator`, `09_アプリケーション設計.md`) turns a
 * non-empty unimplemented result into `UNSUPPORTED_RULE` — this module only
 * computes the set, since it has no knowledge of HTTP/Application error
 * shapes.
 */

function skillRequiredCapabilities(
  skill: SkillDefinition,
  index: CatalogIndex,
): readonly CapabilityId[] {
  const ids: CapabilityId[] = [...skill.requiredCapabilities];
  const stepGroups =
    skill.resolution.kind === "CHARGE"
      ? [skill.resolution.steps, skill.resolution.chargeRelease.steps]
      : [skill.resolution.steps];
  for (const steps of stepGroups) {
    for (const ref of collectEffectActionReferences(steps)) {
      const effectAction = index.effectActions.get(ref.effectActionDefinitionId);
      if (effectAction !== undefined) {
        ids.push(...effectAction.requiredCapabilities);
      }
    }
  }
  return ids;
}

export function collectRequiredCapabilities(
  index: CatalogIndex,
  unitDefinitionIds: readonly UnitDefinitionId[],
  memoryDefinitionIds: readonly MemoryDefinitionId[],
): ReadonlySet<CapabilityId> {
  const required = new Set<CapabilityId>();
  const addAll = (ids: readonly CapabilityId[]): void => {
    for (const id of ids) {
      required.add(id);
    }
  };

  for (const unitId of unitDefinitionIds) {
    const unit = index.units.get(unitId);
    if (unit === undefined) {
      continue;
    }
    addAll(unit.requiredCapabilities);
    const skillIds = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    for (const skillId of skillIds) {
      const skill = index.skills.get(skillId);
      if (skill !== undefined) {
        addAll(skillRequiredCapabilities(skill, index));
      }
    }
  }

  for (const memoryId of memoryDefinitionIds) {
    const memory = index.memories.get(memoryId);
    if (memory === undefined) {
      continue;
    }
    addAll(memory.requiredCapabilities);
    for (const triggeredEffect of memory.triggeredEffects) {
      for (const ref of collectEffectActionReferences(triggeredEffect.effectSequence.steps)) {
        const effectAction = index.effectActions.get(ref.effectActionDefinitionId);
        if (effectAction !== undefined) {
          addAll(effectAction.requiredCapabilities);
        }
      }
    }
  }

  return required;
}

export function findUnimplementedCapabilities(
  requiredCapabilities: ReadonlySet<CapabilityId>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
): readonly CapabilityId[] {
  const unimplemented: CapabilityId[] = [];
  for (const id of requiredCapabilities) {
    const capability = capabilities.get(id);
    if (capability === undefined || capability.status !== "IMPLEMENTED") {
      unimplemented.push(id);
    }
  }
  return unimplemented;
}
