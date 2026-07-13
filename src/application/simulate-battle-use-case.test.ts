import { describe, expect, it } from "vitest";
import { SimulateBattleUseCase } from "./simulate-battle-use-case.js";
import type { SimulateBattleCommand } from "./simulate-battle-command.js";
import { ApplicationError } from "./application-error.js";
import { FixedBattleIdGenerator } from "../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../testing/random/sequence-random-source-factory.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../domain/ports/battle-catalog.js";
import { createCapabilityDefinition } from "../domain/catalog/capability-definition.js";
import {
  createCapabilityId,
  createEffectActionDefinitionId,
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type CapabilityId,
  type EffectActionDefinitionId,
  type MemoryDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../domain/catalog/catalog-ids.js";
import type { EffectActionDefinition } from "../domain/catalog/effect-action-definition.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../domain/catalog/memory-definition.js";
import type { SkillDefinition } from "../domain/catalog/skill-definition.js";
import type { TargetSelectorDefinition } from "../domain/catalog/target-selector-definition.js";
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
  private readonly skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
  private readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;

  constructor(
    units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
    memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition> = new Map(),
    capabilities: BattleCatalogSnapshot["capabilities"] = new Map(),
    catalogRevision = "rev-1",
    skills: ReadonlyMap<SkillDefinitionId, SkillDefinition> = new Map(),
    effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> = new Map(),
  ) {
    this.units = units;
    this.memories = memories;
    this.capabilities = capabilities;
    this.catalogRevision = catalogRevision;
    this.skills = skills;
    this.effectActions = effectActions;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    this.callCount++;
    return {
      catalogRevision: this.catalogRevision,
      units: this.units,
      skills: this.skills,
      effectActions: this.effectActions,
      memories: this.memories,
      capabilities: this.capabilities,
    };
  }
}

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function attackSkill(id: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Attack", tags: [] },
  };
}

function damageEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "NORMAL" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
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
      randomSourceFactory: new SequenceRandomSourceFactory([]),
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
      randomSourceFactory: new SequenceRandomSourceFactory([]),
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
      randomSourceFactory: new SequenceRandomSourceFactory([]),
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
      randomSourceFactory: new SequenceRandomSourceFactory([]),
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
      randomSourceFactory: new SequenceRandomSourceFactory([]),
    });

    useCase.execute(command());

    expect(catalog.callCount).toBe(1);
  });

  it("UT-USECASE-006 (R-FRM-03): assigns distinct BattleUnitIds when the same UnitDefinitionId fills multiple slots", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
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
      randomSourceFactory: new SequenceRandomSourceFactory([]),
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

  it("UT-USECASE-008 (09_アプリケーション設計.md: Battleごとに専用のRandomSourceを生成する): a fresh RandomSource is generated per execute() call, so a second call is not exhausted by the first", () => {
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    const attackerUnit: UnitDefinition = {
      ...unitDefinition("UNIT_ATK"),
      baseStats: { ...unitDefinition("UNIT_ATK").baseStats, maximumAp: 1 },
      activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
    };
    // UNIT_001 (activeSkillDefinitionIds: []) always WAITs, so only the
    // attacker ever rolls a critical — exactly one RNG value per execute().
    const units = new Map([
      [createUnitDefinitionId("UNIT_ATK"), attackerUnit],
      [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")],
    ]);
    const skills = new Map([
      [createSkillDefinitionId(skillId), attackSkill(skillId, effectActionId)],
    ]);
    const effectActions = new Map([
      [createEffectActionDefinitionId(effectActionId), damageEffectAction(effectActionId)],
    ]);
    const catalog = new FakeBattleCatalog(
      units,
      new Map(),
      new Map(),
      "rev-1",
      skills,
      effectActions,
    );
    // Exactly one preset value: enough for exactly one Battle's single critical roll
    // (maximumAp: 1, skill cost: 1, turnLimit: 1 -> exactly one AS use per execute()).
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1", "B_2"]),
      randomSourceFactory: new SequenceRandomSourceFactory([0.99]),
    });
    const attackerCommand = command({
      allyFormation: { slots: [slot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
      enemyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
      turnLimit: 1,
    });

    useCase.execute(attackerCommand);

    // With a shared RandomSource this second call would throw "exhausted" —
    // a fresh RandomSource per Battle means it succeeds identically to the first.
    expect(() => useCase.execute(attackerCommand)).not.toThrow();
  });

  it("SCN-BTL-001 (Issue #10 acceptance): a full battle's event log satisfies sequence/parent/root determinism, and the independent StateDelta Reducer restores finalState from initialState + transitions", async () => {
    const { reduceStateDeltas } = await import("../domain/battle/events/state-delta-reducer.js");
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    const attackerUnit: UnitDefinition = {
      ...unitDefinition("UNIT_ATK"),
      baseStats: { ...unitDefinition("UNIT_ATK").baseStats, maximumAp: 1 },
      activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
    };
    // UNIT_001 (activeSkillDefinitionIds: []) always WAITs, exercising both
    // ActionStarted effectiveActionType values ("AS" and "WAIT") in one battle.
    const units = new Map([
      [createUnitDefinitionId("UNIT_ATK"), attackerUnit],
      [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")],
    ]);
    const skills = new Map([
      [createSkillDefinitionId(skillId), attackSkill(skillId, effectActionId)],
    ]);
    const effectActions = new Map([
      [createEffectActionDefinitionId(effectActionId), damageEffectAction(effectActionId)],
    ]);
    const catalog = new FakeBattleCatalog(
      units,
      new Map(),
      new Map(),
      "rev-1",
      skills,
      effectActions,
    );
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([0.99]),
    });

    const result = useCase.execute(
      command({
        allyFormation: { slots: [slot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
    );

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_001 defense 10 -> 1 damage
    // floor, 100 HP survives) that stays RUNNING through TURN_ENDING, then
    // resolves on the turn-limit boundary — exercising the full M3 event set.
    expect(result.outcome).toBe("ALLY_LOSE");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");

    const { events, transitions, initialState, finalState } = result.observation;

    // Event ordering (invariant list #1): sequence is 1..N with no gaps or duplicates.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, index) => index + 1));

    // eventId is unique within the battle.
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);

    // Parent/root determinism: a child's sequence exceeds its parent's, and it
    // shares the parent's rootEventId; a root event is its own rootEventId.
    const byId = new Map(events.map((e) => [e.eventId, e]));
    for (const event of events) {
      if (event.parentEventId === undefined) {
        expect(event.rootEventId).toBe(event.eventId);
        continue;
      }
      const parent = byId.get(event.parentEventId);
      expect(parent).toBeDefined();
      expect(event.sequence).toBeGreaterThan(parent!.sequence);
      expect(event.rootEventId).toBe(parent!.rootEventId);
    }

    // The full M3 event catalog is exercised by this one non-lethal-attack +
    // mandatory-WAIT + turn-limit-completion battle.
    expect(new Set(events.map((e) => e.eventType))).toEqual(
      new Set([
        "BattleStarted",
        "TurnStarted",
        "ResourcesRecovered",
        "ActionQueueCreated",
        "ActionStarted",
        "TargetsSelected",
        "SkillUseStarting",
        "SkillUseStarted",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageCalculated",
        "DamageApplied",
        "SkillUseCompleted",
        "ActionCompleting",
        "ActionCompleted",
        "TurnCompleting",
        "TurnCompleted",
        "BattleCompleted",
      ]),
    );

    // SCN-BTL-001/SCN-BTL-021: initialState + transitions = finalState, verified
    // through an independent Reducer (not Battle's own advance/resolve logic).
    const restored = reduceStateDeltas(
      initialState,
      transitions.map((t) => t.delta),
    );
    expect(restored).toEqual(finalState);
    expect(finalState.status).toBe("COMPLETED");
  });
});
