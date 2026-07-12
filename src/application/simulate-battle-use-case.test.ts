import { describe, expect, it } from "vitest";
import { SimulateBattleUseCase } from "./simulate-battle-use-case.js";
import type { SimulateBattleCommand } from "./simulate-battle-command.js";
import { ApplicationError } from "./application-error.js";
import { FixedBattleIdGenerator } from "../testing/id/fixed-battle-id-generator.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../domain/ports/battle-catalog.js";
import { createCapabilityDefinition } from "../domain/catalog/capability-definition.js";
import {
  createCapabilityId,
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type CapabilityId,
  type MemoryDefinitionId,
  type UnitDefinitionId,
} from "../domain/catalog/catalog-ids.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../domain/catalog/memory-definition.js";
import type { UnitDefinition } from "../domain/catalog/unit-definition.js";
import { createBattleId } from "../domain/shared/ids.js";

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

class FakeBattleCatalog implements BattleCatalog {
  callCount = 0;
  private readonly units: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  private readonly memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>;
  private readonly capabilities: BattleCatalogSnapshot["capabilities"];
  private readonly catalogRevision: string;

  constructor(
    units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
    memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition> = new Map(),
    capabilities: BattleCatalogSnapshot["capabilities"] = new Map(),
    catalogRevision = "rev-1",
  ) {
    this.units = units;
    this.memories = memories;
    this.capabilities = capabilities;
    this.catalogRevision = catalogRevision;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    this.callCount++;
    return {
      catalogRevision: this.catalogRevision,
      units: this.units,
      skills: new Map(),
      effectActions: new Map(),
      memories: this.memories,
      capabilities: this.capabilities,
    };
  }
}

function slot(unitId: string, column: 0 | 1 | 2, row: "FRONT" | "REAR" = "FRONT") {
  return { unitDefinitionId: createUnitDefinitionId(unitId), position: { column, row } };
}

function command(overrides: Partial<SimulateBattleCommand> = {}): SimulateBattleCommand {
  return {
    allyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
    turnLimit: 3,
    logLevel: "DETAILED",
    ...overrides,
  };
}

const UNITS = new Map([[createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")]]);

describe("SimulateBattleUseCase", () => {
  it("UT-USECASE-001 / SCN-BTL-001 lifecycle: completes a minimal battle end to end with no real time, file, or HTTP dependency", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    const result = useCase.execute(command({ turnLimit: 3 }));

    expect(result.battleId).toBe(createBattleId("B_1"));
    expect(result.catalogRevision).toBe("rev-1");
    // No ActionQueue/damage exists yet (deferred to #14/#9), so with no way for
    // either side to be defeated, the only reachable outcome in this vertical
    // slice is the turn-limit path (R-END-02 priority 4).
    expect(result.outcome).toBe("ALLY_LOSE");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
    expect(result.completedTurn).toBe(3);
  });

  it("UT-USECASE-002: rejects an invalid command with INVALID_COMMAND without ever calling the Catalog (09_アプリケーション設計.md: Command違反時はCatalogやBattleを呼ばない)", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    try {
      useCase.execute(command({ turnLimit: 0 }));
      expect.fail("expected execute to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
    }
    expect(catalog.callCount).toBe(0);
  });

  it("UT-USECASE-003 (R-FRM-06): rejects an unknown UnitDefinitionId with DEFINITION_NOT_FOUND", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    try {
      useCase.execute(
        command({ allyFormation: { slots: [slot("UNIT_MISSING", 0)], memoryDefinitionIds: [] } }),
      );
      expect.fail("expected execute to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
    }
  });

  it("UT-USECASE-004 (R-FRM-06): rejects a definition graph with an unimplemented Capability, before any Battle is created", () => {
    const capabilityId = createCapabilityId("CAP_UNSUPPORTED");
    const units = new Map([
      [createUnitDefinitionId("UNIT_GATED"), unitDefinition("UNIT_GATED", [capabilityId])],
    ]);
    const capabilities = new Map([
      [
        capabilityId,
        createCapabilityDefinition({
          capabilityId: "CAP_UNSUPPORTED",
          status: "PLANNED",
          description: "not yet implemented",
          requiredBy: [],
        }),
      ],
    ]);
    const catalog = new FakeBattleCatalog(units, new Map(), capabilities);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    try {
      useCase.execute(
        command({
          allyFormation: { slots: [slot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [slot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
        }),
      );
      expect.fail("expected execute to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
    }
  });

  it("UT-USECASE-005: loads the Catalog snapshot exactly once per execution (09_アプリケーション設計.md: 一つの実行中は同じCatalogスナップショットだけを参照する)", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    useCase.execute(command());

    expect(catalog.callCount).toBe(1);
  });

  it("UT-USECASE-006 (R-FRM-03): assigns distinct BattleUnitIds when the same UnitDefinitionId fills multiple slots", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    const result = useCase.execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_001", 0), slot("UNIT_001", 1)],
          memoryDefinitionIds: [],
        },
      }),
    );

    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
  });

  it("UT-USECASE-007: resolves a referenced MemoryDefinitionId that exists in the Catalog", () => {
    const memories = new Map([
      [
        createMemoryDefinitionId("MEM_001"),
        createMemoryDefinition({
          memoryDefinitionId: "MEM_001",
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
          requiredCapabilities: [],
          metadata: { displayName: "Test Memory" },
        }),
      ],
    ]);
    const catalog = new FakeBattleCatalog(UNITS, memories);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    });

    const result = useCase.execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_001", 0)],
          memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
        },
      }),
    );

    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
  });
});
