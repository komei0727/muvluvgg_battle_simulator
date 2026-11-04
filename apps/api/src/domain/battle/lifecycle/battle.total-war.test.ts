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
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DefaultUnitDefinitionMap } from "../../../testing/fixtures/default-unit-definition-map.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

/** ASを持つユニット定義。持たない定義（`PASSIVE_UNIT`）のユニットは行動フェーズで待機する。 */
const ATTACKER_UNIT = createUnitDefinitionId("UNIT_001");
const PASSIVE_UNIT = createUnitDefinitionId("UNIT_PASSIVE");
const TURN_END_STRIKER_UNIT = createUnitDefinitionId("UNIT_TURN_END_STRIKER");

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const NO_RANDOM = () => new SequenceRandomSource([]);

interface UnitSpec {
  readonly unitDefinitionId?: UnitDefinitionId;
  readonly position?: FormationPosition;
  readonly stats?: Partial<BattlePartyMember["combatStats"]>;
  readonly overrides?: Partial<BattleUnit>;
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
  return { ...createBattleUnit(member, side, LIMITS), ...spec.overrides };
}

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

const TRAITS: SkillDefinition["traits"] = {
  priorityAttack: false,
  simultaneousActivationLimited: false,
  exclusiveActivationGroupId: null,
  accuracy: { guaranteedHit: false },
  piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
};

function damageEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
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

function damageSteps(
  steps: readonly { readonly target: "ENEMY_ALL" | "SELF"; readonly effectAction: string }[],
): SkillDefinition["resolution"] {
  return {
    kind: "IMMEDIATE",
    targetBindings: [{ targetBindingId: createTargetBindingId("TGT_ENEMY"), selector: ENEMY_ALL }],
    steps: steps.map((step) => ({
      kind: "ACTION",
      stepCondition: { kind: "TRUE" },
      targetCondition: { kind: "TRUE" },
      target:
        step.target === "SELF"
          ? { kind: "SELF" }
          : { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ENEMY") },
      actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(step.effectAction) }],
    })),
  };
}

const ATTACK_SKILL: SkillDefinition = {
  skillDefinitionId: createSkillDefinitionId("SKL_ATTACK"),
  skillType: "AS",
  cost: { resource: "AP", amount: 1 },
  activationCondition: { kind: "TRUE" },
  triggers: [],
  counterUpdates: [],
  resolution: damageSteps([{ target: "ENEMY_ALL", effectAction: "ACT_ATTACK" }]),
  cooldown: { unit: "ACTION", count: 0 },
  traits: TRAITS,
  metadata: { displayName: "Attack", tags: [] },
};

/** 1回のAS使用で、敵へ致死ダメージを与えてから自分自身へ致死ダメージを与える（同時全滅の再現）。 */
const MUTUALLY_LETHAL_SKILL: SkillDefinition = {
  ...ATTACK_SKILL,
  skillDefinitionId: createSkillDefinitionId("SKL_MUTUALLY_LETHAL"),
  resolution: damageSteps([
    { target: "ENEMY_ALL", effectAction: "ACT_ATTACK" },
    { target: "SELF", effectAction: "ACT_ATTACK" },
  ]),
};

const TURN_END_STRIKE_PS_ID = createSkillDefinitionId("SKL_PS_TURN_END_STRIKE");

/** `TurnCompleted`で敵全体へダメージを与えるPS。ターン終了の判定タイミングで全滅を起こす。 */
const TURN_END_STRIKE_PS: SkillDefinition = {
  skillDefinitionId: TURN_END_STRIKE_PS_ID,
  skillType: "PS",
  cost: { resource: "PP", amount: 1 },
  activationCondition: { kind: "TRUE" },
  triggers: [
    {
      eventType: "TurnCompleted",
      category: "FACT",
      sourceSelector: "SELF",
      targetSelector: "SELF",
      condition: { kind: "TRUE" },
    },
  ],
  counterUpdates: [],
  resolution: damageSteps([{ target: "ENEMY_ALL", effectAction: "ACT_ATTACK" }]),
  cooldown: { unit: "TURN", count: 0 },
  traits: TRAITS,
  metadata: { displayName: "TurnEndStrike", tags: [] },
};

