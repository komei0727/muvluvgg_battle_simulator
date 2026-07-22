import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "./battle.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createTurnLimit } from "../model/turn-limit.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DefaultUnitDefinitionMap } from "../../../testing/fixtures/default-unit-definition-map.js";

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

const NO_SKILLS: BattleDefinitions = {
  activeSkillsByUnit: new Map(),
  exSkillByUnit: new Map(),
  effectActions: new Map(),
  unitDefinitions: new DefaultUnitDefinitionMap(),
  skillDefinitions: new Map(),
};
const NO_RANDOM = () => new SequenceRandomSource([]);
const recorder = () => new EventRecorder(createBattleId("B_1"));

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

function statModDefinition(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE" },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function turnEffect(
  id: string,
  effectActionDefinitionId: EffectActionDefinitionId,
  ownerUnit: BattleUnit,
  timeLimitRemaining: number,
  grantedTurnNumber: number,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
    duplicate: true,
    sourceId: ownerUnit.battleUnitId,
    targetId: ownerUnit.battleUnitId,
    magnitude: 0.2,
    duration: {
      definition: {
        timeLimit: { unit: "TURN", count: timeLimitRemaining },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining,
      grantedTurnNumber,
    },
    appliedTurnNumber: grantedTurnNumber,
  };
}

