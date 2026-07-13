import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "./battle.js";
import { createBattleUnit, type BattleUnit } from "./battle-unit.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import type { BattlePartyMember } from "./battle-party.js";
import { createTurnLimit } from "./turn-limit.js";
import { DomainValidationError } from "../shared/errors.js";
import { createBattleId, createBattleUnitId } from "../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
  type UnitDefinitionId,
} from "../catalog/catalog-ids.js";
import type { Side } from "./side.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";
import type { TargetSelectorDefinition } from "../catalog/target-selector-definition.js";
import type { EffectActionDefinition } from "../catalog/effect-action-definition.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

function member(id: string, overrides: Partial<BattlePartyMember> = {}): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
    ...overrides,
  };
}

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  return { ...createBattleUnit(member(id), side, LIMITS), ...overrides };
}

function unitWithStats(
  id: string,
  side: Side,
  statOverrides: Partial<BattlePartyMember["combatStats"]>,
): BattleUnit {
  return createBattleUnit(
    member(id, { combatStats: { ...member(id).combatStats, ...statOverrides } }),
    side,
    LIMITS,
  );
}

const NO_SKILLS: BattleDefinitions = { activeSkillsByUnit: new Map(), effectActions: new Map() };
const NO_RANDOM = () => new SequenceRandomSource([]);

