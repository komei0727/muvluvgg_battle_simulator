import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSIVE_CHAIN_LIMITS,
  PassiveActivationRuntime,
  type PassiveActivationRuntimeContext,
} from "./passive-activation-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
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
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { applyStateDelta } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";

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
  resolutionPhase?: PassiveActivationRuntimeContext["resolutionPhase"],
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
    ...(resolutionPhase !== undefined ? { resolutionPhase } : {}),
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

    // レビュー指摘[P2]: PSも一つのSkillUseのため、この発動に属する全イベント
    // (リソース消費・Cooldown設定・PassiveActivated・PassiveResolved)は同じ
    // skillUseIdを共有し、かつTurnStarted(このPSの原因イベント、PSのSkillUse
    // ではない)にはskillUseIdが無いはずである。
    const skillUseIds = events
      .filter((e) => e.eventType !== "TurnStarted")
      .map((e) => e.skillUseId);
    expect(skillUseIds.every((id) => id !== undefined)).toBe(true);
    expect(new Set(skillUseIds).size).toBe(1);
    expect(events.find((e) => e.eventType === "TurnStarted")!.skillUseId).toBeUndefined();
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

  it("UT-R-PS-01-033 (Issue #144, TRIGGER_EXCLUSION_TIMING): PassiveActivationRuntimeContext.resolutionPhase reaches candidate detection AND reconfirmation, excluding a RESOLUTION_PHASE(negate: true)-gated PS only when the context's resolutionPhase matches", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill: SkillDefinition = {
      ...passiveSkillOf("SKL_PS", { ppCost: 2 }),
      triggers: [
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "RESOLUTION_PHASE", phase: "TURN_START", negate: true },
        },
      ],
    };
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentPp: 3,
      maximumPp: 3,
    });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );

    const excludedRecorder = new EventRecorder(createBattleId("B_1"));
    const excludedTurnStarted = recordTurnStarted(excludedRecorder);
    const excludedRuntime = new PassiveActivationRuntime(
      contextOf(excludedRecorder, definitions, excludedTurnStarted, undefined, "TURN_START"),
      [owner],
    );
    const excludedUnits = excludedRuntime.onFactEvent(excludedTurnStarted, [owner]);
    expect(excludedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(3);
    expect(excludedRecorder.getEvents().map((e) => e.eventType)).toEqual(["TurnStarted"]);

    const includedRecorder = new EventRecorder(createBattleId("B_2"));
    const includedTurnStarted = recordTurnStarted(includedRecorder);
    const includedRuntime = new PassiveActivationRuntime(
      contextOf(includedRecorder, definitions, includedTurnStarted, createActionId("B_2:action:1")),
      [owner],
    );
    const includedUnits = includedRuntime.onFactEvent(includedTurnStarted, [owner]);
    expect(includedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(1);
    expect(includedRecorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it('UT-R-PS-01-036 (review re-fix [P2], Issue #144 follow-up): PassiveActivationRuntimeContext.resolutionPhase: "BATTLE_START" reaches candidate detection AND reconfirmation, activating a RESOLUTION_PHASE("BATTLE_START", negate: false)-gated PS — the same mechanism already proven for "TURN_START"/"TURN_END", verified here independently of `startBattle`\'s real BattleUnit resource state (Q-BTL-05 forbids a 0-cost PS, and `createBattleUnit`/READY→RUNNING never grants PP before this point — see UT-BATTLE-017 in battle.test.ts, which correctly asserts this candidate can never actually activate through the real creation path)', () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill: SkillDefinition = {
      ...passiveSkillOf("SKL_PS", { ppCost: 1 }),
      triggers: [
        {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "RESOLUTION_PHASE", phase: "BATTLE_START", negate: false },
        },
      ],
    };
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentPp: 1,
      maximumPp: 3,
    });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );

    const recorder = new EventRecorder(createBattleId("B_1"));
    const battleStarted = recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 5, allySlotCount: 1, enemySlotCount: 1 },
    });
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, battleStarted, undefined, "BATTLE_START"),
      [owner],
    );
    const units = runtime.onFactEvent(battleStarted, [owner]);
    expect(units.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(0);
    expect(recorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it("UT-R-PS-04-012 (Issue #144 review fix [P2]): a POSITION_RELATION-gated PS whose event references a target absent from the roster is discarded deterministically at reconfirmation, not thrown", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill: SkillDefinition = {
      ...passiveSkillOf("SKL_PS", { ppCost: 2 }),
      triggers: [
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: {
            kind: "POSITION_RELATION",
            target: { kind: "TRIGGER_TARGET" },
            relation: "IN_FRONT_OF",
          },
        },
      ],
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );

    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnScope = recorder.nextResolutionScopeId();
    const vanishedTargetId = createBattleUnitId("GONE");
    const turnStarted = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: turnScope,
      targetUnitIds: [vanishedTargetId],
      payload: { turnNumber: 1 },
    });
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    expect(() => runtime.onFactEvent(turnStarted, [owner])).not.toThrow();
    const updatedOwner = runtime.currentUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(updatedOwner.currentPp).toBe(3);
    expect(recorder.getEvents().map((e) => e.eventType)).toEqual(["TurnStarted"]);
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
          combatStats: owner.combatStats,
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
          combatStats: owner.combatStats,
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
      combatStats: finalOwner.combatStats,
      skillCounters: { [skill.skillDefinitionId]: {} },
    });
  });

  it("review fix [P1]: PassiveResolved now reaches PS candidate detection, so another PS reacting to 'an ally's PS resolved' activates in the same resolution scope", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_RESOLVED_REACT_OWNER");
    const skillA = passiveSkillOf("SKL_PS_RESOLVED_A", { ppCost: 1 });
    const skillB: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_RESOLVED_B"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "PassiveResolved",
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
      metadata: { displayName: "SKL_PS_RESOLVED_B", tags: [] },
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
    const resolvedEvents = events.filter((e) => e.eventType === "PassiveResolved");
    expect(resolvedEvents.map((e) => e.payload.skillDefinitionId)).toEqual([
      skillA.skillDefinitionId,
      skillB.skillDefinitionId,
    ]);
    const activatedEvents = events.filter((e) => e.eventType === "PassiveActivated");
    expect(activatedEvents.map((e) => e.payload.skillDefinitionId)).toEqual([
      skillA.skillDefinitionId,
      skillB.skillDefinitionId,
    ]);
  });

  it("review fix [P1]: PassiveInterrupted now reaches PS candidate detection, so another unit's PS reacting to it activates", () => {
    const ownerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_INTERRUPTED_OWNER");
    const selfDamage = damageEffectAction("ACT_SELF_DAMAGE_INTERRUPT");
    const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE_INTERRUPT");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY_INTERRUPT");
    const skillA = passiveSkillOf("SKL_BACKLASH_INTERRUPT", {
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
        // 1段目で自爆し使用者(PS所有者)が戦闘不能になるため、2段目は未解決のまま
        // 打ち切られる(UT-R-SKL-01-001と同じ設定)。1段しかないと打ち切られる
        // 残り効果が0件になり`PassiveInterrupted`ではなく`PassiveResolved`が
        // 発行されてしまう。
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
    const watcherUnitDefinitionId = createUnitDefinitionId("UNIT_PS_INTERRUPTED_WATCHER");
    const skillB: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_INTERRUPTED_WATCHER"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "PassiveInterrupted",
          category: "FACT",
          sourceSelector: "ANY",
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
      metadata: { displayName: "SKL_PS_INTERRUPTED_WATCHER", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId: ownerUnitDefinitionId,
      currentHp: 10,
      maximumHp: 10,
      attack: 100,
      defense: 0,
      currentPp: 3,
    });
    const watcher = unit("WATCHER", "ALLY", {
      unitDefinitionId: watcherUnitDefinitionId,
      currentPp: 3,
    });
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_PS_INTERRUPTED_ENEMY");
    const enemy = unit("ENEMY", "ENEMY", {
      currentHp: 100,
      maximumHp: 100,
      unitDefinitionId: enemyUnitDefinitionId,
    });
    const definitions = definitionsOf(
      new Map([
        [
          ownerUnitDefinitionId,
          unitDefinitionOf(ownerUnitDefinitionId, [skillA.skillDefinitionId]),
        ],
        [
          watcherUnitDefinitionId,
          unitDefinitionOf(watcherUnitDefinitionId, [skillB.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([
        [skillA.skillDefinitionId, skillA],
        [skillB.skillDefinitionId, skillB],
      ]),
      new Map([
        [selfDamage.effectActionDefinitionId, selfDamage],
        [enemyDamage.effectActionDefinitionId, enemyDamage],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner, watcher, enemy],
    );

    runtime.onFactEvent(turnStarted, [owner, watcher, enemy]);

    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "PassiveInterrupted")).toBe(true);
    const activatedEvents = events.filter((e) => e.eventType === "PassiveActivated");
    expect(activatedEvents.map((e) => e.payload.skillDefinitionId)).toEqual([
      skillA.skillDefinitionId,
      skillB.skillDefinitionId,
    ]);
  });

  it("review fix [P2]: multiple RuntimeCounter updates caused by the same event are applied one at a time — a PS reacting to the first RuntimeCounterChanged cannot observe a second counter's not-yet-emitted value", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_SEQUENTIAL_COUNTERS_OWNER");
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_SEQ_A");
    const counterB = createRuntimeCounterId("RUNTIME_COUNTER_SEQ_B");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_SEQUENTIAL_COUNTERS"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      // レビュー指摘[P2]の再現条件: 修正前は`counterA`の変化に反応する候補解決の
      // 時点で`counterB`（後続counter）が既に更新済みだったため、この
      // RUNTIME_COUNTER条件（`counterB == 0`）が偽になり発動しなかった。
      activationCondition: { kind: "RUNTIME_COUNTER", counter: counterB, op: "EQ", value: 0 },
      triggers: [
        {
          eventType: "RuntimeCounterChanged",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterA },
        },
      ],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterA,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
        {
          kind: "INCREMENT",
          counter: counterB,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
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
      metadata: { displayName: "SKL_PS_SEQUENTIAL_COUNTERS", tags: [] },
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]);

    const counterChangedEvents = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged");
    expect(counterChangedEvents.map((e) => e.payload.counter)).toEqual([counterA, counterB]);

    // The PS reacting to counterA's change activated, proving its RUNTIME_COUNTER
    // condition observed counterB still at 0 (not yet emitted) at that moment.
    const activatedEvents = recorder.getEvents().filter((e) => e.eventType === "PassiveActivated");
    expect(activatedEvents).toHaveLength(1);
    expect(activatedEvents[0]?.payload.skillDefinitionId).toBe(skill.skillDefinitionId);

    const finalOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(finalOwner.skillCounters?.[skill.skillDefinitionId]).toEqual({
      [counterA]: { value: 1, carry: 0 },
      [counterB]: { value: 1, carry: 0 },
    });
  });

  it("review fix [P2]: a counterUpdates definition that re-triggers itself from the RuntimeCounterChanged it causes throws a deterministic ExecutionGuardExceededError instead of recursing forever", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_COUNTER_SELF_REGEN_OWNER");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_SELF_REGEN_ONFACTEVENT");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_COUNTER_SELF_REGEN"),
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
        },
        {
          // このcounterの再更新契機が、自身の変化で発行される
          // `RuntimeCounterChanged`自身になっている（悪意/誤りのあるCatalog定義）。
          // 毎回`value`が変化する(INCREMENT)ため、この`RuntimeCounterChanged`は
          // 自分自身の条件にも一致し続け、`onFactEvent`が無限に再帰する。
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "RuntimeCounterChanged",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterId },
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
      metadata: { displayName: "SKL_PS_COUNTER_SELF_REGEN", tags: [] },
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

    let caught: unknown;
    try {
      runtime.onFactEvent(turnStarted, [owner]);
    } catch (error) {
      caught = error;
    }
    // レビュー指摘[P1]: 実行ガード超過は`DomainValidationError`
    // （`INVALID_COMMAND`/HTTP422へ変換される）ではなく、専用の
    // `ExecutionGuardExceededError`（`EXECUTION_LIMIT_EXCEEDED`/HTTP503）でなければ
    // ならない。
    expect(caught).toBeInstanceOf(ExecutionGuardExceededError);
    expect((caught as Error).message).toMatch(/self-triggering recursion exceeded/);
  });

  it("review re-fix [P2]: a PS chain reacting to the first RuntimeCounterChanged that mutates the still-pending second counter is not clobbered by a stale pre-computed value", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_COUNTER_RACE_OWNER");
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_RACE_A");
    const counterB = createRuntimeCounterId("RUNTIME_COUNTER_RACE_B");
    const mutatorSkillId = createSkillDefinitionId("SKL_PS_COUNTER_RACE_MUTATOR");
    // レビュー再指摘[P2]の再現: counterAとcounterBは同じ原因イベント
    // (TurnStarted)で一括検出される対象だが、counterAのRuntimeCounterChanged
    // に反応するPS連鎖(mutatorSkill)が、まだ処理されていないcounterBを
    // "先に"別経路(自身のPassiveActivatedをtriggerとするcounterUpdates)で
    // 変化させる。修正前は、TurnStarted起点で事前計算したcounterBの
    // change.after(=1)で、mutatorが書き込んだ値(10)を上書きしてしまっていた。
    const originalSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_COUNTER_RACE_ORIGINAL"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterA,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
        {
          kind: "INCREMENT",
          counter: counterB,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
        {
          // mutatorSkillの発動(counterAの変化に反応)で、counterBを"横から"
          // 大きく書き換える。このcounterUpdates自体はTurnStartedにはマッチ
          // しないため、最初の一括検出には含まれない。
          kind: "INCREMENT",
          counter: counterB,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "PassiveActivated",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
            condition: {
              kind: "EVENT_PAYLOAD",
              field: "skillDefinitionId",
              op: "EQ",
              value: mutatorSkillId,
            },
          },
          amount: 10,
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
      metadata: { displayName: "SKL_PS_COUNTER_RACE_ORIGINAL", tags: [] },
    };
    const mutatorSkill: SkillDefinition = {
      skillDefinitionId: mutatorSkillId,
      skillType: "PS",
      cost: { resource: "PP", amount: 0 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "RuntimeCounterChanged",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterA },
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
      metadata: { displayName: "SKL_PS_COUNTER_RACE_MUTATOR", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([
        [
          unitDefinitionId,
          unitDefinitionOf(unitDefinitionId, [
            originalSkill.skillDefinitionId,
            mutatorSkill.skillDefinitionId,
          ]),
        ],
      ]),
      new Map([
        [originalSkill.skillDefinitionId, originalSkill],
        [mutatorSkill.skillDefinitionId, mutatorSkill],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]);

    const counterBChanges = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged" && e.payload.counter === counterB);
    // First: mutatorSkill's PassiveActivated-triggered write (0 -> 10).
    // Second: originalSkill's TurnStarted-triggered entry, applied against
    // the now-current state (10 -> 11) at the point the outer generator
    // reaches it, not the stale pre-computed (0 -> 1) snapshot taken before
    // the mutator ran.
    expect(counterBChanges.map((e) => e.payload)).toMatchObject([
      { before: 0, after: 10 },
      { before: 10, after: 11 },
    ]);

    const finalOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(finalOwner.skillCounters?.[originalSkill.skillDefinitionId]).toEqual({
      [counterA]: { value: 1, carry: 0 },
      [counterB]: { value: 11, carry: 0 },
    });
  });

  it("review re-re-fix [P2]: an originalSkill entry that matched the causing event before a PS chain ran is still applied afterward, even though the PS chain changed the counter its match condition depended on", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_COUNTER_NO_VANISH_OWNER");
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_NO_VANISH_A");
    const counterE = createRuntimeCounterId("RUNTIME_COUNTER_NO_VANISH_E");
    const mutatorSkillId = createSkillDefinitionId("SKL_PS_COUNTER_NO_VANISH_MUTATOR");
    // レビュー再々指摘[P2]の再現: counterEのマッチング条件(counterA==0)は、
    // TurnStarted到着直後(counterAはまだ0)の時点では真であり一致が確定する。
    // その後mutatorSkillがcounterAの変化に反応して連鎖的にcounterAをさらに
    // 書き換えても、既に確定済みのcounterEの一致は取り消されてはならない
    // (before/afterの再計算だけが最新状態を反映する)。
    const originalSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_COUNTER_NO_VANISH_ORIGINAL"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterA,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
        {
          kind: "INCREMENT",
          counter: counterE,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "RUNTIME_COUNTER", counter: counterA, op: "EQ", value: 0 },
          },
          amount: 1,
        },
        {
          // mutatorSkillの発動でcounterAをさらに書き換える。TurnStartedには
          // マッチしないため最初の一括マッチングには含まれない。
          kind: "INCREMENT",
          counter: counterA,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "PassiveActivated",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
            condition: {
              kind: "EVENT_PAYLOAD",
              field: "skillDefinitionId",
              op: "EQ",
              value: mutatorSkillId,
            },
          },
          amount: 5,
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
      metadata: { displayName: "SKL_PS_COUNTER_NO_VANISH_ORIGINAL", tags: [] },
    };
    const mutatorSkill: SkillDefinition = {
      skillDefinitionId: mutatorSkillId,
      skillType: "PS",
      cost: { resource: "PP", amount: 0 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "RuntimeCounterChanged",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterA },
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
      metadata: { displayName: "SKL_PS_COUNTER_NO_VANISH_MUTATOR", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([
        [
          unitDefinitionId,
          unitDefinitionOf(unitDefinitionId, [
            originalSkill.skillDefinitionId,
            mutatorSkill.skillDefinitionId,
          ]),
        ],
      ]),
      new Map([
        [originalSkill.skillDefinitionId, originalSkill],
        [mutatorSkill.skillDefinitionId, mutatorSkill],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]);

    const counterAChanges = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged" && e.payload.counter === counterA);
    expect(counterAChanges.map((e) => e.payload)).toMatchObject([
      { before: 0, after: 1 },
      { before: 1, after: 6 },
    ]);

    // counterE's match was locked in against the pre-mutator state (A === 0)
    // and must still fire even though A is now 6 by the time the outer
    // generator reaches this entry.
    const counterEChanges = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged" && e.payload.counter === counterE);
    expect(counterEChanges.map((e) => e.payload)).toMatchObject([{ before: 0, after: 1 }]);

    const finalOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(finalOwner.skillCounters?.[originalSkill.skillDefinitionId]).toEqual({
      [counterA]: { value: 6, carry: 0 },
      [counterE]: { value: 1, carry: 0 },
    });
  });

  describe("R-EFF-08 (expiration.conditions, レビュー修正 PR #209)", () => {
    const STAT_MOD_ID = createEffectActionDefinitionId("ACT_CURSE_ATK_DOWN");

    function statModDefinition(): EffectActionDefinition {
      return {
        effectActionDefinitionId: STAT_MOD_ID,
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

    function conditionalEffect(
      holderId: ReturnType<typeof createBattleUnitId>,
      conditions: readonly ConditionDefinition[],
    ): AppliedEffect {
      return {
        effectInstanceId: createEffectInstanceId("effect-curse"),
        effectActionDefinitionId: STAT_MOD_ID,
        kindKey: effectKindKeyFromDefinitionId(STAT_MOD_ID),
        duplicate: true,
        sourceId: holderId,
        targetId: holderId,
        magnitude: -0.2,
        duration: {
          definition: { expiration: { conditions }, dispellable: true, linkedEffectGroupId: null },
        },
        appliedTurnNumber: 1,
      };
    }

    it("UT-R-EFF-08-008 (レビュー指摘[P2]、任意のFACT/TIMINGイベントに接続): expires a matching effect on a non-ActionCompleted event (TurnStarted), before that event's own PS candidates resolve", () => {
      const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
      const owner = unit("OWNER", "ALLY", { attack: 10, unitDefinitionId });
      const ownerWithEffect: BattleUnit = {
        ...owner,
        combatStats: { ...owner.combatStats, attack: 8 },
        appliedEffects: [
          conditionalEffect(owner.battleUnitId, [
            { kind: "EVENT_PAYLOAD", field: "turnNumber", op: "EQ", value: 1 },
          ]),
        ],
      };
      const skill = passiveSkillOf("SKL_ON_TURN_START", { ppCost: 0 });
      const definitions = definitionsOf(
        new Map([
          [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        ]),
        new Map([[skill.skillDefinitionId, skill]]),
        new Map([[STAT_MOD_ID, statModDefinition()]]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        ownerWithEffect,
      ]);

      const updatedUnits = runtime.onFactEvent(turnStarted, [ownerWithEffect]);

      const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(updatedOwner.appliedEffects).toHaveLength(0);
      expect(updatedOwner.combatStats.attack).toBe(10);

      const eventTypes = recorder.getEvents().map((e) => e.eventType);
      const expiredIndex = eventTypes.indexOf("EffectExpired");
      const combatStatChangedIndex = eventTypes.indexOf("CombatStatChanged");
      const passiveActivatedIndex = eventTypes.indexOf("PassiveActivated");
      expect(expiredIndex).toBeGreaterThanOrEqual(0);
      expect(combatStatChangedIndex).toBeGreaterThan(expiredIndex);
      // The TurnStarted-triggered PS's own candidate resolution (PassiveActivated)
      // must come after the expiration-condition cascade for the SAME event.
      expect(passiveActivatedIndex).toBeGreaterThan(combatStatChangedIndex);
    });

    it("UT-R-EFF-08-009 (production Catalog ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL相当、TARGET_STATE/SELF/IS_ALIVE): expires an effect whose holder is defeated by the event just recorded", () => {
      const holder = unit("HOLDER", "ALLY", { attack: 10, currentHp: 0 });
      const holderWithEffect: BattleUnit = {
        ...holder,
        combatStats: { ...holder.combatStats, attack: 8 },
        appliedEffects: [
          conditionalEffect(holder.battleUnitId, [
            {
              kind: "TARGET_STATE",
              target: { kind: "SELF" },
              field: "IS_ALIVE",
              op: "EQ",
              value: false,
            },
          ]),
        ],
      };
      const definitions = definitionsOf(
        new Map(),
        new Map(),
        new Map([[STAT_MOD_ID, statModDefinition()]]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const unitDefeated = recorder.record({
        eventType: "UnitDefeated",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: turnStarted.resolutionScopeId,
        parentEventId: turnStarted.eventId,
        rootEventId: turnStarted.eventId,
        targetUnitIds: [holder.battleUnitId],
        payload: { unitId: holder.battleUnitId, causeEventId: turnStarted.eventId },
      });
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        holderWithEffect,
      ]);

      const updatedUnits = runtime.onFactEvent(unitDefeated, [holderWithEffect]);

      const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updatedHolder.appliedEffects).toHaveLength(0);
      expect(updatedHolder.combatStats.attack).toBe(10);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(true);
    });

    it("UT-R-EFF-08-010: does nothing (no EffectExpired) when no expiration.conditions matches the event", () => {
      const unitDefinitionId = createUnitDefinitionId("UNIT_A");
      const owner = unit("OWNER", "ALLY", { attack: 10, unitDefinitionId });
      const ownerWithEffect: BattleUnit = {
        ...owner,
        appliedEffects: [
          conditionalEffect(owner.battleUnitId, [
            { kind: "EVENT_PAYLOAD", field: "turnNumber", op: "EQ", value: 999 },
          ]),
        ],
      };
      const definitions = definitionsOf(
        new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [])]]),
        new Map(),
        new Map([[STAT_MOD_ID, statModDefinition()]]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        ownerWithEffect,
      ]);

      const updatedUnits = runtime.onFactEvent(turnStarted, [ownerWithEffect]);

      const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(updatedOwner.appliedEffects).toHaveLength(1);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(false);
    });

    it("UT-R-EFF-08-011 (レビュー再指摘[P1]、PS連鎖内部イベント): expires an effect whose expiration.conditions matches a PassiveActivated event yielded from inside the PS chain itself (not routed through onFactEvent)", () => {
      const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
      const skill = passiveSkillOf("SKL_PS", { ppCost: 0 });
      const owner = unit("OWNER", "ALLY", { attack: 10, unitDefinitionId });
      const ownerWithEffect: BattleUnit = {
        ...owner,
        combatStats: { ...owner.combatStats, attack: 8 },
        appliedEffects: [
          conditionalEffect(owner.battleUnitId, [
            {
              kind: "EVENT_PAYLOAD",
              field: "skillDefinitionId",
              op: "EQ",
              value: skill.skillDefinitionId,
            },
          ]),
        ],
      };
      const definitions = definitionsOf(
        new Map([
          [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        ]),
        new Map([[skill.skillDefinitionId, skill]]),
        new Map([[STAT_MOD_ID, statModDefinition()]]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        ownerWithEffect,
      ]);

      const updatedUnits = runtime.onFactEvent(turnStarted, [ownerWithEffect]);

      // `PassiveActivated`自体は`activatePassiveCandidate`（PS連鎖の内部）が直接
      // yieldするイベントで、`onFactEvent`を経由しない。この効果はその
      // `PassiveActivated`自身のpayload(`skillDefinitionId`)を条件にしているため、
      // 修正前（トップレベルの`onFactEvent`だけがR-EFF-08を評価していた頃）は
      // 一切失効しなかった。
      const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(updatedOwner.appliedEffects).toHaveLength(0);
      expect(updatedOwner.combatStats.attack).toBe(10);

      const eventTypes = recorder.getEvents().map((e) => e.eventType);
      const passiveActivatedIndex = eventTypes.indexOf("PassiveActivated");
      const expiredIndex = eventTypes.indexOf("EffectExpired");
      expect(passiveActivatedIndex).toBeGreaterThanOrEqual(0);
      expect(expiredIndex).toBeGreaterThan(passiveActivatedIndex);
    });
  });

  describe("RuntimeCounter APPLIED_EFFECT scope (R-EFF-11, EFF-005/Issue #162)", () => {
    const holderUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_HOLDER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_ENEMY");
    const hitCounterId = createRuntimeCounterId("RUNTIME_COUNTER_HIT_COUNT");
    const effectActionDefinitionId = createEffectActionDefinitionId("ACT_EFF_CURSE");

    function curseDefinition(threshold = 2): DurationDefinition {
      return {
        dispellable: true,
        linkedEffectGroupId: null,
        counterUpdates: [
          {
            kind: "INCREMENT",
            counter: hitCounterId,
            scope: "APPLIED_EFFECT",
            trigger: {
              eventType: "DamageApplied",
              category: "FACT",
              sourceSelector: "ENEMY",
              targetSelector: "SELF",
              condition: { kind: "TRUE" },
            },
            amount: 1,
          },
        ],
        expiration: {
          conditions: [
            { kind: "RUNTIME_COUNTER", counter: hitCounterId, op: "GTE", value: threshold },
          ],
        },
      };
    }

    function curseEffect(threshold = 2): AppliedEffect {
      return {
        effectInstanceId: createEffectInstanceId("effect-curse"),
        effectActionDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
        duplicate: true,
        sourceId: createBattleUnitId("ENEMY"),
        targetId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        duration: { definition: curseDefinition(threshold), counters: {} },
        appliedTurnNumber: 1,
      };
    }

    function hitEvent(
      recorder: EventRecorder,
      turnStarted: BattleDomainEvent,
      enemy: BattleUnit,
    ): BattleDomainEvent {
      return recorder.record({
        eventType: "DamageApplied",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 1,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: turnStarted.resolutionScopeId,
        rootEventId: turnStarted.eventId,
        sourceUnitId: enemy.battleUnitId,
        targetUnitIds: [createBattleUnitId("HOLDER")],
        payload: {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_EFF_CURSE_HIT"),
          hitIndex: 1,
          targetUnitId: createBattleUnitId("HOLDER"),
          calculatedDamage: 10,
          hitPointDamage: 10,
          hpBefore: 100,
          hpAfter: 90,
          defeated: false,
        },
      });
    }

    it("UT-R-EFF-11-014 (EFF-005 Issue #162): increments the effect instance's own counter, emits RuntimeCounterChanged with effectInstanceId (not skillDefinitionId), and does not throw", () => {
      const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
      const holder = { ...unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId }) };
      const holderWithEffect = { ...holder, appliedEffects: [curseEffect()] };
      const definitions = definitionsOf(
        new Map([
          [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
          [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
        ]),
        new Map(),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        [enemy, holderWithEffect],
      );

      const hit1 = hitEvent(recorder, turnStarted, enemy);
      const units = runtime.onFactEvent(hit1, [enemy, holderWithEffect]);

      const updatedHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updatedHolder.appliedEffects).toHaveLength(1);
      expect(updatedHolder.appliedEffects[0]!.duration.counters).toEqual({
        [hitCounterId]: { value: 1, carry: 0 },
      });

      // PR #211レビュー[P1]: この`hit1`は`onFactEvent`のトップレベル呼び出しと
      // `resolvePassiveChain`が注入する`deps.applyEffectRuntimeCounterUpdates`の
      // 両方から`resolveEvent`経由で到達しうる — `processedEffectRuntimeCounterEventIds`
      // ガードにより二重加算されず、`RuntimeCounterChanged`はちょうど1件だけ
      // 発行されることを明示的に固定する。
      const runtimeCounterChangedEvents = recorder
        .getEvents()
        .filter((e) => e.eventType === "RuntimeCounterChanged");
      expect(runtimeCounterChangedEvents).toHaveLength(1);
      const runtimeCounterChanged = runtimeCounterChangedEvents[0]!;
      expect(runtimeCounterChanged.parentEventId).toBe(hit1.eventId);
      expect(runtimeCounterChanged.payload).toMatchObject({
        ownerUnitId: holder.battleUnitId,
        scope: "APPLIED_EFFECT",
        counter: hitCounterId,
        effectInstanceId: curseEffect().effectInstanceId,
        before: 0,
        after: 1,
        carry: 0,
        valueChanged: true,
      });
      expect(runtimeCounterChanged.payload).not.toHaveProperty("skillDefinitionId");
    });

    it("UT-R-EFF-11-015 (EFF-005 Issue #162): once the counter reaches the expiration.conditions threshold, the effect instance expires (R-EFF-08 evaluates the freshly updated counter)", () => {
      const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
      const holder = unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId });
      const holderWithEffect = { ...holder, appliedEffects: [curseEffect()] };
      const definitions = definitionsOf(
        new Map([
          [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
          [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
        ]),
        new Map(),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        [enemy, holderWithEffect],
      );

      const hit1 = hitEvent(recorder, turnStarted, enemy);
      let units = runtime.onFactEvent(hit1, [enemy, holderWithEffect]);
      expect(
        units.find((u) => u.battleUnitId === holder.battleUnitId)?.appliedEffects,
      ).toHaveLength(1);

      const hit2 = hitEvent(recorder, turnStarted, enemy);
      units = runtime.onFactEvent(hit2, units);

      const updatedHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updatedHolder.appliedEffects).toHaveLength(0);

      const eventTypes = recorder.getEvents().map((e) => e.eventType);
      const secondRuntimeCounterChangedIndex = eventTypes.lastIndexOf("RuntimeCounterChanged");
      const expiredIndex = eventTypes.indexOf("EffectExpired");
      expect(expiredIndex).toBeGreaterThan(secondRuntimeCounterChangedIndex);
    });

    it("UT-R-EFF-11-016 (EFF-005 Issue #162): a RuntimeCounterChanged stateDelta.units[holder].effects[instanceId] before/after round-trips through the independent Reducer", () => {
      const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
      const holder = unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId });
      const holderWithEffect = { ...holder, appliedEffects: [curseEffect()] };
      const definitions = definitionsOf(
        new Map([
          [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
          [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
        ]),
        new Map(),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        [enemy, holderWithEffect],
      );

      const hit1 = hitEvent(recorder, turnStarted, enemy);
      const units = runtime.onFactEvent(hit1, [enemy, holderWithEffect]);
      const updatedHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;

      const initialSnapshot: BattleStateSnapshot = {
        status: "RUNNING",
        currentTurn: 1,
        units: {
          [holder.battleUnitId]: {
            hp: holder.currentHp,
            ap: holder.currentAp,
            pp: holder.currentPp,
            extraGauge: holder.currentExtraGauge,
            combatStats: holder.combatStats,
            effects: [
              {
                effectInstanceId: curseEffect().effectInstanceId,
                effectDefinitionId: effectActionDefinitionId,
                sourceUnitId: enemy.battleUnitId,
                kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
                duplicate: true,
                isEffective: true,
                magnitude: 0,
                appliedTurnNumber: 1,
                counters: {},
              },
            ],
          },
        },
      };

      const runtimeCounterChanged = recorder
        .getEvents()
        .find((e) => e.eventType === "RuntimeCounterChanged")!;
      const restored = applyStateDelta(initialSnapshot, runtimeCounterChanged.stateDelta!);

      expect(restored.units[holder.battleUnitId]?.effects?.[0]?.counters).toEqual({
        [hitCounterId]: 1,
      });
      expect(updatedHolder.appliedEffects[0]!.duration.counters).toEqual({
        [hitCounterId]: { value: 1, carry: 0 },
      });
    });

    it("UT-R-EFF-11-017 (PR #211 review [P1]): a DamageApplied event caused by a PS's own EffectSequence (chain-internal, never reaches onFactEvent directly) still updates the target's AppliedEffect counter and its expiration.conditions", () => {
      const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_ATTACKER");
      const attackDamage = damageEffectAction("ACT_EFF_ATTACK_DAMAGE");
      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const attackSkill = passiveSkillOf("SKL_PS_ATTACK", {
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
              target: { kind: "BINDING", targetBindingId: enemyBindingId },
              actions: [{ effectActionDefinitionId: attackDamage.effectActionDefinitionId }],
            },
          ],
        },
      });
      const attacker = unit("ATTACKER", "ALLY", {
        unitDefinitionId: attackerUnitDefinitionId,
        currentPp: 3,
        attack: 100,
      });
      const holderWithEffect = {
        ...unit("HOLDER", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId, maximumHp: 1000 }),
        appliedEffects: [curseEffect(1)],
      };
      const definitions = definitionsOf(
        new Map([
          [
            attackerUnitDefinitionId,
            unitDefinitionOf(attackerUnitDefinitionId, [attackSkill.skillDefinitionId]),
          ],
          [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
        ]),
        new Map([[attackSkill.skillDefinitionId, attackSkill]]),
        new Map([[attackDamage.effectActionDefinitionId, attackDamage]]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        [attacker, holderWithEffect],
      );

      const units = runtime.onFactEvent(turnStarted, [attacker, holderWithEffect]);

      const events = recorder.getEvents();
      expect(events.some((e) => e.eventType === "DamageApplied")).toBe(true);
      const damageApplied = events.find((e) => e.eventType === "DamageApplied")!;
      const runtimeCounterChangedEvents = events.filter(
        (e) => e.eventType === "RuntimeCounterChanged",
      );
      expect(runtimeCounterChangedEvents).toHaveLength(1);
      const runtimeCounterChanged = runtimeCounterChangedEvents[0]!;
      expect(runtimeCounterChanged.payload).toMatchObject({
        scope: "APPLIED_EFFECT",
        counter: hitCounterId,
        effectInstanceId: curseEffect().effectInstanceId,
        before: 0,
        after: 1,
      });
      expect(runtimeCounterChanged.parentEventId).toBe(damageApplied.eventId);
      // PR #211レビュー[P2]: 原因イベント（PS自身のEffectSequenceが発行した
      // DamageApplied）が持つskillUseIdをRuntimeCounterChangedへ引き継ぐこと —
      // 「同じSkillUse解決に属するイベントは同じskillUseIdを持つ」不変条件。
      expect(damageApplied.skillUseId).toBeDefined();
      expect(runtimeCounterChanged.skillUseId).toBe(damageApplied.skillUseId);

      const updatedHolder = units.find((u) => u.battleUnitId === "HOLDER")!;
      expect(updatedHolder.appliedEffects).toHaveLength(0);
      const expired = events.find((e) => e.eventType === "EffectExpired");
      expect(expired).toBeDefined();
    });

    it("UT-R-EFF-11-018 (PR #211 review [P1]): a DurationDefinition.counterUpdates that re-triggers itself from the RuntimeCounterChanged it causes, entirely inside the PS-chain-internal path (never reaching onFactEvent), throws a deterministic ExecutionGuardExceededError instead of recursing forever", () => {
      const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_SELF_REGEN_ATTACKER");
      const attackDamage = damageEffectAction("ACT_EFF_SELF_REGEN_ATTACK_DAMAGE");
      const enemyBindingId = createTargetBindingId("TGT_ENEMY_SELF_REGEN");
      const attackSkill = passiveSkillOf("SKL_PS_SELF_REGEN_ATTACK", {
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
              target: { kind: "BINDING", targetBindingId: enemyBindingId },
              actions: [{ effectActionDefinitionId: attackDamage.effectActionDefinitionId }],
            },
          ],
        },
      });
      const attacker = unit("ATTACKER", "ALLY", {
        unitDefinitionId: attackerUnitDefinitionId,
        currentPp: 3,
        attack: 100,
      });
      const selfRegenCounterId = createRuntimeCounterId("RUNTIME_COUNTER_EFF_SELF_REGEN");
      const selfRegenEffectActionDefinitionId = createEffectActionDefinitionId(
        "ACT_EFF_SELF_REGEN_CURSE",
      );
      const selfRegenEffect: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("effect-self-regen"),
        effectActionDefinitionId: selfRegenEffectActionDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(selfRegenEffectActionDefinitionId),
        duplicate: true,
        sourceId: createBattleUnitId("ATTACKER"),
        targetId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: null,
            counterUpdates: [
              {
                kind: "INCREMENT",
                counter: selfRegenCounterId,
                scope: "APPLIED_EFFECT",
                trigger: {
                  eventType: "DamageApplied",
                  category: "FACT",
                  sourceSelector: "ENEMY",
                  targetSelector: "SELF",
                  condition: { kind: "TRUE" },
                },
                amount: 1,
              },
              {
                // このcounterの再更新契機が、自身の変化で発行される
                // `RuntimeCounterChanged`自身になっている（誤ったCatalog定義）。
                // PS自身のEffectSequenceが発行した`DamageApplied`（chain内部、
                // `onFactEvent`を経由しない）から誘発されるため、`onFactEvent`の
                // `counterUpdateDepth`は一切増加しない — `resolveEvent`自身の
                // 再帰専用ガード（`ChainState.effectRuntimeCounterDepth`）が
                // 正しく機能しなければ、この再帰は無限に続く。
                kind: "INCREMENT",
                counter: selfRegenCounterId,
                scope: "APPLIED_EFFECT",
                trigger: {
                  eventType: "RuntimeCounterChanged",
                  category: "FACT",
                  sourceSelector: "ANY",
                  targetSelector: "ANY",
                  condition: {
                    kind: "EVENT_PAYLOAD",
                    field: "counter",
                    op: "EQ",
                    value: selfRegenCounterId,
                  },
                },
                amount: 1,
              },
            ],
          },
          counters: {},
        },
        appliedTurnNumber: 1,
      };
      const holderWithEffect = {
        ...unit("HOLDER", "ENEMY", {
          unitDefinitionId: enemyUnitDefinitionId,
          maximumHp: 1000,
        }),
        appliedEffects: [selfRegenEffect],
      };
      const definitions = definitionsOf(
        new Map([
          [
            attackerUnitDefinitionId,
            unitDefinitionOf(attackerUnitDefinitionId, [attackSkill.skillDefinitionId]),
          ],
          [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
        ]),
        new Map([[attackSkill.skillDefinitionId, attackSkill]]),
        new Map([[attackDamage.effectActionDefinitionId, attackDamage]]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      // A small maxEffectRuntimeCounterDepth keeps this test fast and
      // deterministic instead of looping many rounds before failing.
      const context: PassiveActivationRuntimeContext = {
        ...contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        limits: { ...DEFAULT_PASSIVE_CHAIN_LIMITS, maxEffectRuntimeCounterDepth: 3 },
      };
      const runtime = new PassiveActivationRuntime(context, [attacker, holderWithEffect]);

      let caught: unknown;
      try {
        runtime.onFactEvent(turnStarted, [attacker, holderWithEffect]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExecutionGuardExceededError);
    });

    it("UT-R-EFF-11-019 (PR #211 review [P1]): a second AppliedEffect counter that matches the same causing event is applied against state updated by the first counter's own candidate chain, not a stale pre-computed value", () => {
      const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
      const counterA = createRuntimeCounterId("RUNTIME_COUNTER_EFF_RACE_A");
      const counterB = createRuntimeCounterId("RUNTIME_COUNTER_EFF_RACE_B");
      const effectA: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("effect-race-a"),
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_EFF_RACE_A"),
        kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_EFF_RACE_A")),
        duplicate: true,
        sourceId: enemy.battleUnitId,
        targetId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: null,
            counterUpdates: [
              {
                kind: "INCREMENT",
                counter: counterA,
                scope: "APPLIED_EFFECT",
                trigger: {
                  eventType: "DamageApplied",
                  category: "FACT",
                  sourceSelector: "ENEMY",
                  targetSelector: "SELF",
                  condition: { kind: "TRUE" },
                },
                amount: 1,
              },
            ],
          },
          counters: {},
        },
        appliedTurnNumber: 1,
      };
      // レビュー再指摘[P1]の再現: `effectB`はDamageAppliedへ直接一致するcounterB
      // 更新（+1）に加えて、`effectA`のRuntimeCounterChanged（counterA）に反応して
      // "横から"counterBを大きく書き換える2件目のcounterUpdatesを持つ。修正前は
      // DamageApplied起点で一括計算したcounterBのbefore/after(0->1)を使っていた
      // ため、この横からの書き換え(0->10)を上書きしてしまっていた。
      const effectB: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("effect-race-b"),
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_EFF_RACE_B"),
        kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_EFF_RACE_B")),
        duplicate: true,
        sourceId: enemy.battleUnitId,
        targetId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: null,
            counterUpdates: [
              {
                kind: "INCREMENT",
                counter: counterB,
                scope: "APPLIED_EFFECT",
                trigger: {
                  eventType: "DamageApplied",
                  category: "FACT",
                  sourceSelector: "ENEMY",
                  targetSelector: "SELF",
                  condition: { kind: "TRUE" },
                },
                amount: 1,
              },
              {
                kind: "INCREMENT",
                counter: counterB,
                scope: "APPLIED_EFFECT",
                trigger: {
                  eventType: "RuntimeCounterChanged",
                  category: "FACT",
                  sourceSelector: "SELF",
                  targetSelector: "ANY",
                  condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterA },
                },
                amount: 10,
              },
            ],
          },
          counters: {},
        },
        appliedTurnNumber: 1,
      };
      const holderWithEffects = {
        ...unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId }),
        appliedEffects: [effectA, effectB],
      };
      const definitions = definitionsOf(
        new Map([
          [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
          [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
        ]),
        new Map(),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        [enemy, holderWithEffects],
      );

      const hit1 = hitEvent(recorder, turnStarted, enemy);
      runtime.onFactEvent(hit1, [enemy, holderWithEffects]);

      const counterBChanges = recorder
        .getEvents()
        .filter((e) => e.eventType === "RuntimeCounterChanged" && e.payload.counter === counterB);
      // First: effectB's RuntimeCounterChanged-triggered "side" write (0 -> 10),
      // resolved as part of counterA's own candidate chain. Second: effectB's
      // DamageApplied-triggered entry, applied against the now-current state
      // (10 -> 11) once the outer loop reaches it — not the stale
      // pre-computed (0 -> 1) snapshot taken before the side write ran.
      expect(counterBChanges.map((e) => e.payload)).toMatchObject([
        { before: 0, after: 10 },
        { before: 10, after: 11 },
      ]);
    });
  });
});
