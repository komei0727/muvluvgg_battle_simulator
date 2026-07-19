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
});
