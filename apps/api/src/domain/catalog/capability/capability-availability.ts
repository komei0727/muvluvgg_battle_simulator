import type { CapabilityDefinition } from "./capability-definition.js";
import type {
  CapabilityId,
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../definitions/catalog-ids.js";
import {
  collectEffectActionReferences,
  type CatalogIndex,
} from "../integrity/catalog-integrity.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";

/**
 * `実装済みCapability比較器` (`13_実装計画.md` M1実装項目7). Given a selected
 * Unit/Memory graph, transitively collects every `requiredCapabilities`
 * reachable through Skill and EffectAction references, then compares it
 * against `capabilities.json`'s `IMPLEMENTED` set. The caller (a future
 * `SimulationPreflightValidator`, `09_アプリケーション設計.md`) turns a
 * non-empty unimplemented result into `UNSUPPORTED_RULE` — this module only
 * computes the set, since it has no knowledge of HTTP/Application error
 * shapes.
 *
 * R-FRM-06 #5 requires the rejection to name both the Capability ID and the
 * definition ID that required it, so each collected Capability is tracked
 * alongside every definition (Unit/Skill/EffectAction/Memory) that declared
 * it in `requiredCapabilities`.
 */

/** Capability ID -> every definition ID that declared it in `requiredCapabilities`. */
export type RequiredCapabilities = ReadonlyMap<CapabilityId, ReadonlySet<string>>;

function addRequirement(
  target: Map<CapabilityId, Set<string>>,
  capabilityIds: readonly CapabilityId[],
  requiredByDefinitionId: string,
): void {
  for (const capabilityId of capabilityIds) {
    let requiredBy = target.get(capabilityId);
    if (requiredBy === undefined) {
      requiredBy = new Set();
      target.set(capabilityId, requiredBy);
    }
    requiredBy.add(requiredByDefinitionId);
  }
}

function collectSkillRequirements(
  skill: SkillDefinition,
  index: CatalogIndex,
  target: Map<CapabilityId, Set<string>>,
): void {
  addRequirement(target, skill.requiredCapabilities, skill.skillDefinitionId);
  const stepGroups =
    skill.resolution.kind === "CHARGE"
      ? [skill.resolution.steps, skill.resolution.chargeRelease.steps]
      : [skill.resolution.steps];
  for (const steps of stepGroups) {
    for (const ref of collectEffectActionReferences(steps)) {
      const effectAction = index.effectActions.get(ref.effectActionDefinitionId);
      if (effectAction !== undefined) {
        addRequirement(
          target,
          effectAction.requiredCapabilities,
          effectAction.effectActionDefinitionId,
        );
      }
    }
  }
}

export function collectRequiredCapabilities(
  index: CatalogIndex,
  unitDefinitionIds: readonly UnitDefinitionId[],
  memoryDefinitionIds: readonly MemoryDefinitionId[],
): RequiredCapabilities {
  const target = new Map<CapabilityId, Set<string>>();

  for (const unitId of unitDefinitionIds) {
    const unit = index.units.get(unitId);
    if (unit === undefined) {
      continue;
    }
    addRequirement(target, unit.requiredCapabilities, unit.unitDefinitionId);
    const skillIds = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    for (const skillId of skillIds) {
      const skill = index.skills.get(skillId);
      if (skill !== undefined) {
        collectSkillRequirements(skill, index, target);
      }
    }
  }

  for (const memoryId of memoryDefinitionIds) {
    const memory = index.memories.get(memoryId);
    if (memory === undefined) {
      continue;
    }
    addRequirement(target, memory.requiredCapabilities, memory.memoryDefinitionId);
    for (const triggeredEffect of memory.triggeredEffects) {
      for (const ref of collectEffectActionReferences(triggeredEffect.effectSequence.steps)) {
        const effectAction = index.effectActions.get(ref.effectActionDefinitionId);
        if (effectAction !== undefined) {
          addRequirement(
            target,
            effectAction.requiredCapabilities,
            effectAction.effectActionDefinitionId,
          );
        }
      }
    }
  }

  return target;
}

export interface UnimplementedCapability {
  readonly capabilityId: CapabilityId;
  readonly requiredByDefinitionIds: readonly string[];
}

export function findUnimplementedCapabilities(
  requiredCapabilities: RequiredCapabilities,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
): readonly UnimplementedCapability[] {
  const unimplemented: UnimplementedCapability[] = [];
  for (const [capabilityId, requiredBy] of requiredCapabilities) {
    const capability = capabilities.get(capabilityId);
    if (capability === undefined || capability.status !== "IMPLEMENTED") {
      unimplemented.push({ capabilityId, requiredByDefinitionIds: [...requiredBy] });
    }
  }
  return unimplemented;
}