function unitDefinition(
  unitDefinitionId: UnitDefinitionId,
  passiveSkillDefinitionIds: readonly SkillDefinitionId[] = [],
): UnitDefinition {
  return {
    unitDefinitionId,
    category: "PLAYABLE",
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
      subAffinityBonus: 0.15,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds,
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    metadata: {
      displayName: unitDefinitionId,
      characterName: unitDefinitionId,
      characterId: `CHAR_${unitDefinitionId}`,
      affiliations: [],
      tags: [],
    },
  };
}

function definitions(attackSkill: SkillDefinition = ATTACK_SKILL): BattleDefinitions {
  const effectAction = damageEffectAction("ACT_ATTACK");
  return {
    activeSkillsByUnit: new Map([[ATTACKER_UNIT, [attackSkill]]]),
    exSkillByUnit: new Map(),
    effectActions: new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [effectAction.effectActionDefinitionId, effectAction],
    ]),
    unitDefinitions: new DefaultUnitDefinitionMap([
      [TURN_END_STRIKER_UNIT, unitDefinition(TURN_END_STRIKER_UNIT, [TURN_END_STRIKE_PS_ID])],
    ]),
    skillDefinitions: new Map([[TURN_END_STRIKE_PS_ID, TURN_END_STRIKE_PS]]),
  };
}

function totalWar(
  ally: readonly (readonly BattleUnit[])[],
  enemy: readonly (readonly BattleUnit[])[],
  battleDefinitions: BattleDefinitions = definitions(),
  turnLimit = 15,
): Battle {
  return createTotalWarBattle(
    createBattleId("B_1"),
    { ALLY: ally, ENEMY: enemy },
    createTurnLimit(turnLimit),
    battleDefinitions,
  );
}

function eventsOfTurn(recorder: EventRecorder, turnNumber: number): readonly BattleDomainEvent[] {
  return recorder.getEvents().filter((event) => event.turnNumber === turnNumber);
}

function typesOf(events: readonly BattleDomainEvent[]): readonly string[] {
  return events.map((event) => event.eventType);
}

function idsOf(units: readonly BattleUnit[]): readonly BattleUnitId[] {
  return units.map((u) => u.battleUnitId);
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

/** 1手で敵の1番目の編成（HP10・防御0の1体）を倒す味方と、控えに1編成を持つ敵。 */
function oneShotBattle(): Battle {
  // 敵の2つの編成は同じ配置位置（中央前列）に置く。
  return totalWar(
    [[unit("ally:1", "ALLY", { unitDefinitionId: ATTACKER_UNIT, stats: { attack: 999 } })]],
    [
      [unit("enemy:1", "ENEMY", { stats: { maximumHp: 10, defense: 0 } })],
      [unit("enemy:2", "ENEMY", { stats: { defense: 990 } })],
    ],
  );
}

describe("createTotalWarBattle", () => {
  it("UT-R-TWR-03-001: places only each side's first formation on the board and keeps the rest as reserves", () => {
    const battle = totalWar(
      [[unit("ally:1", "ALLY")], [unit("ally:2", "ALLY")], [unit("ally:3", "ALLY")]],
      [[unit("enemy:1", "ENEMY")], [unit("enemy:2", "ENEMY")]],
    );

    expect(battle.mode).toBe("TOTAL_WAR");
    expect(idsOf(battle.allyUnits)).toEqual([createBattleUnitId("ally:1")]);
    expect(idsOf(battle.enemyUnits)).toEqual([createBattleUnitId("enemy:1")]);
    expect(battle.allyUnits[0]!.formationNumber).toBe(1);
    expect(battle.formations?.ALLY).toMatchObject({
      formationCount: 3,
      activeFormationNumber: 1,
      defeatedCount: 0,
    });
    expect(
      battle.formations?.ALLY.reserves.map((reserve) => ({
        formationNumber: reserve.formationNumber,
        unitIds: idsOf(reserve.units),
        unitFormationNumbers: reserve.units.map((u) => u.formationNumber),
      })),
    ).toEqual([
      { formationNumber: 2, unitIds: [createBattleUnitId("ally:2")], unitFormationNumbers: [2] },
      { formationNumber: 3, unitIds: [createBattleUnitId("ally:3")], unitFormationNumbers: [3] },
    ]);
    expect(battle.formations?.ENEMY.reserves).toHaveLength(1);
  });

  it("UT-R-TWR-03-002: counts only the first formation in BattleStarted's slot counts", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    startBattle(
      totalWar(
        [[unit("ally:1", "ALLY")], [unit("ally:2", "ALLY"), unit("ally:3", "ALLY")]],
        [[unit("enemy:1", "ENEMY")]],
      ),
      NO_RANDOM(),
      recorder,
    );

    expect(recorder.getEvents()[0]!.payload).toMatchObject({ allySlotCount: 1, enemySlotCount: 1 });
  });

  it("UT-R-TWR-03-003: rejects a BattleUnitId reused across formations", () => {
    expect(() =>
      totalWar([[unit("ally:1", "ALLY")], [unit("ally:1", "ALLY")]], [[unit("enemy:1", "ENEMY")]]),
    ).toThrow(DomainValidationError);
  });
});

