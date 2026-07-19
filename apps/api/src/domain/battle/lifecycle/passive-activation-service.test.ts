import { describe, expect, it } from "vitest";
import {
  PassiveActivationRuntime,
  type PassiveActivationRuntimeContext,
} from "./passive-activation-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { applyStateDelta } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(
  id: string,
  side: Side,
  overrides: {
    maximumPp?: number;
    maximumExtraGauge?: number;
    currentPp?: number;
    currentExtraGauge?: number;
    currentHp?: number;
    maximumHp?: number;
    attack?: number;
    defense?: number;
    unitDefinitionId?: UnitDefinitionId;
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: overrides.unitDefinitionId ?? createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 10,
      defense: overrides.defense ?? 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const limits = {
    maximumAp: LIMITS.maximumAp,
    maximumPp: overrides.maximumPp ?? LIMITS.maximumPp,
    maximumExtraGauge: overrides.maximumExtraGauge ?? LIMITS.maximumExtraGauge,
  };
  const built = createBattleUnit(member, side, limits);
  return {
    ...built,
    currentPp: overrides.currentPp ?? built.currentPp,
    currentExtraGauge: overrides.currentExtraGauge ?? built.currentExtraGauge,
    currentHp: overrides.currentHp ?? built.currentHp,
  };
}

function unitDefinitionOf(
  id: UnitDefinitionId,
  passiveSkillDefinitionIds: readonly SkillDefinitionId[],
): UnitDefinition {
  return {
    unitDefinitionId: id,
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 10,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds,
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: {
      displayName: "Test Unit",
      characterName: "Test Character",
      characterId: "CHAR_TEST",
      affiliations: [],
      tags: [],
    },
  };
}

function passiveSkillOf(
  id: string,
  overrides: {
    ppCost?: number;
    cooldown?: SkillDefinition["cooldown"];
    resolution?: SkillDefinition["resolution"];
  } = {},
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: overrides.ppCost ?? 2 },
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
    resolution: overrides.resolution ?? { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: overrides.cooldown ?? { unit: "ACTION", count: 0 },
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

function definitionsOf(
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<
    ReturnType<typeof createEffectActionDefinitionId>,
    EffectActionDefinition
  > = new Map(),
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions,
    skillDefinitions,
  };
}

function recordTurnStarted(recorder: EventRecorder): BattleDomainEvent {
  return recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
}

function contextOf(
  recorder: EventRecorder,
  definitions: BattleDefinitions,
  triggerEvent: BattleDomainEvent,
  actionId?: ReturnType<typeof createActionId>,
): PassiveActivationRuntimeContext {
  return {
    definitions,
    random: new SequenceRandomSource([]),
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: triggerEvent.resolutionScopeId,
    rootEventId: triggerEvent.eventId,
    ...(actionId !== undefined ? { actionId } : {}),
  };
}

