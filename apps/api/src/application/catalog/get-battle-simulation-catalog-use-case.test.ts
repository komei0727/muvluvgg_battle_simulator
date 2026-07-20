import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import { GetBattleSimulationCatalogUseCase } from "./get-battle-simulation-catalog-use-case.js";
import { runPreflight } from "../simulation/simulation-preflight-validator.js";
import type { SimulateBattleCommand } from "../simulation/simulate-battle-command.js";
import { createCapabilityDefinition } from "../../domain/catalog/capability/capability-definition.js";
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
import {
  createUnitDefinition,
  type UnitDefinition,
} from "../../domain/catalog/definitions/unit-definition.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleCatalogDirectory } from "../../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";

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

function attackSkill(
  id: string,
  effectActionId: string,
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
          actions: [{ effectActionDefinitionId: effectActionId }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: id },
  });
}

function unitDefinition(
  id: string,
  overrides: {
    requiredCapabilities?: readonly string[];
    activeSkillDefinitionIds?: readonly string[];
  } = {},
): UnitDefinition {
  return createUnitDefinition({
    unitDefinitionId: id,
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: overrides.activeSkillDefinitionIds ?? [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: "SKL_EX",
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    metadata: {
      displayName: `${id}-name`,
      characterName: `${id}-char`,
      characterId: id,
    },
  });
}

function memoryDefinition(
  id: string,
  effectActionId: string,
  requiredCapabilities: readonly string[] = [],
): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId: id,
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
              actions: [{ effectActionDefinitionId: effectActionId }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: id },
  });
}

class FakeBattleCatalogDirectory implements BattleCatalogDirectory {
  callCount = 0;
  private readonly snapshot: BattleCatalogSnapshot;

  constructor(snapshot: BattleCatalogSnapshot) {
    this.snapshot = snapshot;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    this.callCount++;
    return this.snapshot;
  }
}

function snapshotOf(overrides: Partial<BattleCatalogSnapshot>): BattleCatalogSnapshot {
  return {
    catalogRevision: "rev-1",
    units: new Map(),
    skills: new Map(),
    effectActions: new Map(),
    memories: new Map(),
    capabilities: new Map(),
    ...overrides,
  };
}

function toMap<K, V>(entries: readonly V[], keyOf: (value: V) => K): ReadonlyMap<K, V> {
  return new Map(entries.map((value) => [keyOf(value), value]));
}

