import { describe, expect, it } from "vitest";
import { advanceBattle, createTotalWarBattle, startBattle, type Battle } from "./battle.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
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
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../../catalog/definitions/memory-definition.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DefaultUnitDefinitionMap } from "../../../testing/fixtures/default-unit-definition-map.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

/** ASを持つユニット定義。持たない定義のユニットは行動フェーズで待機する。 */
const ATTACKER_UNIT = createUnitDefinitionId("UNIT_001");
const PASSIVE_UNIT = createUnitDefinitionId("UNIT_PASSIVE");

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const NO_RANDOM = () => new SequenceRandomSource([]);

interface UnitSpec {
  readonly unitDefinitionId?: UnitDefinitionId;
  readonly position?: FormationPosition;
  readonly stats?: Partial<BattlePartyMember["combatStats"]>;
}

function unit(id: string, side: Side, spec: UnitSpec = {}): BattleUnit {
  const position = spec.position ?? { column: "CENTER", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: spec.unitDefinitionId ?? PASSIVE_UNIT,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      subAffinityBonus: 0.15,
      ...spec.stats,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

/** 1手で敵の出撃中の編成（HP10・防御0の1体）を倒す味方。 */
function striker(id: string, side: Side = "ALLY"): BattleUnit {
  return unit(id, side, { unitDefinitionId: ATTACKER_UNIT, stats: { attack: 999 } });
}

function fragile(id: string, side: Side): BattleUnit {
  return unit(id, side, { stats: { maximumHp: 10, defense: 0 } });
}

const TGT_ENEMY = createTargetBindingId("TGT_ENEMY");
const ATTACK_ACTION = createEffectActionDefinitionId("ACT_ATTACK");
const ATTACK_UP = createEffectActionDefinitionId("ACT_MEM_ATTACK_UP");

function attackSkill(hitSelf: boolean): SkillDefinition {
  const step = (target: TargetReference) => ({
    kind: "ACTION" as const,
    stepCondition: { kind: "TRUE" as const },
    targetCondition: { kind: "TRUE" as const },
    target,
    actions: [{ effectActionDefinitionId: ATTACK_ACTION }],
  });
  return {
    skillDefinitionId: createSkillDefinitionId(hitSelf ? "SKL_MUTUALLY_LETHAL" : "SKL_ATTACK"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: TGT_ENEMY,
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
        step({ kind: "BINDING", targetBindingId: TGT_ENEMY }),
        ...(hitSelf ? [step({ kind: "SELF" })] : []),
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
}

const DAMAGE_ACTION: EffectActionDefinition = {
  kind: "DAMAGE",
  effectActionDefinitionId: ATTACK_ACTION,
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

const ATTACK_UP_ACTION = {
  effectActionDefinitionId: ATTACK_UP,
  kind: "APPLY_STAT_MOD",
  payload: {
    stat: "ATTACK",
    valueType: "RATIO",
    formula: { kind: "CONSTANT", value: 0.1 },
    stacking: { mode: "STACKABLE" },
    duration: { dispellable: false, timeLimit: { unit: "BATTLE", count: 1 } },
  },
  metadata: { tags: [] },
} as unknown as EffectActionDefinition;

/** `eventType` を契機に、`selectorSide`（Memoryの陣営から見た相対陣営）の全員へ攻撃力+10%を付与する。 */
function memory(
  memoryDefinitionId: string,
  eventType: "BattleStarted" | "TurnStarted" | "TurnCompleted",
  selectorSide: "ALLY" | "ENEMY" = "ALLY",
): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId,
    triggeredEffects: [
      {
        trigger: { eventType, category: "FACT", sourceSelector: "SELF", targetSelector: "SELF" },
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
              actions: [{ effectActionDefinitionId: ATTACK_UP }],
            },
          ],
        },
      },
    ],
    metadata: { displayName: memoryDefinitionId },
  });
}

const REACTOR_UNIT = createUnitDefinitionId("UNIT_REACTOR");
const REACTION_PS_ID = createSkillDefinitionId("SKL_PS_REACTION_STRIKE");

/** 効果の付与（`EffectApplied`）に反応して敵全体へダメージを与えるPS。出撃Memoryの付与に反応する。 */
const REACTION_STRIKE_PS: SkillDefinition = {
  ...attackSkill(false),
  skillDefinitionId: REACTION_PS_ID,
  skillType: "PS",
  cost: { resource: "PP", amount: 1 },
  triggers: [
    {
      eventType: "EffectApplied",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
      condition: { kind: "TRUE" },
    },
  ],
  cooldown: { unit: "TURN", count: 0 },
  metadata: { displayName: "ReactionStrike", tags: [] },
};

