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
            targetBindingId: createTargetBindingId("TGT_SELF"),
            selector: {
              kind: "SELF",
              filters: [],
              order: ["DEFAULT"],
              count: "ALL",
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_SELF") },
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
    // R-TEX-06 #4: 2ヒット目も解決され、復活後の敵（HP120）を再び削り切る。
    expect(afterTurn.exercise?.breakCount).toBe(2);
    // R-TEX-02 #2: 各ヒットの計上量はオーバーキルを含む150。
    expect(afterTurn.exercise?.totalScore).toBe(300);
    expect(afterTurn.enemyUnits[0]!.currentHp).toBe(140);

    expectStateRestoration(initialState, recorder, afterTurn);
  });
});
