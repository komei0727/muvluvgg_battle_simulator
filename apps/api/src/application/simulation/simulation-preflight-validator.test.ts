import { describe, expect, it } from "vitest";
import { runPreflight } from "./simulation-preflight-validator.js";
import type { SimulateBattleCommand } from "./simulate-battle-command.js";
import { ApplicationError } from "../contracts/application-error.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { createCapabilityDefinition } from "../../domain/catalog/capability/capability-definition.js";
import {
  createCapabilityId,
  createEffectActionDefinitionId,
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type CapabilityId,
  type EffectActionDefinitionId,
  type MemoryDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { createEffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition-factory.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../../domain/catalog/definitions/memory-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
} from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";

function unitDefinition(
  id: string,
  requiredCapabilities: readonly CapabilityId[] = [],
): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities,
    metadata: { displayName: id, characterName: id, characterId: id, affiliations: [], tags: [] },
  };
}

function damageAction(
  id: string,
  requiredCapabilities: readonly string[] = [],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function statModAction(
  id: string,
  requiredCapabilities: readonly string[] = [],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 20 },
        stacking: { mode: "STACKABLE" },
        duration: { timeLimit: { unit: "TURN", count: 2 }, dispellable: true },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function asSkill(
  id: string,
  targetActionId: string,
  requiredCapabilities: readonly string[] = [],
): SkillDefinition {
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
    requiredCapabilities,
    metadata: { displayName: "AS" },
  });
}

function memoryWithCapability(
  id: string,
  requiredCapabilities: readonly string[],
): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId: id,
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
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
              actions: [{ effectActionDefinitionId: "ACT_ATTACK_UP" }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Memory" },
  });
}

