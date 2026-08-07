import type {
  EffectActionDefinitionId,
  MemoryDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import { collectEffectActionReferences } from "../definitions/effect-step-walk.js";
import type { MemoryDefinition } from "../definitions/memory-definition.js";
import { toReadonlyMap } from "../../shared/readonly-map.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { UnitDefinition } from "../definitions/unit-definition.js";
import {
  CatalogIntegrityError,
  type CatalogIntegrityViolation,
} from "./catalog-integrity-violation.js";
import { validateEffectAction } from "./effect-action-integrity.js";
import { validateMemory } from "./memory-integrity.js";
import { validateSkill } from "./skill-integrity.js";
import { validateUnit } from "./unit-integrity.js";

/**
 * Whole-Catalog structural/semantic validation (`11_インフラストラクチャ設計.md`
 * の読み込み段階: Resolve → Semantic). Operates on already Shape-and-Domain
 * validated per-item Definitions (`catalog-definition-mapper.ts`); this module
 * only checks invariants that require seeing every file at once — ID
 * uniqueness across a whole file, Unit→Skill / Skill・Memory→EffectAction
 * reference existence, EX skill cost agreement, and the
 * `TriggerDefinition.eventType` closed list that
 * `trigger-definition.ts` explicitly defers here (issue #7).
 *
 * このmoduleは索引の構築と定義種別ごとの検証moduleの呼び出しだけを持ち、規則そのものは
 * 次のmoduleが持つ。Catalogの利用側はこのmoduleをfacadeとして参照する。
 *
 * - 走査基盤: `definitions/effect-step-walk.ts`（EffectStepツリーの唯一の降下経路）／
 *   `condition-inspection.ts`／`effect-step-inspection.ts`／
 *   `target-reference-cardinality.ts`／`effect-action-inspection.ts`
 * - 規則: `effect-sequence-integrity.ts`（EffectSequence共通）／
 *   `last-result-data-flow.ts`／`trigger-integrity.ts`／`effect-action-integrity.ts`／`skill-integrity.ts`／
 *   `unit-integrity.ts`／`memory-integrity.ts`
 */

export {
  CatalogIntegrityError,
  VIOLATION_RULES,
  type CatalogIntegrityRule,
  type CatalogIntegrityViolation,
} from "./catalog-integrity-violation.js";
export { collectEffectActionReferences };

export interface CatalogDefinitions {
  readonly units: readonly UnitDefinition[];
  readonly skills: readonly SkillDefinition[];
  readonly effectActions: readonly EffectActionDefinition[];
  readonly memories: readonly MemoryDefinition[];
}

export interface CatalogIndex {
  readonly units: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
  readonly memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>;
}

function indexById<Id extends string, Def>(
  definitions: readonly Def[],
  idOf: (def: Def) => Id,
  typeName: string,
  violations: CatalogIntegrityViolation[],
): Map<Id, Def> {
  const map = new Map<Id, Def>();
  for (const def of definitions) {
    const id = idOf(def);
    if (map.has(id)) {
      violations.push({
        targetId: id,
        rule: "DUPLICATE_ID",
        message: `duplicate ${typeName} id "${id}"`,
      });
      continue;
    }
    map.set(id, def);
  }
  return map;
}

export function buildCatalogIndex(definitions: CatalogDefinitions): CatalogIndex {
  const violations: CatalogIntegrityViolation[] = [];

  const effectActions = indexById(
    definitions.effectActions,
    (e) => e.effectActionDefinitionId,
    "EffectAction",
    violations,
  );
  const skills = indexById(definitions.skills, (s) => s.skillDefinitionId, "Skill", violations);
  const units = indexById(definitions.units, (u) => u.unitDefinitionId, "Unit", violations);
  const memories = indexById(
    definitions.memories,
    (m) => m.memoryDefinitionId,
    "Memory",
    violations,
  );

  for (const effectAction of effectActions.values()) {
    validateEffectAction(effectAction, effectActions, skills, violations);
  }
  for (const skill of skills.values()) {
    validateSkill(skill, effectActions, violations);
  }
  for (const unit of units.values()) {
    validateUnit(unit, skills, effectActions, violations);
  }
  for (const memory of memories.values()) {
    validateMemory(memory, effectActions, violations);
  }

  if (violations.length > 0) {
    throw new CatalogIntegrityError(violations);
  }

  return {
    units: toReadonlyMap(units),
    skills: toReadonlyMap(skills),
    effectActions: toReadonlyMap(effectActions),
    memories: toReadonlyMap(memories),
  };
}
