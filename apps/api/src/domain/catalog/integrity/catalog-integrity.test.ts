import { describe, expect, it } from "vitest";
import {
  createCapabilityDefinition,
  type CapabilityDefinition,
} from "../capability/capability-definition.js";
import {
  buildCatalogIndex,
  CatalogIntegrityError,
  type CatalogDefinitions,
} from "./catalog-integrity.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import { createEffectActionDefinition } from "../definitions/effect-action-definition-factory.js";
import { createMemoryDefinition } from "../definitions/memory-definition.js";
import { createSkillDefinition, type SkillDefinition } from "../definitions/skill-definition.js";
import type { TargetReferenceInput } from "../definitions/references.js";
import type { TargetSelectorDefinitionInput } from "../definitions/target-selector-definition.js";
import { createUnitDefinition, type UnitDefinition } from "../definitions/unit-definition.js";
import type { ConditionDefinitionInput } from "../definitions/condition-definition.js";

function damageAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

function effectImmunityAction(
  id: string,
  referencedEffectActionIds: readonly string[],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "EFFECT_IMMUNITY",
      payload: {
        categories: ["SPECIFIC_EFFECT"],
        effectActionDefinitionIds: referencedEffectActionIds,
        duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
        maxBlocks: null,
      },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

function removeEffectsAction(
  id: string,
  referencedEffectActionIds: readonly string[],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "REMOVE_EFFECTS",
      payload: {
        categories: ["SPECIFIC_EFFECT"],
        effectActionDefinitionIds: referencedEffectActionIds,
      },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

function asSkill(id: string, targetActionId: string): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: targetActionId }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "AS" },
  });
}

function branchSkill(id: string, requiredCapabilities: readonly string[]): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
            },
          ],
          elseSteps: [],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "BRANCH AS" },
  });
}

function targetingSkill(
  selector: TargetSelectorDefinitionInput,
  requiredCapabilities: readonly string[],
  target: TargetReferenceInput = { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
  activationCondition?: ConditionDefinitionInput,
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: "SKL_AS1",
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: "TGT_PRIMARY", selector }],
      steps: [
        {
          kind: "ACTION",
          target,
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    ...(activationCondition === undefined ? {} : { activationCondition }),
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Targeting AS" },
  });
}

function branchMemory(requiredCapabilities: readonly string[]) {
  return createMemoryDefinition({
    memoryDefinitionId: "MEM_BRANCH",
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
        },
        effectSequence: {
          steps: [
            {
              kind: "BRANCH",
              condition: { kind: "TRUE" },
              thenSteps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
                },
              ],
              elseSteps: [],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Branch Memory" },
  });
}

function triggerContextMemory(requiredCapabilities: readonly string[]) {
  return createMemoryDefinition({
    memoryDefinitionId: "MEM_TRIGGER_CONTEXT",
    triggeredEffects: [
      {
        trigger: {
          eventType: "HitPointReduced",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "SELF",
        },
        effectSequence: {
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Trigger Context Memory" },
  });
}

function psSkill(
  id: string,
  eventType: string,
  category: string,
  requiredCapabilities: readonly string[] = [],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    triggers: [{ eventType, category, sourceSelector: "SELF", targetSelector: "SELF" }],
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "PS" },
  });
}

function exSkill(id: string, amount: number): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "EX" },
  });
}

