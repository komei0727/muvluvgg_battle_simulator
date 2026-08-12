import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "./battle.js";
import { captureBattleState } from "./battle-state-snapshot.js";
import { reduceStateDeltas } from "./state-delta-reducer.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  SUBUNIT_PROVIDER_ATTACK_KEY,
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

/**
 * ブレイク・復活パイプライン（TEX-004、R-TEX-03／05〜08）の通し検証。味方の`UNIT_001`だけが
 * ASを持ち、`hitCount`と1ヒットあたりのダメージ量だけを差し替えて各シナリオを作る。
 */
function breakingAttackerDefinitions(options: {
  readonly damagePerHit: number;
  readonly hitCount: number;
  readonly allyPassive?: SkillDefinition;
  readonly extraEffectActions?: readonly EffectActionDefinition[];
}): BattleDefinitions {
  const effectActionDefinitionId = createEffectActionDefinitionId("ACT_BIG_ATTACK");
  const effectAction: EffectActionDefinition = {
    kind: "DAMAGE",
    effectActionDefinitionId,
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      // 防御力の影響を受けない固定値にする — 強化後の防御力でヒットごとの量が変わると、
      // ブレイク回数と強化倍率の検証がダメージ計算式の検証に化けてしまう。
      formula: { kind: "CONSTANT", value: options.damagePerHit },
      hitCount: options.hitCount,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 1, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
  const skill: SkillDefinition = {
    skillDefinitionId: createSkillDefinitionId("SKL_BIG_ATTACK"),
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
    // 味方はAPの続く限り同じ行動を繰り返せるため、1ターンに1回だけ使えるようにする
    // — ブレイク回数と強化倍率の対応を、行動回数に左右されずに検証するためである。
    cooldown: { unit: "TURN", count: 5 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "BigAttack", tags: [] },
  };
  const unitDefinitions = new DefaultUnitDefinitionMap();
  const allyUnitDefinitionId = createUnitDefinitionId("UNIT_001");
  if (options.allyPassive !== undefined) {
    unitDefinitions.set(allyUnitDefinitionId, {
      ...unitDefinitions.get(allyUnitDefinitionId)!,
      passiveSkillDefinitionIds: [options.allyPassive.skillDefinitionId],
    });
  }
  const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);
  if (options.allyPassive !== undefined) {
    skillDefinitions.set(options.allyPassive.skillDefinitionId, options.allyPassive);
  }
  return {
    activeSkillsByUnit: new Map<UnitDefinitionId, readonly SkillDefinition[]>([
      [allyUnitDefinitionId, [skill]],
    ]),
    exSkillByUnit: new Map(),
    effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [effectActionDefinitionId, effectAction],
      ...(options.extraEffectActions ?? []).map(
        (definition) => [definition.effectActionDefinitionId, definition] as const,
      ),
    ]),
    unitDefinitions,
    skillDefinitions,
  };
}

function exerciseBattleWith(
  definitions: BattleDefinitions,
  enemyOverrides: Partial<BattleUnit> = {},
) {
  const enemy = { ...unit("enemy:1", "ENEMY", "UNIT_002"), ...enemyOverrides };
  const battle = createBattle(
    createBattleId("B_1"),
    [unit("ally:1", "ALLY")],
    [enemy],
    createTurnLimit(5),
    definitions,
    "TACTICAL_EXERCISE",
  );
  const recorder = new EventRecorder(createBattleId("B_1"));
  const random = new SequenceRandomSource([]);
  const initialState = captureBattleState(battle);
  const afterTurn = advanceBattle(startBattle(battle, random, recorder), random, recorder);
  return { battle, recorder, afterTurn, initialState };
}

/** `initialState + 全stateDelta = finalState`（`08_ドメインイベント.md`「状態復元」）。 */
function expectStateRestoration(
  initialState: ReturnType<typeof captureBattleState>,
  recorder: EventRecorder,
  afterTurn: Parameters<typeof captureBattleState>[0],
): void {
  const deltas = recorder
    .getEvents()
    .filter((event) => event.stateDelta !== undefined)
    .map((event) => event.stateDelta!);
  expect(reduceStateDeltas(initialState, deltas)).toEqual(captureBattleState(afterTurn));
}

