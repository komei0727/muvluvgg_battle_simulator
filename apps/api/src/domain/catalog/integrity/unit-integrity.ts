import type { CapabilityDefinition } from "../capability/capability-definition.js";
import type {
  CapabilityId,
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import { collectEffectActionReferences } from "../definitions/effect-step-walk.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { UnitDefinition } from "../definitions/unit-definition.js";
import { checkRequiredCapabilities } from "./capability-declaration-integrity.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";

function checkNoDuplicateSkillReferences(
  skillIds: readonly SkillDefinitionId[],
  listName: string,
  unitId: string,
  violations: CatalogIntegrityViolation[],
): void {
  const seen = new Set<SkillDefinitionId>();
  for (const id of skillIds) {
    if (seen.has(id)) {
      violations.push({
        targetId: unitId,
        rule: "DUPLICATE_SKILL_REFERENCE",
        message: `${listName} lists "${id}" more than once, making definition order ambiguous`,
      });
    }
    seen.add(id);
  }
}

function validateSkillReference(
  skillId: SkillDefinitionId,
  expectedSkillType: SkillDefinition["skillType"],
  unitId: string,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  violations: CatalogIntegrityViolation[],
): SkillDefinition | undefined {
  const skill = skills.get(skillId);
  if (skill === undefined) {
    violations.push({
      targetId: unitId,
      rule: "DANGLING_REFERENCE",
      message: `references undefined SkillDefinition "${skillId}"`,
    });
    return undefined;
  }
  if (skill.skillType !== expectedSkillType) {
    violations.push({
      targetId: unitId,
      rule: "TYPE_MISMATCH",
      message: `references Skill "${skillId}" with skillType "${skill.skillType}", expected "${expectedSkillType}"`,
    });
    return undefined;
  }
  return skill;
}

/**
 * Issue #129 「所有関係をpreflightで検証する」: Unitが所有するAS/PS/EXから
 * 到達可能な`COOLDOWN_MANIPULATION`が、同じUnitが所有するスキルだけを対象に
 * できることを検証する。対象スキルの存在自体は`validateEffectAction`の
 * `DANGLING_REFERENCE`が既に担うため、ここでは「存在するが他Unit所有」の
 * ケースだけを扱う。
 */
function checkCooldownManipulationOwnership(
  unit: UnitDefinition,
  ownedSkillIds: ReadonlySet<SkillDefinitionId>,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  for (const skillId of ownedSkillIds) {
    const skill = skills.get(skillId);
    if (skill === undefined) {
      continue;
    }
    const refs = [
      ...collectEffectActionReferences(skill.resolution.steps),
      ...(skill.resolution.kind === "CHARGE"
        ? collectEffectActionReferences(skill.resolution.chargeRelease.steps)
        : []),
    ];
    for (const ref of refs) {
      const effectAction = effectActions.get(ref.effectActionDefinitionId);
      if (effectAction?.kind !== "COOLDOWN_MANIPULATION") {
        continue;
      }
      const targetSkillDefinitionId = effectAction.payload.targetSkillDefinitionId;
      if (skills.has(targetSkillDefinitionId) && !ownedSkillIds.has(targetSkillDefinitionId)) {
        violations.push({
          targetId: unit.unitDefinitionId,
          rule: "UNOWNED_SKILL_REFERENCE",
          message: `EffectAction "${effectAction.effectActionDefinitionId}" (COOLDOWN_MANIPULATION) targets SkillDefinition "${targetSkillDefinitionId}", which is not owned by unit "${unit.unitDefinitionId}"`,
        });
      }
    }
  }
}

export function validateUnit(
  unit: UnitDefinition,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  checkNoDuplicateSkillReferences(
    unit.activeSkillDefinitionIds,
    "activeSkillDefinitionIds",
    unit.unitDefinitionId,
    violations,
  );
  checkNoDuplicateSkillReferences(
    unit.passiveSkillDefinitionIds,
    "passiveSkillDefinitionIds",
    unit.unitDefinitionId,
    violations,
  );

  for (const skillId of unit.activeSkillDefinitionIds) {
    validateSkillReference(skillId, "AS", unit.unitDefinitionId, skills, violations);
  }
  for (const skillId of unit.passiveSkillDefinitionIds) {
    validateSkillReference(skillId, "PS", unit.unitDefinitionId, skills, violations);
  }
  const exSkill = validateSkillReference(
    unit.extraSkillDefinitionId,
    "EX",
    unit.unitDefinitionId,
    skills,
    violations,
  );
  if (exSkill !== undefined && exSkill.cost.amount !== unit.extraGaugeMaximum) {
    violations.push({
      targetId: unit.unitDefinitionId,
      rule: "EX_COST_MISMATCH",
      message: `EX skill "${exSkill.skillDefinitionId}" cost.amount (${exSkill.cost.amount}) does not match extraGaugeMaximum (${unit.extraGaugeMaximum})`,
    });
  }

  checkRequiredCapabilities(
    unit.requiredCapabilities,
    unit.unitDefinitionId,
    capabilities,
    violations,
  );

  const ownedSkillIds = new Set<SkillDefinitionId>([
    ...unit.activeSkillDefinitionIds,
    ...unit.passiveSkillDefinitionIds,
    unit.extraSkillDefinitionId,
  ]);
  checkCooldownManipulationOwnership(unit, ownedSkillIds, skills, effectActions, violations);
}