describe("advanceBattle (TOTAL_WAR)", () => {
  it("UT-R-TWR-03-004: a wipe after an action publishes FormationDefeated and cuts the rest of the action phase, while TURN_ENDING still runs", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const cooldownSkillId = createSkillDefinitionId("SKL_TURN_COOLDOWN");
    const started = startBattle(
      totalWar(
        [
          [
            unit("ally:1", "ALLY", {
              unitDefinitionId: ATTACKER_UNIT,
              stats: { attack: 999 },
              overrides: {
                cooldowns: { [cooldownSkillId]: { unit: "TURN", remaining: 2, setTurnNumber: 0 } },
              },
            }),
          ],
        ],
        [
          [unit("enemy:1", "ENEMY", { stats: { maximumHp: 10, defense: 0 } })],
          [unit("enemy:2", "ENEMY")],
        ],
      ),
      NO_RANDOM(),
      recorder,
    );

    const afterTurn1 = advanceBattle(started, NO_RANDOM(), recorder);

    const turn1 = eventsOfTurn(recorder, 1);
    const types = typesOf(turn1);
    expect(afterTurn1.status).toBe("RUNNING");
    // AP3の味方は通常なら3回行動するが、1回目で敵の編成が全滅したため残りを実行しない。
    expect(types.filter((type) => type === "ActionStarted")).toHaveLength(1);
    expect(afterTurn1.allyUnits[0]!.currentAp).toBe(2);
    const defeated = turn1.filter((event) => event.eventType === "FormationDefeated");
    expect(defeated.map((event) => event.payload)).toEqual([
      { side: "ENEMY", formationNumber: 1, turnNumber: 1, remainingReserveCount: 1 },
    ]);
    const actionCompleted = turn1.find((event) => event.eventType === "ActionCompleted")!;
    expect(defeated[0]!.parentEventId).toBe(actionCompleted.eventId);
    expect(types.indexOf("UnitDefeated")).toBeLessThan(types.indexOf("FormationDefeated"));
    // R-TWR-03 #5: 打ち切った後もターン終了処理（クールタイム減算・TurnCompleted）は行う。
    expect(types.indexOf("FormationDefeated")).toBeLessThan(types.indexOf("TurnCompleting"));
    expect(types).toContain("TurnCompleted");
    expect(afterTurn1.allyUnits[0]!.cooldowns[cooldownSkillId]?.remaining).toBe(1);
    expect(afterTurn1.formations?.ENEMY).toMatchObject({
      activeFormationNumber: 1,
      defeatedCount: 1,
    });
    // 控えはまだ盤面に出ない（次ターンの開始時に出撃する）。
    expect(idsOf(afterTurn1.enemyUnits)).toEqual([createBattleUnitId("enemy:1")]);
  });

  it("UT-R-TWR-04-001: deploys the next formation at the start of the following turn, before TurnStarted, and it acts in that turn", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const started = startBattle(oneShotBattle(), NO_RANDOM(), recorder);
    const afterTurn1 = advanceBattle(started, NO_RANDOM(), recorder);

    const afterTurn2 = advanceBattle(afterTurn1, NO_RANDOM(), recorder);

    const turn2 = eventsOfTurn(recorder, 2);
    const types = typesOf(turn2);
    expect(types[0]).toBe("FormationDeployed");
    expect(types[1]).toBe("TurnStarted");
    const deployed = turn2[0]!;
    expect(deployed.payload).toEqual({
      side: "ENEMY",
      formationNumber: 2,
      turnNumber: 2,
      battleUnitIds: [createBattleUnitId("enemy:2")],
    });
    expect(deployed.rootEventId).toBe(deployed.eventId);
    expect(deployed.parentEventId).toBeUndefined();
    // R-TWR-03 #8: 全滅した編成のユニットは戦闘不能のまま盤面に残り、新しい編成が加わる。
    expect(idsOf(afterTurn2.enemyUnits)).toEqual([
      createBattleUnitId("enemy:1"),
      createBattleUnitId("enemy:2"),
    ]);
    expect(findUnit(afterTurn2, "enemy:1").currentHp).toBe(0);
    expect(findUnit(afterTurn2, "enemy:2").formationNumber).toBe(2);
    expect(afterTurn2.formations?.ENEMY).toMatchObject({
      activeFormationNumber: 2,
      defeatedCount: 1,
      reserves: [],
    });
    // 出撃したユニットはTURN_STARTINGでAP・PPを回復し、そのターンの行動順に乗る。
    const recovered = turn2.find((event) => event.eventType === "ResourcesRecovered")!;
    expect(
      (recovered.payload as { units: readonly { battleUnitId: BattleUnitId }[] }).units.map(
        (entry) => entry.battleUnitId,
      ),
    ).toContain(createBattleUnitId("enemy:2"));
    const firstQueue = turn2.find((event) => event.eventType === "ActionQueueCreated")!;
    expect(
      (
        firstQueue.payload as { reservations: readonly { battleUnitId: BattleUnitId }[] }
      ).reservations.map((entry) => entry.battleUnitId),
    ).toContain(createBattleUnitId("enemy:2"));
    // 同じマスに残る戦闘不能の1番目の編成のユニットは、対象にならない。
    const targeted = turn2
      .filter((event) => event.eventType === "TargetsSelected")
      .flatMap((event) => event.targetUnitIds ?? []);
    expect(targeted).toContain(createBattleUnitId("enemy:2"));
    expect(targeted).not.toContain(createBattleUnitId("enemy:1"));
  });

  it("UT-R-TWR-04-002: the surviving formation carries its HP, EX gauge, effects and cooldowns into the next fight unchanged, and recovers AP/PP as usual", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const cooldownSkillId = createSkillDefinitionId("SKL_TURN_COOLDOWN");
    const started = startBattle(
      totalWar(
        [
          [
            unit("ally:1", "ALLY", {
              unitDefinitionId: ATTACKER_UNIT,
              stats: { attack: 999 },
              overrides: {
                currentHp: 37,
                cooldowns: { [cooldownSkillId]: { unit: "TURN", remaining: 5, setTurnNumber: 0 } },
              },
            }),
          ],
        ],
        [
          [unit("enemy:1", "ENEMY", { stats: { maximumHp: 10, defense: 0 } })],
          [unit("enemy:2", "ENEMY")],
        ],
      ),
      NO_RANDOM(),
      recorder,
    );
    const afterTurn1 = advanceBattle(started, NO_RANDOM(), recorder);
    const allyAtTurn1End = findUnit(afterTurn1, "ally:1");

    advanceBattle(afterTurn1, NO_RANDOM(), recorder);

    // 出撃スコープでは勝ち残った編成の状態を変えない。AP・PPは続くTURN_STARTINGで回復する。
    const turn2 = eventsOfTurn(recorder, 2);
    const turnStartedIndex = typesOf(turn2).indexOf("TurnStarted");
    expect(
      turn2
        .slice(0, turnStartedIndex)
        .filter((event) => event.stateDelta !== undefined && "units" in event.stateDelta),
    ).toEqual([]);
    expect(allyAtTurn1End.currentHp).toBe(37);
    expect(allyAtTurn1End.cooldowns[cooldownSkillId]?.remaining).toBe(4);
    const recovered = turn2.find((event) => event.eventType === "ResourcesRecovered")!;
    expect(
      (
        recovered.payload as {
          units: readonly { battleUnitId: BattleUnitId; apBefore: number; apAfter: number }[];
        }
      ).units.find((entry) => entry.battleUnitId === createBattleUnitId("ally:1")),
    ).toMatchObject({ apBefore: allyAtTurn1End.currentAp, apAfter: 3 });
  });

  it("UT-R-TWR-03-005: a wipe found at the turn-start checkpoint skips the action phase but still runs TURN_ENDING", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const started = startBattle(
      totalWar(
        [[unit("ally:1", "ALLY", { unitDefinitionId: ATTACKER_UNIT })]],
        [[unit("enemy:1", "ENEMY", { overrides: { currentHp: 0 } })], [unit("enemy:2", "ENEMY")]],
      ),
      NO_RANDOM(),
      recorder,
    );

    const afterTurn1 = advanceBattle(started, NO_RANDOM(), recorder);

    const turn1 = eventsOfTurn(recorder, 1);
    const types = typesOf(turn1);
    expect(afterTurn1.status).toBe("RUNNING");
    expect(types).not.toContain("ActionQueueCreated");
    const turnStarted = turn1.find((event) => event.eventType === "TurnStarted")!;
    const defeated = turn1.find((event) => event.eventType === "FormationDefeated")!;
    expect(defeated.payload).toMatchObject({ side: "ENEMY", formationNumber: 1 });
    expect(defeated.parentEventId).toBe(turnStarted.eventId);
    expect(defeated.rootEventId).toBe(turnStarted.eventId);
    expect(types).toContain("TurnCompleted");
  });

  it("UT-R-TWR-03-006: a wipe caused by a turn-end PS is detected at the turn-end checkpoint as a child of TurnCompleted", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const started = startBattle(
      totalWar(
        [
          [
            unit("ally:1", "ALLY", {
              unitDefinitionId: TURN_END_STRIKER_UNIT,
              stats: { attack: 999 },
            }),
          ],
        ],
        [
          [unit("enemy:1", "ENEMY", { stats: { maximumHp: 10, defense: 0 } })],
          [unit("enemy:2", "ENEMY")],
        ],
      ),
      NO_RANDOM(),
      recorder,
    );

    const afterTurn1 = advanceBattle(started, NO_RANDOM(), recorder);

    const turn1 = eventsOfTurn(recorder, 1);
    const turnCompleted = turn1.find((event) => event.eventType === "TurnCompleted")!;
    const defeated = turn1.filter((event) => event.eventType === "FormationDefeated");
    expect(afterTurn1.status).toBe("RUNNING");
    expect(defeated).toHaveLength(1);
    expect(defeated[0]!.parentEventId).toBe(turnCompleted.eventId);
    expect(defeated[0]!.sequence).toBeGreaterThan(turnCompleted.sequence);

    advanceBattle(afterTurn1, NO_RANDOM(), recorder);
    expect(typesOf(eventsOfTurn(recorder, 2))[0]).toBe("FormationDeployed");
  });

  it("UT-R-TWR-03-007: a formation already reported as defeated is not reported again at a later checkpoint of the same turn", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const started = startBattle(oneShotBattle(), NO_RANDOM(), recorder);

    advanceBattle(started, NO_RANDOM(), recorder);

    expect(
      recorder.getEvents().filter((event) => event.eventType === "FormationDefeated"),
    ).toHaveLength(1);
  });

  it("UT-R-TWR-04-003: when both sides are wiped together, both publish FormationDefeated (ally first) and both deploy in one scope (ally first, enemy as its child)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const started = startBattle(
      totalWar(
        [
          [
            unit("ally:1", "ALLY", {
              unitDefinitionId: ATTACKER_UNIT,
              stats: { attack: 999, defense: 0, maximumHp: 10 },
            }),
          ],
          [unit("ally:2", "ALLY")],
        ],
        [
          [unit("enemy:1", "ENEMY", { stats: { maximumHp: 10, defense: 0 } })],
          [unit("enemy:2", "ENEMY")],
        ],
        definitions(MUTUALLY_LETHAL_SKILL),
      ),
      NO_RANDOM(),
      recorder,
    );

    const afterTurn1 = advanceBattle(started, NO_RANDOM(), recorder);
    expect(afterTurn1.status).toBe("RUNNING");
    expect(
      eventsOfTurn(recorder, 1)
        .filter((event) => event.eventType === "FormationDefeated")
        .map((event) => event.payload),
    ).toEqual([
      { side: "ALLY", formationNumber: 1, turnNumber: 1, remainingReserveCount: 1 },
      { side: "ENEMY", formationNumber: 1, turnNumber: 1, remainingReserveCount: 1 },
    ]);

    const afterTurn2 = advanceBattle(afterTurn1, NO_RANDOM(), recorder);

    const turn2 = eventsOfTurn(recorder, 2);
    const [allyDeployed, enemyDeployed, turnStarted] = turn2;
    expect(allyDeployed!.eventType).toBe("FormationDeployed");
    expect(allyDeployed!.payload).toMatchObject({ side: "ALLY", formationNumber: 2 });
    expect(enemyDeployed!.eventType).toBe("FormationDeployed");
    expect(enemyDeployed!.payload).toMatchObject({ side: "ENEMY", formationNumber: 2 });
    expect(enemyDeployed!.parentEventId).toBe(allyDeployed!.eventId);
    expect(enemyDeployed!.rootEventId).toBe(allyDeployed!.eventId);
    expect(enemyDeployed!.resolutionScopeId).toBe(allyDeployed!.resolutionScopeId);
    expect(turnStarted!.eventType).toBe("TurnStarted");
    expect(idsOf(afterTurn2.allyUnits)).toEqual([
      createBattleUnitId("ally:1"),
      createBattleUnitId("ally:2"),
    ]);
  });

  it("UT-R-TWR-03-008: a wipe of a side with no reserve left ends the battle, and the wiped side with a reserve does not lose", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const started = startBattle(
      totalWar(
        [
          [
            unit("ally:1", "ALLY", {
              unitDefinitionId: ATTACKER_UNIT,
              stats: { attack: 999, defense: 0, maximumHp: 10 },
            }),
          ],
          [unit("ally:2", "ALLY")],
        ],
        [[unit("enemy:1", "ENEMY", { stats: { maximumHp: 10, defense: 0 } })]],
        definitions(MUTUALLY_LETHAL_SKILL),
      ),
      NO_RANDOM(),
      recorder,
    );

    const completed = advanceBattle(started, NO_RANDOM(), recorder);

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toMatchObject({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
    });
    const types = typesOf(recorder.getEvents());
    expect(types.lastIndexOf("FormationDefeated")).toBeLessThan(types.indexOf("BattleCompleted"));
    expect(types).not.toContain("TurnCompleting");
  });
});
