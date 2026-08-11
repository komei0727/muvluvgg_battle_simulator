import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "./battle.js";
import { captureBattleState } from "./battle-state-snapshot.js";
import { reduceStateDeltas } from "./state-delta-reducer.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  effectKindKeyFromDefinitionId,
} from "../model/applied-effect.js";
import { createTurnLimit } from "../model/turn-limit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { MemoryDefinition } from "../../catalog/definitions/memory-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { Side } from "../../shared/side.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DefaultUnitDefinitionMap } from "../../../testing/fixtures/default-unit-definition-map.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const NO_SKILLS: BattleDefinitions = {
  activeSkillsByUnit: new Map(),
  exSkillByUnit: new Map(),
  effectActions: new Map(),
  unitDefinitions: new DefaultUnitDefinitionMap(),
  skillDefinitions: new Map(),
};

function unit(id: string, side: Side, unitDefinitionId = "UNIT_001"): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

function memoryDefinition(): MemoryDefinition {
  return {
    memoryDefinitionId: createMemoryDefinitionId("MEM_TEST"),
    triggeredEffects: [],
    metadata: { displayName: "Test Memory", tags: [] },
  };
}

function battleOf(mode?: "NORMAL" | "TACTICAL_EXERCISE") {
  return createBattle(
    createBattleId("B_1"),
    [unit("ally:1", "ALLY")],
    [unit("enemy:1", "ENEMY")],
    createTurnLimit(5),
    NO_SKILLS,
    mode,
  );
}

describe("Battle mode and exercise state (R-TEX-01)", () => {
  it("UT-R-TEX-01-001: a battle created without a mode is NORMAL and owns no exercise state, so its snapshot carries no exercise projection", () => {
    const battle = battleOf();

    expect(battle.mode).toBe("NORMAL");
    expect(battle.exercise).toBeUndefined();
    expect(captureBattleState(battle)).not.toHaveProperty("exercise");
  });

  it("UT-R-TEX-01-002: a TACTICAL_EXERCISE battle owns exercise state that starts at zero and is projected into the state snapshot", () => {
    const battle = battleOf("TACTICAL_EXERCISE");

    expect(battle.mode).toBe("TACTICAL_EXERCISE");
    expect(battle.exercise?.snapshot()).toEqual({ totalScore: 0, breakCount: 0 });
    expect(captureBattleState(battle).exercise).toEqual({ totalScore: 0, breakCount: 0 });
  });

  it("UT-R-TEX-01-003: a tactical exercise rejects an enemy side that is not exactly one unit, while a normal battle keeps accepting it", () => {
    const twoEnemies = [unit("enemy:1", "ENEMY"), unit("enemy:2", "ENEMY")];

    expect(() =>
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        twoEnemies,
        createTurnLimit(5),
        NO_SKILLS,
        "TACTICAL_EXERCISE",
      ),
    ).toThrow(DomainValidationError);
    expect(
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        twoEnemies,
        createTurnLimit(5),
        NO_SKILLS,
      ).enemyUnits,
    ).toHaveLength(2);
  });

  it("UT-R-TEX-01-004: a tactical exercise rejects enemy-side memories", () => {
    const definitions: BattleDefinitions = {
      ...NO_SKILLS,
      memoriesBySide: { ALLY: [], ENEMY: [memoryDefinition()] },
    };

    expect(() =>
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
        "TACTICAL_EXERCISE",
      ),
    ).toThrow(DomainValidationError);
    // 味方のメモリーはR-FRM-01〜05のままなので受理する。
    expect(
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        { ...NO_SKILLS, memoriesBySide: { ALLY: [memoryDefinition()], ENEMY: [] } },
        "TACTICAL_EXERCISE",
      ).mode,
    ).toBe("TACTICAL_EXERCISE");
  });

  it("UT-R-TEX-01-005: a tactical exercise rejects a turn limit other than the fixed five", () => {
    expect(() =>
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(4),
        NO_SKILLS,
        "TACTICAL_EXERCISE",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-01-006: the exercise state captures the enemy's base combat stats at creation, which is the origin the break scaling recomputes from (R-TEX-04)", () => {
    const enemy = unit("enemy:1", "ENEMY");
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [enemy],
      createTurnLimit(5),
      NO_SKILLS,
      "TACTICAL_EXERCISE",
    );

    expect(battle.exercise?.originalEnemyBaseCombatStats).toEqual(enemy.baseCombatStats);
  });
});

/** 味方の`UNIT_001`だけがAS（1ヒット・威力1）を持ち、敵の`UNIT_002`は行動しない。 */
function attackerDefinitions(): BattleDefinitions {
  const effectActionDefinitionId = createEffectActionDefinitionId("ACT_ATTACK");
  const effectAction: EffectActionDefinition = {
    kind: "DAMAGE",
    effectActionDefinitionId,
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
  const skill: SkillDefinition = {
    skillDefinitionId: createSkillDefinitionId("SKL_ATTACK"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_1"),
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: "ALL",
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId }],
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
    metadata: { displayName: "Attack", tags: [] },
  };
  return {
    activeSkillsByUnit: new Map<UnitDefinitionId, readonly SkillDefinition[]>([
      [createUnitDefinitionId("UNIT_001"), [skill]],
    ]),
    exSkillByUnit: new Map(),
    effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [effectActionDefinitionId, effectAction],
    ]),
    unitDefinitions: new DefaultUnitDefinitionMap(),
    skillDefinitions: new Map([[skill.skillDefinitionId, skill]]),
  };
}

