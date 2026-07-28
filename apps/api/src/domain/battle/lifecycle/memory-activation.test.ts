import { describe, expect, it } from "vitest";
import { createBattle, startBattle, advanceBattle } from "./battle.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createTurnLimit } from "../model/turn-limit.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
  type TriggeredEffectInput,
} from "../../catalog/definitions/memory-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { Side } from "../../shared/side.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DefaultUnitDefinitionMap } from "../../../testing/fixtures/default-unit-definition-map.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function member(id: string, overrides: Partial<BattlePartyMember> = {}): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {
      maximumHp: 100,
      attack: 100,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
    ...overrides,
  };
}

function unit(id: string, side: Side): BattleUnit {
  return createBattleUnit(member(id), side, LIMITS);
}

function statModAction(id: string, value: number): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value },
      stacking: { mode: "STACKABLE" },
      duration: { dispellable: true, timeLimit: { unit: "BATTLE", count: 1 } },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  } as unknown as EffectActionDefinition;
}

function battleStartedStatModMemory(
  memoryDefinitionId: string,
  effectActionDefinitionId: string,
  selectorSide: "ALLY" | "ENEMY",
  eventType = "BattleStarted",
): MemoryDefinition {
  const triggeredEffect: TriggeredEffectInput = {
    trigger: {
      eventType,
      category: "FACT",
      sourceSelector: "SELF",
      targetSelector: "SELF",
    },
    effectSequence: {
      targetBindings: [
        {
          targetBindingId: "TGT_ALL",
          selector: { kind: "SELECT", side: selectorSide, count: "ALL" },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_ALL" },
          actions: [{ effectActionDefinitionId }],
        },
      ],
    },
  };
  return createMemoryDefinition({
    memoryDefinitionId,
    triggeredEffects: [triggeredEffect],
    requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
    metadata: { displayName: memoryDefinitionId },
  });
}

function definitionsWith(
  memoriesBySide: Readonly<Record<Side, readonly MemoryDefinition[]>>,
  effectActions: readonly [EffectActionDefinitionId, EffectActionDefinition][],
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(effectActions),
    unitDefinitions: new DefaultUnitDefinitionMap(),
    skillDefinitions: new Map(),
    memoriesBySide,
  };
}

function battleWith(definitions: BattleDefinitions) {
  return createBattle(
    createBattleId("B_1"),
    [unit("ally:1", "ALLY")],
    [unit("enemy:1", "ENEMY")],
    createTurnLimit(3),
    definitions,
  );
}

const ATTACK_UP = createEffectActionDefinitionId("ACT_MEM_ATTACK_UP");