describe("break and revival pipeline (R-TEX-03／05〜08)", () => {
  it("SCN-BTL-025: a break applies the table's enhancement to the original baseline, fully heals to the enhanced maximum, and carries AP/PP/EX gauges, cooldowns and the action reservation across it", () => {
    const enemyBefore = {
      currentAp: 2,
      currentPp: 1,
      currentExtraGauge: 7,
    } satisfies Partial<BattleUnit>;
    const { recorder, afterTurn, initialState } = exerciseBattleWith(
      breakingAttackerDefinitions({ damagePerHit: 150, hitCount: 1 }),
      enemyBefore,
    );

    const types = recorder.getEvents().map((event) => event.eventType);
    expect(types).toContain("UnitBroken");
    expect(types).toContain("UnitRevived");
    // R-TEX-03 #3／R-TEX-06 #1: 敵が`DEFEATED`として観測されるタイミングを作らない。
    expect(types).not.toContain("UnitDefeated");
    // R-TEX-03 #3: 行動順キューからの除去も起きない。
    expect(
      recorder
        .getEvents()
        .filter((event) => event.eventType === "ActionReservationRemoved")
        .map((event) => (event.payload as { battleUnitId?: string }).battleUnitId),
    ).not.toContain("enemy:1");

    const enemy = afterTurn.enemyUnits[0]!;
    // R-TEX-04: 原基準値（HP100・攻撃10・防御10・速度10・会心率0）へ1ブレイク目の強化。
    // HP／攻撃／防御は×1.20、速度は×1.05（10.5 → R-TEX-04 #5で切り捨て10）、
    // 会心率は絶対値+1pp。会心ダメージ・属性相性は強化しない（同 #3）。
    expect(enemy.baseCombatStats).toEqual({
      maximumHp: 120,
      attack: 12,
      defense: 12,
      criticalRate: 0.01,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    });
    // R-TEX-05 #3: 強化後の最大HPまで全回復する。
    expect(enemy.currentHp).toBe(120);
    // R-TEX-06 #2／#3: ブレイク〜復活の区間が、AP・PP・EXゲージの現在値と上限、
    // クールタイム、チャージ、RuntimeCounter、行動順予約を一切動かさないことを
    // 差分の所有で確かめる（ターン開始の回復や敵自身の待機によるAP消費は同じ区間の
    // 外で起きるため、ターン終了時点の値と比べると両者を取り違える）。
    const events = recorder.getEvents();
    const brokenIndex = events.findIndex((event) => event.eventType === "UnitBroken");
    const revivedIndex = events.findIndex((event) => event.eventType === "UnitRevived");
    const carriedOverFields = [
      "ap",
      "pp",
      "extraGauge",
      "maximumAp",
      "maximumPp",
      "maximumExtraGauge",
      "cooldowns",
      "charge",
      "skillCounters",
    ] as const;
    const touched = events
      .slice(brokenIndex, revivedIndex + 1)
      .flatMap((event) =>
        carriedOverFields.filter(
          (field) => event.stateDelta?.units?.["enemy:1" as never]?.[field] !== undefined,
        ),
      );
    expect(touched).toEqual([]);
    expect(enemy.maximumAp).toBe(LIMITS.maximumAp);
    expect(enemy.maximumExtraGauge).toBe(LIMITS.maximumExtraGauge);
    // R-TEX-03 #4: ブレイク回数が1増える。R-TEX-02 #2: オーバーキル分も計上する。
    expect(afterTurn.exercise?.breakCount).toBe(1);
    expect(afterTurn.exercise?.totalScore).toBe(150);

    expectStateRestoration(initialState, recorder, afterTurn);
  });

  it("SCN-BTL-026: a revival clears the enemy's unit-granted effects and markers while Memory-granted ones persist (R-TEX-05 #2 / R-MEM-04)", () => {
    const buffDefinitionId = createEffectActionDefinitionId("ACT_ENEMY_ATK_UP");
    const enemyId = createBattleUnitId("enemy:1");
    const unitGranted = {
      effectInstanceId: createEffectInstanceId("EFF_FROM_UNIT"),
      effectActionDefinitionId: buffDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(buffDefinitionId),
      duplicate: true,
      sourceUnitId: enemyId,
      targetUnitId: enemyId,
      magnitude: 0.5,
      categories: ["BUFF" as const],
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    // R-MEM-04: メモリー由来の付与は`sourceUnitId`のキー自体を持たず`sourceSide`だけを持つ。
    const { sourceUnitId: _granterUnitId, ...withoutGranter } = unitGranted;
    const memoryGranted = {
      ...withoutGranter,
      effectInstanceId: createEffectInstanceId("EFF_FROM_MEMORY"),
      sourceSide: "ALLY" as const,
    };

    const definitions = breakingAttackerDefinitions({
      damagePerHit: 150,
      hitCount: 1,
      extraEffectActions: [
        {
          effectActionDefinitionId: buffDefinitionId,
          kind: "APPLY_STAT_MOD",
          payload: {
            stat: "ATTACK",
            valueType: "RATIO",
            formula: { kind: "CONSTANT", value: 0 },
            stacking: { mode: "STACKABLE", max: null },
            duration: { dispellable: true, linkedEffectGroupId: null },
          },
          metadata: { tags: [] },
        },
      ],
    });

    const { recorder, afterTurn, initialState } = exerciseBattleWith(definitions, {
      appliedEffects: [unitGranted, memoryGranted],
    });

    const enemy = afterTurn.enemyUnits[0]!;
    expect(enemy.appliedEffects.map((effect) => effect.effectInstanceId)).toEqual([
      "EFF_FROM_MEMORY",
    ]);
    // 解除は`UnitBroken`の子として発行され、`UnitRevived`より前に完了する。
    const order = recorder
      .getEvents()
      .map((event) => event.eventType)
      .filter(
        (type) => type === "UnitBroken" || type === "EffectRemoved" || type === "UnitRevived",
      );
    expect(order).toEqual(["UnitBroken", "EffectRemoved", "UnitRevived"]);
    // 残った効果（メモリー由来+50%）は強化後の基礎値12へ合成される（R-TEX-04 #4）。
    expect(enemy.baseCombatStats.attack).toBe(12);
    expect(enemy.combatStats.attack).toBe(18);

    expectStateRestoration(initialState, recorder, afterTurn);
  });

  it("SCN-BTL-027: a break mid multi-hit counts the overkill, fires the defeat trigger, and lands the remaining hits on the revived enemy", () => {
    const onDefeatDamageId = createEffectActionDefinitionId("ACT_ON_DEFEAT_MARK");
    // R-TEX-03 #2: Catalog定義は`UnitDefeated`のままで、ブレイクでも発動する。
    const onDefeatPassive: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_ON_ENEMY_DEFEATED"),
      skillType: "PS",
      cost: { resource: "PP", amount: 0 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "UnitDefeated",
          category: "FACT",
          // production の `SKL_HIIRO_LONEWOLF_PS2`／`SKL_LILY_HERO_PS1`／
          // `SKL_YURIA_WILDCARD_PS1`（いずれも「自身が敵を撃破した時」）と同じ形。
          // `UnitBroken`が撃破元ではなくブレイク対象を発生源にすると、種別の照合に
          // 成功してもここで脱落する。
          sourceSelector: "SELF",
          targetSelector: "ENEMY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: createTargetBindingId("TGT_ENEMY"),
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: true,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ENEMY") },
            actions: [{ effectActionDefinitionId: onDefeatDamageId }],
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
      metadata: { displayName: "OnEnemyDefeated", tags: [] },
    };
    const definitions = breakingAttackerDefinitions({
      damagePerHit: 150,
      hitCount: 2,
      allyPassive: onDefeatPassive,
      extraEffectActions: [
        {
          effectActionDefinitionId: onDefeatDamageId,
          kind: "APPLY_STAT_MOD",
          payload: {
            stat: "ATTACK",
            valueType: "RATIO",
            formula: { kind: "CONSTANT", value: 0.1 },
            stacking: { mode: "STACKABLE", max: null },
            duration: { dispellable: true, linkedEffectGroupId: null },
          },
          metadata: { tags: [] },
        },
      ],
    });

    const { recorder, afterTurn, initialState } = exerciseBattleWith(definitions);

    const types = recorder.getEvents().map((event) => event.eventType);
    expect(types).not.toContain("UnitDefeated");
    // R-TEX-03 #2: 「敵撃破時」契機のPSがブレイクでも発動する。
    expect(
      recorder
        .getEvents()
        .filter((event) => event.eventType === "PassiveActivated")
        .map((event) => (event.payload as { skillDefinitionId: string }).skillDefinitionId),
    ).toContain("SKL_ON_ENEMY_DEFEATED");
    // R-TEX-05 #2＋`06_戦闘状態遷移.md`の手順: 撃破トリガーは解除より**前**に完了する。
    // そのトリガーが敵へ付与した非メモリー由来の効果は、続く解除で必ず消える。
    expect(afterTurn.enemyUnits[0]!.appliedEffects).toEqual([]);
    // R-TEX-06 #4: 2ヒット目も解決され、復活後の敵（HP120）を再び削り切る。
    expect(afterTurn.exercise?.breakCount).toBe(2);
    // R-TEX-02 #2: 各ヒットの計上量はオーバーキルを含む150。
    expect(afterTurn.exercise?.totalScore).toBe(300);
    expect(afterTurn.enemyUnits[0]!.currentHp).toBe(140);

    expectStateRestoration(initialState, recorder, afterTurn);
  });
});

/** 5ターン走らせるか、演習が早期終了するまで`advanceBattle`を繰り返す。 */
function runExerciseToCompletion(
  definitions: BattleDefinitions,
  allyUnits: readonly BattleUnit[] = [unit("ally:1", "ALLY")],
) {
  const battle = createBattle(
    createBattleId("B_1"),
    allyUnits,
    [unit("enemy:1", "ENEMY", "UNIT_002")],
    createTurnLimit(5),
    definitions,
    "TACTICAL_EXERCISE",
  );
  const recorder = new EventRecorder(createBattleId("B_1"));
  const random = new SequenceRandomSource([]);
  const initialState = captureBattleState(battle);
  let completed = startBattle(battle, random, recorder);
  while (completed.status !== "COMPLETED") {
    completed = advanceBattle(completed, random, recorder);
  }
  return { recorder, completed, initialState };
}

/** R-TEX-10 #2: ブレイク履歴は`UnitBroken`の投影として出力する（集約は履歴を持たない）。 */
function projectBreakHistory(recorder: EventRecorder) {
  return recorder
    .getEvents()
    .filter((event) => event.eventType === "UnitBroken")
    .map((event) => {
      const payload = event.payload as {
        breakNumber: number;
        turnNumber: number;
        totalScore: number;
      };
      return {
        breakNumber: payload.breakNumber,
        turnNumber: payload.turnNumber,
        cumulativeScoreAtBreak: payload.totalScore,
      };
    });
}

function accumulatedScoreTotal(recorder: EventRecorder): number {
  return recorder
    .getEvents()
    .filter((event) => event.eventType === "ExerciseScoreAccumulated")
    .reduce((sum, event) => sum + (event.payload as { amount: number }).amount, 0);
}

/** 味方の`UNIT_001`が固定ダメージのASを持ち、敵の`UNIT_002`が味方を1撃で倒すASを持つ。 */
function mutualAttackerDefinitions(options: {
  readonly allyDamage: number;
  readonly enemyDamage?: number;
}): BattleDefinitions {
  const base = breakingAttackerDefinitions({ damagePerHit: options.allyDamage, hitCount: 1 });
  if (options.enemyDamage === undefined) {
    return base;
  }
  const enemyActionId = createEffectActionDefinitionId("ACT_ENEMY_ATTACK");
  const enemyAction: EffectActionDefinition = {
    kind: "DAMAGE",
    effectActionDefinitionId: enemyActionId,
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "CONSTANT", value: options.enemyDamage },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 1, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
  const allySkill = base.activeSkillsByUnit.get(createUnitDefinitionId("UNIT_001"))![0]!;
  const enemySkill: SkillDefinition = {
    ...allySkill,
    skillDefinitionId: createSkillDefinitionId("SKL_ENEMY_ATTACK"),
    resolution: {
      ...allySkill.resolution,
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: enemyActionId }],
        },
      ],
    },
    metadata: { displayName: "EnemyAttack", tags: [] },
  };
  return {
    ...base,
    activeSkillsByUnit: new Map([
      ...base.activeSkillsByUnit,
      [createUnitDefinitionId("UNIT_002"), [enemySkill]],
    ]),
    effectActions: new Map([...base.effectActions, [enemyActionId, enemyAction]]),
    skillDefinitions: new Map([
      ...base.skillDefinitions,
      [enemySkill.skillDefinitionId, enemySkill],
    ]),
  };
}