function cooldownManipulationAction(
  id: string,
  targetSkillDefinitionId: string,
  operation: "RESET" | "REDUCE" = "RESET",
  requiredCapabilities: readonly string[] = ["CAP_COOLDOWN_MANIPULATION"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "COOLDOWN_MANIPULATION",
      payload: { targetSkillDefinitionId, operation },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function unit(
  id: string,
  overrides: {
    active?: readonly string[];
    passive?: readonly string[];
    extra?: string;
    extraGaugeMaximum?: number;
    requiredCapabilities?: readonly string[];
  } = {},
): UnitDefinition {
  return createUnitDefinition({
    unitDefinitionId: id,
    attribute: "COMICAL",
    unitType: "AGILE",
    role: "CONTROL",
    positionAptitudes: ["FRONT"],
    baseStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      maximumAp: 4,
      maximumPp: 4,
    },
    extraGaugeMaximum: overrides.extraGaugeMaximum ?? 7,
    activeSkillDefinitionIds: overrides.active ?? ["SKL_AS1"],
    passiveSkillDefinitionIds: overrides.passive ?? [],
    extraSkillDefinitionId: overrides.extra ?? "SKL_EX1",
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    metadata: { displayName: "Unit", characterName: "Character", characterId: "CHAR_1" },
  });
}

function capability(id: string, status = "PLANNED"): CapabilityDefinition {
  return createCapabilityDefinition({
    capabilityId: id,
    schemaStatus: "SUPPORTED",
    runtimeStatus: status,
    implementationTaskId: "TEST-001",
    description: "d",
    verification: { productionDefinitionIds: [], testCaseIds: [] },
  });
}

function baseDefinitions(): CatalogDefinitions {
  return {
    units: [unit("UNIT_001")],
    skills: [asSkill("SKL_AS1", "ACT_DAMAGE_1"), exSkill("SKL_EX1", 7)],
    effectActions: [damageAction("ACT_DAMAGE_1")],
    memories: [],
    capabilities: [],
  };
}

describe("buildCatalogIndex", () => {
  it("UT-CAT-IDX-001: indexes a valid minimal catalog without violations", () => {
    const index = buildCatalogIndex(baseDefinitions());
    expect(index.units.get("UNIT_001" as never)).toBeDefined();
    expect(index.skills.size).toBe(2);
    expect(index.effectActions.size).toBe(1);
  });

  it("UT-CAT-IDX-002: rejects duplicate ids within the same definition type", () => {
    const defs = baseDefinitions();
    const withDup: CatalogDefinitions = {
      ...defs,
      effectActions: [...defs.effectActions, damageAction("ACT_DAMAGE_1")],
    };
    expect(() => buildCatalogIndex(withDup)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDup);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrityError);
      const err = error as CatalogIntegrityError;
      expect(err.violations).toHaveLength(1);
      expect(err.violations[0]?.targetId).toBe("ACT_DAMAGE_1");
      expect(err.violations[0]?.rule).toBe("DUPLICATE_ID");
    }
  });

  it("UT-CAT-IDX-003: rejects a Unit's activeSkillDefinitionIds referencing a missing Skill", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_MISSING"] })],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("UT-CAT-IDX-004: rejects a Unit referencing a Skill of the wrong skillType", () => {
    const defs = baseDefinitions();
    const withWrongType: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_EX1"] })],
    };
    expect(() => buildCatalogIndex(withWrongType)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withWrongType);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("TYPE_MISMATCH");
    }
  });

  it("UT-CAT-IDX-005: rejects an EX skill whose cost.amount does not match the Unit's extraGaugeMaximum", () => {
    const defs = baseDefinitions();
    const mismatched: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { extraGaugeMaximum: 9 })],
    };
    expect(() => buildCatalogIndex(mismatched)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(mismatched);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("EX_COST_MISMATCH");
    }
  });

  it("UT-CAT-IDX-006: rejects a Skill effectSequence referencing a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      skills: [asSkill("SKL_AS1", "ACT_MISSING"), exSkill("SKL_EX1", 7)],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("SKL_AS1");
    }
  });

  it("UT-CAT-IDX-007: rejects a Memory triggeredEffect referencing a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      memories: [
        createMemoryDefinition({
          memoryDefinitionId: "MEM_001",
          triggeredEffects: [
            {
              trigger: {
                eventType: "BattleStarted",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ALLY",
              },
              effectSequence: {
                targetBindings: [
                  {
                    targetBindingId: "TGT_ALL_ALLIES",
                    selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
                  },
                ],
                steps: [
                  {
                    kind: "ACTION",
                    target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
                    actions: [{ effectActionDefinitionId: "ACT_MISSING" }],
                  },
                ],
              },
            },
          ],
          requiredCapabilities: [],
          metadata: { displayName: "Memory" },
        }),
      ],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("MEM_001");
    }
  });

  it("UT-CAT-IDX-008: rejects requiredCapabilities that are not defined in capabilities.json", () => {
    const defs = baseDefinitions();
    const withUnknownCap: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_UNKNOWN"] })],
    };
    expect(() => buildCatalogIndex(withUnknownCap)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withUnknownCap);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("UNKNOWN_CAPABILITY");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("UT-CAT-IDX-009: accepts requiredCapabilities that are defined in capabilities.json", () => {
    const defs = baseDefinitions();
    const withCap: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_HEAL"] })],
      capabilities: [capability("CAP_HEAL", "PLANNED")],
    };
    const index = buildCatalogIndex(withCap);
    expect(index.capabilities.get("CAP_HEAL" as never)?.runtimeStatus).toBe("PLANNED");
  });

  it("UT-CAT-IDX-010: rejects a PS trigger referencing an unknown eventType", () => {
    const defs = baseDefinitions();
    const withUnknownEvent: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
      skills: [...defs.skills, psSkill("SKL_PS1", "NotARealEvent", "FACT")],
    };
    expect(() => buildCatalogIndex(withUnknownEvent)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withUnknownEvent);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("UNKNOWN_EVENT_TYPE");
      expect(err.violations[0]?.targetId).toBe("SKL_PS1");
    }
  });

  it("UT-CAT-IDX-011: rejects a PS trigger whose declared category mismatches the eventType's documented category", () => {
    const defs = baseDefinitions();
    const withMismatch: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
      // UnitBeingAttacked is documented as TIMING, not FACT.
      skills: [
        ...defs.skills,
        psSkill("SKL_PS1", "UnitBeingAttacked", "FACT", ["CAP_TRIGGER_CONTEXT"]),
      ],
      capabilities: [capability("CAP_TRIGGER_CONTEXT")],
    };
    expect(() => buildCatalogIndex(withMismatch)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withMismatch);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("EVENT_CATEGORY_MISMATCH");
    }
  });

  it("UT-CAT-IDX-012: accepts the documented EffectApplied (FACT) trigger", () => {
    const defs = baseDefinitions();
    const withEffectApplied: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
      skills: [
        ...defs.skills,
        psSkill("SKL_PS1", "EffectApplied", "FACT", ["CAP_TRIGGER_CONTEXT"]),
      ],
      capabilities: [capability("CAP_TRIGGER_CONTEXT")],
    };
    const index = buildCatalogIndex(withEffectApplied);
    expect(index.skills.get("SKL_PS1" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-013: rejects a Unit that lists the same Skill id twice in activeSkillDefinitionIds", () => {
    const defs = baseDefinitions();
    const withDupRef: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS1"] })],
    };
    expect(() => buildCatalogIndex(withDupRef)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDupRef);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DUPLICATE_SKILL_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("UT-CAT-IDX-014: collects multiple violations in a single pass", () => {
    const defs = baseDefinitions();
    const multi: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_MISSING"], requiredCapabilities: ["CAP_UNKNOWN"] })],
    };
    try {
      buildCatalogIndex(multi);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("UT-CAT-IDX-015: rejects an EFFECT_IMMUNITY payload.effectActionDefinitionIds referencing a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        effectImmunityAction("ACT_IMMUNITY_1", ["ACT_MISSING"]),
      ],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("ACT_IMMUNITY_1");
    }
  });

  it("UT-CAT-IDX-016: rejects a REMOVE_EFFECTS payload.effectActionDefinitionIds referencing a missing EffectActionDefinition (Issue #44 G-04 follow-up)", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      effectActions: [...defs.effectActions, removeEffectsAction("ACT_REMOVE_1", ["ACT_MISSING"])],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("ACT_REMOVE_1");
    }
  });

  it("UT-CAT-IDX-017: rejects a COOLDOWN_MANIPULATION payload.targetSkillDefinitionId referencing a missing SkillDefinition (Issue #129)", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_CD_RESET")],
      effectActions: [
        ...defs.effectActions,
        cooldownManipulationAction("ACT_CD_RESET", "SKL_MISSING"),
      ],
    };
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "DANGLING_REFERENCE" && v.targetId === "ACT_CD_RESET",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-018: rejects a COOLDOWN_MANIPULATION targeting a SkillDefinition owned by a different Unit (Issue #129)", () => {
    const defs = baseDefinitions();
    const withUnowned: CatalogDefinitions = {
      ...defs,
      units: [
        unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] }),
        unit("UNIT_002", { active: ["SKL_U2_AS1"], extra: "SKL_U2_EX1" }),
      ],
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_CD_RESET"),
        asSkill("SKL_U2_AS1", "ACT_DAMAGE_1"),
        exSkill("SKL_U2_EX1", 7),
      ],
      effectActions: [
        ...defs.effectActions,
        cooldownManipulationAction("ACT_CD_RESET", "SKL_U2_AS1"),
      ],
    };
    try {
      buildCatalogIndex(withUnowned);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "UNOWNED_SKILL_REFERENCE" && v.targetId === "UNIT_001",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-019: accepts a COOLDOWN_MANIPULATION targeting a SkillDefinition owned by the same Unit (Issue #129)", () => {
    const defs = baseDefinitions();
    const withOwned: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_CD_RESET")],
      effectActions: [...defs.effectActions, cooldownManipulationAction("ACT_CD_RESET", "SKL_AS1")],
      capabilities: [capability("CAP_COOLDOWN_MANIPULATION")],
    };

    const index = buildCatalogIndex(withOwned);

    expect(index.effectActions.get("ACT_CD_RESET" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-020: rejects a COOLDOWN_MANIPULATION missing the required CAP_COOLDOWN_MANIPULATION capability (Issue #129 review)", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_CD_RESET")],
      effectActions: [
        ...defs.effectActions,
        cooldownManipulationAction("ACT_CD_RESET", "SKL_AS1", "RESET", []),
      ],
      capabilities: [capability("CAP_COOLDOWN_MANIPULATION")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_CD_RESET",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-021: rejects a production definition that uses a schema-unsupported Capability", () => {
    const defs = baseDefinitions();
    const schemaPlanned = createCapabilityDefinition({
      capabilityId: "CAP_FUTURE_SCHEMA",
      schemaStatus: "PLANNED",
      runtimeStatus: "PLANNED",
      implementationTaskId: "TEST-001",
      description: "future schema",
      verification: { productionDefinitionIds: [], testCaseIds: [] },
    });

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { requiredCapabilities: ["CAP_FUTURE_SCHEMA"] })],
        capabilities: [schemaPlanned],
      }),
    ).toThrowError(/UNSUPPORTED_SCHEMA_CAPABILITY/);
  });

  it("UT-CAT-IDX-022: rejects IMPLEMENTED evidence pointing to a missing production definition", () => {
    const defs = baseDefinitions();
    const implemented = createCapabilityDefinition({
      capabilityId: "CAP_READY",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "IMPLEMENTED",
      implementationTaskId: "TEST-001",
      description: "ready",
      verification: {
        productionDefinitionIds: ["ACT_MISSING"],
        testCaseIds: ["TEST-001"],
      },
    });

    expect(() => buildCatalogIndex({ ...defs, capabilities: [implemented] })).toThrowError(
      /INVALID_CAPABILITY_VERIFICATION/,
    );
  });

  it("UT-CAT-IDX-023: rejects IMPLEMENTED evidence whose production definition does not declare the Capability", () => {
    const defs = baseDefinitions();
    const implemented = createCapabilityDefinition({
      capabilityId: "CAP_READY",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "IMPLEMENTED",
      implementationTaskId: "TEST-001",
      description: "ready",
      verification: {
        productionDefinitionIds: ["ACT_DAMAGE_1"],
        testCaseIds: ["TEST-001"],
      },
    });

    expect(() => buildCatalogIndex({ ...defs, capabilities: [implemented] })).toThrowError(
      /does not declare capability/,
    );
  });

  it("UT-CAT-IDX-024: rejects BRANCH/REPEAT skills without CAP_RESOLUTION_BRANCH_REPEAT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [branchSkill("SKL_AS1", []), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).toThrowError(/must declare "CAP_RESOLUTION_BRANCH_REPEAT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [branchSkill("SKL_AS1", ["CAP_RESOLUTION_BRANCH_REPEAT"]), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-025: rejects runtime-owned trigger events without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
        skills: [...defs.skills, psSkill("SKL_PS1", "HitPointReduced", "FACT")],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);
  });

  it("UT-CAT-IDX-026: rejects BRANCH/REPEAT memories without CAP_RESOLUTION_BRANCH_REPEAT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        memories: [branchMemory([])],
        capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).toThrowError(/must declare "CAP_RESOLUTION_BRANCH_REPEAT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        memories: [branchMemory(["CAP_RESOLUTION_BRANCH_REPEAT"])],
        capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-027: rejects runtime-owned Memory triggers without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        memories: [triggerContextMemory([])],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        memories: [triggerContextMemory(["CAP_TRIGGER_CONTEXT"])],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      capabilityId: "CAP_TARGET_FILTER_ORDER",
      selector: {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
      },
    },
    {
      capabilityId: "CAP_TARGET_DERIVED_AREA",
      selector: {
        kind: "BINDING_DERIVED",
        base: { kind: "SELF" },
        area: { kind: "SAME_ROW_AS_BASE", includeBase: false },
      },
    },
    {
      capabilityId: "CAP_TARGET_BINDING_FALLBACK",
      selector: {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        fallback: { kind: "SELECT", side: "ENEMY", count: 1 },
      },
    },
  ])(
    "UT-CAT-IDX-028: rejects $capabilityId-owned target structure without its Capability",
    ({ capabilityId, selector }) => {
      const defs = baseDefinitions();
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [targetingSkill(selector, []), exSkill("SKL_EX1", 7)],
          capabilities: [capability(capabilityId)],
        }),
      ).toThrowError(new RegExp(`must declare "${capabilityId}"`));

      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [targetingSkill(selector, [capabilityId]), exSkill("SKL_EX1", 7)],
          capabilities: [capability(capabilityId)],
        }),
      ).not.toThrow();
    },
  );

  it("UT-CAT-IDX-029: rejects TRIGGER_SOURCE/TRIGGER_TARGET EffectStep references without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    const selector = { kind: "SELECT", side: "ENEMY", count: 1 } as const;
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [targetingSkill(selector, [], { kind: "TRIGGER_TARGET" }), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          targetingSkill(selector, ["CAP_TRIGGER_CONTEXT"], { kind: "TRIGGER_SOURCE" }),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).not.toThrow();
  });

  it.each(["LAST_ACTION_TARGETS", "LAST_DAMAGED_TARGETS"] as const)(
    "UT-CAT-IDX-030: rejects %s EffectStep references without CAP_RESOLUTION_BRANCH_REPEAT",
    (kind) => {
      const defs = baseDefinitions();
      const selector = { kind: "SELECT", side: "ENEMY", count: 1 } as const;
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [targetingSkill(selector, [], { kind }), exSkill("SKL_EX1", 7)],
          capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
        }),
      ).toThrowError(/must declare "CAP_RESOLUTION_BRANCH_REPEAT"/);

      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            targetingSkill(selector, ["CAP_RESOLUTION_BRANCH_REPEAT"], { kind }),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
        }),
      ).not.toThrow();
    },
  );

  it("UT-CAT-IDX-031: rejects a non-TRUE activationCondition without CAP_ACTIVATION_CONDITION", () => {
    const defs = baseDefinitions();
    const selector = { kind: "SELECT", side: "ENEMY", count: 1 } as const;
    const activationCondition = { kind: "TURN_NUMBER", op: "GTE", value: 2 } as const;
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          targetingSkill(selector, [], undefined, activationCondition),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [capability("CAP_ACTIVATION_CONDITION")],
      }),
    ).toThrowError(/must declare "CAP_ACTIVATION_CONDITION"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          targetingSkill(selector, ["CAP_ACTIVATION_CONDITION"], undefined, activationCondition),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [capability("CAP_ACTIVATION_CONDITION")],
      }),
    ).not.toThrow();
  });
});