describe("PassiveActivationRuntime.onFactEvent", () => {
  it("UT-R-PS-05-001: consumes PP, increases the EX gauge by the same amount, sets the cooldown, and emits PassiveActivated with correct before/after values in order", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill = passiveSkillOf("SKL_PS", {
      ppCost: 2,
      cooldown: { unit: "ACTION", count: 3 },
    });
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentPp: 3,
      maximumPp: 3,
      currentExtraGauge: 0,
      maximumExtraGauge: 10,
    });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]);

    const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(updatedOwner.currentPp).toBe(1);
    expect(updatedOwner.currentExtraGauge).toBe(2);

    const events = recorder.getEvents();
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toEqual([
      "TurnStarted",
      "ResourceChanged",
      "PassivePointConsumed",
      "ResourceChanged",
      "ExtraGaugeIncreased",
      "CooldownStarted",
      "PassiveActivated",
      "PassiveResolved",
    ]);

    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: owner.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
      ppBefore: 3,
      ppAfter: 1,
      exBefore: 0,
      exAfter: 2,
    });

    const resourceChanged = events.filter(
      (e): e is Extract<BattleDomainEvent, { eventType: "ResourceChanged" }> =>
        e.eventType === "ResourceChanged",
    );
    expect(resourceChanged.map((e) => e.payload.resource)).toEqual(["PP", "EX_GAUGE"]);
    expect(resourceChanged[0]!.payload).toMatchObject({ before: 3, after: 1, delta: -2 });
    expect(resourceChanged[1]!.payload).toMatchObject({ before: 0, after: 2, delta: 2 });
  });

  it("UT-R-PS-05-002: clamps the EX gain at the max and emits ExtraGaugeOverflowDiscarded with the requested/actual/discarded split", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill = passiveSkillOf("SKL_PS", { ppCost: 3 });
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentPp: 3,
      maximumPp: 3,
      currentExtraGauge: 8,
      maximumExtraGauge: 10,
    });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]);

    expect(updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentExtraGauge).toBe(
      10,
    );

    const overflow = recorder
      .getEvents()
      .find((e) => e.eventType === "ExtraGaugeOverflowDiscarded")!;
    expect(overflow.payload).toEqual({
      battleUnitId: owner.battleUnitId,
      requestedAmount: 3,
      actualAmount: 2,
      discardedAmount: 1,
    });
  });

  it("UT-R-SKL-01-001: when the PS owner is defeated partway through its own EffectSequence, the remaining step is skipped and PassiveInterrupted is emitted instead of PassiveResolved", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const selfDamage = damageEffectAction("ACT_SELF_DAMAGE");
    const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY");
    const skill = passiveSkillOf("SKL_BACKLASH", {
      ppCost: 1,
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
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
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: enemyDamage.effectActionDefinitionId }],
          },
        ],
      },
    });
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentHp: 10,
      maximumHp: 10,
      attack: 100,
      defense: 0,
      currentPp: 3,
    });
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const enemy = unit("ENEMY", "ENEMY", {
      currentHp: 100,
      maximumHp: 100,
      unitDefinitionId: enemyUnitDefinitionId,
    });
    const definitions = definitionsOf(
      new Map([
        [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([[skill.skillDefinitionId, skill]]),
      new Map([
        [selfDamage.effectActionDefinitionId, selfDamage],
        [enemyDamage.effectActionDefinitionId, enemyDamage],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner, enemy],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner, enemy]);

    expect(updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentHp).toBe(0);
    expect(updatedUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!.currentHp).toBe(100);

    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "PassiveInterrupted")).toBe(true);
    expect(events.some((e) => e.eventType === "PassiveResolved")).toBe(false);
    const interrupted = events.find((e) => e.eventType === "PassiveInterrupted")!;
    expect(interrupted.payload).toMatchObject({
      actorUnitId: owner.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
      reason: "OWNER_DEFEATED",
    });
    expect(
      events.some(
        (e) => e.eventType === "DamageApplied" && e.targetUnitIds?.includes(enemy.battleUnitId),
      ),
    ).toBe(false);
  });

  it("PR #141 review [P1]: a PS triggered from a turn-boundary event (no actionId, e.g. TurnStarted) can still resolve real EffectSequence steps instead of throwing", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY");
    const skill = passiveSkillOf("SKL_TURN_ATTACK", {
      ppCost: 1,
      // TURN-unit (not the default ACTION-unit): setting an ACTION-unit
      // cooldown requires an actionId, which a turn-boundary activation
      // (like this one) doesn't have — that's a separate, orthogonal
      // constraint from the EffectSequence-resolution bug this test targets.
      cooldown: { unit: "TURN", count: 0 },
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
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
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: enemyDamage.effectActionDefinitionId }],
          },
        ],
      },
    });
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      attack: 100,
      currentPp: 3,
    });
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const enemy = unit("ENEMY", "ENEMY", {
      currentHp: 100,
      maximumHp: 100,
      defense: 0,
      unitDefinitionId: enemyUnitDefinitionId,
    });
    const definitions = definitionsOf(
      new Map([
        [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([[skill.skillDefinitionId, skill]]),
      new Map([[enemyDamage.effectActionDefinitionId, enemyDamage]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    // No actionId: this PS is activated from a turn-boundary event, not from
    // within any unit's own action.
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      owner,
      enemy,
    ]);

    let updatedUnits: readonly BattleUnit[] = [];
    expect(() => {
      updatedUnits = runtime.onFactEvent(turnStarted, [owner, enemy]);
    }).not.toThrow();

    const updatedEnemy = updatedUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.currentHp).toBeLessThan(100);
    expect(recorder.getEvents().some((e) => e.eventType === "DamageApplied")).toBe(true);
  });

  it("PR #141 re-review [P1]: a PS triggered from a turn-boundary event with a positive ACTION-unit cooldown does not throw, and the cooldown decrements at the owner's next own action", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill = passiveSkillOf("SKL_TURN_ACTION_CD", {
      ppCost: 1,
      cooldown: { unit: "ACTION", count: 2 },
    });
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      owner,
    ]);

    let updatedUnits: readonly BattleUnit[] = [];
    expect(() => {
      updatedUnits = runtime.onFactEvent(turnStarted, [owner]);
    }).not.toThrow();

    const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(updatedOwner.cooldowns[skill.skillDefinitionId]).toEqual({
      unit: "ACTION",
      remaining: 2,
    });
    const cooldownStarted = recorder.getEvents().find((e) => e.eventType === "CooldownStarted")!;
    expect(cooldownStarted.payload).toMatchObject({
      actorUnitId: owner.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
      unit: "ACTION",
      initialRemaining: 2,
    });
    // No setActionId recorded (no action was in progress), so the owner's own
    // next action-completion decrements it regardless of that action's id.
    expect(cooldownStarted.stateDelta).toEqual({
      units: {
        [owner.battleUnitId]: {
          cooldowns: { [skill.skillDefinitionId]: { unit: "ACTION", before: 0, after: 2 } },
        },
      },
    });
  });

  it("UT-R-PS-04-009 (Issue #34 integration): a PS candidate without enough PP is silently skipped (no PassiveActivated), leaving resources untouched", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill = passiveSkillOf("SKL_PS", { ppCost: 5 });
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 1, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]);

    expect(updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(1);
    expect(recorder.getEvents().some((e) => e.eventType === "PassiveActivated")).toBe(false);
  });

  it("PR #142レビュー[P1]: when a PS's own EffectSequence has two EffectActions and the first triggers a child PS, the child resolves completely before the parent's second EffectAction starts (親A→子PS→親B)", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD");
    const actionA = damageEffectAction("ACT_A");
    const actionB = damageEffectAction("ACT_B");
    const childAction = damageEffectAction("ACT_CHILD");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT"),
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionA.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionB.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: 任意の`EffectActionCompleted`に反応する（R-PS-07の1解決スコープ1回
    // guardにより、実際に発動するのは最初に観測した1件だけ — 親のaction A由来の
    // ものになるはずで、これが「親A→子PS→親B」の検証を成立させる）。
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD"),
      triggers: [
        {
          eventType: "EffectActionCompleted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: childAction.effectActionDefinitionId }],
          },
        ],
      },
    };

    const parentOwner = unit("PARENT", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      currentPp: 3,
    });
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      currentPp: 3,
    });
    const definitions = definitionsOf(
      new Map([
        [
          parentUnitDefinitionId,
          unitDefinitionOf(parentUnitDefinitionId, [parentSkill.skillDefinitionId]),
        ],
        [
          childUnitDefinitionId,
          unitDefinitionOf(childUnitDefinitionId, [childSkill.skillDefinitionId]),
        ],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map([
        [actionA.effectActionDefinitionId, actionA],
        [actionB.effectActionDefinitionId, actionB],
        [childAction.effectActionDefinitionId, childAction],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner],
    );

    runtime.onFactEvent(turnStarted, [parentOwner, childOwner]);

    const events = recorder.getEvents();
    const actionCompletedEvents = events.filter(
      (e): e is Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }> =>
        e.eventType === "EffectActionCompleted",
    );
    // 親のaction A・B・子のchildActionの3件がそれぞれ1回ずつ解決される。
    expect(actionCompletedEvents.map((e) => e.payload.effectActionDefinitionId)).toEqual([
      actionA.effectActionDefinitionId,
      childAction.effectActionDefinitionId,
      actionB.effectActionDefinitionId,
    ]);

    const actionACompletedIndex = events.indexOf(actionCompletedEvents[0]!);
    const childPassiveActivatedIndex = events.findIndex(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    const actionBStartingIndex = events.findIndex(
      (e) =>
        e.eventType === "EffectActionStarting" &&
        e.payload.effectActionDefinitionId === actionB.effectActionDefinitionId,
    );
    expect(childPassiveActivatedIndex).toBeGreaterThan(actionACompletedIndex);
    expect(actionBStartingIndex).toBeGreaterThan(childPassiveActivatedIndex);

    // 子PSは1解決スコープ1回のため、親のaction B由来のEffectActionCompletedや
    // 自分自身のchildAction由来のEffectActionCompletedでは再発動しない。
    const childPassiveActivatedEvents = events.filter(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    expect(childPassiveActivatedEvents).toHaveLength(1);
  });

  it("PR #142再レビュー[P1]: a child PS triggered by DamageApplied (the DAMAGE action's own internal event, not EffectActionCompleted) resolves before the parent's second EffectAction starts", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD");
    const actionA = damageEffectAction("ACT_A");
    const actionB = damageEffectAction("ACT_B");
    const childAction = damageEffectAction("ACT_CHILD");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT"),
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionA.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionB.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: `DamageApplied`（DAMAGE適用が内部で発行するイベントそのもの）に
    // 反応する。`EffectActionCompleted`ではなく、これより前に発行される内部
    // イベントを契機にしても、親のaction Bより前に解決されることを確認する
    // （PR #142再レビュー[P1]の回帰: generator化でEFFECT_RESOLVEDが
    // `EffectActionCompleted`だけになり、`DamageApplied`が候補検出へ渡らなく
    // なっていた）。
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD"),
      triggers: [
        {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: childAction.effectActionDefinitionId }],
          },
        ],
      },
    };

    const parentOwner = unit("PARENT", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      currentPp: 3,
    });
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      currentPp: 3,
    });
    const definitions = definitionsOf(
      new Map([
        [
          parentUnitDefinitionId,
          unitDefinitionOf(parentUnitDefinitionId, [parentSkill.skillDefinitionId]),
        ],
        [
          childUnitDefinitionId,
          unitDefinitionOf(childUnitDefinitionId, [childSkill.skillDefinitionId]),
        ],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map([
        [actionA.effectActionDefinitionId, actionA],
        [actionB.effectActionDefinitionId, actionB],
        [childAction.effectActionDefinitionId, childAction],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner],
    );

    runtime.onFactEvent(turnStarted, [parentOwner, childOwner]);

    const events = recorder.getEvents();
    const damageAppliedEvents = events.filter((e) => e.eventType === "DamageApplied");
    // 親のaction A・子のchildAction・親のaction Bの3件のDamageAppliedが発行される。
    expect(damageAppliedEvents).toHaveLength(3);

    const actionADamageAppliedIndex = events.indexOf(damageAppliedEvents[0]!);
    const childPassiveActivatedIndex = events.findIndex(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    const actionBStartingIndex = events.findIndex(
      (e) =>
        e.eventType === "EffectActionStarting" &&
        e.payload.effectActionDefinitionId === actionB.effectActionDefinitionId,
    );
    expect(childPassiveActivatedIndex).toBeGreaterThan(actionADamageAppliedIndex);
    expect(actionBStartingIndex).toBeGreaterThan(childPassiveActivatedIndex);

    const childPassiveActivatedEvents = events.filter(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    expect(childPassiveActivatedEvents).toHaveLength(1);
  });

  it("PR #142再レビュー[P1]: a child PS triggered by CooldownReduced (a COOLDOWN_MANIPULATION action's own internal event) resolves before the parent's second EffectAction starts", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD");
    const targetSkillId = createSkillDefinitionId("SKL_ON_COOLDOWN");
    const resetAction: EffectActionDefinition = {
      kind: "COOLDOWN_MANIPULATION",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_RESET"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: { targetSkillDefinitionId: targetSkillId, operation: "RESET" },
    };
    const actionB = damageEffectAction("ACT_B");
    const childAction = damageEffectAction("ACT_CHILD");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT"),
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: resetAction.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionB.effectActionDefinitionId }],
          },
        ],
      },
    };
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD"),
      triggers: [
        {
          eventType: "CooldownReduced",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: childAction.effectActionDefinitionId }],
          },
        ],
      },
    };

    const parentOwner = {
      ...unit("PARENT", "ALLY", { unitDefinitionId: parentUnitDefinitionId, currentPp: 3 }),
      cooldowns: { [targetSkillId]: { unit: "ACTION" as const, remaining: 2 } },
    };
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      currentPp: 3,
    });
    const definitions = definitionsOf(
      new Map([
        [
          parentUnitDefinitionId,
          unitDefinitionOf(parentUnitDefinitionId, [parentSkill.skillDefinitionId]),
        ],
        [
          childUnitDefinitionId,
          unitDefinitionOf(childUnitDefinitionId, [childSkill.skillDefinitionId]),
        ],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map<ReturnType<typeof createEffectActionDefinitionId>, EffectActionDefinition>([
        [resetAction.effectActionDefinitionId, resetAction],
        [actionB.effectActionDefinitionId, actionB],
        [childAction.effectActionDefinitionId, childAction],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner],
    );

    runtime.onFactEvent(turnStarted, [parentOwner, childOwner]);

    const events = recorder.getEvents();
    const cooldownReducedIndex = events.findIndex((e) => e.eventType === "CooldownReduced");
    expect(cooldownReducedIndex).toBeGreaterThanOrEqual(0);
    const childPassiveActivatedIndex = events.findIndex(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    const actionBStartingIndex = events.findIndex(
      (e) =>
        e.eventType === "EffectActionStarting" &&
        e.payload.effectActionDefinitionId === actionB.effectActionDefinitionId,
    );
    expect(childPassiveActivatedIndex).toBeGreaterThan(cooldownReducedIndex);
    expect(actionBStartingIndex).toBeGreaterThan(childPassiveActivatedIndex);
  });

  it("UT-R-EFF-11-001 (RuntimeCounter, Issue #143): updates the counter and emits RuntimeCounterChanged before the causing event's own PS candidates are resolved, so a modulo-gated PS only activates once the counter reaches a multiple", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_CRIT");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS2"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "RUNTIME_COUNTER",
            counter: counterId,
            op: "GTE",
            value: 1,
            modulo: 2,
          },
        },
      ],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "CriticalCheckResolved",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
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
      metadata: { displayName: "SKL_PS2", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    function recordCrit(): BattleDomainEvent {
      return recorder.record({
        eventType: "CriticalCheckResolved",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 1,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: turnStarted.resolutionScopeId,
        rootEventId: turnStarted.eventId,
        sourceUnitId: owner.battleUnitId,
        payload: { mode: "NORMAL", baseCriticalRate: 1, effectiveCriticalRate: 1, result: true },
      });
    }

    const crit1 = recordCrit();
    let units = runtime.onFactEvent(crit1, [owner]);
    expect(units.find((u) => u.battleUnitId === owner.battleUnitId)?.skillCounters).toEqual({
      [skill.skillDefinitionId]: { RUNTIME_COUNTER_CRIT: { value: 1, carry: 0 } },
    });
    expect(recorder.getEvents().some((e) => e.eventType === "PassiveActivated")).toBe(false);

    const runtimeCounterChanged1 = recorder
      .getEvents()
      .find((e) => e.eventType === "RuntimeCounterChanged")!;
    expect(runtimeCounterChanged1.parentEventId).toBe(crit1.eventId);
    expect(runtimeCounterChanged1.sequence).toBeGreaterThan(crit1.sequence);
    expect(runtimeCounterChanged1.payload).toMatchObject({
      ownerUnitId: owner.battleUnitId,
      scope: "SKILL_RUNTIME",
      counter: "RUNTIME_COUNTER_CRIT",
      skillDefinitionId: skill.skillDefinitionId,
      before: 0,
      after: 1,
      carry: 0,
    });
    expect(runtimeCounterChanged1.stateDelta).toEqual({
      units: {
        [owner.battleUnitId]: {
          skillCounters: {
            [skill.skillDefinitionId]: { RUNTIME_COUNTER_CRIT: { before: 0, after: 1 } },
          },
        },
      },
    });

    const crit2 = recordCrit();
    units = runtime.onFactEvent(crit2, units);
    expect(units.find((u) => u.battleUnitId === owner.battleUnitId)?.skillCounters).toEqual({
      [skill.skillDefinitionId]: { RUNTIME_COUNTER_CRIT: { value: 2, carry: 0 } },
    });

    const passiveActivated = recorder.getEvents().find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated).toBeDefined();
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: owner.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
    });
    const runtimeCounterChanged2 = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged")[1]!;
    expect(runtimeCounterChanged2.sequence).toBeLessThan(passiveActivated.sequence);
  });

  it("UT-R-PS-05-003 (Issue #143 fix: PassiveActivated now reaches PS candidate detection): a PS that activates causes another PS reacting to PassiveActivated to activate within the same resolution scope", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_CHAIN_OWNER");
    const skillA: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_A"),
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
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      requiredCapabilities: [],
      metadata: { displayName: "SKL_PS_A", tags: [] },
    };
    const skillB: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_B"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "PassiveActivated",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "EVENT_PAYLOAD",
            field: "skillDefinitionId",
            op: "EQ",
            value: skillA.skillDefinitionId,
          },
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
      metadata: { displayName: "SKL_PS_B", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([
        [
          unitDefinitionId,
          unitDefinitionOf(unitDefinitionId, [skillA.skillDefinitionId, skillB.skillDefinitionId]),
        ],
      ]),
      new Map([
        [skillA.skillDefinitionId, skillA],
        [skillB.skillDefinitionId, skillB],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    runtime.onFactEvent(turnStarted, [owner]);

    const events = recorder.getEvents();
    const passiveActivatedEvents = events.filter((e) => e.eventType === "PassiveActivated");
    expect(passiveActivatedEvents.map((e) => e.payload.skillDefinitionId)).toEqual([
      skillA.skillDefinitionId,
      skillB.skillDefinitionId,
    ]);
  });

  it("UT-R-PS-05-004 (review fix [P1]: PassiveActivated re-entry must not clobber the activation guard): a PS whose own trigger reacts to its own PassiveActivated activates exactly once per resolution scope (R-PS-07), not twice", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_SELF_REACT_OWNER");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_SELF_REACT"),
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
        {
          // Deliberately reacts to its own PassiveActivated (unconditionally),
          // so the buggy implementation would try to re-activate itself the
          // moment its own PassiveActivated event is processed mid-flight.
          eventType: "PassiveActivated",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
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
      metadata: { displayName: "SKL_PS_SELF_REACT", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    runtime.onFactEvent(turnStarted, [owner]);

    const passiveActivatedEvents = recorder
      .getEvents()
      .filter((e) => e.eventType === "PassiveActivated");
    expect(passiveActivatedEvents).toHaveLength(1);
  });

  it("UT-R-EFF-11-002 (review fix [P2]): finalizeResolutionScope discards a resetScope: RESOLUTION_SCOPE counter and emits RuntimeCounterReset once the candidate stack is empty", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_RESET_OWNER");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_SCOPED");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_RESET"),
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
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
          resetScope: "RESOLUTION_SCOPE",
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
      metadata: { displayName: "SKL_PS_RESET", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const afterEvent = runtime.onFactEvent(turnStarted, [owner]);
    const ownerAfterEvent = afterEvent.find((u) => u.battleUnitId === owner.battleUnitId);
    expect(ownerAfterEvent?.skillCounters).toEqual({
      [skill.skillDefinitionId]: { RUNTIME_COUNTER_SCOPED: { value: 1, carry: 0 } },
    });

    const finalUnits = runtime.finalizeResolutionScope();
    const ownerAfterFinalize = finalUnits.find((u) => u.battleUnitId === owner.battleUnitId);
    expect(ownerAfterFinalize?.skillCounters?.[skill.skillDefinitionId]).toEqual({});

    const reset = recorder.getEvents().find((e) => e.eventType === "RuntimeCounterReset")!;
    expect(reset).toBeDefined();
    expect(reset.parentEventId).toBe(turnStarted.eventId);
    expect(reset.payload).toMatchObject({
      ownerUnitId: owner.battleUnitId,
      scope: "SKILL_RUNTIME",
      counter: counterId,
      skillDefinitionId: skill.skillDefinitionId,
      before: 1,
    });
    // レビュー再レビュー[P1]: `after: 0`ではなく`undefined`（キー自体の削除）。
    expect(reset.stateDelta).toEqual({
      units: {
        [owner.battleUnitId]: {
          skillCounters: {
            [skill.skillDefinitionId]: { [counterId]: { before: 1, after: undefined } },
          },
        },
      },
    });

    // レビュー再レビュー[P1]: `reset.stateDelta`だけから独立Reducerで復元した
    // 状態が、実状態（`resetRuntimeCounter`がキーを削除した後の`ownerAfterFinalize`）
    // と同じ形（`{}`、`{ counter: 0 }`ではない）になること。
    const initialSnapshot: BattleStateSnapshot = {
      status: "RUNNING",
      currentTurn: 1,
      units: {
        [owner.battleUnitId]: {
          hp: owner.currentHp,
          ap: owner.currentAp,
          pp: owner.currentPp,
          extraGauge: owner.currentExtraGauge,
          skillCounters: { [skill.skillDefinitionId]: { [counterId]: 1 } },
        },
      },
    };
    const reconstructed = applyStateDelta(initialSnapshot, reset.stateDelta!);
    expect(reconstructed.units[owner.battleUnitId]!.skillCounters).toEqual({
      [skill.skillDefinitionId]: {},
    });

    // Calling it again is a stable no-op: nothing left to reset, no duplicate event.
    const resetEventsBefore = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterReset").length;
    runtime.finalizeResolutionScope();
    const resetEventsAfter = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterReset").length;
    expect(resetEventsAfter).toBe(resetEventsBefore);
  });

  it("UT-R-EFF-11-003 (review re-fix [P1]): a resetScope counter whose own counterUpdates re-triggers on the RuntimeCounterReset it causes makes finalizeResolutionScope throw a deterministic error instead of looping forever", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_RESET_LOOP_OWNER");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_SELF_REGEN");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_RESET_LOOP"),
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
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
          resetScope: "RESOLUTION_SCOPE",
        },
        {
          // このcounterの再生成契機が、自身がRESOLUTION_SCOPE終了時に発行する
          // `RuntimeCounterReset`自身になっている（悪意/誤りのあるCatalog定義）。
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "RuntimeCounterReset",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
          resetScope: "RESOLUTION_SCOPE",
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
      metadata: { displayName: "SKL_PS_RESET_LOOP", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );
    runtime.onFactEvent(turnStarted, [owner]);

    expect(() => runtime.finalizeResolutionScope()).toThrow(
      /exceeded .* discard\/emit\/resolve rounds/,
    );
  });

  it("UT-R-EFF-11-004 (review re-re-fix [P1]): a hit that lands carry exactly on 0 (not via reset) still reconstructs to the same skillCounterCarry shape as the real state (key absent, not present with value 0) across sub-threshold -> exact-crossing -> resolution-scope reset", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_CARRY_ZERO_OWNER");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_CARRY_ZERO");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_CARRY_ZERO"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "RuntimeCounterChanged",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "AND",
            conditions: [
              { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterId },
              { kind: "EVENT_PAYLOAD", field: "valueChanged", op: "EQ", value: true },
            ],
          },
        },
      ],
      counterUpdates: [
        {
          kind: "CUMULATIVE_DAMAGE_THRESHOLD",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "DamageApplied",
            category: "FACT",
            sourceSelector: "ENEMY",
            targetSelector: "SELF",
            condition: { kind: "TRUE" },
          },
          maxHpRatio: 0.5,
          resetScope: "RESOLUTION_SCOPE",
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
      metadata: { displayName: "SKL_PS_CARRY_ZERO", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentPp: 3,
      maximumPp: 3,
      maximumHp: 100,
    });
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_CARRY_ZERO_ENEMY");
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([[skill.skillDefinitionId, skill]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner, enemy],
    );

    function damageAppliedEvent(damage: number): BattleDomainEvent {
      return recorder.record({
        eventType: "DamageApplied",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: turnStarted.resolutionScopeId,
        parentEventId: turnStarted.eventId,
        rootEventId: turnStarted.eventId,
        sourceUnitId: enemy.battleUnitId,
        targetUnitIds: [owner.battleUnitId],
        payload: {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_CARRY_ZERO_HIT"),
          hitIndex: 1,
          targetUnitId: owner.battleUnitId,
          calculatedDamage: damage,
          hitPointDamage: damage,
          hpBefore: owner.currentHp,
          hpAfter: owner.currentHp - damage,
          defeated: false,
        },
      });
    }

    let snapshot: BattleStateSnapshot = {
      status: "RUNNING",
      currentTurn: 1,
      units: {
        [owner.battleUnitId]: {
          hp: owner.currentHp,
          ap: owner.currentAp,
          pp: owner.currentPp,
          extraGauge: owner.currentExtraGauge,
        },
      },
    };
    let appliedEventCount = 0;
    // レビュー再々々々レビュー[P1]: `?? {}`で個別フィールドを緩く比較するのでは
    // なく、`captureBattleState`相当の完全なSnapshot同士を直接突き合わせる
    // ため、RuntimeCounterChanged/Reset以外（PP消費・EX増加等）も含め全ての
    // イベントのstateDeltaを順に適用し、実状態と同じ完全なunit射影を再構築する。
    function replayNewEventDeltasIntoSnapshot(): void {
      const events = recorder.getEvents();
      for (; appliedEventCount < events.length; appliedEventCount += 1) {
        const event = events[appliedEventCount]!;
        if (event.stateDelta !== undefined) {
          snapshot = applyStateDelta(snapshot, event.stateDelta);
        }
      }
    }

    // Hit 1: 20 damage, sub-threshold (threshold = maxHp(100) * 0.5 = 50).
    // carry 0 -> 20 (carry-only change, valueChanged: false); value stays 0.
    runtime.onFactEvent(damageAppliedEvent(20), [owner, enemy]);
    replayNewEventDeltasIntoSnapshot();
    let ownerNow = runtime.currentUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(ownerNow.skillCounters?.[skill.skillDefinitionId]).toEqual({
      [counterId]: { value: 0, carry: 20 },
    });
    expect(snapshot.units[owner.battleUnitId]!.skillCounterCarry).toEqual({
      [skill.skillDefinitionId]: { [counterId]: 20 },
    });

    // Hit 2: 30 more damage. Total carry 20+30=50 crosses the threshold
    // exactly once with remainder 0 — carry lands exactly back on 0 via a
    // normal update (not a resolution-scope reset). value 0 -> 1.
    runtime.onFactEvent(damageAppliedEvent(30), runtime.currentUnits);
    replayNewEventDeltasIntoSnapshot();
    ownerNow = runtime.currentUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(ownerNow.skillCounters?.[skill.skillDefinitionId]).toEqual({
      [counterId]: { value: 1, carry: 0 },
    });
    // The real state's carry projection omits the `skillCounterCarry` field
    // entirely once no counter has nonzero carry — assert the key itself is
    // absent (not merely falsy/`{}`), matching `captureBattleState` exactly
    // (レビュー再々々々レビュー[P1]: `?? {}` previously masked `{}` vs "no key").
    expect(
      Object.prototype.hasOwnProperty.call(
        snapshot.units[owner.battleUnitId]!,
        "skillCounterCarry",
      ),
    ).toBe(false);
    expect(snapshot.units[owner.battleUnitId]!.skillCounterCarry).toBeUndefined();

    // Resolution-scope end: the counter's public value (1) is discarded.
    // carry is already 0 at this point, so no skillCounterCarry delta is
    // expected from the reset itself (only skillCounters).
    runtime.finalizeResolutionScope();
    replayNewEventDeltasIntoSnapshot();
    const finalOwner = runtime.currentUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(finalOwner.skillCounters?.[skill.skillDefinitionId]).toEqual({});
    expect(snapshot.units[owner.battleUnitId]!.skillCounters).toEqual({
      [skill.skillDefinitionId]: {},
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        snapshot.units[owner.battleUnitId]!,
        "skillCounterCarry",
      ),
    ).toBe(false);
    expect(snapshot.units[owner.battleUnitId]!.skillCounterCarry).toBeUndefined();

    // 直接、実状態(`captureBattleState`相当の射影)と再構築Snapshotの
    // unit全体を突き合わせる（フィールド単位の`?? {}`に頼らない）。
    // `finalOwner`（実BattleUnit）に対応する射影は、carryが1件も残って
    // いないため`skillCounterCarry`を持たず、`skillCounters`は
    // `{ [skillDefinitionId]: {} }`だけを持つ。
    expect(snapshot.units[owner.battleUnitId]).toEqual({
      hp: finalOwner.currentHp,
      ap: finalOwner.currentAp,
      pp: finalOwner.currentPp,
      extraGauge: finalOwner.currentExtraGauge,
      skillCounters: { [skill.skillDefinitionId]: {} },
    });
  });
});
