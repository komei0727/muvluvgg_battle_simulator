import { describe, expect, it } from "vitest";
import { SimulateBattleUseCase } from "./simulate-battle-use-case.js";
import type { SimulateBattleCommand } from "./simulate-battle-command.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import { ApplicationError } from "../contracts/application-error.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { createCapabilityDefinition } from "../../domain/catalog/capability/capability-definition.js";
import {
  createCapabilityId,
  createEffectActionDefinitionId,
  createMemoryDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type CapabilityId,
  type EffectActionDefinitionId,
  type MemoryDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../../domain/catalog/definitions/memory-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

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

/** `unitDefinition`の`extraSkillDefinitionId`（"SKL_EX"）が参照するEXスキル。EXゲージは満タンにならないため実際には使用されない。 */
function exSkillDefinition(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
  };
}

const EX_SKILLS = new Map([[createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")]]);

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
    skills: ReadonlyMap<SkillDefinitionId, SkillDefinition> = EX_SKILLS,
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
    counterUpdates: [],
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

/**
 * `09_アプリケーション設計.md`「SimulationExecutionContext」。テストが
 * 期限を意識する必要がない大半のケースでは、`Number.MAX_SAFE_INTEGER`を
 * `deadlineEpochMs`に使い、`ManualClock`の初期時刻(0)がこれを超えることは
 * ないため、`#18`の期限チェックが誤って発火しない。
 */
function testContext(
  overrides: Partial<SimulationExecutionContext> = {},
): SimulationExecutionContext {
  return { requestId: "test-request", deadlineEpochMs: Number.MAX_SAFE_INTEGER, ...overrides };
}

const UNITS = new Map([[createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")]]);

describe("SimulateBattleUseCase", () => {
  it("UT-USECASE-001 / SCN-BTL-001 lifecycle: completes a minimal battle end to end with no real time, file, or HTTP dependency", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock: new ManualClock(0),
    });

    const result = useCase.execute(command({ turnLimit: 3 }), testContext());

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
      clock: new ManualClock(0),
    });

    try {
      useCase.execute(command({ turnLimit: 0 }), testContext());
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
      clock: new ManualClock(0),
    });

    try {
      useCase.execute(
        command({ allyFormation: { slots: [slot("UNIT_MISSING", 0)], memoryDefinitionIds: [] } }),
        testContext(),
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
          schemaStatus: "SUPPORTED",
          runtimeStatus: "PLANNED",
          implementationTaskId: "TEST-001",
          description: "not yet implemented",
          verification: { productionDefinitionIds: ["TEST_DEFINITION"], testCaseIds: ["TEST-001"] },
        }),
      ],
    ]);
    const catalog = new FakeBattleCatalog(units, new Map(), capabilities);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock: new ManualClock(0),
    });

    try {
      useCase.execute(
        command({
          allyFormation: { slots: [slot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [slot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
        }),
        testContext(),
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
      clock: new ManualClock(0),
    });

    useCase.execute(command(), testContext());

    expect(catalog.callCount).toBe(1);
  });

  it("UT-USECASE-006 (R-FRM-03): assigns distinct BattleUnitIds when the same UnitDefinitionId fills multiple slots", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock: new ManualClock(0),
    });

    const result = useCase.execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_001", 0), slot("UNIT_001", 1)],
          memoryDefinitionIds: [],
        },
      }),
      testContext(),
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
      clock: new ManualClock(0),
    });

    const result = useCase.execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_001", 0)],
          memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
        },
      }),
      testContext(),
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
      ...EX_SKILLS,
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
      clock: new ManualClock(0),
    });
    const attackerCommand = command({
      allyFormation: { slots: [slot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
      enemyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
      turnLimit: 1,
    });

    useCase.execute(attackerCommand, testContext());

    // With a shared RandomSource this second call would throw "exhausted" —
    // a fresh RandomSource per Battle means it succeeds identically to the first.
    expect(() => useCase.execute(attackerCommand, testContext())).not.toThrow();
  });

  it("UT-USECASE-009 (11_インフラストラクチャ設計.md「キャンセルと期限」: 協調的停止 — SimulationExecutionGuardが安全な内部境界でdeadlineEpochMsを確認する): throws ApplicationError EXECUTION_TIMEOUT before completing the Battle once the Clock has passed the context's deadline, never returning a battle result as if it were a loss", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const clock = new ManualClock(1_000);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock,
    });

    try {
      useCase.execute(command(), testContext({ deadlineEpochMs: 999 }));
      expect.fail("expected execute to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("EXECUTION_TIMEOUT");
    }
  });

  it("UT-USECASE-010: does not time out when the Clock has not yet reached the deadline, even on the very last safe check before COMPLETED", () => {
    const catalog = new FakeBattleCatalog(UNITS);
    const clock = new ManualClock(0);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock,
    });

    const result = useCase.execute(command({ turnLimit: 3 }), testContext({ deadlineEpochMs: 1 }));

    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
  });

  it("SCN-BTL-001 (Issue #10 acceptance): a full battle's event log satisfies sequence/parent/root determinism, and the independent StateDelta Reducer restores finalState from initialState + transitions", async () => {
    const { reduceStateDeltas } =
      await import("../../domain/battle/lifecycle/state-delta-reducer.js");
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
      ...EX_SKILLS,
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
      clock: new ManualClock(0),
    });

    const result = useCase.execute(
      command({
        allyFormation: { slots: [slot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
      testContext(),
    );

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_001 defense 10 -> 1 damage
    // floor, 100 HP survives) that stays RUNNING through TURN_ENDING, then
    // resolves on the turn-limit boundary — exercising the full M3 event set.
    expect(result.outcome).toBe("ALLY_LOSE");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");

    const { events, stateTransitions, initialState, finalState } = result;

    // Event ordering (invariant list #1): sequence is 1..N with no gaps or duplicates.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, index) => index + 1));

    // sequence is unique within the battle (BattleLogEvent has no eventId; it
    // is the public identifier).
    expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);

    // Parent/root determinism (10_API設計.md BattleLogEventResponse):
    // a child's sequence exceeds its resolved parentSequence, a root event is
    // its own rootSequence, and a child shares its parent's rootSequence.
    const bySequence = new Map(events.map((e) => [e.sequence, e]));
    for (const event of events) {
      if (event.parentSequence === undefined) {
        expect(event.rootSequence).toBe(event.sequence);
        continue;
      }
      const parent = bySequence.get(event.parentSequence);
      expect(parent).toBeDefined();
      expect(event.sequence).toBeGreaterThan(event.parentSequence);
      expect(event.rootSequence).toBe(parent!.rootSequence);
    }

    // The full M3 event catalog plus ActionWaited (M5/issue #20) except
    // UnitDefeated (this attack is non-lethal by design, to also exercise
    // TurnCompleting/TurnCompleted/turn-limit completion in the same run) is
    // exercised by this one non-lethal-attack + mandatory-WAIT +
    // turn-limit-completion battle. UnitDefeated is covered separately below
    // by the lethal-path test.
    // `type` is the design's UPPER_SNAKE_CASE public form of the internal eventType.
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        "BATTLE_STARTED",
        "TURN_STARTED",
        "RESOURCES_RECOVERED",
        "ACTION_QUEUE_CREATED",
        "ACTION_STARTED",
        "ACTION_WAITED",
        "RESOURCE_CHANGED",
        "TARGETS_SELECTED",
        "SKILL_USE_STARTING",
        "SKILL_USE_STARTED",
        "EFFECT_STEP_STARTING",
        "EFFECT_ACTION_STARTING",
        "HIT_CONFIRMED",
        "CRITICAL_CHECK_RESOLVED",
        "DAMAGE_CALCULATED",
        "DAMAGE_APPLIED",
        "EFFECT_ACTION_COMPLETED",
        "EFFECT_STEP_COMPLETED",
        "SKILL_USE_COMPLETED",
        "ACTION_COMPLETING",
        "ACTION_COMPLETED",
        "TURN_COMPLETING",
        "TURN_COMPLETED",
        "BATTLE_COMPLETED",
      ]),
    );

    // Events carrying a stateDelta reference their StateTransition by its
    // 0-based position in stateTransitions (10_API設計.md
    // 「stateTransitionIndex」), and never duplicate the delta content on the
    // event itself.
    for (const event of events) {
      expect(event).not.toHaveProperty("stateDelta");
      if (event.stateTransitionIndex !== undefined) {
        expect(stateTransitions[event.stateTransitionIndex]?.causedBySequence).toBe(event.sequence);
      }
    }

    // SCN-BTL-001/SCN-BTL-021: initialState + stateTransitions = finalState,
    // verified through an independent Reducer (not Battle's own advance/resolve
    // logic). This includes the battle outcome itself (`result`), which is real
    // Battle aggregate state (`Battle.result`), not just status/turn/units.
    const restored = reduceStateDeltas(
      initialState,
      stateTransitions.map((t) => t.stateDelta),
    );
    expect(restored).toEqual(finalState);
    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 1,
    });
  });

  it("SCN-BTL-001 (Issue #10 acceptance, lethal path): a lethal AS attack emits DamageApplied -> UnitDefeated -> BattleCompleted in causal order, with UnitDefeated's payload naming the defeated unit and the causing DamageApplied event", () => {
    const skillId = "SKL_LETHAL";
    const effectActionId = "ACT_LETHAL";
    const attackerUnit: UnitDefinition = {
      ...unitDefinition("UNIT_ATK"),
      baseStats: { ...unitDefinition("UNIT_ATK").baseStats, maximumAp: 1, attack: 999 },
      activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
    };
    const defenderUnit: UnitDefinition = {
      ...unitDefinition("UNIT_DEF"),
      baseStats: { ...unitDefinition("UNIT_DEF").baseStats, maximumHp: 10, defense: 0 },
    };
    const units = new Map([
      [createUnitDefinitionId("UNIT_ATK"), attackerUnit],
      [createUnitDefinitionId("UNIT_DEF"), defenderUnit],
    ]);
    const skills = new Map([
      ...EX_SKILLS,
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
      clock: new ManualClock(0),
    });

    const result = useCase.execute(
      command({
        allyFormation: { slots: [slot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [slot("UNIT_DEF", 0)], memoryDefinitionIds: [] },
        turnLimit: 5,
      }),
      testContext(),
    );

    expect(result.outcome).toBe("ALLY_WIN");
    expect(result.completionReason).toBe("ENEMY_DEFEATED");

    const { events } = result;
    const eventTypes = events.map((e) => e.type);
    const damageAppliedIndex = eventTypes.indexOf("DAMAGE_APPLIED");
    const unitDefeatedIndex = eventTypes.indexOf("UNIT_DEFEATED");
    const battleCompletedIndex = eventTypes.indexOf("BATTLE_COMPLETED");

    expect(damageAppliedIndex).toBeGreaterThanOrEqual(0);
    expect(unitDefeatedIndex).toBeGreaterThan(damageAppliedIndex);
    expect(battleCompletedIndex).toBeGreaterThan(unitDefeatedIndex);

    const damageApplied = events[damageAppliedIndex]!;
    const unitDefeated = events[unitDefeatedIndex]!;
    expect(damageApplied.details).toMatchObject({ defeated: true });
    // Causal link at the public level: UnitDefeated's parentSequence points
    // back to the DamageApplied event that caused it.
    expect(unitDefeated.parentSequence).toBe(damageApplied.sequence);
    expect(unitDefeated.details).toMatchObject({ unitId: createBattleUnitId("enemy:1") });
  });

  it("SCN-BTL-008 (Issue #34 acceptance): a defender's PS triggered by DamageApplied consumes PP and increases the EX gauge by the same amount, recorded via ResourceChanged/PassiveActivated/PassiveResolved", () => {
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    const passiveSkillId = "SKL_PS_ON_DAMAGED";
    const attackerUnit: UnitDefinition = {
      ...unitDefinition("UNIT_ATK"),
      baseStats: { ...unitDefinition("UNIT_ATK").baseStats, maximumAp: 1 },
      activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
    };
    const defenderUnit: UnitDefinition = {
      ...unitDefinition("UNIT_PS_DEF"),
      baseStats: { ...unitDefinition("UNIT_PS_DEF").baseStats, maximumHp: 1000, maximumPp: 3 },
      extraGaugeMaximum: 10,
      passiveSkillDefinitionIds: [createSkillDefinitionId(passiveSkillId)],
    };
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "SELF",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      requiredCapabilities: [],
      metadata: { displayName: passiveSkillId, tags: [] },
    };
    const units = new Map([
      [createUnitDefinitionId("UNIT_ATK"), attackerUnit],
      [createUnitDefinitionId("UNIT_PS_DEF"), defenderUnit],
    ]);
    const skills = new Map([
      ...EX_SKILLS,
      [createSkillDefinitionId(skillId), attackSkill(skillId, effectActionId)],
      [createSkillDefinitionId(passiveSkillId), passiveSkill],
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
      clock: new ManualClock(0),
    });

    const result = useCase.execute(
      command({
        allyFormation: { slots: [slot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [slot("UNIT_PS_DEF", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
      testContext(),
    );

    const { events, finalState } = result;
    const defenderUnitId = createBattleUnitId("enemy:1");

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_PS_DEF defense 10 -> 1
    // damage floor, 1000 HP survives) so the PS resolves without interruption.
    const eventTypes = events.map((e) => e.type);
    const damageAppliedIndex = eventTypes.indexOf("DAMAGE_APPLIED");
    const passiveActivatedIndex = eventTypes.indexOf("PASSIVE_ACTIVATED");
    const passiveResolvedIndex = eventTypes.indexOf("PASSIVE_RESOLVED");
    expect(damageAppliedIndex).toBeGreaterThanOrEqual(0);
    // R-SKL-01/02: the PS resolves immediately, before the attacker's action completes.
    expect(passiveActivatedIndex).toBeGreaterThan(damageAppliedIndex);
    expect(passiveResolvedIndex).toBeGreaterThan(passiveActivatedIndex);

    const passiveActivated = events[passiveActivatedIndex]!;
    expect(passiveActivated.details).toMatchObject({
      actorUnitId: defenderUnitId,
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      // TURN_STARTING recovers PP to maximumPp (3) before the action phase.
      ppBefore: 3,
      ppAfter: 2,
      exBefore: 0,
      exAfter: 1,
    });

    // Restrict to the window between DamageApplied and PassiveActivated so the
    // defender's own later WAIT action (which also emits AP/EX ResourceChanged
    // for itself, R-ACT-03) doesn't get mixed into the PS's own resource change.
    const resourceChangedForDefender = events
      .slice(damageAppliedIndex, passiveActivatedIndex)
      .filter(
        (e) =>
          e.type === "RESOURCE_CHANGED" &&
          (e.details as { battleUnitId: string }).battleUnitId === defenderUnitId,
      );
    expect(
      resourceChangedForDefender.map((e) => (e.details as { resource: string }).resource),
    ).toEqual(["PP", "EX_GAUGE"]);
    expect(resourceChangedForDefender[0]!.details).toMatchObject({
      before: 3,
      after: 2,
      delta: -1,
      reason: "SKILL_COST",
    });
    expect(resourceChangedForDefender[1]!.details).toMatchObject({
      before: 0,
      after: 1,
      delta: 1,
      reason: "EX_GAIN",
    });

    expect(finalState.units[defenderUnitId]!.pp).toBe(2);
    // +1 from the PS's own activation, then +1 per subsequent mandatory WAIT
    // in the defender's own action phase (maximumAp 3, no active skill, R-ACT-03).
    expect(finalState.units[defenderUnitId]!.extraGauge).toBe(4);
  });

  it("review fix [P1]: a RuntimeCounter execution-guard breach surfaces as EXECUTION_LIMIT_EXCEEDED (HTTP 503), not INVALID_COMMAND (HTTP 422)", () => {
    const passiveSkillId = "SKL_PS_COUNTER_SELF_REGEN_E2E";
    const counterId = "RUNTIME_COUNTER_SELF_REGEN_E2E";
    const psUnit: UnitDefinition = {
      ...unitDefinition("UNIT_PS_COUNTER_LOOP"),
      passiveSkillDefinitionIds: [createSkillDefinitionId(passiveSkillId)],
    };
    // このユニットのcounterUpdatesは`TurnStarted`で初回発火し、以後は自身が
    // 発行する`RuntimeCounterChanged`を契機に再更新し続ける（悪意/誤りのある
    // Catalog定義）。PS自体のtriggersは空のため、活動履歴とは無関係に
    // `onFactEvent`の再帰だけが無限に続く（レビュー指摘[P2]の再現、
    // 実行ガードで検出されることの確認）。
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: createRuntimeCounterId(counterId),
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
        {
          kind: "INCREMENT",
          counter: createRuntimeCounterId(counterId),
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "RuntimeCounterChanged",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterId },
          },
          amount: 1,
        },
      ],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      requiredCapabilities: [],
      metadata: { displayName: passiveSkillId, tags: [] },
    };
    const units = new Map([
      [createUnitDefinitionId("UNIT_PS_COUNTER_LOOP"), psUnit],
      [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")],
    ]);
    const skills = new Map([...EX_SKILLS, [createSkillDefinitionId(passiveSkillId), passiveSkill]]);
    const catalog = new FakeBattleCatalog(units, new Map(), new Map(), "rev-1", skills);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([0.99]),
      clock: new ManualClock(0),
    });

    let caught: unknown;
    try {
      useCase.execute(
        command({
          allyFormation: { slots: [slot("UNIT_PS_COUNTER_LOOP", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [slot("UNIT_001", 0)], memoryDefinitionIds: [] },
          turnLimit: 1,
        }),
        testContext(),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationError);
    expect((caught as ApplicationError).code).toBe("EXECUTION_LIMIT_EXCEEDED");
  });

  it("review re-fix [P1]: a legitimate 5v5, 99-turn, all-WAIT boundary battle (10_API設計.md's 'must comfortably handle a normal 99-turn battle' contract) completes without hitting EXECUTION_LIMIT_EXCEEDED", () => {
    // レビュー再指摘[P1]: 旧`DEFAULT_MAX_TOTAL_EVENTS`(20,000)は、5対5・現行
    // ユニットの最大AP(4)で全員がWAITを選択する境界ケース(1ターン最大40行動、
    // 行動イベントだけで概算23,760件)を処理できなかった。この境界を実際に
    // `SimulateBattleUseCase`経由で走らせ、実行ガードに引っかからないことを
    // 確認する(`event-recorder.ts`のコメントに実測値の詳細を記載)。
    const waitUnit: UnitDefinition = {
      ...unitDefinition("UNIT_WAIT_ONLY"),
      // レビュー指摘[P1]の実測前提(「現在のユニットの最大APは4」)を再現する。
      baseStats: { ...unitDefinition("UNIT_WAIT_ONLY").baseStats, maximumAp: 4 },
    };
    const units = new Map([[createUnitDefinitionId("UNIT_WAIT_ONLY"), waitUnit]]);
    const catalog = new FakeBattleCatalog(units);
    const useCase = new SimulateBattleUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_BOUNDARY"]),
      randomSourceFactory: new SequenceRandomSourceFactory(new Array(1000).fill(0.99)),
      clock: new ManualClock(0),
    });
    const fiveSlots = [
      slot("UNIT_WAIT_ONLY", 0, "FRONT"),
      slot("UNIT_WAIT_ONLY", 1, "FRONT"),
      slot("UNIT_WAIT_ONLY", 2, "FRONT"),
      slot("UNIT_WAIT_ONLY", 0, "REAR"),
      slot("UNIT_WAIT_ONLY", 1, "REAR"),
    ];

    const result = useCase.execute(
      command({
        allyFormation: { slots: fiveSlots, memoryDefinitionIds: [] },
        enemyFormation: { slots: fiveSlots, memoryDefinitionIds: [] },
        turnLimit: 99,
        logLevel: "DETAILED",
      }),
      testContext(),
    );

    expect(result.finalState.currentTurn).toBe(99);
    // The old 20,000 cap would have failed this legitimate battle; the
    // recalibrated cap must clear it with margin to spare.
    expect(result.events.length).toBeGreaterThan(20_000);
    expect(result.events.length).toBeLessThan(1_000_000);
  });
});