function definitions(hitSelf = false): BattleDefinitions {
  const unitDefinitions = new DefaultUnitDefinitionMap();
  unitDefinitions.set(REACTOR_UNIT, {
    ...unitDefinitions.get(REACTOR_UNIT)!,
    passiveSkillDefinitionIds: [REACTION_PS_ID],
  });
  return {
    activeSkillsByUnit: new Map([
      [ATTACKER_UNIT, [attackSkill(hitSelf)]],
      [REACTOR_UNIT, [attackSkill(hitSelf)]],
    ]),
    exSkillByUnit: new Map(),
    effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [ATTACK_ACTION, DAMAGE_ACTION],
      [ATTACK_UP, ATTACK_UP_ACTION],
    ]),
    unitDefinitions,
    skillDefinitions: new Map([[REACTION_PS_ID, REACTION_STRIKE_PS]]),
  };
}

interface FormationSpec {
  readonly units: readonly BattleUnit[];
  readonly memories?: readonly MemoryDefinition[];
}

function totalWar(
  ally: readonly FormationSpec[],
  enemy: readonly FormationSpec[],
  battleDefinitions: BattleDefinitions = definitions(),
): Battle {
  return createTotalWarBattle(
    createBattleId("B_1"),
    { ALLY: ally.map((f) => f.units), ENEMY: enemy.map((f) => f.units) },
    createTurnLimit(15),
    battleDefinitions,
    {
      ALLY: ally.map((f) => f.memories ?? []),
      ENEMY: enemy.map((f) => f.memories ?? []),
    },
  );
}

/** 味方は1手で敵の1番目の編成を倒す。敵は控えに2番目の編成を持つ。 */
function enemyRelayBattle(
  allyMemories: readonly MemoryDefinition[],
  enemyMemories: readonly (readonly MemoryDefinition[])[],
): Battle {
  return totalWar(
    [{ units: [striker("ally:1")], memories: allyMemories }],
    [
      { units: [fragile("enemy:1", "ENEMY")], memories: enemyMemories[0] ?? [] },
      {
        units: [unit("enemy:2", "ENEMY", { stats: { defense: 5000 } })],
        memories: enemyMemories[1] ?? [],
      },
    ],
  );
}

function memoryTriggers(events: readonly BattleDomainEvent[]): readonly string[] {
  return events
    .filter((event) => event.eventType === "MemoryTriggered")
    .map((event) => (event.payload as { memoryDefinitionId: string }).memoryDefinitionId);
}

function eventsOfTurn(recorder: EventRecorder, turnNumber: number): readonly BattleDomainEvent[] {
  return recorder.getEvents().filter((event) => event.turnNumber === turnNumber);
}

function findUnit(battle: Battle, id: string): BattleUnit {
  const found = [...battle.allyUnits, ...battle.enemyUnits].find(
    (candidate) => candidate.battleUnitId === createBattleUnitId(id),
  );
  if (found === undefined) {
    throw new Error(`unit ${id} is not on the board`);
  }
  return found;
}

/** 戦闘開始から `turns` ターン進める。 */
function run(battle: Battle, turns: number, recorder: EventRecorder): Battle {
  let current = startBattle(battle, NO_RANDOM(), recorder);
  for (let i = 0; i < turns; i++) {
    current = advanceBattle(current, NO_RANDOM(), recorder);
  }
  return current;
}