describe("exercise end conditions and result (R-TEX-09／10)", () => {
  it("UT-R-TEX-09-009: an exercise that survives five turns ends with TURN_LIMIT_REACHED at completedTurn 5 and no outcome", () => {
    const { recorder, completed, initialState } = runExerciseToCompletion(attackerDefinitions());

    // R-TEX-10 #1: 演習結果は終了理由・終了ターン・総スコア・ブレイク回数だけを持つ。
    expect(completed.result).toEqual({
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 5,
      totalScore: completed.exercise!.totalScore,
      breakCount: 0,
    });
    expect(completed.result).not.toHaveProperty("outcome");
    // R-TEX-10 #3: 総スコアは発行された全計上量の合計とも最終状態の累計スコアとも一致する。
    expect(completed.result!.completedTurn).toBe(5);
    expect(accumulatedScoreTotal(recorder)).toBe(completed.exercise?.totalScore);
    expect(captureBattleState(completed).exercise?.totalScore).toBe(completed.exercise?.totalScore);
    // ブレイク0回でも結果は成立する（履歴は空）。
    expect(projectBreakHistory(recorder)).toEqual([]);

    expectStateRestoration(initialState, recorder, completed);
  });

  it("UT-R-TEX-09-010: an enemy reaching 0 HP does not end the exercise, so the battle keeps running after a break", () => {
    const { recorder, completed } = runExerciseToCompletion(
      breakingAttackerDefinitions({ damagePerHit: 150, hitCount: 1 }),
    );

    // ブレイクは毎ターン起きるが、そのどれも終了判定へ影響しない（R-TEX-09 #2）。
    expect(completed.exercise?.breakCount).toBeGreaterThan(0);
    expect(completed.result?.completionReason).toBe("TURN_LIMIT_REACHED");
    // 最初のブレイクの後にもターンが進み、`BattleCompleted`は最終ターンまで発行されない。
    const events = recorder.getEvents();
    const firstBreak = events.findIndex((event) => event.eventType === "UnitBroken");
    const completedIndex = events.findIndex((event) => event.eventType === "BattleCompleted");
    expect(firstBreak).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(firstBreak);
    expect(events[completedIndex]!.turnNumber).toBe(5);
    expect(projectBreakHistory(recorder).length).toBe(completed.exercise?.breakCount);
  });

  it("SCN-BTL-028: an ally wipe ends the exercise early with ALLY_DEFEATED, the score and break history at that point, and no further processing", () => {
    const { recorder, completed, initialState } = runExerciseToCompletion(
      mutualAttackerDefinitions({ allyDamage: 150, enemyDamage: 1000 }),
    );

    expect(completed.result).toEqual({
      completionReason: "ALLY_DEFEATED",
      completedTurn: 1,
      totalScore: 150,
      breakCount: 1,
    });
    // R-TEX-10 #2: ブレイク履歴は`UnitBroken`の投影。集約は履歴を持たない。
    expect(projectBreakHistory(recorder)).toEqual([
      { breakNumber: 1, turnNumber: 1, cumulativeScoreAtBreak: 150 },
    ]);
    // R-TEX-09 #3: 終了確定後は未処理のキュー・効果・PS候補を処理しない。
    const events = recorder.getEvents();
    expect(events[events.length - 1]!.eventType).toBe("BattleCompleted");
    expect(events.filter((event) => event.eventType === "TurnStarted")).toHaveLength(1);

    expectStateRestoration(initialState, recorder, completed);
  });
});