describe("GetBattleSimulationCatalogUseCase", () => {
  it("returns the catalogRevision and every Unit/Memory in definition-ID ascending order", () => {
    const unitB = unitDefinition("UNIT_B");
    const unitA = unitDefinition("UNIT_A");
    const memoryB = memoryDefinition("MEM_B", "ACT_MEM");
    const memoryA = memoryDefinition("MEM_A", "ACT_MEM");
    const snapshot = snapshotOf({
      units: toMap([unitB, unitA], (u) => u.unitDefinitionId),
      memories: toMap([memoryB, memoryA], (m) => m.memoryDefinitionId),
      effectActions: toMap([damageAction("ACT_MEM")], (e) => e.effectActionDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();

    expect(result.catalogRevision).toBe("rev-1");
    expect(result.units.map((u) => u.unitDefinitionId)).toEqual(["UNIT_A", "UNIT_B"]);
    expect(result.memories.map((m) => m.memoryDefinitionId)).toEqual(["MEM_A", "MEM_B"]);
  });

  it("loads the snapshot and projects the read model only once, reusing it across repeated execute() calls", () => {
    const unit = unitDefinition("UNIT_A");
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
    });
    const directory = new FakeBattleCatalogDirectory(snapshot);
    const useCase = new GetBattleSimulationCatalogUseCase({ battleCatalogDirectory: directory });

    const first = useCase.execute();
    const second = useCase.execute();

    expect(directory.callCount).toBe(1);
    expect(second).toBe(first);
  });

  it("freezes the shared Result graph so mutation attempts are rejected and later execute() calls stay unaffected", () => {
    const unit = unitDefinition("UNIT_A");
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();
    const unitSummary = result.units[0]!;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.units)).toBe(true);
    expect(Object.isFrozen(unitSummary)).toBe(true);
    expect(Object.isFrozen(unitSummary.unavailableCapabilities)).toBe(true);

    expect(() => (result.units as unknown as unknown[]).push(unitSummary)).toThrow();
    expect(() => {
      (result as unknown as Record<string, unknown>).catalogRevision = "mutated";
    }).toThrow();
    expect(() => {
      (unitSummary as unknown as Record<string, unknown>).selectable = false;
    }).toThrow();
    expect(() => {
      (unitSummary.unavailableCapabilities as unknown as unknown[]).push("CAP_X");
    }).toThrow();

    expect(useCase.execute().units.length).toBe(1);
    expect(useCase.execute().units[0]!.selectable).toBe(true);
  });

  it("marks a Unit selectable with no unavailableCapabilities when every required Capability is IMPLEMENTED", () => {
    const unit = unitDefinition("UNIT_A", { activeSkillDefinitionIds: ["SKL_A"] });
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
      skills: toMap([attackSkill("SKL_A", "ACT_A")], (s) => s.skillDefinitionId),
      effectActions: toMap([damageAction("ACT_A")], (e) => e.effectActionDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const summary = useCase.execute().units[0]!;

    expect(summary).toEqual({
      unitDefinitionId: "UNIT_A",
      displayName: "UNIT_A-name",
      characterName: "UNIT_A-char",
      attribute: "AGGRESSIVE",
      unitType: "PHYSICAL",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT", "BACK"],
      selectable: true,
      unavailableCapabilities: [],
    });
  });

  it("marks a Unit unselectable when its Skill requires a Capability absent from the Catalog", () => {
    const unit = unitDefinition("UNIT_A", { activeSkillDefinitionIds: ["SKL_A"] });
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
      skills: toMap([attackSkill("SKL_A", "ACT_A", ["CAP_SKILL"])], (s) => s.skillDefinitionId),
      effectActions: toMap([damageAction("ACT_A")], (e) => e.effectActionDefinitionId),
      capabilities: new Map(),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const summary = useCase.execute().units[0]!;

    expect(summary.selectable).toBe(false);
    expect(summary.unavailableCapabilities).toEqual(["CAP_SKILL"]);
  });

  it("marks a Unit unselectable when a transitively referenced EffectAction requires an unimplemented Capability", () => {
    const unit = unitDefinition("UNIT_A", { activeSkillDefinitionIds: ["SKL_A"] });
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
      skills: toMap([attackSkill("SKL_A", "ACT_A")], (s) => s.skillDefinitionId),
      effectActions: toMap(
        [damageAction("ACT_A", ["CAP_ACTION"])],
        (e) => e.effectActionDefinitionId,
      ),
      capabilities: toMap(
        [
          createCapabilityDefinition({
            capabilityId: "CAP_ACTION",
            schemaStatus: "SUPPORTED",
            runtimeStatus: "PLANNED",
            implementationTaskId: "TEST-001",
            description: "d",
            verification: {
              productionDefinitionIds: ["TEST_DEFINITION"],
              testCaseIds: ["TEST-001"],
            },
          }),
        ],
        (c) => c.capabilityId,
      ),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const summary = useCase.execute().units[0]!;

    expect(summary.selectable).toBe(false);
    expect(summary.unavailableCapabilities).toEqual(["CAP_ACTION"]);
  });

  it("dedupes and sorts unavailableCapabilities ascending when multiple missing Capabilities are collected", () => {
    const unit = unitDefinition("UNIT_A", {
      requiredCapabilities: ["CAP_Z", "CAP_A"],
      activeSkillDefinitionIds: ["SKL_A"],
    });
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
      skills: toMap([attackSkill("SKL_A", "ACT_A", ["CAP_A"])], (s) => s.skillDefinitionId),
      effectActions: toMap([damageAction("ACT_A")], (e) => e.effectActionDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const summary = useCase.execute().units[0]!;

    expect(summary.unavailableCapabilities).toEqual(["CAP_A", "CAP_Z"]);
  });

  it("marks a Memory unselectable when its triggeredEffects require an unimplemented Capability", () => {
    const memory = memoryDefinition("MEM_A", "ACT_MEM", ["CAP_MEMORY"]);
    const snapshot = snapshotOf({
      memories: toMap([memory], (m) => m.memoryDefinitionId),
      effectActions: toMap([damageAction("ACT_MEM")], (e) => e.effectActionDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const summary = useCase.execute().memories[0]!;

    expect(summary).toEqual({
      memoryDefinitionId: "MEM_A",
      displayName: "MEM_A",
      selectable: false,
      unavailableCapabilities: ["CAP_MEMORY"],
    });
  });

  it("does not expose Skill, EffectAction, or triggeredEffects shapes in the result", () => {
    const unit = unitDefinition("UNIT_A", { activeSkillDefinitionIds: ["SKL_A"] });
    const memory = memoryDefinition("MEM_A", "ACT_MEM");
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
      skills: toMap([attackSkill("SKL_A", "ACT_A")], (s) => s.skillDefinitionId),
      effectActions: toMap(
        [damageAction("ACT_A"), damageAction("ACT_MEM")],
        (e) => e.effectActionDefinitionId,
      ),
      memories: toMap([memory], (m) => m.memoryDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();
    const [unitSummary] = result.units;
    const [memorySummary] = result.memories;
    if (unitSummary === undefined || memorySummary === undefined) {
      throw new Error("expected one unit and one memory summary");
    }

    expect(Object.keys(unitSummary).sort()).toEqual(
      [
        "unitDefinitionId",
        "displayName",
        "characterName",
        "attribute",
        "unitType",
        "role",
        "positionAptitudes",
        "selectable",
        "unavailableCapabilities",
      ].sort(),
    );
    expect(Object.keys(memorySummary).sort()).toEqual(
      ["memoryDefinitionId", "displayName", "selectable", "unavailableCapabilities"].sort(),
    );
  });

  it("agrees with SimulationPreflightValidator on selectability for the same Catalog revision", () => {
    const selectableUnit = unitDefinition("UNIT_OK");
    const unselectableUnit = unitDefinition("UNIT_BAD", { activeSkillDefinitionIds: ["SKL_BAD"] });
    const snapshot = snapshotOf({
      units: toMap([selectableUnit, unselectableUnit], (u) => u.unitDefinitionId),
      skills: toMap(
        [attackSkill("SKL_BAD", "ACT_BAD", ["CAP_MISSING"])],
        (s) => s.skillDefinitionId,
      ),
      effectActions: toMap([damageAction("ACT_BAD")], (e) => e.effectActionDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const summaries = useCase.execute().units;

    const commandFor = (unitDefinitionId: string): SimulateBattleCommand => ({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: selectableUnit.unitDefinitionId,
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
      turnLimit: 10,
      logLevel: "DETAILED",
    });

    for (const summary of summaries) {
      let preflightPassed = true;
      try {
        runPreflight(commandFor(summary.unitDefinitionId), snapshot);
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationError);
        expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
        preflightPassed = false;
      }
      expect(summary.selectable).toBe(preflightPassed);
    }
  });
});