describe("createTotalWarBattle (memories)", () => {
  it("UT-R-TWR-05-001: rejects memories given per side through BattleDefinitions, since a total war owns them per formation", () => {
    const withSideMemories: BattleDefinitions = {
      ...definitions(),
      memoriesBySide: { ALLY: [memory("MEM_A", "BattleStarted")], ENEMY: [] },
    };

    expect(() =>
      totalWar(
        [{ units: [unit("ally:1", "ALLY")] }],
        [{ units: [unit("enemy:1", "ENEMY")] }],
        withSideMemories,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-TWR-05-002: rejects memories for a formation that does not exist", () => {
    expect(() =>
      createTotalWarBattle(
        createBattleId("B_1"),
        { ALLY: [[unit("ally:1", "ALLY")]], ENEMY: [[unit("enemy:1", "ENEMY")]] },
        createTurnLimit(15),
        definitions(),
        { ALLY: [[], [memory("MEM_A", "BattleStarted")]], ENEMY: [] },
      ),
    ).toThrow(DomainValidationError);
  });
});

describe("Memory scope in TOTAL_WAR (R-TWR-05)", () => {
  it("UT-R-TWR-05-003: at BattleStarted only the first formations' battle-start memories activate, not the reserves'", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));

    startBattle(
      enemyRelayBattle(
        [memory("MEM_A1", "BattleStarted")],
        [[memory("MEM_E1", "BattleStarted")], [memory("MEM_E2", "BattleStarted")]],
      ),
      NO_RANDOM(),
      recorder,
    );

    expect(memoryTriggers(recorder.getEvents())).toEqual(["MEM_A1", "MEM_E1"]);
  });

  it("UT-R-TWR-05-004: a later formation's battle-start memory activates once on its own FormationDeployed, before TurnStarted, and the surviving formation's does not activate again", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));

    const afterTurn3 = run(
      enemyRelayBattle(
        [memory("MEM_A1", "BattleStarted")],
        [[], [memory("MEM_E2", "BattleStarted")]],
      ),
      3,
      recorder,
    );

    const turn2 = eventsOfTurn(recorder, 2);
    const types = turn2.map((event) => event.eventType);
    expect(memoryTriggers(turn2)).toEqual(["MEM_E2"]);
    const deployed = turn2.find((event) => event.eventType === "FormationDeployed")!;
    const triggered = turn2.find((event) => event.eventType === "MemoryTriggered")!;
    // R-TWR-05 #4: 出撃スコープ（行動順キュー生成前、`TurnStarted` の発行前）で解決する。
    expect(types.indexOf("MemoryTriggered")).toBeLessThan(types.indexOf("TurnStarted"));
    expect(triggered.resolutionScopeId).toBe(deployed.resolutionScopeId);
    expect(triggered.rootEventId).toBe(deployed.eventId);
    expect(triggered.parentEventId).toBe(deployed.eventId);
    expect(findUnit(afterTurn3, "enemy:2").appliedEffects).toHaveLength(1);
    // 出撃し直していない味方の編成の戦闘開始時Memoryは、戦闘開始時の1回だけ。
    expect(memoryTriggers(recorder.getEvents())).toEqual(["MEM_A1", "MEM_E2"]);
  });

  it("UT-R-TWR-05-005: memory effects granted to the surviving formation carry over into the next fight", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));

    const afterTurn2 = run(
      enemyRelayBattle(
        [memory("MEM_A1", "BattleStarted")],
        [[], [memory("MEM_E2", "BattleStarted")]],
      ),
      2,
      recorder,
    );

    const ally = findUnit(afterTurn2, "ally:1");
    expect(ally.appliedEffects).toHaveLength(1);
    expect(ally.combatStats.attack).toBeCloseTo(999 * 1.1, 6);
  });

  it("UT-R-TWR-05-006: turn-start memories activate only for the formation in play — not for a reserve, nor for a wiped formation", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));

    run(
      enemyRelayBattle(
        [memory("MEM_A1_TURN", "TurnStarted")],
        [[memory("MEM_E1_TURN", "TurnStarted")], [memory("MEM_E2_TURN", "TurnStarted")]],
      ),
      3,
      recorder,
    );

    expect(memoryTriggers(eventsOfTurn(recorder, 1))).toEqual(["MEM_A1_TURN", "MEM_E1_TURN"]);
    expect(memoryTriggers(eventsOfTurn(recorder, 2))).toEqual(["MEM_A1_TURN", "MEM_E2_TURN"]);
    expect(memoryTriggers(eventsOfTurn(recorder, 3))).toEqual(["MEM_A1_TURN", "MEM_E2_TURN"]);
  });

  it("UT-R-TWR-05-007: a wiped formation's memories stop at once, so its turn-end memory does not activate in the turn of the wipe", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));

    run(
      enemyRelayBattle(
        [memory("MEM_A1_END", "TurnCompleted")],
        [[memory("MEM_E1_END", "TurnCompleted")], []],
      ),
      1,
      recorder,
    );

    expect(memoryTriggers(eventsOfTurn(recorder, 1))).toEqual(["MEM_A1_END"]);
  });

  it("UT-R-TWR-05-008: when both sides deploy together, battle-start memories resolve after both FormationDeployed, ally first, and can target the opponent's new formation", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const battle = totalWar(
      [
        {
          units: [
            unit("ally:1", "ALLY", {
              unitDefinitionId: ATTACKER_UNIT,
              stats: { attack: 999, defense: 0, maximumHp: 10 },
            }),
          ],
        },
        { units: [unit("ally:2", "ALLY")], memories: [memory("MEM_A2", "BattleStarted", "ENEMY")] },
      ],
      [
        { units: [fragile("enemy:1", "ENEMY")] },
        { units: [unit("enemy:2", "ENEMY")], memories: [memory("MEM_E2", "BattleStarted")] },
      ],
      definitions(true),
    );

    const afterTurn2 = run(battle, 2, recorder);

    const turn2 = eventsOfTurn(recorder, 2);
    const types = turn2.map((event) => event.eventType);
    expect(types.slice(0, 2)).toEqual(["FormationDeployed", "FormationDeployed"]);
    expect(memoryTriggers(turn2)).toEqual(["MEM_A2", "MEM_E2"]);
    expect(types.lastIndexOf("MemoryResolved")).toBeLessThan(types.indexOf("TurnStarted"));
    // 味方のMemory（敵全体が対象）は、同じスコープで出撃した敵の新しい編成へ届く。
    expect(findUnit(afterTurn2, "enemy:2").appliedEffects).toHaveLength(2);
    expect(findUnit(afterTurn2, "ally:2").appliedEffects).toHaveLength(0);
    const [allyDeployed, enemyDeployed] = turn2;
    const triggered = turn2.filter((event) => event.eventType === "MemoryTriggered");
    expect(triggered[0]!.parentEventId).toBe(allyDeployed!.eventId);
    expect(triggered[1]!.parentEventId).toBe(enemyDeployed!.eventId);
  });

  it("UT-R-TWR-05-009: a formation wiped inside the deployment scope is detected before TurnStarted, so a last formation's loss ends the battle there and its turn-start memory never activates", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const battle = totalWar(
      [
        {
          units: [
            unit("ally:1", "ALLY", { unitDefinitionId: REACTOR_UNIT, stats: { attack: 999 } }),
          ],
        },
      ],
      [
        { units: [fragile("enemy:1", "ENEMY")] },
        {
          units: [fragile("enemy:2", "ENEMY")],
          memories: [memory("MEM_E2", "BattleStarted"), memory("MEM_E2_TURN", "TurnStarted")],
        },
      ],
    );

    const completed = run(battle, 2, recorder);

    const turn2 = eventsOfTurn(recorder, 2);
    const types = turn2.map((event) => event.eventType);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toMatchObject({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 2,
    });
    expect(turn2.at(-1)).toMatchObject({ eventType: "BattleCompleted", turnNumber: 2 });
    expect(types).toEqual(expect.arrayContaining(["MemoryTriggered", "UnitDefeated"]));
    expect(types).not.toContain("TurnStarted");
    expect(memoryTriggers(recorder.getEvents())).toEqual(["MEM_E2"]);
    const deployed = turn2.find((event) => event.eventType === "FormationDeployed")!;
    const defeated = turn2.filter((event) => event.eventType === "FormationDefeated");
    expect(defeated.map((event) => event.payload)).toEqual([
      { side: "ENEMY", formationNumber: 2, turnNumber: 2, remainingReserveCount: 0 },
    ]);
    expect(defeated[0]!.resolutionScopeId).toBe(deployed.resolutionScopeId);
    expect(types.indexOf("UnitDefeated")).toBeLessThan(types.indexOf("FormationDefeated"));
    expect(types.indexOf("FormationDefeated")).toBeLessThan(types.indexOf("BattleCompleted"));
  });

  it("UT-R-TWR-05-010: when the formation wiped inside the deployment scope still has a reserve, the turn skips its action phase, the wiped formation's turn-start memory stays silent, and the next formation deploys on the following turn", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const battle = totalWar(
      [
        {
          units: [
            unit("ally:1", "ALLY", { unitDefinitionId: REACTOR_UNIT, stats: { attack: 999 } }),
          ],
        },
      ],
      [
        { units: [fragile("enemy:1", "ENEMY")] },
        {
          units: [fragile("enemy:2", "ENEMY")],
          memories: [memory("MEM_E2", "BattleStarted"), memory("MEM_E2_TURN", "TurnStarted")],
        },
        { units: [unit("enemy:3", "ENEMY", { stats: { defense: 5000 } })] },
      ],
    );

    const afterTurn3 = run(battle, 3, recorder);

    const turn2 = eventsOfTurn(recorder, 2);
    const types = turn2.map((event) => event.eventType);
    expect(types.indexOf("FormationDefeated")).toBeLessThan(types.indexOf("TurnStarted"));
    expect(memoryTriggers(turn2)).toEqual(["MEM_E2"]);
    expect(types).not.toContain("ActionQueueCreated");
    expect(types).toContain("TurnCompleted");
    expect(afterTurn3.status).toBe("RUNNING");
    expect(afterTurn3.formations?.ENEMY).toMatchObject({
      activeFormationNumber: 3,
      defeatedCount: 2,
    });
    expect(eventsOfTurn(recorder, 3)[0]).toMatchObject({
      eventType: "FormationDeployed",
      payload: { side: "ENEMY", formationNumber: 3 },
    });
  });
});