/**
 * `eventType`契機で1つのEffectActionを敵へ適用するだけのPS。ブレイクの通知順序
 * （撃破トリガーが解除より前に完了するか）を、経路ごとに同じ形で確かめるために使う。
 */
function passiveOn(
  id: string,
  eventType: string,
  effectActionDefinitionId: EffectActionDefinitionId,
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 0 },
    activationCondition: { kind: "TRUE" },
    triggers: [
      {
        eventType,
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
          targetBindingId: createTargetBindingId("TGT_ENEMY"),
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: "ALL",
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: true,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ENEMY") },
          actions: [{ effectActionDefinitionId }],
        },
      ],
    },
    cooldown: { unit: "TURN", count: 5 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: id, tags: [] },
  };
}

/** 敵へ攻撃力バフを付与するだけの`APPLY_STAT_MOD`（撃破トリガーの痕跡として使う）。 */
function enemyBuffAction(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0.1 },
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    metadata: { tags: [] },
  };
}

/**
 * R-TEX-03 #2＋R-TEX-05 #2（`06_戦闘状態遷移.md`の手順2→3）: 撃破トリガーはブレイクの
 * 効果解除より**前**に完了しなければならない。順序が逆になると、撃破トリガーが敵へ
 * 付与した非メモリー由来の効果が解除されずに残る。
 *
 * PS自身のEffectSequence解決経路（`onFactEventForPassiveChain`を持たない）でも同じ
 * 順序になることを、HP0到達の経路ごとに固定する。
 */