function attackSkill(
  effectActionId: string,
  cooldown: SkillDefinition["cooldown"] = { unit: "ACTION", count: 0 },
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_${effectActionId}`),
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
    cooldown,
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
  return {
    activeSkillsByUnit,
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions: new DefaultUnitDefinitionMap(),
    skillDefinitions: new Map(),
  };
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
    counterUpdates: [],
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
  return {
    activeSkillsByUnit,
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions: new DefaultUnitDefinitionMap(),
    skillDefinitions: new Map(),
  };
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
    const battle = startBattle(readyBattle(), NO_RANDOM(), recorder());
    expect(battle.status).toBe("RUNNING");
  });

  it("UT-BATTLE-005: rejects starting a battle that is not READY", () => {
    const running = startBattle(readyBattle(), NO_RANDOM(), recorder());
    expect(() => startBattle(running, NO_RANDOM(), recorder())).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-017 (review fix [P2], Issue #144 follow-up): a BattleStarted-triggered PS with a non-zero PP cost never activates through the real BattleUnit creation path, because READY→RUNNING never recovers resources and createBattleUnit always starts currentPp at 0 — this is the only PP amount Q-BTL-05 allows (「コスト0のAS・PSは存在しない」), so BattleStarted-triggered PS activation is unreachable by today's decided contract; see passive-activation-service.test.ts's UT-R-PS-01-036 for a low-level (resource-unconstrained) proof that the resolutionPhase: \"BATTLE_START\" wiring itself is correct (docs/ddd/06_戦闘状態遷移.md)", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_001");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_BATTLE_STARTED_COSTLY");
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "TURN", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      requiredCapabilities: [],
      metadata: { displayName: "SKL_PS_ON_BATTLE_STARTED_COSTLY", tags: [] },
    };
    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        unitDefinitionId,
        {
          unitDefinitionId,
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "SUPPORT",
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
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          requiredCapabilities: [],
          metadata: {
            displayName: "Supporter",
            characterName: "Supporter",
            characterId: "CHAR_SUPPORTER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const battleRecorder = recorder();
    // `unit()`は`createBattleUnit`をそのまま呼ぶ（実際の生成経路と同じ形）。
    // `currentPp`を明示的にオーバーライドしないため0のまま。
    const battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
      ),
      NO_RANDOM(),
      battleRecorder,
    );

    // R-PS-04「発動直前確認: 必要PPを保有」が候補を破棄するため、PPは
    // 未変化のまま、`PassiveActivated`は発行されない。
    expect(battle.allyUnits[0]!.currentPp).toBe(0);
    const events = battleRecorder.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["BattleStarted"]);
  });
});

describe("advanceBattle", () => {
  it("UT-BATTLE-006: rejects advancing a battle that is not RUNNING", () => {
    expect(() => advanceBattle(readyBattle(), NO_RANDOM(), recorder())).toThrow(
      DomainValidationError,
    );
  });

  it("UT-BATTLE-007: TURN_STARTING recovers AP/PP for surviving units, which the action phase then spends via mandatory WAITs (no AS defined)", () => {
    const battle = advanceBattle(
      startBattle(readyBattle(5), NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

    expect(battle.turnState.currentTurn).toBe(1);
    // PP is untouched by the action phase (only AP is spent by AS/WAIT), so it proves recovery happened.
    expect(battle.allyUnits[0]!.currentPp).toBe(3);
    // AP recovers to 3, then a unit with no active skills WAITs 3 times (1 AP each) until it is queue-ineligible.
    expect(battle.allyUnits[0]!.currentAp).toBe(0);
    expect(battle.status).toBe("RUNNING");
  });

  it("PR #141 review [P1]: TURN_STARTING's AP/PP recovery is uniquely owned by per-resource ResourceChanged(TURN_RECOVERY) events, not by ResourcesRecovered directly", () => {
    const turnRecorder = recorder();
    const battle = advanceBattle(
      startBattle(readyBattle(5), NO_RANDOM(), recorder()),
      NO_RANDOM(),
      turnRecorder,
    );

    expect(battle.allyUnits[0]!.currentPp).toBe(3);

    const events = turnRecorder.getEvents();
    const resourcesRecovered = events.find((e) => e.eventType === "ResourcesRecovered")!;
    // R-ACT-04: exactly one event owns each state diff — ResourceChanged now
    // owns the AP/PP recovery, so ResourcesRecovered itself must not.
    expect(resourcesRecovered.stateDelta).toBeUndefined();

    // Restrict to the window between ResourcesRecovered and the action phase's
    // first ActionStarted so the ally's own later WAITs (which also emit
    // ResourceChanged for AP/EX, R-ACT-03) aren't mixed in.
    const actionStartedIndex = events.findIndex((e) => e.eventType === "ActionStarted");
    const resourceChangedForAlly = events
      .slice(0, actionStartedIndex)
      .filter(
        (e): e is Extract<typeof e, { eventType: "ResourceChanged" }> =>
          e.eventType === "ResourceChanged" && e.sourceUnitId === battle.allyUnits[0]!.battleUnitId,
      );
    expect(
      resourceChangedForAlly.map((e) => ({
        resource: e.payload.resource,
        reason: e.payload.reason,
      })),
    ).toEqual([
      { resource: "AP", reason: "TURN_RECOVERY" },
      { resource: "PP", reason: "TURN_RECOVERY" },
    ]);
    expect(resourceChangedForAlly[0]!.payload).toMatchObject({ before: 0, after: 3, delta: 3 });
    expect(resourceChangedForAlly[0]!.stateDelta).toEqual({
      units: { [battle.allyUnits[0]!.battleUnitId]: { ap: { before: 0, after: 3 } } },
    });
    expect(resourceChangedForAlly[1]!.stateDelta).toEqual({
      units: { [battle.allyUnits[0]!.battleUnitId]: { pp: { before: 0, after: 3 } } },
    });
  });

  it("UT-BATTLE-008: does not recover resources for a unit that started defeated", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0, currentAp: 0 })],
      [unit("enemy:1", "ENEMY")],
      createTurnLimit(5),
      NO_SKILLS,
    );

    const advanced = advanceBattle(
      startBattle(battle, NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

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

    const completed = advanceBattle(
      startBattle(battle, NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

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

    const completed = advanceBattle(
      startBattle(battle, NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

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

    const completed = advanceBattle(
      startBattle(battle, NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "ALLY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-004 / SCN-BTL-020 lifecycle: neither side defeated stays RUNNING until the regulation turn count is reached, then resolves ALLY_LOSE/TURN_LIMIT_REACHED", () => {
    const rec = recorder();
    let battle = startBattle(readyBattle(2), NO_RANDOM(), rec);

    battle = advanceBattle(battle, NO_RANDOM(), rec);
    expect(battle.status).toBe("RUNNING");
    expect(battle.turnState.currentTurn).toBe(1);

    battle = advanceBattle(battle, NO_RANDOM(), rec);
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
    const completed = advanceBattle(
      startBattle(battle, NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

    expect(() => advanceBattle(completed, NO_RANDOM(), recorder())).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-010 (Issue #9 acceptance: ダメージから勝敗までDomain内で完結する): AS attacks reduce the target's HP within the action phase, once per AP spent (maximumAp: 3, cost: 1)", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unitWithStats("ally:1", "ALLY", { attack: 30 })],
      [unitWithStats("enemy:1", "ENEMY", { defense: 10 })],
      createTurnLimit(5),
      attackerDefinitions(),
    );

    const advanced = advanceBattle(
      startBattle(battle, NO_RANDOM(), recorder()),
      NO_RANDOM(),
      recorder(),
    );

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
      NO_RANDOM(),
      recorder(),
    );

    battle = advanceBattle(battle, NO_RANDOM(), recorder());

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
      NO_RANDOM(),
      recorder(),
    );

    battle = advanceBattle(battle, NO_RANDOM(), recorder());

    expect(battle.status).toBe("COMPLETED");
    expect(battle.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "SIMULTANEOUS_DEFEAT",
      completedTurn: 1,
    });
  });

  it("UT-BATTLE-013 (R-SKL-04 ターン単位): does not decrement a TURN-unit cooldown set on the current turn, but decrements it at the next turn's end", () => {
    const cooldownSkillId = createSkillDefinitionId("SKL_TURN_COOLDOWN");
    let battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [
          unit("ally:1", "ALLY", {
            cooldowns: { [cooldownSkillId]: { unit: "TURN", remaining: 2, setTurnNumber: 1 } },
          }),
        ],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        NO_SKILLS,
      ),
      NO_RANDOM(),
      recorder(),
    );

    const turn1Recorder = recorder();
    battle = advanceBattle(battle, NO_RANDOM(), turn1Recorder);

    expect(battle.allyUnits[0]!.cooldowns[cooldownSkillId]).toEqual({
      unit: "TURN",
      remaining: 2,
      setTurnNumber: 1,
    });
    expect(turn1Recorder.getEvents().filter((e) => e.eventType === "CooldownReduced")).toHaveLength(
      0,
    );

    const turn2Recorder = recorder();
    battle = advanceBattle(battle, NO_RANDOM(), turn2Recorder);

    expect(battle.allyUnits[0]!.cooldowns[cooldownSkillId]).toEqual({
      unit: "TURN",
      remaining: 1,
      setTurnNumber: 1,
    });
    const reduced = turn2Recorder.getEvents().filter((e) => e.eventType === "CooldownReduced");
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({
      actorUnitId: battle.allyUnits[0]!.battleUnitId,
      skillDefinitionId: cooldownSkillId,
      unit: "TURN",
      before: 2,
      after: 1,
    });
    expect(
      turn2Recorder.getEvents().filter((e) => e.eventType === "CooldownCompleted"),
    ).toHaveLength(0);
  });

  it("UT-BATTLE-014 (R-SKL-04 ターン単位 / regression PR#128 review [P1]): an actual AS use with a TURN-unit cooldown records the setting scope as `setTurnNumber` (not `setActionId`), so it is not decremented at the end of the same turn it was set", () => {
    const skill = attackSkill("ACT_TURN_CD", { unit: "TURN", count: 2 });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[createUnitDefinitionId("UNIT_001"), [skill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [createEffectActionDefinitionId("ACT_TURN_CD"), damageEffectAction("ACT_TURN_CD")],
      ]),
      unitDefinitions: new DefaultUnitDefinitionMap(),
      skillDefinitions: new Map(),
    };
    const battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
      ),
      NO_RANDOM(),
      recorder(),
    );

    const advanced = advanceBattle(battle, NO_RANDOM(), recorder());

    // A bug here (using `{ actionId }` as the cooldown-setting scope
    // regardless of `cooldown.unit`) would record `setActionId` instead,
    // causing `decrementTurnCooldowns` to treat this as "not set this turn"
    // and decrement it to `remaining: 1` within this very same TURN_ENDING.
    expect(advanced.allyUnits[0]!.cooldowns[skill.skillDefinitionId]).toEqual({
      unit: "TURN",
      remaining: 2,
      setTurnNumber: 1,
    });
  });

  it("UT-R-EFF-06-006 (R-EFF-06 #1/Q-EFF-12): does not decrement a TURN-unit AppliedEffect granted on the current turn", () => {
    const def = statModDefinition("ACT_TURN_BUFF");
    const definitions: BattleDefinitions = {
      ...NO_SKILLS,
      effectActions: new Map([[def.effectActionDefinitionId, def]]),
    };
    const ally = unit("ally:1", "ALLY");
    const effect = turnEffect("effect-1", def.effectActionDefinitionId, ally, 2, 1);
    let battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [{ ...ally, appliedEffects: [effect] }],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
      ),
      NO_RANDOM(),
      recorder(),
    );

    const turn1Recorder = recorder();
    battle = advanceBattle(battle, NO_RANDOM(), turn1Recorder);

    expect(battle.allyUnits[0]!.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
    expect(
      turn1Recorder.getEvents().filter((e) => e.eventType === "EffectDurationReduced"),
    ).toHaveLength(0);
  });

  it("UT-R-EFF-06-007 (R-EFF-06 #2/#5/#6, R-STA-04): decrements a TURN-unit AppliedEffect at the next turn's end, and expires + reverts CombatStat at 0 remaining", () => {
    const def = statModDefinition("ACT_TURN_BUFF");
    const definitions: BattleDefinitions = {
      ...NO_SKILLS,
      effectActions: new Map([[def.effectActionDefinitionId, def]]),
    };
    const ally = unit("ally:1", "ALLY");
    const effect = turnEffect("effect-1", def.effectActionDefinitionId, ally, 1, 1);
    const allyWithEffect = {
      ...ally,
      appliedEffects: [effect],
      combatStats: { ...ally.combatStats, attack: 12 },
    };
    let battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [allyWithEffect],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
      ),
      NO_RANDOM(),
      recorder(),
    );

    battle = advanceBattle(battle, NO_RANDOM(), recorder());
    const turn2Recorder = recorder();
    battle = advanceBattle(battle, NO_RANDOM(), turn2Recorder);

    expect(battle.allyUnits[0]!.appliedEffects).toHaveLength(0);
    expect(battle.allyUnits[0]!.combatStats.attack).toBe(10);
    const types = turn2Recorder.getEvents().map((e) => e.eventType);
    expect(types).toContain("EffectDurationReduced");
    expect(types).toContain("EffectExpired");
    expect(types).toContain("CombatStatChanged");
    expect(types.indexOf("EffectDurationReduced")).toBeLessThan(types.indexOf("EffectExpired"));
    expect(types.indexOf("EffectExpired")).toBeLessThan(types.indexOf("CombatStatChanged"));
    expect(types.indexOf("CombatStatChanged")).toBeLessThan(types.indexOf("TurnCompleted"));
  });

  it("UT-R-PS-05-003 (Issue #34 integration): a PS that triggers on TurnStarted activates during TURN_STARTING, before the action phase runs (PP consumed, EX gauge increased)", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_001");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_TURN_STARTED");
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
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
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "TURN", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      requiredCapabilities: [],
      metadata: { displayName: "SKL_PS_ON_TURN_STARTED", tags: [] },
    };
    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        unitDefinitionId,
        {
          unitDefinitionId,
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "SUPPORT",
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
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          requiredCapabilities: [],
          metadata: {
            displayName: "Supporter",
            characterName: "Supporter",
            characterId: "CHAR_SUPPORTER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY", { currentPp: 0 })],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
      ),
      NO_RANDOM(),
      recorder(),
    );

    const turnRecorder = recorder();
    const advanced = advanceBattle(battle, NO_RANDOM(), turnRecorder);

    // TURN_STARTING recovers AP/PP to max *before* resolving PS (06_戦闘状態
    // 遷移.md「TURN_STARTING」#2 precedes #5), so the PS consumes from the
    // recovered maximumPp (3), leaving 2 — not from the pre-recovery value.
    expect(advanced.allyUnits[0]!.currentPp).toBe(2);
    // EX gauge: +1 from the PS's own activation, then +1 per subsequent
    // mandatory WAIT in the action phase (maximumAp 3, no active skill, R-ACT-03).
    expect(advanced.allyUnits[0]!.currentExtraGauge).toBe(4);

    const events = turnRecorder.getEvents();
    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: battle.allyUnits[0]!.battleUnitId,
      skillDefinitionId: passiveSkillDefinitionId,
      ppBefore: 3,
      ppAfter: 2,
      exBefore: 0,
      exAfter: 1,
    });
    expect(events.some((e) => e.eventType === "PassiveResolved")).toBe(true);

    // The PS-owning unit's own action phase (WAITs, since it has no active
    // skill) happens after TURN_STARTING and is unaffected by the PS.
    expect(advanced.allyUnits[0]!.currentAp).toBe(0);
  });

  it('UT-BATTLE-016 (Issue #144 follow-up, PR #150 remaining work): resolves a PS that triggers on TurnCompleting, passing resolutionPhase: "TURN_END" to the trigger condition, before the turn-unit cooldown decrement re-reads unit state (06_戦闘状態遷移.md TURN_ENDING #1-2)', () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_001");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_TURN_COMPLETING");
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "TurnCompleting",
          category: "TIMING",
          // レビュー指摘[P1]: production Catalogの`TurnCompleting`trigger12件は
          // すべて`SELF`/`SELF`（`08_ドメインイベント.md`の「自身がASを使う前」
          // 例と同じ著者慣習）。`TurnCompleting`はunit固有の`sourceUnitId`/
          // `targetUnitIds`を持たないグローバルイベントのため、`ANY`/`ANY`では
          // この不一致（`evaluateSourceSelector`/`evaluateTargetSelector`の
          // `SELF`分岐が`event.sourceUnitId`不在時に必ずfalseを返す）を検出
          // できなかった。
          sourceSelector: "SELF",
          targetSelector: "SELF",
          condition: { kind: "RESOLUTION_PHASE", phase: "TURN_END", negate: false },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "TURN", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      requiredCapabilities: [],
      metadata: { displayName: "SKL_PS_ON_TURN_COMPLETING", tags: [] },
    };
    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        unitDefinitionId,
        {
          unitDefinitionId,
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "SUPPORT",
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
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          requiredCapabilities: [],
          metadata: {
            displayName: "Supporter",
            characterName: "Supporter",
            characterId: "CHAR_SUPPORTER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [unit("ally:1", "ALLY")],
        [unit("enemy:1", "ENEMY")],
        createTurnLimit(5),
        definitions,
      ),
      NO_RANDOM(),
      recorder(),
    );

    const turnRecorder = recorder();
    const advanced = advanceBattle(battle, NO_RANDOM(), turnRecorder);

    // TURN_STARTING recovers PP to max (3), and the PS costs 1, consumed
    // during TURN_ENDING (TurnCompleting), leaving 2.
    expect(advanced.allyUnits[0]!.currentPp).toBe(2);

    const events = turnRecorder.getEvents();
    const turnCompletingIndex = events.findIndex((e) => e.eventType === "TurnCompleting");
    const passiveActivatedIndex = events.findIndex((e) => e.eventType === "PassiveActivated");
    const turnCompletedIndex = events.findIndex((e) => e.eventType === "TurnCompleted");
    expect(turnCompletingIndex).toBeGreaterThanOrEqual(0);
    // 06_戦闘状態遷移.md TURN_ENDING #1: `TurnCompleting`発行直後に対応するPSを
    // 解決する（#2のクールタイム再取得より前）。
    expect(passiveActivatedIndex).toBeGreaterThan(turnCompletingIndex);
    expect(turnCompletedIndex).toBeGreaterThan(passiveActivatedIndex);
    const passiveActivated = events[passiveActivatedIndex]!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: advanced.allyUnits[0]!.battleUnitId,
      skillDefinitionId: passiveSkillDefinitionId,
      ppBefore: 3,
      ppAfter: 2,
    });
    expect(events.some((e) => e.eventType === "PassiveResolved")).toBe(true);
  });
});