describe("exercise score accumulation across a resolved turn (R-TEX-02)", () => {
  it("UT-R-TEX-02-015: the exercise state reaches the damage pipeline, so a resolved attack turn accumulates the score and keeps initialState + deltas === finalState", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [unit("enemy:1", "ENEMY", "UNIT_002")],
      createTurnLimit(5),
      attackerDefinitions(),
      "TACTICAL_EXERCISE",
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const random = new SequenceRandomSource([]);

    const initialState = captureBattleState(battle);
    const afterTurn = advanceBattle(startBattle(battle, random, recorder), random, recorder);

    const scored = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated");
    const amounts = scored.map((event) => (event.payload as { amount: number }).amount);
    expect(scored.length).toBeGreaterThan(0);
    expect(amounts.every((amount) => amount > 0)).toBe(true);

    // R-TEX-10 #3: 総スコアは発行された全計上量の合計と一致する。
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    expect(afterTurn.exercise?.totalScore).toBe(total);

    // `08_ドメインイベント.md`「状態復元」: 演習の差分種別を含めて成立する。
    const deltas = recorder
      .getEvents()
      .filter((event) => event.stateDelta !== undefined)
      .map((event) => event.stateDelta!);
    expect(reduceStateDeltas(initialState, deltas)).toEqual(captureBattleState(afterTurn));
  });

  it("UT-R-TEX-02-017: a passive skill firing on TurnStarted feeds the score too, so the PS/Memory chain carries the exercise state as well", () => {
    const damageActionId = createEffectActionDefinitionId("ACT_PS_DAMAGE");
    const passive: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_TURN_STARTED"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: createTargetBindingId("TGT_1"),
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: damageActionId }],
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
      metadata: { displayName: "OnTurnStarted", tags: [] },
    };
    const unitDefinitions = new DefaultUnitDefinitionMap();
    const allyUnitDefinitionId = createUnitDefinitionId("UNIT_001");
    unitDefinitions.set(allyUnitDefinitionId, {
      ...unitDefinitions.get(allyUnitDefinitionId)!,
      passiveSkillDefinitionIds: [passive.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
        [
          damageActionId,
          {
            kind: "DAMAGE",
            effectActionDefinitionId: damageActionId,
            metadata: { tags: [] },
            payload: {
              damageType: "PHYSICAL",
              formula: { kind: "CONSTANT", value: 25 },
              hitCount: 1,
              critical: { mode: "PREVENTED" },
              accuracy: { mode: "NORMAL" },
              piercing: {
                defenseIgnoreRate: 0,
                shieldIgnoreRate: 0,
                damageReductionIgnoreRate: 0,
              },
              damageModifiers: [],
              link: { enabled: false },
            },
          },
        ],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([[passive.skillDefinitionId, passive]]),
    };

    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [unit("enemy:1", "ENEMY", "UNIT_002")],
      createTurnLimit(5),
      definitions,
      "TACTICAL_EXERCISE",
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const random = new SequenceRandomSource([]);

    const afterTurn = advanceBattle(startBattle(battle, random, recorder), random, recorder);

    const scored = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated");
    expect(scored).toHaveLength(1);
    expect(afterTurn.exercise?.totalScore).toBeGreaterThan(0);
  });

  it("UT-R-TEX-02-018: a continuous damage firing at the waiting enemy's own action start feeds the score, so the action-start path carries the exercise state as well", () => {
    const dotActionId = createEffectActionDefinitionId("ACT_DOT");
    const dotDefinition: EffectActionDefinition = {
      effectActionDefinitionId: dotActionId,
      kind: "APPLY_CONTINUOUS_DAMAGE",
      payload: {
        continuousDamageKind: "FIXED",
        damageType: "PHYSICAL",
        formula: { kind: "CONSTANT", value: 15 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 3 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      metadata: { tags: [] },
    };
    const burning: BattleUnit = {
      ...unit("enemy:1", "ENEMY", "UNIT_002"),
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("EFFECT_DOT"),
          effectActionDefinitionId: dotActionId,
          kindKey: effectKindKeyFromDefinitionId(dotActionId),
          categories: ["DEBUFF"],
          duplicate: true,
          sourceUnitId: createBattleUnitId("ally:1"),
          targetUnitId: createBattleUnitId("enemy:1"),
          magnitude: 15,
          continuousDamage: { continuousDamageKind: "FIXED", damageType: "PHYSICAL" },
          snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: 100 },
          duration: {
            definition: {
              timeLimit: { unit: "ACTION", count: 3 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 3,
          },
          appliedTurnNumber: 1,
        },
      ],
    };
    const definitions: BattleDefinitions = {
      ...NO_SKILLS,
      effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
        [dotActionId, dotDefinition],
      ]),
    };

    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [burning],
      createTurnLimit(5),
      definitions,
      "TACTICAL_EXERCISE",
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const random = new SequenceRandomSource([]);

    const afterTurn = advanceBattle(startBattle(battle, random, recorder), random, recorder);

    const scored = recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated");
    expect(scored.length).toBeGreaterThan(0);
    expect(afterTurn.exercise?.totalScore).toBe(
      scored.reduce((sum, event) => sum + (event.payload as { amount: number }).amount, 0),
    );
  });

  it("UT-R-TEX-02-016: a normal battle resolving the same attack turn emits no exercise event and no exercise delta", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [unit("enemy:1", "ENEMY", "UNIT_002")],
      createTurnLimit(5),
      attackerDefinitions(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const random = new SequenceRandomSource([]);

    const afterTurn = advanceBattle(startBattle(battle, random, recorder), random, recorder);

    expect(afterTurn.exercise).toBeUndefined();
    expect(recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated")).toEqual(
      [],
    );
    expect(recorder.getEvents().filter((e) => e.stateDelta?.exercise !== undefined)).toEqual([]);
  });
});