describe("break resolution notifies the defeat trigger before the removal on every path (R-TEX-03 #2)", () => {
  const HP_DRAIN = createEffectActionDefinitionId("ACT_HP_DRAIN");
  const MAX_HP_DROP = createEffectActionDefinitionId("ACT_MAX_HP_DROP");
  const ON_DEFEAT_BUFF = createEffectActionDefinitionId("ACT_ON_DEFEAT_BUFF");

  function runWith(
    killerAction: EffectActionDefinition,
    killerPassive: SkillDefinition,
  ): ReturnType<typeof exerciseBattleWith> {
    const onDefeat = passiveOn("SKL_ON_DEFEAT_BUFF", "UnitDefeated", ON_DEFEAT_BUFF);
    const unitDefinitions = new DefaultUnitDefinitionMap();
    const allyUnitDefinitionId = createUnitDefinitionId("UNIT_001");
    unitDefinitions.set(allyUnitDefinitionId, {
      ...unitDefinitions.get(allyUnitDefinitionId)!,
      passiveSkillDefinitionIds: [killerPassive.skillDefinitionId, onDefeat.skillDefinitionId],
    });
    return exerciseBattleWith({
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
        [killerAction.effectActionDefinitionId, killerAction],
        [ON_DEFEAT_BUFF, enemyBuffAction("ACT_ON_DEFEAT_BUFF")],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([
        [killerPassive.skillDefinitionId, killerPassive],
        [onDefeat.skillDefinitionId, onDefeat],
      ]),
    });
  }

  function expectTriggerRanBeforeRemoval(run: ReturnType<typeof exerciseBattleWith>): void {
    const events = run.recorder.getEvents();
    const types = events.map((event) => event.eventType);
    expect(types).toContain("UnitBroken");
    expect(types).not.toContain("UnitDefeated");
    // まず撃破トリガーが実際に発動していることを確かめる — 発動しないまま
    // 「敵に効果が残っていない」ことを見ても、順序の検証にならない（空振り）。
    expect(
      events
        .filter((event) => event.eventType === "PassiveActivated")
        .map((event) => (event.payload as { skillDefinitionId: string }).skillDefinitionId),
    ).toContain("SKL_ON_DEFEAT_BUFF");
    const buffApplied = events.findIndex(
      (event) =>
        event.eventType === "EffectApplied" &&
        (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
          ON_DEFEAT_BUFF,
    );
    expect(buffApplied).toBeGreaterThanOrEqual(0);
    // その付与が、ブレイクの解除より前に起きている（＝トリガーが解除に先行した）。
    const lastRemoval = types.lastIndexOf("EffectRemoved");
    expect(lastRemoval).toBeGreaterThan(buffApplied);
    // 結果として、撃破トリガーが敵へ付与した効果は解除で必ず消えている。
    expect(run.afterTurn.enemyUnits[0]!.appliedEffects).toEqual([]);
  }

  it("UT-R-TEX-03-012 (MODIFY_RESOURCE path): a PS-driven MODIFY_RESOURCE(HP) break runs the defeat trigger before the removal", () => {
    const drain: EffectActionDefinition = {
      effectActionDefinitionId: HP_DRAIN,
      kind: "MODIFY_RESOURCE",
      payload: {
        resource: "HP",
        operation: "ADD",
        formula: { kind: "CONSTANT", value: -1000 },
      },
      metadata: { tags: [] },
    };
    expectTriggerRanBeforeRemoval(runWith(drain, passiveOn("SKL_DRAIN", "TurnStarted", HP_DRAIN)));
  });

  it("UT-R-TEX-03-015: UnitBroken carries the actual breaker as its source, so a sourceSelector: SELF defeat trigger fires only on the ally that broke the enemy", () => {
    // `trigger-selector-evaluator.ts`は発生源を持たないイベントを「特定ユニットへ
    // 帰属しないグローバルイベント」とみなし、SELFを全員に成立させる。したがって
    // 味方1体だけでは`UnitBroken.sourceUnitId`の欠落を検出できない — 撃破していない
    // 味方が同じSELFトリガーで発動しないことまで見て初めて発生源を固定できる。
    const selfDefeatTrigger = {
      eventType: "UnitDefeated",
      category: "FACT" as const,
      sourceSelector: "SELF" as const,
      targetSelector: "ENEMY" as const,
      condition: { kind: "TRUE" as const },
    };
    const breakerPassive: SkillDefinition = {
      ...passiveOn("SKL_BREAKER_ON_DEFEAT", "UnitDefeated", ON_DEFEAT_BUFF),
      triggers: [selfDefeatTrigger],
    };
    const bystanderPassive: SkillDefinition = {
      ...passiveOn("SKL_BYSTANDER_ON_DEFEAT", "UnitDefeated", ON_DEFEAT_BUFF),
      triggers: [selfDefeatTrigger],
    };
    const attacker = breakingAttackerDefinitions({
      damagePerHit: 150,
      hitCount: 1,
      allyPassive: breakerPassive,
      extraEffectActions: [enemyBuffAction("ACT_ON_DEFEAT_BUFF")],
    });
    // 攻撃しない味方（UNIT_003）へ、まったく同じSELF撃破トリガーのPSを持たせる。
    const unitDefinitions = new DefaultUnitDefinitionMap();
    unitDefinitions.set(createUnitDefinitionId("UNIT_001"), {
      ...unitDefinitions.get(createUnitDefinitionId("UNIT_001"))!,
      passiveSkillDefinitionIds: [breakerPassive.skillDefinitionId],
    });
    unitDefinitions.set(createUnitDefinitionId("UNIT_003"), {
      ...unitDefinitions.get(createUnitDefinitionId("UNIT_003"))!,
      passiveSkillDefinitionIds: [bystanderPassive.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      ...attacker,
      unitDefinitions,
      skillDefinitions: new Map([
        ...attacker.skillDefinitions,
        [bystanderPassive.skillDefinitionId, bystanderPassive],
      ]),
    };

    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY"), unit("ally:2", "ALLY", "UNIT_003")],
      [unit("enemy:1", "ENEMY", "UNIT_002")],
      createTurnLimit(5),
      definitions,
      "TACTICAL_EXERCISE",
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const random = new SequenceRandomSource([]);
    advanceBattle(startBattle(battle, random, recorder), random, recorder);

    const broken = recorder.getEvents().find((event) => event.eventType === "UnitBroken")!;
    // R-TEX-03 #2: この経路の`UnitDefeated`と同じ発生源（攻撃者）を運ぶ。
    expect(broken.sourceUnitId).toBe(createBattleUnitId("ally:1"));
    const activated = recorder
      .getEvents()
      .filter((event) => event.eventType === "PassiveActivated")
      .map((event) => (event.payload as { skillDefinitionId: string }).skillDefinitionId);
    // 実際に撃破した味方のSELFトリガーは発動する。
    expect(activated).toContain("SKL_BREAKER_ON_DEFEAT");
    // 撃破していない味方の同じSELFトリガーは発動しない。
    expect(activated).not.toContain("SKL_BYSTANDER_ON_DEFEAT");
  });

  it("UT-R-TEX-03-016 (sub-unit additional-damage debuff path): a MAXIMUM_HP debuff that clamps the enemy to 0 runs the defeat trigger before the removal", () => {
    // R-SUB-02第3項: サブユニットの追加ダメージに付随するデバフ。ここでは最大HPを
    // -100%にして、追加ダメージそのものではなく再計算のHP clampでブレイクさせる。
    const MAX_HP_DEBUFF = createEffectActionDefinitionId("ACT_SUBUNIT_MAX_HP_DEBUFF");
    const SUBUNIT_ACTION = createEffectActionDefinitionId("ACT_SUBUNIT");
    const onDefeat = passiveOn("SKL_ON_DEFEAT_BUFF", "UnitDefeated", ON_DEFEAT_BUFF);
    const attacker = breakingAttackerDefinitions({
      // 直撃ではブレイクさせない（敵の最大HPは100）。
      damagePerHit: 10,
      hitCount: 1,
      extraEffectActions: [
        enemyBuffAction("ACT_ON_DEFEAT_BUFF"),
        {
          effectActionDefinitionId: MAX_HP_DEBUFF,
          kind: "APPLY_STAT_MOD",
          payload: {
            stat: "MAXIMUM_HP",
            valueType: "RATIO",
            formula: { kind: "CONSTANT", value: -1 },
            stacking: { mode: "STACKABLE", max: null },
            duration: { dispellable: true, linkedEffectGroupId: null },
          },
          metadata: { tags: [] },
        },
      ],
    });
    const unitDefinitions = new DefaultUnitDefinitionMap();
    const allyUnitDefinitionId = createUnitDefinitionId("UNIT_001");
    unitDefinitions.set(allyUnitDefinitionId, {
      ...unitDefinitions.get(allyUnitDefinitionId)!,
      passiveSkillDefinitionIds: [onDefeat.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      ...attacker,
      unitDefinitions,
      skillDefinitions: new Map([
        ...attacker.skillDefinitions,
        [onDefeat.skillDefinitionId, onDefeat],
      ]),
    };

    const allyWithSubUnit: BattleUnit = {
      ...unit("ally:1", "ALLY"),
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("EFFECT_SUBUNIT"),
          effectActionDefinitionId: SUBUNIT_ACTION,
          kindKey: effectKindKeyFromDefinitionId(SUBUNIT_ACTION),
          categories: ["BUFF"],
          duplicate: true,
          sourceUnitId: createBattleUnitId("ally:1"),
          targetUnitId: createBattleUnitId("ally:1"),
          magnitude: 50,
          subUnit: {
            durability: 50,
            additionalDamage: {
              formula: { kind: "CONSTANT", value: 1 },
              debuff: { effectActionDefinitionId: MAX_HP_DEBUFF },
            },
          },
          snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 10 },
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        },
      ],
    };

    const battle = createBattle(
      createBattleId("B_1"),
      [allyWithSubUnit],
      [unit("enemy:1", "ENEMY", "UNIT_002")],
      createTurnLimit(5),
      definitions,
      "TACTICAL_EXERCISE",
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const random = new SequenceRandomSource([]);
    const initialState = captureBattleState(battle);
    const afterTurn = advanceBattle(startBattle(battle, random, recorder), random, recorder);

    expectTriggerRanBeforeRemoval({ battle, recorder, afterTurn, initialState });
  });

  it("UT-R-TEX-03-014 (continuous damage path): a lethal continuous damage tick runs the defeat trigger before the removal", () => {
    const dotActionId = createEffectActionDefinitionId("ACT_LETHAL_DOT");
    const dotDefinition: EffectActionDefinition = {
      effectActionDefinitionId: dotActionId,
      kind: "APPLY_CONTINUOUS_DAMAGE",
      payload: {
        continuousDamageKind: "FIXED",
        damageType: "PHYSICAL",
        formula: { kind: "CONSTANT", value: 500 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 3 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      metadata: { tags: [] },
    };
    const onDefeat = passiveOn("SKL_ON_DEFEAT_BUFF", "UnitDefeated", ON_DEFEAT_BUFF);
    const unitDefinitions = new DefaultUnitDefinitionMap();
    const allyUnitDefinitionId = createUnitDefinitionId("UNIT_001");
    unitDefinitions.set(allyUnitDefinitionId, {
      ...unitDefinitions.get(allyUnitDefinitionId)!,
      passiveSkillDefinitionIds: [onDefeat.skillDefinitionId],
    });
    // R-MEM-04: メモリー由来ではない（付与者ユニットを持つ）継続ダメージ。
    const burningEnemy = {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("EFFECT_LETHAL_DOT"),
          effectActionDefinitionId: dotActionId,
          kindKey: effectKindKeyFromDefinitionId(dotActionId),
          categories: ["DEBUFF" as const],
          duplicate: true,
          sourceUnitId: createBattleUnitId("ally:1"),
          targetUnitId: createBattleUnitId("enemy:1"),
          magnitude: 500,
          continuousDamage: {
            continuousDamageKind: "FIXED" as const,
            damageType: "PHYSICAL" as const,
          },
          snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: 1000 },
          duration: {
            definition: {
              timeLimit: { unit: "ACTION" as const, count: 3 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 3,
          },
          appliedTurnNumber: 1,
        },
      ],
    };

    const run = exerciseBattleWith(
      {
        activeSkillsByUnit: new Map(),
        exSkillByUnit: new Map(),
        effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
          [dotActionId, dotDefinition],
          [ON_DEFEAT_BUFF, enemyBuffAction("ACT_ON_DEFEAT_BUFF")],
        ]),
        unitDefinitions,
        skillDefinitions: new Map([[onDefeat.skillDefinitionId, onDefeat]]),
      },
      burningEnemy,
    );

    expectTriggerRanBeforeRemoval(run);
    // 継続ダメージ自身は敵が保持する非メモリー由来の効果なので、解除で消える。
    expect(run.afterTurn.exercise?.breakCount).toBeGreaterThan(0);
  });

  it("UT-R-TEX-03-013 (MODIFY_RESOURCE_CAPACITY path): a maximum-HP drop that clamps the enemy to 0 runs the defeat trigger before the removal", () => {
    const capacityDrop: EffectActionDefinition = {
      effectActionDefinitionId: MAX_HP_DROP,
      kind: "MODIFY_RESOURCE_CAPACITY",
      payload: {
        resource: "HP",
        operation: "SET",
        formula: { kind: "CONSTANT", value: 0 },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      metadata: { tags: [] },
    };
    expectTriggerRanBeforeRemoval(
      runWith(capacityDrop, passiveOn("SKL_MAX_HP_DROP", "TurnStarted", MAX_HP_DROP)),
    );
  });
});