describe("Memory triggeredEffects activation (R-MEM-03/R-MEM-04)", () => {
  it("UT-R-MEM-03-001: a BattleStarted Memory applies its APPLY_STAT_MOD as an AppliedEffect while the battle starts", () => {
    const definitions = definitionsWith(
      { ALLY: [battleStartedStatModMemory("MEM_A", ATTACK_UP, "ALLY")], ENEMY: [] },
      [[ATTACK_UP, statModAction(ATTACK_UP, 0.1)]],
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const battle = startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);

    const ally = battle.allyUnits[0]!;
    expect(ally.appliedEffects).toHaveLength(1);
    // R-MEM-03: Memory由来のAPPLY_STAT_MODは通常スキル由来と同じくCombatStatCalculatorで再計算される。
    expect(ally.combatStats.attack).toBeCloseTo(110, 6);
    // 敵側はALLY相対のbindingに含まれない。
    expect(battle.enemyUnits[0]!.appliedEffects).toHaveLength(0);
  });

  it("UT-R-MEM-03-002: emits MemoryTriggered/MemoryResolved with sourceSide and no sourceUnitId", () => {
    const definitions = definitionsWith(
      { ALLY: [battleStartedStatModMemory("MEM_A", ATTACK_UP, "ALLY")], ENEMY: [] },
      [[ATTACK_UP, statModAction(ATTACK_UP, 0.1)]],
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);

    const triggered = recorder.getEvents().find((event) => event.eventType === "MemoryTriggered");
    const resolved = recorder.getEvents().find((event) => event.eventType === "MemoryResolved");
    expect(triggered?.sourceUnitId).toBeUndefined();
    expect(triggered?.sourceSide).toBe("ALLY");
    expect(triggered?.payload).toMatchObject({
      memoryDefinitionId: "MEM_A",
      triggeredEffectIndex: 0,
      sourceSide: "ALLY",
    });
    expect(resolved?.sourceSide).toBe("ALLY");
    expect(resolved?.payload).toMatchObject({ memoryDefinitionId: "MEM_A", resolvedStepCount: 1 });
    // R-MEM-03: 戦闘開始時Memoryは初回ターン開始前に解決する。
    const eventTypes = recorder.getEvents().map((event) => event.eventType);
    expect(eventTypes).not.toContain("TurnStarted");
  });

  it("UT-R-MEM-04-001: an ALLY-side Memory can target the enemy side (selector side is relative to the Memory's own side)", () => {
    const definitions = definitionsWith(
      { ALLY: [battleStartedStatModMemory("MEM_A", ATTACK_UP, "ENEMY")], ENEMY: [] },
      [[ATTACK_UP, statModAction(ATTACK_UP, 0.1)]],
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const battle = startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);

    expect(battle.allyUnits[0]!.appliedEffects).toHaveLength(0);
    expect(battle.enemyUnits[0]!.appliedEffects).toHaveLength(1);
  });

  it("UT-R-MEM-04-002: an ENEMY-side Memory resolves its own ALLY selector to the enemy party", () => {
    const definitions = definitionsWith(
      { ALLY: [], ENEMY: [battleStartedStatModMemory("MEM_E", ATTACK_UP, "ALLY")] },
      [[ATTACK_UP, statModAction(ATTACK_UP, 0.1)]],
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const battle = startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);

    expect(battle.enemyUnits[0]!.appliedEffects).toHaveLength(1);
    expect(battle.allyUnits[0]!.appliedEffects).toHaveLength(0);
  });

  it("UT-R-MEM-04-003: a Memory-granted AppliedEffect records sourceSide instead of a source BattleUnit", () => {
    const definitions = definitionsWith(
      { ALLY: [battleStartedStatModMemory("MEM_A", ATTACK_UP, "ALLY")], ENEMY: [] },
      [[ATTACK_UP, statModAction(ATTACK_UP, 0.1)]],
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const battle = startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);

    const effect = battle.allyUnits[0]!.appliedEffects[0]!;
    expect(effect.sourceId).toBeUndefined();
    expect(effect.sourceSide).toBe("ALLY");
    const applied = recorder.getEvents().find((event) => event.eventType === "EffectApplied");
    expect(applied?.sourceUnitId).toBeUndefined();
    expect(applied?.sourceSide).toBe("ALLY");
  });

  it("UT-R-MEM-03-003: a TurnStarted Memory activates at the start of each turn", () => {
    const definitions = definitionsWith(
      {
        ALLY: [battleStartedStatModMemory("MEM_TURN", ATTACK_UP, "ALLY", "TurnStarted")],
        ENEMY: [],
      },
      [[ATTACK_UP, statModAction(ATTACK_UP, 0.1)]],
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const started = startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);
    expect(started.allyUnits[0]!.appliedEffects).toHaveLength(0);

    const afterTurn = advanceBattle(started, new SequenceRandomSource([]), recorder);
    expect(afterTurn.allyUnits[0]!.appliedEffects).toHaveLength(1);
  });

  it("UT-R-MEM-04-004: rejects a Memory EffectSequence that references SELF as its target", () => {
    const selfTargetMemory = createMemoryDefinition({
      memoryDefinitionId: "MEM_SELF",
      triggeredEffects: [
        {
          trigger: {
            eventType: "BattleStarted",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "SELF",
          },
          effectSequence: {
            targetBindings: [],
            steps: [
              {
                kind: "ACTION",
                target: { kind: "SELF" },
                actions: [{ effectActionDefinitionId: ATTACK_UP }],
              },
            ],
          },
        },
      ],
      requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
      metadata: { displayName: "MEM_SELF" },
    });
    const definitions = definitionsWith({ ALLY: [selfTargetMemory], ENEMY: [] }, [
      [ATTACK_UP, statModAction(ATTACK_UP, 0.1)],
    ]);
    const recorder = new EventRecorder(createBattleId("B_1"));

    expect(() =>
      startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-MEM-01-008: does not emit MemoryTriggered when the Memory resolves to no target at all", () => {
    // ALLY側Memoryが「敵の後列」を対象にするが、敵は前列にしかいないため対象0件。
    const noTargetMemory = createMemoryDefinition({
      memoryDefinitionId: "MEM_NO_TARGET",
      triggeredEffects: [
        {
          trigger: {
            eventType: "BattleStarted",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "SELF",
          },
          effectSequence: {
            targetBindings: [
              {
                targetBindingId: "TGT_BACK_ENEMIES",
                selector: {
                  kind: "SELECT",
                  side: "ENEMY",
                  count: "ALL",
                  filters: [{ kind: "POSITION_ROW", row: "BACK" }],
                },
              },
            ],
            steps: [
              {
                kind: "ACTION",
                target: { kind: "BINDING", targetBindingId: "TGT_BACK_ENEMIES" },
                actions: [{ effectActionDefinitionId: ATTACK_UP }],
              },
            ],
          },
        },
      ],
      requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
      metadata: { displayName: "MEM_NO_TARGET" },
    });
    const definitions = definitionsWith({ ALLY: [noTargetMemory], ENEMY: [] }, [
      [ATTACK_UP, statModAction(ATTACK_UP, 0.1)],
    ]);
    const recorder = new EventRecorder(createBattleId("B_1"));

    const battle = startBattle(battleWith(definitions), new SequenceRandomSource([]), recorder);

    expect(recorder.getEvents().some((event) => event.eventType === "MemoryTriggered")).toBe(false);
    expect(battle.enemyUnits[0]!.appliedEffects).toHaveLength(0);
  });
});