function snapshot(overrides: Partial<BattleCatalogSnapshot> = {}): BattleCatalogSnapshot {
  return {
    catalogRevision: "rev-1",
    units: new Map<UnitDefinitionId, UnitDefinition>([
      [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")],
    ]),
    skills: new Map(),
    effectActions: new Map(),
    memories: new Map<MemoryDefinitionId, MemoryDefinition>(),
    capabilities: new Map(),
    ...overrides,
  };
}

function command(overrides: Partial<SimulateBattleCommand> = {}): SimulateBattleCommand {
  return {
    allyFormation: {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: 0, row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: 0, row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    },
    turnLimit: 30,
    logLevel: "DETAILED",
    ...overrides,
  };
}

describe("runPreflight", () => {
  it("UT-PREFLIGHT-001: passes when every referenced Unit exists and requires no Capability", () => {
    expect(() => runPreflight(command(), snapshot())).not.toThrow();
  });

  it("UT-PREFLIGHT-002 (R-FRM-06): rejects with DEFINITION_NOT_FOUND when a Unit reference is unknown", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });

    try {
      runPreflight(cmd, snapshot());
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.slots[0].unitDefinitionId" }),
      );
    }
  });

  it("UT-PREFLIGHT-003: collects every unknown Unit/Memory reference across both formations in one error", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING_B"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });

    try {
      runPreflight(cmd, snapshot());
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      const violations = (error as ApplicationError).violations;
      expect(violations).toHaveLength(3);
    }
  });

  it("UT-PREFLIGHT-004 (R-FRM-06): rejects with UNSUPPORTED_RULE when a referenced Unit requires a non-IMPLEMENTED Capability", () => {
    const capabilityId = createCapabilityId("CAP_UNSUPPORTED");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_GATED"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_GATED"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });
    const snap = snapshot({
      units: new Map([
        [createUnitDefinitionId("UNIT_GATED"), unitDefinition("UNIT_GATED", [capabilityId])],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_UNSUPPORTED",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "TEST-001",
            description: "not yet implemented",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
      ]),
    });

    try {
      runPreflight(cmd, snap);
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "UNIT_GATED" }),
      );
    }
  });

  it("UT-PREFLIGHT-007 (R-FRM-06): attributes the violation to the Skill (not the Unit) when the Skill itself declares the required Capability", () => {
    const capabilityId = createCapabilityId("CAP_SKILL_GATED");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });
    const unit: UnitDefinition = {
      ...unitDefinition("UNIT_A"),
      activeSkillDefinitionIds: [createSkillDefinitionId("SKL_GATED")],
    };
    const snap = snapshot({
      units: new Map([[createUnitDefinitionId("UNIT_A"), unit]]),
      skills: new Map<SkillDefinitionId, SkillDefinition>([
        [createSkillDefinitionId("SKL_GATED"), asSkill("SKL_GATED", "ACT_PLAIN", [capabilityId])],
      ]),
      effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
        [createEffectActionDefinitionId("ACT_PLAIN"), damageAction("ACT_PLAIN")],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_SKILL_GATED",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "TEST-001",
            description: "not yet implemented",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
      ]),
    });

    try {
      runPreflight(cmd, snap);
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "SKL_GATED" }),
      );
    }
  });

  it("UT-PREFLIGHT-008 (R-FRM-06): attributes the violation to the EffectAction referenced by a Skill's resolution steps", () => {
    const capabilityId = createCapabilityId("CAP_ACTION_GATED");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });
    const unit: UnitDefinition = {
      ...unitDefinition("UNIT_A"),
      activeSkillDefinitionIds: [createSkillDefinitionId("SKL_PLAIN")],
    };
    const snap = snapshot({
      units: new Map([[createUnitDefinitionId("UNIT_A"), unit]]),
      skills: new Map<SkillDefinitionId, SkillDefinition>([
        [createSkillDefinitionId("SKL_PLAIN"), asSkill("SKL_PLAIN", "ACT_GATED")],
      ]),
      effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
        [createEffectActionDefinitionId("ACT_GATED"), damageAction("ACT_GATED", [capabilityId])],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_ACTION_GATED",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "TEST-001",
            description: "not yet implemented",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
      ]),
    });

    try {
      runPreflight(cmd, snap);
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "ACT_GATED" }),
      );
    }
  });

  it("UT-PREFLIGHT-011 (PR #208再レビュー[P2]): rejects with UNSUPPORTED_RULE before Battle generation when a Skill uses APPLY_STAT_MOD, which declares CAP_STAT_MOD (PLANNED — EFF-003 must wire ACTION/TURN duration expiration before this can be safely IMPLEMENTED)", () => {
    const capabilityId = createCapabilityId("CAP_STAT_MOD");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });
    const unit: UnitDefinition = {
      ...unitDefinition("UNIT_A"),
      activeSkillDefinitionIds: [createSkillDefinitionId("SKL_STAT_MOD")],
    };
    const snap = snapshot({
      units: new Map([[createUnitDefinitionId("UNIT_A"), unit]]),
      skills: new Map<SkillDefinitionId, SkillDefinition>([
        [createSkillDefinitionId("SKL_STAT_MOD"), asSkill("SKL_STAT_MOD", "ACT_STAT_MOD")],
      ]),
      effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
        [
          createEffectActionDefinitionId("ACT_STAT_MOD"),
          statModAction("ACT_STAT_MOD", [capabilityId]),
        ],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_STAT_MOD",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "EFF-003",
            description:
              "APPLY_STAT_MODのCombatStat再計算はEFF-002で実装済みだが、ACTION/TURN期間の失効(EFF-003)が無いため引き続きPLANNED",
            verification: { productionDefinitionIds: [], testCaseIds: [] },
          }),
        ],
      ]),
    });

    try {
      runPreflight(cmd, snap);
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "ACT_STAT_MOD" }),
      );
    }
  });

  it("UT-PREFLIGHT-009 (R-FRM-06): attributes the violation to the Memory when the Memory itself declares the required Capability", () => {
    const capabilityId = createCapabilityId("CAP_MEMORY_GATED");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [createMemoryDefinitionId("MEM_GATED")],
      },
    });
    const snap = snapshot({
      memories: new Map<MemoryDefinitionId, MemoryDefinition>([
        [createMemoryDefinitionId("MEM_GATED"), memoryWithCapability("MEM_GATED", [capabilityId])],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_MEMORY_GATED",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "TEST-001",
            description: "not yet implemented",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
      ]),
    });

    try {
      runPreflight(cmd, snap);
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "MEM_GATED" }),
      );
    }
  });

  it("UT-PREFLIGHT-010 (R-FRM-06): reports every requiring definition when multiple definitions need the same missing Capability", () => {
    const capabilityId = createCapabilityId("CAP_SHARED_GATED");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_B"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });
    const snap = snapshot({
      units: new Map([
        [createUnitDefinitionId("UNIT_A"), unitDefinition("UNIT_A", [capabilityId])],
        [createUnitDefinitionId("UNIT_B"), unitDefinition("UNIT_B", [capabilityId])],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_SHARED_GATED",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "TEST-001",
            description: "not yet implemented",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
      ]),
    });

    try {
      runPreflight(cmd, snap);
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      const violations = (error as ApplicationError).violations;
      expect(violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "UNIT_A" }),
      );
      expect(violations).toContainEqual(
        expect.objectContaining({ ruleId: capabilityId, definitionId: "UNIT_B" }),
      );
    }
  });

  it("UT-PREFLIGHT-005 (R-FRM-06): passes once the required Capability's status is IMPLEMENTED", () => {
    const capabilityId = createCapabilityId("CAP_READY");
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_GATED"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_GATED"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });
    const snap = snapshot({
      units: new Map([
        [createUnitDefinitionId("UNIT_GATED"), unitDefinition("UNIT_GATED", [capabilityId])],
      ]),
      capabilities: new Map([
        [
          capabilityId,
          createCapabilityDefinition({
            capabilityId: "CAP_READY",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "IMPLEMENTED",
            implementationTaskId: "TEST-001",
            description: "implemented",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
      ]),
    });

    expect(() => runPreflight(cmd, snap)).not.toThrow();
  });

  it("UT-PREFLIGHT-006: rejects with DEFINITION_NOT_FOUND when a Memory reference is unknown", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
      },
    });

    try {
      runPreflight(cmd, snapshot());
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.memoryDefinitionIds[0]" }),
      );
    }
  });
});