function readyBattle(turnLimit = 5, definitions: BattleDefinitions = NO_SKILLS) {
  return createBattle(
    createBattleId("B_1"),
    [unit("ally:1", "ALLY")],
    [unit("enemy:1", "ENEMY")],
    createTurnLimit(turnLimit),
    definitions,
  );
}

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

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
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function attackSkill(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_${effectActionId}`),
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

/** 攻撃側UnitDefinitionId(UNIT_001)がACT_ATTACKのAS(APコスト1)を1つ持つDefinitions。 */
function attackerDefinitions(): BattleDefinitions {
  const effectAction = damageEffectAction("ACT_ATTACK");
  const activeSkillsByUnit = new Map<UnitDefinitionId, readonly SkillDefinition[]>([
    [createUnitDefinitionId("UNIT_001"), [attackSkill("ACT_ATTACK")]],
  ]);
  const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
    [effectAction.effectActionDefinitionId, effectAction],
  ]);
  return { activeSkillsByUnit, effectActions };
}

/**
 * 攻撃側UnitDefinitionId(UNIT_001)が、1回のAS使用の中で
 * (1) 敵へ致死ダメージ、(2) 自分自身へ致死ダメージ、を2つのACTION stepとして
 * 定義順に処理するASを1つ持つDefinitions。同じ解決スコープ内(R-SKL-01)で
 * 両陣営が全滅する「同時全滅」(R-END-02)をダメージ処理経由で再現するために使う。
 */
function mutuallyLethalDefinitions(): BattleDefinitions {
  const enemyEffectAction = damageEffectAction("ACT_LETHAL_ENEMY");
  const selfEffectAction = damageEffectAction("ACT_LETHAL_SELF");
  const skill: SkillDefinition = {
    skillDefinitionId: createSkillDefinitionId("SKL_MUTUALLY_LETHAL"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_ENEMY"), selector: ENEMY_ALL },
      ],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ENEMY") },
          actions: [{ effectActionDefinitionId: enemyEffectAction.effectActionDefinitionId }],
        },
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: selfEffectAction.effectActionDefinitionId }],
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
    metadata: { displayName: "MutuallyLethal", tags: [] },
  };
  const activeSkillsByUnit = new Map<UnitDefinitionId, readonly SkillDefinition[]>([
    [createUnitDefinitionId("UNIT_001"), [skill]],
  ]);
  const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
    [enemyEffectAction.effectActionDefinitionId, enemyEffectAction],
    [selfEffectAction.effectActionDefinitionId, selfEffectAction],
  ]);
  return { activeSkillsByUnit, effectActions };
}

describe("createBattle", () => {
  it("UT-BATTLE-001: creates a READY battle with turn 0 and the given units", () => {
    const battle = readyBattle(5);

    expect(battle.status).toBe("READY");
    expect(battle.turnState.currentTurn).toBe(0);
    expect(battle.turnState.turnLimit).toBe(5);
    expect(battle.allyUnits).toHaveLength(1);
    expect(battle.enemyUnits).toHaveLength(1);
    expect(battle.result).toBeUndefined();
  });

  it("UT-BATTLE-002: rejects creation with no ally units (06_戦闘状態遷移.md: 両陣営に1体以上のユニットが存在)", () => {
    expect(() =>
      createBattle(
        createBattleId("B_1"),
        [],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        NO_SKILLS,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-003: rejects creation with no enemy units", () => {
    expect(() =>
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [],
        createTurnLimit(5),
        NO_SKILLS,
      ),
    ).toThrow(DomainValidationError);
  });
});

describe("startBattle", () => {
  it("UT-BATTLE-004: transitions READY to RUNNING (06_戦闘状態遷移.md)", () => {
    const battle = startBattle(readyBattle());
    expect(battle.status).toBe("RUNNING");
  });

  it("UT-BATTLE-005: rejects starting a battle that is not READY", () => {
    const running = startBattle(readyBattle());
    expect(() => startBattle(running)).toThrow(DomainValidationError);
  });
});

describe("advanceBattle", () => {
  it("UT-BATTLE-006: rejects advancing a battle that is not RUNNING", () => {
    expect(() => advanceBattle(readyBattle(), NO_RANDOM())).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-007: TURN_STARTING recovers AP/PP for surviving units, which the action phase then spends via mandatory WAITs (no AS defined)", () => {
    const battle = advanceBattle(startBattle(readyBattle(5)), NO_RANDOM());

    expect(battle.turnState.currentTurn).toBe(1);
    // PP is untouched by the action phase (only AP is spent by AS/WAIT), so it proves recovery happened.
    expect(battle.allyUnits[0]!.currentPp).toBe(3);
    // AP recovers to 3, then a unit with no active skills WAITs 3 times (1 AP each) until it is queue-ineligible.
    expect(battle.allyUnits[0]!.currentAp).toBe(0);
    expect(battle.status).toBe("RUNNING");
  });

  it("UT-BATTLE-008: does not recover resources for a unit that started defeated", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0, currentAp: 0 })],
      [unit("enemy:1", "ENEMY")],
      createTurnLimit(5),
      NO_SKILLS,
    );

    const advanced = advanceBattle(startBattle(battle), NO_RANDOM());

    expect(advanced.allyUnits[0]!.currentAp).toBe(0);
  });

  it("UT-R-END-01-001 / SCN-BTL-019 lifecycle: mutual defeat at battle start resolves ALLY_WIN/SIMULTANEOUS_DEFEAT on the first TURN_STARTING result check", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0 })],
      [unit("enemy:1", "ENEMY", { currentHp: 0 })],
      createTurnLimit(5),
      NO_SKILLS,
    );

    const completed = advanceBattle(startBattle(battle), NO_RANDOM());

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "SIMULTANEOUS_DEFEAT",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-002: an enemy defeated before allies resolves ALLY_WIN/ENEMY_DEFEATED even mid-way through the turn limit", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [unit("enemy:1", "ENEMY", { currentHp: 0 })],
      createTurnLimit(99),
      NO_SKILLS,
    );

    const completed = advanceBattle(startBattle(battle), NO_RANDOM());

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-003: allies defeated with the enemy surviving resolves ALLY_LOSE/ALLY_DEFEATED", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0 })],
      [unit("enemy:1", "ENEMY")],
      createTurnLimit(5),
      NO_SKILLS,
    );

    const completed = advanceBattle(startBattle(battle), NO_RANDOM());

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "ALLY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-004 / SCN-BTL-020 lifecycle: neither side defeated stays RUNNING until the regulation turn count is reached, then resolves ALLY_LOSE/TURN_LIMIT_REACHED", () => {
    let battle = startBattle(readyBattle(2));

    battle = advanceBattle(battle, NO_RANDOM());
    expect(battle.status).toBe("RUNNING");
    expect(battle.turnState.currentTurn).toBe(1);

    battle = advanceBattle(battle, NO_RANDOM());
    expect(battle.status).toBe("COMPLETED");
    expect(battle.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 2,
    });
  });

  it("UT-BATTLE-009: rejects advancing a COMPLETED battle (06_戦闘状態遷移.md 異常系: COMPLETED後の進行要求)", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0 })],
      [unit("enemy:1", "ENEMY", { currentHp: 0 })],
      createTurnLimit(5),
      NO_SKILLS,
    );
    const completed = advanceBattle(startBattle(battle), NO_RANDOM());

    expect(() => advanceBattle(completed, NO_RANDOM())).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-010 (Issue #9 acceptance: ダメージから勝敗までDomain内で完結する): AS attacks reduce the target's HP within the action phase, once per AP spent (maximumAp: 3, cost: 1)", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unitWithStats("ally:1", "ALLY", { attack: 30 })],
      [unitWithStats("enemy:1", "ENEMY", { defense: 10 })],
      createTurnLimit(5),
      attackerDefinitions(),
    );

    const advanced = advanceBattle(startBattle(battle), NO_RANDOM());

    expect(advanced.status).toBe("RUNNING");
    // 3 AP at 1 AP/use means the ally attacks 3 times this turn: 100 - 3*20 = 40.
    expect(advanced.enemyUnits[0]!.currentHp).toBe(40);
    expect(advanced.allyUnits[0]!.currentAp).toBe(0);
  });

  it("UT-BATTLE-011 (Issue #9 acceptance: ダメージから勝敗までDomain内で完結する): repeated AS attacks defeat the enemy and resolve ALLY_WIN/ENEMY_DEFEATED without a turn limit", () => {
    let battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [unitWithStats("ally:1", "ALLY", { attack: 999 })],
        [unitWithStats("enemy:1", "ENEMY", { defense: 0, maximumHp: 10 })],
        createTurnLimit(5),
        attackerDefinitions(),
      ),
    );

    battle = advanceBattle(battle, NO_RANDOM());

    expect(battle.status).toBe("COMPLETED");
    expect(battle.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-BATTLE-012 (Issue #9 acceptance: 同時全滅, R-END-02): a single AS use that deals lethal damage to the enemy and then to its own user resolves SIMULTANEOUS_DEFEAT/ALLY_WIN", () => {
    let battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [unitWithStats("ally:1", "ALLY", { attack: 999, defense: 0, maximumHp: 10 })],
        [unitWithStats("enemy:1", "ENEMY", { defense: 0, maximumHp: 10 })],
        createTurnLimit(5),
        mutuallyLethalDefinitions(),
      ),
    );

    battle = advanceBattle(battle, NO_RANDOM());

    expect(battle.status).toBe("COMPLETED");
    expect(battle.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "SIMULTANEOUS_DEFEAT",
      completedTurn: 1,
    });
  });
});
