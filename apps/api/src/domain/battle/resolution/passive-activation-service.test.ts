import { describe, expect, it } from "vitest";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createActionId,
  createEffectInstanceId,
  createSkillUseId,
} from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { applyStateDelta } from "../events/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../lifecycle/battle-state-snapshot.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";
import {
  contextOf,
  damageEffectAction,
  definitionsOf,
  passiveSkillOf,
  recordTurnStarted,
  statusEffectAction,
  unit,
  unitDefinitionOf,
} from "../../../testing/fixtures/passive-activation-runtime.js";

describe("PassiveActivationRuntime.onFactEvent", () => {
  it("UT-R-PS-05-001 [R-ACT-03, R-PS-05]: consumes PP, increases the EX gauge by the same amount, sets the cooldown, and emits PassiveActivated with correct before/after values in order", () => {
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

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

    // PSも一つのSkillUseのため、この発動に属する全イベント
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

  it("UT-R-PS-05-002 [R-ACT-03, R-PS-05]: clamps the EX gain at the max and emits ExtraGaugeOverflowDiscarded with the requested/actual/discarded split", () => {
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

    expect(updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentExtraGauge).toBe(
      10,
    );

    const overflow = recorder
      .getEvents()
      .find((e) => e.eventType === "ExtraGaugeOverflowDiscarded")!;
    expect(overflow.payload).toEqual({
      battleUnitId: owner.battleUnitId,
      baseDelta: 3,
      requestedAmount: 3,
      actualAmount: 2,
      discardedAmount: 1,
    });
  });

  it("UT-R-PS-01-133 (TRIGGER_EXCLUSION_TIMING): PassiveActivationRuntimeContext.resolutionPhase reaches candidate detection AND reconfirmation, excluding a RESOLUTION_PHASE(negate: true)-gated PS only when the context's resolutionPhase matches", () => {
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
    const excludedUnits = excludedRuntime.onFactEvent(excludedTurnStarted, [owner]).units;
    expect(excludedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(3);
    expect(excludedRecorder.getEvents().map((e) => e.eventType)).toEqual(["TurnStarted"]);

    const includedRecorder = new EventRecorder(createBattleId("B_2"));
    const includedTurnStarted = recordTurnStarted(includedRecorder);
    const includedRuntime = new PassiveActivationRuntime(
      contextOf(includedRecorder, definitions, includedTurnStarted, createActionId("B_2:action:1")),
      [owner],
    );
    const includedUnits = includedRuntime.onFactEvent(includedTurnStarted, [owner]).units;
    expect(includedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(1);
    expect(includedRecorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it('UT-R-PS-01-036: PassiveActivationRuntimeContext.resolutionPhase: "BATTLE_START" reaches candidate detection AND reconfirmation, activating a RESOLUTION_PHASE("BATTLE_START", negate: false)-gated PS — the same mechanism already proven for "TURN_START"/"TURN_END", verified here independently of `startBattle`\'s real BattleUnit resource state (Q-BTL-05 forbids a 0-cost PS, and `createBattleUnit`/READY→RUNNING never grants PP before this point — see battle.test.ts, which correctly asserts this candidate can never actually activate through the real creation path)', () => {
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
    const units = runtime.onFactEvent(battleStarted, [owner]).units;
    expect(units.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(0);
    expect(recorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it("UT-R-PS-01-053 (RES-004): PassiveActivationRuntimeContext.turnNumber reaches candidate detection AND reconfirmation for a TURN_NUMBER-gated PS", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill: SkillDefinition = {
      ...passiveSkillOf("SKL_PS", { ppCost: 1 }),
      activationCondition: { kind: "TURN_NUMBER", op: "NEQ", value: 1 },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 1, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
    );

    const excludedRecorder = new EventRecorder(createBattleId("B_1"));
    const excludedTurnStarted = recordTurnStarted(excludedRecorder);
    const excludedRuntime = new PassiveActivationRuntime(
      contextOf(excludedRecorder, definitions, excludedTurnStarted, undefined, undefined, 1),
      [owner],
    );
    const excludedUnits = excludedRuntime.onFactEvent(excludedTurnStarted, [owner]).units;
    expect(excludedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(1);
    expect(excludedRecorder.getEvents().map((e) => e.eventType)).not.toContain("PassiveActivated");

    const includedRecorder = new EventRecorder(createBattleId("B_2"));
    const includedTurnStarted = recordTurnStarted(includedRecorder);
    const includedRuntime = new PassiveActivationRuntime(
      contextOf(includedRecorder, definitions, includedTurnStarted, undefined, undefined, 2),
      [owner],
    );
    const includedUnits = includedRuntime.onFactEvent(includedTurnStarted, [owner]).units;
    expect(includedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(0);
    expect(includedRecorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it("UT-R-PS-01-054 (RES-004): the current unit roster reaches candidate detection AND reconfirmation for an ALIVE_UNIT_COUNT-gated PS", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const allyDefinitionId = createUnitDefinitionId("UNIT_ALLY");
    const skill: SkillDefinition = {
      ...passiveSkillOf("SKL_PS", { ppCost: 1 }),
      activationCondition: {
        kind: "ALIVE_UNIT_COUNT",
        side: "ALLY",
        excludeSelf: true,
        op: "GT",
        value: 0,
      },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 1, maximumPp: 3 });
    const ally = unit("ALLY_1", "ALLY", { unitDefinitionId: allyDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        [allyDefinitionId, unitDefinitionOf(allyDefinitionId, [])],
      ]),
      new Map([[skill.skillDefinitionId, skill]]),
    );

    const excludedRecorder = new EventRecorder(createBattleId("B_1"));
    const excludedTurnStarted = recordTurnStarted(excludedRecorder);
    const excludedRuntime = new PassiveActivationRuntime(
      contextOf(excludedRecorder, definitions, excludedTurnStarted),
      [owner],
    );
    const excludedUnits = excludedRuntime.onFactEvent(excludedTurnStarted, [owner]).units;
    expect(excludedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(1);
    expect(excludedRecorder.getEvents().map((e) => e.eventType)).not.toContain("PassiveActivated");

    const includedRecorder = new EventRecorder(createBattleId("B_2"));
    const includedTurnStarted = recordTurnStarted(includedRecorder);
    const includedRuntime = new PassiveActivationRuntime(
      contextOf(includedRecorder, definitions, includedTurnStarted),
      [owner, ally],
    );
    const includedUnits = includedRuntime.onFactEvent(includedTurnStarted, [owner, ally]).units;
    expect(includedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(0);
    expect(includedRecorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it("UT-R-PS-04-012 (review fix): a POSITION_RELATION-gated PS whose event references a target absent from the roster is discarded deterministically at reconfirmation, not thrown", () => {
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

  it("UT-R-SKL-01-005: when the PS owner is defeated partway through its own EffectSequence, the remaining step is skipped and PassiveInterrupted is emitted instead of PassiveResolved", () => {
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner, enemy]).units;

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

  it("a PS triggered from a turn-boundary event (no actionId, e.g. TurnStarted) can still resolve real EffectSequence steps instead of throwing", () => {
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
      updatedUnits = runtime.onFactEvent(turnStarted, [owner, enemy]).units;
    }).not.toThrow();

    const updatedEnemy = updatedUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.currentHp).toBeLessThan(100);
    expect(recorder.getEvents().some((e) => e.eventType === "DamageApplied")).toBe(true);
  });

  it("a PS triggered from a turn-boundary event with a positive ACTION-unit cooldown does not throw, and the cooldown decrements at the owner's next own action", () => {
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
      updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;
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
    // `establishesScope`はその「設定scopeなし」を独立Reducerへ
    // 明示するための印であり、これが無いと復元側は不在を「省略」と読み違えて
    // 直前の`setActionId`を残してしまう。
    expect(cooldownStarted.stateDelta).toEqual({
      units: {
        [owner.battleUnitId]: {
          cooldowns: {
            [skill.skillDefinitionId]: {
              unit: "ACTION",
              before: 0,
              after: 2,
              establishesScope: true,
            },
          },
        },
      },
    });
  });

  it("UT-R-PS-04-016 (integration): a PS candidate without enough PP is silently skipped (no PassiveActivated), leaving resources untouched", () => {
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

    expect(updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp).toBe(1);
    expect(recorder.getEvents().some((e) => e.eventType === "PassiveActivated")).toBe(false);
  });

  it("UT-R-ATM-01-004: when a PS's own EffectSequence has two EffectActions and the first triggers a child PS, the child is held back until the parent's whole effect processing finished (親A→親B→PassiveResolved→子PS)", () => {
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionA.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionB.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: 任意の`EffectActionCompleted`に反応する（R-PS-07の1解決スコープ1回
    // guardにより、実際に発動するのは最初に検出した1件だけ — 親のaction A由来の
    // ものになる。R-ATM-01により、その候補は検出だけ即時に行われ、発動は親の
    // 効果処理が完了して`PassiveResolved`を発行した後になる）。
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
    // R-ATM-01: 子の効果処理は親の効果処理の**後**に来る。
    expect(actionCompletedEvents.map((e) => e.payload.effectActionDefinitionId)).toEqual([
      actionA.effectActionDefinitionId,
      actionB.effectActionDefinitionId,
      childAction.effectActionDefinitionId,
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
    const parentResolvedIndex = events.findIndex(
      (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === parentOwner.battleUnitId,
    );
    expect(childPassiveActivatedIndex).toBeGreaterThan(actionACompletedIndex);
    // R-ATM-02 #3: 保留候補の発動は完了イベント（`PassiveResolved`）の後。
    expect(actionBStartingIndex).toBeLessThan(parentResolvedIndex);
    expect(childPassiveActivatedIndex).toBeGreaterThan(parentResolvedIndex);

    // 子PSは1解決スコープ1回のため、親のaction B由来のEffectActionCompletedや
    // 自分自身のchildAction由来のEffectActionCompletedでは再発動しない。
    const childPassiveActivatedEvents = events.filter(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    expect(childPassiveActivatedEvents).toHaveLength(1);
  });

  it("UT-R-ATM-01-005: a child PS triggered by DamageApplied (the DAMAGE action's own internal event, not EffectActionCompleted) is detected there but only activates after the parent's whole effect processing", () => {
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionA.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: actionB.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: `DamageApplied`（DAMAGE適用が内部で発行するイベントそのもの）に
    // 反応する。`EffectActionCompleted`ではなく、これより前に発行される内部
    // イベントを契機にしても、親のaction Bより前に解決されることを確認する
    // （回帰: generator化でEFFECT_RESOLVEDが
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
    // 親のaction A・親のaction B・子のchildActionの3件のDamageAppliedが発行される。
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
    const parentResolvedIndex = events.findIndex(
      (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === parentOwner.battleUnitId,
    );
    // R-ATM-01: `DamageApplied`の候補は検出されるが、発動は親の効果処理完了後。
    expect(actionBStartingIndex).toBeGreaterThan(actionADamageAppliedIndex);
    expect(actionBStartingIndex).toBeLessThan(parentResolvedIndex);
    expect(childPassiveActivatedIndex).toBeGreaterThan(parentResolvedIndex);

    const childPassiveActivatedEvents = events.filter(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    expect(childPassiveActivatedEvents).toHaveLength(1);
  });

  it("UT-R-EFF-09-030 [R-ATM-01, R-EFF-09]: a PS's own DAMAGE action against a frozen target with a linked-group sibling records the cascade's EffectExpired before FreezeRemoved (R-EFF-09 detection granularity), while the reacting child PS activates only after the parent's effect processing (R-ATM-01)", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_FREEZE");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD_REACT");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_FROZEN");
    const parentDamage = damageEffectAction("ACT_PARENT_FREEZE_DAMAGE");
    const linkStatMod: EffectActionDefinition = {
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_LINK_SIBLING"),
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0.2 },
        stacking: { mode: "STACKABLE", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      metadata: { tags: [] },
    };
    const enemyBindingId = createTargetBindingId("TGT_FROZEN_ENEMY");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT_FREEZE_DAMAGE"),
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: parentDamage.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: linkedEffectGroupカスケードで失効するsiblingの`EffectExpired`に
    // 反応する。凍結解除カスケードが個別に`yield`されていれば、この
    // `PassiveActivated`は`FreezeRemoved`より前に記録されるはず — まとめて
    // 最後に処理されるとこの順序が逆転する（回帰チェック）。
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD_REACT_TO_EXPIRY"),
      triggers: [
        {
          eventType: "EffectExpired",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
    };

    const parentOwner = unit("PARENT", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      attack: 30,
      currentPp: 3,
    });
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      currentPp: 3,
    });
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const siblingEffectId = createEffectInstanceId("sibling-1");
    const enemyBase = unit("ENEMY", "ENEMY", {
      unitDefinitionId: enemyUnitDefinitionId,
      defense: 10,
      currentHp: 100,
      maximumHp: 100,
    });
    const linkedDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: "GROUP_A",
    };
    const enemy: BattleUnit = {
      ...enemyBase,
      // Simulate the sibling's +20% ATTACK already contributing to
      // `combatStats` (as `grantEffect`/`recalculateCombatStats` would have
      // left it: 10 * 1.2 = 12), so its cascade removal produces a
      // detectable `before !== after` CombatStatChanged.
      combatStats: { ...enemyBase.combatStats, attack: 12 },
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceUnitId: parentOwner.battleUnitId,
          targetUnitId: enemyBase.battleUnitId,
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: { definition: linkedDuration },
          appliedTurnNumber: 1,
        },
        {
          effectInstanceId: siblingEffectId,
          effectActionDefinitionId: linkStatMod.effectActionDefinitionId,
          kindKey: effectKindKeyFromDefinitionId(linkStatMod.effectActionDefinitionId),
          duplicate: true,
          sourceUnitId: enemyBase.battleUnitId,
          targetUnitId: enemyBase.battleUnitId,
          magnitude: 0.2,
          categories: ["BUFF"],
          duration: { definition: linkedDuration },
          appliedTurnNumber: 1,
        },
      ],
    };

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
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map([
        [parentDamage.effectActionDefinitionId, parentDamage],
        [linkStatMod.effectActionDefinitionId, linkStatMod],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner, enemy],
    );

    const result = runtime.onFactEvent(turnStarted, [parentOwner, childOwner, enemy]);

    const updatedEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.appliedEffects).toHaveLength(0);
    expect(updatedEnemy.combatStats.attack).toBe(10);

    const events = recorder.getEvents();
    const cascadeExpired = events.find(
      (e) => e.eventType === "EffectExpired" && e.payload.effectInstanceId === siblingEffectId,
    );
    const freezeRemoved = events.find((e) => e.eventType === "FreezeRemoved");
    const childPassiveActivated = events.find(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    expect(cascadeExpired).toBeDefined();
    expect(freezeRemoved).toBeDefined();
    expect(childPassiveActivated).toBeDefined();
    expect(events.indexOf(cascadeExpired!)).toBeLessThan(events.indexOf(freezeRemoved!));
    // 中核となる回帰チェック: 子PSの候補はEffectExpired（カスケードの子）の発行
    // 時点で検出されるが、R-ATM-01により発動は親PSの効果処理が完了して
    // `PassiveResolved`を発行した後になる（EffectExpiredの通知粒度そのものは
    // 上のcascadeExpired→freezeRemovedの順で担保される）。
    const parentResolved = events.find(
      (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === parentOwner.battleUnitId,
    );
    expect(parentResolved).toBeDefined();
    expect(events.indexOf(freezeRemoved!)).toBeLessThan(events.indexOf(parentResolved!));
    expect(events.indexOf(childPassiveActivated!)).toBeGreaterThan(events.indexOf(parentResolved!));
  });

  it("PS-own DAMAGE against a frozen target still notifies the pre-cascade FACT events (HitConfirmed) — they are not silently dropped once the freeze-removal cascade starts yielding", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_HITCONFIRMED");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD_HITCONFIRMED");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_HITCONFIRMED");
    const parentDamage = damageEffectAction("ACT_PARENT_HITCONFIRMED_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_HITCONFIRMED_ENEMY");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT_HITCONFIRMED"),
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: parentDamage.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: 凍結解除カスケードが始まる前（`DamageCalculated`より前）に記録
    // 済みの`HitConfirmed`に反応する。この時点はまだ凍結除去のyieldループが
    // 一度も回っていないため、`innerEventsStart`を不用意に進めてしまうと
    // このイベントが取りこぼされ、この子PSが一切発動しなくなる
    // （回帰チェック）。
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD_HITCONFIRMED"),
      triggers: [
        {
          eventType: "HitConfirmed",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
    };

    const parentOwner = unit("PARENT", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      attack: 30,
      currentPp: 3,
    });
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      currentPp: 3,
    });
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const enemy: BattleUnit = {
      ...unit("ENEMY", "ENEMY", {
        unitDefinitionId: enemyUnitDefinitionId,
        defense: 10,
        currentHp: 100,
        maximumHp: 100,
      }),
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceUnitId: parentOwner.battleUnitId,
          targetUnitId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        },
      ],
    };

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
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map([[parentDamage.effectActionDefinitionId, parentDamage]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner, enemy],
    );

    runtime.onFactEvent(turnStarted, [parentOwner, childOwner, enemy]);

    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "HitConfirmed")).toBe(true);
    const childPassiveActivated = events.find(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === childOwner.battleUnitId,
    );
    expect(childPassiveActivated).toBeDefined();
  });

  it("a child PS reacting to FreezeRemoved that defeats the target before this hit's own HP application does not cause a duplicate UnitDefeated", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_DEFEAT");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD_DEFEAT");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_DEFEAT");
    const parentDamage = damageEffectAction("ACT_PARENT_DEFEAT_DAMAGE");
    const childDamage = damageEffectAction("ACT_CHILD_DEFEAT_DAMAGE");
    const parentEnemyBindingId = createTargetBindingId("TGT_DEFEAT_ENEMY_PARENT");
    const childEnemyBindingId = createTargetBindingId("TGT_DEFEAT_ENEMY_CHILD");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT_DEFEAT"),
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: parentEnemyBindingId,
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
            target: { kind: "BINDING", targetBindingId: parentEnemyBindingId },
            actions: [{ effectActionDefinitionId: parentDamage.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: `FreezeRemoved`（凍結解除カスケードの最後）に反応し、致死ダメージを
    // 与えて対象を戦闘不能にする — 親自身のこのヒットのHP適用より前。
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD_DEFEAT"),
      triggers: [
        {
          eventType: "FreezeRemoved",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: childEnemyBindingId,
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
            target: { kind: "BINDING", targetBindingId: childEnemyBindingId },
            actions: [{ effectActionDefinitionId: childDamage.effectActionDefinitionId }],
          },
        ],
      },
    };

    const parentOwner = unit("PARENT", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      attack: 15,
      currentPp: 3,
    });
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      attack: 999,
      currentPp: 3,
    });
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const enemy: BattleUnit = {
      ...unit("ENEMY", "ENEMY", {
        unitDefinitionId: enemyUnitDefinitionId,
        defense: 0,
        currentHp: 10,
        maximumHp: 10,
      }),
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceUnitId: parentOwner.battleUnitId,
          targetUnitId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        },
      ],
    };

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
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map([
        [parentDamage.effectActionDefinitionId, parentDamage],
        [childDamage.effectActionDefinitionId, childDamage],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner, enemy],
    );

    const result = runtime.onFactEvent(turnStarted, [parentOwner, childOwner, enemy]);

    const updatedEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.currentHp).toBe(0);

    const unitDefeatedEvents = recorder.getEvents().filter((e) => e.eventType === "UnitDefeated");
    expect(unitDefeatedEvents).toHaveLength(1);
  });

  it("UT-R-DMG-05-006 (R-DMG-05 #4): inside a PS's OWN EffectSequence (no onFactEventForPassiveChain), a child PS reacting to DamageWillBeApplied that defeats the target cancels the parent's hit — the TIMING event's chain resolves before damage calculation, not after the hit completed", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_WBA");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD_WBA");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_WBA");
    const parentDamage = damageEffectAction("ACT_PARENT_WBA_DAMAGE");
    const childDamage = damageEffectAction("ACT_CHILD_WBA_DAMAGE");
    const parentEnemyBindingId = createTargetBindingId("TGT_WBA_ENEMY_PARENT");
    const childEnemyBindingId = createTargetBindingId("TGT_WBA_ENEMY_CHILD");

    const parentSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PARENT_WBA"),
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: parentEnemyBindingId,
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
            target: { kind: "BINDING", targetBindingId: parentEnemyBindingId },
            actions: [{ effectActionDefinitionId: parentDamage.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 子PS: 親のヒットの`DamageWillBeApplied`（R-DMG-05 #4のTIMINGイベント）に
    // 反応し、致死ダメージで対象を戦闘不能にする。親のこのヒットは、
    // 「TIMINGイベント後の再検証」に従って取り消されなければならない。
    const childSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_CHILD_WBA"),
      triggers: [
        {
          eventType: "DamageWillBeApplied",
          category: "TIMING",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: childEnemyBindingId,
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
            target: { kind: "BINDING", targetBindingId: childEnemyBindingId },
            actions: [{ effectActionDefinitionId: childDamage.effectActionDefinitionId }],
          },
        ],
      },
    };

    const parentOwner = unit("PARENT", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      attack: 15,
      currentPp: 3,
    });
    const childOwner = unit("CHILD", "ALLY", {
      unitDefinitionId: childUnitDefinitionId,
      attack: 999,
      currentPp: 3,
    });
    const enemy = unit("ENEMY", "ENEMY", {
      unitDefinitionId: enemyUnitDefinitionId,
      defense: 0,
      currentHp: 10,
      maximumHp: 10,
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
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([
        [parentSkill.skillDefinitionId, parentSkill],
        [childSkill.skillDefinitionId, childSkill],
      ]),
      new Map([
        [parentDamage.effectActionDefinitionId, parentDamage],
        [childDamage.effectActionDefinitionId, childDamage],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [parentOwner, childOwner, enemy],
    );

    const result = runtime.onFactEvent(turnStarted, [parentOwner, childOwner, enemy]);

    const events = recorder.getEvents();
    const actionIdOf = (eventType: string): string[] =>
      events
        .filter((event) => event.eventType === eventType)
        .map(
          (event) =>
            (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ?? "",
        );

    // 親のヒットは`DamageWillBeApplied`まで到達している。
    expect(actionIdOf("DamageWillBeApplied")).toContain(parentDamage.effectActionDefinitionId);
    // が、その連鎖が対象を倒したため、親のダメージ計算・適用は起きない。
    expect(actionIdOf("DamageCalculated")).toEqual([childDamage.effectActionDefinitionId]);
    expect(actionIdOf("DamageApplied")).toEqual([childDamage.effectActionDefinitionId]);
    expect(events.filter((event) => event.eventType === "UnitDefeated")).toHaveLength(1);

    const updatedEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.currentHp).toBe(0);
  });

  it("UT-R-ATM-01-006: a child PS triggered by CooldownReduced (a COOLDOWN_MANIPULATION action's own internal event) is detected there but only activates after the parent's whole effect processing", () => {
    const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT");
    const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD");
    const targetSkillId = createSkillDefinitionId("SKL_ON_COOLDOWN");
    const resetAction: EffectActionDefinition = {
      kind: "COOLDOWN_MANIPULATION",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_RESET"),
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: resetAction.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
    const parentResolvedIndex = events.findIndex(
      (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === parentOwner.battleUnitId,
    );
    // R-ATM-01: `CooldownReduced`の候補は検出されるが、発動は親の効果処理完了後。
    expect(actionBStartingIndex).toBeGreaterThan(cooldownReducedIndex);
    expect(actionBStartingIndex).toBeLessThan(parentResolvedIndex);
    expect(childPassiveActivatedIndex).toBeGreaterThan(parentResolvedIndex);
  });

  it("UT-R-EFF-11-001 (RuntimeCounter): updates the counter and emits RuntimeCounterChanged before the causing event's own PS candidates are resolved, so a modulo-gated PS only activates once the counter reaches a multiple", () => {
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
    let units = runtime.onFactEvent(crit1, [owner]).units;
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
    units = runtime.onFactEvent(crit2, units).units;
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

  it("UT-R-EFF-11-028 (Issue #553, RESET): a RESET triggered by the PS's own PassiveActivated returns the counter to 0 before that PS's EffectSequence resolves, and the next INCREMENT counts up from 0 again", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_RESET_OWNER");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_CRIT");
    const skillDefinitionId = createSkillDefinitionId("SKL_PS_RESET");
    const buffAction = statusEffectAction("ACT_PS_RESET_BUFF", 1);
    const critTrigger = {
      eventType: "CriticalCheckResolved",
      category: "FACT",
      sourceSelector: "SELF",
      targetSelector: "ANY",
      condition: { kind: "TRUE" },
    } as const;
    const skill: SkillDefinition = {
      skillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          ...critTrigger,
          condition: { kind: "RUNTIME_COUNTER", counter: counterId, op: "EQ", value: 2 },
        },
      ],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: critTrigger,
          amount: 1,
        },
        {
          kind: "RESET",
          counter: counterId,
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
              value: skillDefinitionId,
            },
          },
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: buffAction.effectActionDefinitionId }],
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
      metadata: { displayName: "SKL_PS_RESET", tags: [] },
    };
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3, maximumPp: 3 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skillDefinitionId])]]),
      new Map([[skillDefinitionId, skill]]),
      new Map([[buffAction.effectActionDefinitionId, buffAction]]),
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

    let units = runtime.onFactEvent(recordCrit(), [owner]).units;
    units = runtime.onFactEvent(recordCrit(), units).units;

    const events = recorder.getEvents();
    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated).toBeDefined();
    const resetChanged = events.find(
      (e) => e.eventType === "RuntimeCounterChanged" && e.payload.after === 0,
    )!;
    expect(resetChanged, "the RESET must emit RuntimeCounterChanged(after: 0)").toBeDefined();
    expect(resetChanged.payload).toMatchObject({
      ownerUnitId: owner.battleUnitId,
      scope: "SKILL_RUNTIME",
      counter: counterId,
      skillDefinitionId,
      before: 2,
      after: 0,
      carry: 0,
      valueChanged: true,
    });
    // R-PS-05 #4→#5: `PassiveActivated`の直後・そのPSのEffectSequence解決の前。
    const effectActionStarting = events.find((e) => e.eventType === "EffectActionStarting")!;
    expect(resetChanged.sequence).toBeGreaterThan(passiveActivated.sequence);
    expect(resetChanged.sequence).toBeLessThan(effectActionStarting.sequence);
    // `RuntimeCounterReset`（解決スコープ終了時の破棄）は使わない — キーは値0で残る。
    expect(events.some((e) => e.eventType === "RuntimeCounterReset")).toBe(false);
    expect(units.find((u) => u.battleUnitId === owner.battleUnitId)?.skillCounters).toEqual({
      [skillDefinitionId]: { [counterId]: { value: 0, carry: 0 } },
    });
    expect(resetChanged.stateDelta).toEqual({
      units: {
        [owner.battleUnitId]: {
          skillCounters: { [skillDefinitionId]: { [counterId]: { before: 2, after: 0 } } },
        },
      },
    });

    // `RuntimeCounterReset`（キー削除）と違い、独立Reducerの復元結果は実状態と
    // 同じく「キーは残り値が0」になる。
    const initialSnapshot: BattleStateSnapshot = {
      status: "RUNNING",
      currentTurn: 1,
      units: {
        [owner.battleUnitId]: {
          hp: owner.currentHp,
          ap: owner.currentAp,
          pp: owner.currentPp,
          extraGauge: owner.currentExtraGauge,
          maximumAp: owner.maximumAp,
          maximumPp: owner.maximumPp,
          maximumExtraGauge: owner.maximumExtraGauge,
          combatStats: owner.combatStats,
          baseCombatStats: owner.combatStats,
          skillCounters: { [skillDefinitionId]: { [counterId]: 2 } },
        },
      },
    };
    expect(
      applyStateDelta(initialSnapshot, resetChanged.stateDelta!).units[owner.battleUnitId]!
        .skillCounters,
    ).toEqual({ [skillDefinitionId]: { [counterId]: 0 } });

    // リセット後の`INCREMENT`は0起点で数え直す（余剰の繰り越しがない）。
    units = runtime.onFactEvent(recordCrit(), units).units;
    expect(units.find((u) => u.battleUnitId === owner.battleUnitId)?.skillCounters).toEqual({
      [skillDefinitionId]: { [counterId]: { value: 1, carry: 0 } },
    });
  });

  it("UT-R-PS-05-006 (fix: PassiveActivated now reaches PS candidate detection): a PS that activates causes another PS reacting to PassiveActivated to activate within the same resolution scope", () => {
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

  it("UT-R-PS-05-004 (review fix: PassiveActivated re-entry must not clobber the activation guard): a PS whose own trigger reacts to its own PassiveActivated activates exactly once per resolution scope (R-PS-07), not twice", () => {
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

  it("UT-R-EFF-11-002 (review fix): finalizeResolutionScope discards a resetScope: RESOLUTION_SCOPE counter and emits RuntimeCounterReset once the candidate stack is empty", () => {
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

    const afterEvent = runtime.onFactEvent(turnStarted, [owner]).units;
    const ownerAfterEvent = afterEvent.find((u) => u.battleUnitId === owner.battleUnitId);
    expect(ownerAfterEvent?.skillCounters).toEqual({
      [skill.skillDefinitionId]: { RUNTIME_COUNTER_SCOPED: { value: 1, carry: 0 } },
    });

    const { units: finalUnits, lastEventId } = runtime.finalizeResolutionScope(turnStarted.eventId);
    const ownerAfterFinalize = finalUnits.find((u) => u.battleUnitId === owner.battleUnitId);
    expect(ownerAfterFinalize?.skillCounters?.[skill.skillDefinitionId]).toEqual({});

    const reset = recorder.getEvents().find((e) => e.eventType === "RuntimeCounterReset")!;
    expect(reset).toBeDefined();
    expect(reset.parentEventId).toBe(turnStarted.eventId);
    // 呼び出し側が`recorder.getEvents()`の
    // 末尾を推測しなくても、この終了処理が発行した最後のイベントを明示的に
    // 得られる。
    expect(lastEventId).toBe(reset.eventId);
    expect(reset.payload).toMatchObject({
      ownerUnitId: owner.battleUnitId,
      scope: "SKILL_RUNTIME",
      counter: counterId,
      skillDefinitionId: skill.skillDefinitionId,
      before: 1,
    });
    // `after: 0`ではなく`undefined`（キー自体の削除）。
    expect(reset.stateDelta).toEqual({
      units: {
        [owner.battleUnitId]: {
          skillCounters: {
            [skill.skillDefinitionId]: { [counterId]: { before: 1, after: undefined } },
          },
        },
      },
    });

    // `reset.stateDelta`だけから独立Reducerで復元した
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
          maximumAp: owner.maximumAp,
          maximumPp: owner.maximumPp,
          maximumExtraGauge: owner.maximumExtraGauge,
          combatStats: owner.combatStats,
          baseCombatStats: owner.combatStats,
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
    runtime.finalizeResolutionScope(turnStarted.eventId);
    const resetEventsAfter = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterReset").length;
    expect(resetEventsAfter).toBe(resetEventsBefore);
  });

  it("UT-R-EFF-11-027 (#251 是正): finalizeResolutionScope returns the caller's own cursor unchanged when there is nothing to reset — the overwhelmingly common case, since most skills declare no resetScope: RESOLUTION_SCOPE counters — so callers can tell 'nothing happened' apart from 'something happened' instead of receiving a rootEventId that could wrongly roll back their own causal cursor", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_NO_RESET_OWNER");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_NO_RESET"),
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
      metadata: { displayName: "SKL_PS_NO_RESET", tags: [] },
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
    const { lastEventId } = runtime.finalizeResolutionScope(turnStarted.eventId);

    expect(recorder.getEvents().some((e) => e.eventType === "RuntimeCounterReset")).toBe(false);
    expect(lastEventId).toBe(turnStarted.eventId);
  });

  it("UT-R-EFF-11-003 (review re-fix): a resetScope counter whose own counterUpdates re-triggers on the RuntimeCounterReset it causes makes finalizeResolutionScope throw a deterministic error instead of looping forever", () => {
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

    expect(() => runtime.finalizeResolutionScope(turnStarted.eventId)).toThrow(
      /exceeded .* discard\/emit\/resolve rounds/,
    );
  });

  it("UT-R-EFF-11-004 (review re-re-fix): a hit that lands carry exactly on 0 (not via reset) still reconstructs to the same skillCounterCarry shape as the real state (key absent, not present with value 0) across sub-threshold -> exact-crossing -> resolution-scope reset", () => {
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
          // DMG-004（R-SHD-02/03）: シールド未所持の対象なので全量がHPへ向かう。
          hpDirectDamage: 0,
          typedShieldAbsorbed: 0,
          untypedShieldAbsorbed: 0,
          subUnitAbsorbed: 0,
          discardedDamage: 0,
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
          maximumAp: owner.maximumAp,
          maximumPp: owner.maximumPp,
          maximumExtraGauge: owner.maximumExtraGauge,
          combatStats: owner.combatStats,
          baseCombatStats: owner.combatStats,
        },
      },
    };
    let appliedEventCount = 0;
    // `?? {}`で個別フィールドを緩く比較するのでは
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
    // (`?? {}` previously masked `{}` vs "no key").
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
    runtime.finalizeResolutionScope(turnStarted.eventId);
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
      maximumAp: finalOwner.maximumAp,
      maximumPp: finalOwner.maximumPp,
      maximumExtraGauge: finalOwner.maximumExtraGauge,
      combatStats: finalOwner.combatStats,
      baseCombatStats: finalOwner.combatStats,
      skillCounters: { [skill.skillDefinitionId]: {} },
    });
  });

  it("review fix: PassiveResolved now reaches PS candidate detection, so another PS reacting to 'an ally's PS resolved' activates in the same resolution scope", () => {
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

  it("review fix: PassiveInterrupted now reaches PS candidate detection, so another unit's PS reacting to it activates", () => {
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
        // 打ち切られる(UT-R-SKL-01-005と同じ設定)。1段しかないと打ち切られる
        // 残り効果が0件になり`PassiveInterrupted`ではなく`PassiveResolved`が
        // 発行されてしまう。
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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

  it("review fix: multiple RuntimeCounter updates caused by the same event are applied one at a time — a PS reacting to the first RuntimeCounterChanged cannot observe a second counter's not-yet-emitted value", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_SEQUENTIAL_COUNTERS_OWNER");
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_SEQ_A");
    const counterB = createRuntimeCounterId("RUNTIME_COUNTER_SEQ_B");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_SEQUENTIAL_COUNTERS"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      // 修正前は`counterA`の変化に反応する候補解決の
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

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

  it("review fix: a counterUpdates definition that re-triggers itself from the RuntimeCounterChanged it causes throws a deterministic ExecutionGuardExceededError instead of recursing forever", () => {
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
    // 実行ガード超過は`DomainValidationError`
    // （`INVALID_COMMAND`/HTTP422へ変換される）ではなく、専用の
    // `ExecutionGuardExceededError`（`EXECUTION_LIMIT_EXCEEDED`/HTTP503）でなければ
    // ならない。
    expect(caught).toBeInstanceOf(ExecutionGuardExceededError);
    expect((caught as Error).message).toMatch(/self-triggering recursion exceeded/);
  });

  it("review re-fix: a PS chain reacting to the first RuntimeCounterChanged that mutates the still-pending second counter is not clobbered by a stale pre-computed value", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_COUNTER_RACE_OWNER");
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_RACE_A");
    const counterB = createRuntimeCounterId("RUNTIME_COUNTER_RACE_B");
    const mutatorSkillId = createSkillDefinitionId("SKL_PS_COUNTER_RACE_MUTATOR");
    // counterAとcounterBは同じ原因イベント
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

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

  it("review re-re-fix: an originalSkill entry that matched the causing event before a PS chain ran is still applied afterward, even though the PS chain changed the counter its match condition depended on", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_COUNTER_NO_VANISH_OWNER");
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_NO_VANISH_A");
    const counterE = createRuntimeCounterId("RUNTIME_COUNTER_NO_VANISH_E");
    const mutatorSkillId = createSkillDefinitionId("SKL_PS_COUNTER_NO_VANISH_MUTATOR");
    // counterEのマッチング条件(counterA==0)は、
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

    const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

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

  describe("R-TGT-08 Stealth consumption inside a PS's own EffectSequence (TGT-004)", () => {
    it("UT-R-TGT-08-009: a Stealth AppliedEffect consumed by a PS's own targetBindings redirect (not the AS/EX callback path) still reaches the PS chain — a watcher PS triggered by the resulting EffectExpired(CONSUMPTION) is detected there and activates once the parent's effect processing completed (R-ATM-01)", () => {
      const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_STEALTH");
      const watcherUnitDefinitionId = createUnitDefinitionId("UNIT_WATCHER_STEALTH");
      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE_STEALTH");
      const watcherAction = damageEffectAction("ACT_WATCHER_SELF");
      const stealthDefinitionId = createEffectActionDefinitionId("ACT_STEALTH_PS_OWN");

      const parentSkill: SkillDefinition = {
        ...passiveSkillOf("SKL_PARENT_STEALTH"),
        // TurnStarted起動（actionIdなし）のためTURN単位cooldownにする
        // （行動外のトップレベルイベントはACTION単位cooldownを解決できないため）。
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
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "BINDING", targetBindingId: enemyBindingId },
              actions: [{ effectActionDefinitionId: enemyDamage.effectActionDefinitionId }],
            },
          ],
        },
      };
      // watcherPS: EffectExpired(reason: CONSUMPTION)に反応する。Stealth消費が
      // `context.onFactEventForPassiveChain`未指定（PS自身のEffectSequenceが
      // `yield*`委譲される経路）でも、他のEffectAction内部イベントと同様
      // `EFFECT_RESOLVED`としてyieldされ、`resolvePassiveChain`/`driveActivation`
      // 側のdriverが子PS連鎖を処理できることを検証する。
      const watcherSkill: SkillDefinition = {
        ...passiveSkillOf("SKL_WATCHER_CONSUMPTION"),
        cooldown: { unit: "TURN", count: 0 },
        triggers: [
          {
            eventType: "EffectExpired",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "EVENT_PAYLOAD", field: "reason", op: "EQ", value: "CONSUMPTION" },
          },
        ],
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: watcherAction.effectActionDefinitionId }],
            },
          ],
        },
      };

      const stealthInstance: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("ei-stealth-ps-own"),
        effectActionDefinitionId: stealthDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(stealthDefinitionId),
        duplicate: true,
        sourceUnitId: createBattleUnitId("HOLDER"),
        targetUnitId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        categories: ["BUFF"],
        statusKind: "STEALTH",
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
        appliedTurnNumber: 1,
      };
      const holder: BattleUnit = {
        ...unit("HOLDER", "ENEMY"),
        appliedEffects: [stealthInstance],
      };
      const parentOwner = unit("PARENT", "ALLY", {
        unitDefinitionId: parentUnitDefinitionId,
        currentPp: 3,
        attack: 100,
      });
      const watcherOwner = unit("WATCHER", "ALLY", {
        unitDefinitionId: watcherUnitDefinitionId,
        currentPp: 3,
      });
      const definitions = definitionsOf(
        new Map([
          [
            parentUnitDefinitionId,
            unitDefinitionOf(parentUnitDefinitionId, [parentSkill.skillDefinitionId]),
          ],
          [
            watcherUnitDefinitionId,
            unitDefinitionOf(watcherUnitDefinitionId, [watcherSkill.skillDefinitionId]),
          ],
          [
            createUnitDefinitionId("UNIT_A"),
            unitDefinitionOf(createUnitDefinitionId("UNIT_A"), []),
          ],
        ]),
        new Map([
          [parentSkill.skillDefinitionId, parentSkill],
          [watcherSkill.skillDefinitionId, watcherSkill],
        ]),
        new Map<ReturnType<typeof createEffectActionDefinitionId>, EffectActionDefinition>([
          [enemyDamage.effectActionDefinitionId, enemyDamage],
          [watcherAction.effectActionDefinitionId, watcherAction],
        ]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        parentOwner,
        watcherOwner,
        holder,
      ]);

      const updatedUnits = runtime.onFactEvent(turnStarted, [
        parentOwner,
        watcherOwner,
        holder,
      ]).units;

      const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updatedHolder.appliedEffects).toHaveLength(0);

      const events = recorder.getEvents();
      const expiredEvent = events.find((e) => e.eventType === "EffectExpired")!;
      expect(expiredEvent.payload).toMatchObject({
        effectInstanceId: stealthInstance.effectInstanceId,
        reason: "CONSUMPTION",
      });
      const expiredIndex = events.indexOf(expiredEvent);
      const watcherActivatedEvents = events.filter(
        (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === watcherOwner.battleUnitId,
      );
      expect(watcherActivatedEvents).toHaveLength(1);
      const watcherActivatedIndex = events.indexOf(watcherActivatedEvents[0]!);
      const parentActionStartingIndex = events.findIndex(
        (e) =>
          e.eventType === "EffectActionStarting" &&
          e.payload.effectActionDefinitionId === enemyDamage.effectActionDefinitionId,
      );
      const parentResolvedIndex = events.findIndex(
        (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === parentOwner.battleUnitId,
      );
      expect(watcherActivatedIndex).toBeGreaterThan(expiredIndex);
      // R-ATM-01: 消費の`EffectExpired`はPS/Memoryへ届くが、watcherの発動は
      // 親PSの効果処理（最初のEffectActionを含む）が完了した後になる。
      expect(parentActionStartingIndex).toBeLessThan(parentResolvedIndex);
      expect(watcherActivatedIndex).toBeGreaterThan(parentResolvedIndex);
    });

    it("UT-R-EFF-09-008 [R-EFF-09, R-TGT-08] (R-EFF-09): a Stealth holder whose AppliedEffect is PARENT-role in a linkedEffectGroupId cascades its CHILD-role sibling first, and both resulting EffectExpired events reach the PS chain in order via the same PS-own-EffectSequence path", () => {
      const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_STEALTH_LINK");
      const cascadeWatcherUnitDefinitionId = createUnitDefinitionId("UNIT_WATCHER_CASCADE");
      const consumptionWatcherUnitDefinitionId = createUnitDefinitionId("UNIT_WATCHER_CONSUMPTION");
      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE_STEALTH_LINK");
      const cascadeWatcherAction = damageEffectAction("ACT_WATCHER_CASCADE_SELF");
      const consumptionWatcherAction = damageEffectAction("ACT_WATCHER_CONSUMPTION_SELF");
      const stealthDefinitionId = createEffectActionDefinitionId("ACT_STEALTH_PS_OWN_LINK");
      const siblingDefinitionId = createEffectActionDefinitionId("ACT_LINK_SIBLING");

      const parentSkill: SkillDefinition = {
        ...passiveSkillOf("SKL_PARENT_STEALTH_LINK"),
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
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "BINDING", targetBindingId: enemyBindingId },
              actions: [{ effectActionDefinitionId: enemyDamage.effectActionDefinitionId }],
            },
          ],
        },
      };
      const cascadeWatcherSkill: SkillDefinition = {
        ...passiveSkillOf("SKL_WATCHER_CASCADE"),
        cooldown: { unit: "TURN", count: 0 },
        triggers: [
          {
            eventType: "EffectExpired",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: {
              kind: "EVENT_PAYLOAD",
              field: "reason",
              op: "EQ",
              value: "LINKED_GROUP_CASCADE",
            },
          },
        ],
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [
                { effectActionDefinitionId: cascadeWatcherAction.effectActionDefinitionId },
              ],
            },
          ],
        },
      };
      const consumptionWatcherSkill: SkillDefinition = {
        ...passiveSkillOf("SKL_WATCHER_CONSUMPTION_LINK"),
        cooldown: { unit: "TURN", count: 0 },
        triggers: [
          {
            eventType: "EffectExpired",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "EVENT_PAYLOAD", field: "reason", op: "EQ", value: "CONSUMPTION" },
          },
        ],
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [
                { effectActionDefinitionId: consumptionWatcherAction.effectActionDefinitionId },
              ],
            },
          ],
        },
      };

      const stealthInstance: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("ei-stealth-ps-own-link"),
        effectActionDefinitionId: stealthDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(stealthDefinitionId),
        duplicate: true,
        sourceUnitId: createBattleUnitId("HOLDER"),
        targetUnitId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        categories: ["BUFF"],
        statusKind: "STEALTH",
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: "GROUP_STEALTH_LINK",
            linkedEffectGroupRole: "PARENT",
          },
        },
        appliedTurnNumber: 1,
      };
      const siblingInstance: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("ei-sibling-ps-own-link"),
        effectActionDefinitionId: siblingDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(siblingDefinitionId),
        duplicate: true,
        sourceUnitId: createBattleUnitId("HOLDER"),
        targetUnitId: createBattleUnitId("HOLDER"),
        magnitude: 0,
        categories: ["BUFF"],
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: "GROUP_STEALTH_LINK",
            linkedEffectGroupRole: "CHILD",
          },
        },
        appliedTurnNumber: 1,
      };
      const holder: BattleUnit = {
        ...unit("HOLDER", "ENEMY"),
        appliedEffects: [stealthInstance, siblingInstance],
      };
      const parentOwner = unit("PARENT", "ALLY", {
        unitDefinitionId: parentUnitDefinitionId,
        currentPp: 3,
        attack: 100,
      });
      const cascadeWatcherOwner = unit("WATCHER_CASCADE", "ALLY", {
        unitDefinitionId: cascadeWatcherUnitDefinitionId,
        currentPp: 3,
      });
      const consumptionWatcherOwner = unit("WATCHER_CONSUMPTION", "ALLY", {
        unitDefinitionId: consumptionWatcherUnitDefinitionId,
        currentPp: 3,
      });
      const definitions = definitionsOf(
        new Map([
          [
            parentUnitDefinitionId,
            unitDefinitionOf(parentUnitDefinitionId, [parentSkill.skillDefinitionId]),
          ],
          [
            cascadeWatcherUnitDefinitionId,
            unitDefinitionOf(cascadeWatcherUnitDefinitionId, [
              cascadeWatcherSkill.skillDefinitionId,
            ]),
          ],
          [
            consumptionWatcherUnitDefinitionId,
            unitDefinitionOf(consumptionWatcherUnitDefinitionId, [
              consumptionWatcherSkill.skillDefinitionId,
            ]),
          ],
          [
            createUnitDefinitionId("UNIT_A"),
            unitDefinitionOf(createUnitDefinitionId("UNIT_A"), []),
          ],
        ]),
        new Map([
          [parentSkill.skillDefinitionId, parentSkill],
          [cascadeWatcherSkill.skillDefinitionId, cascadeWatcherSkill],
          [consumptionWatcherSkill.skillDefinitionId, consumptionWatcherSkill],
        ]),
        new Map<ReturnType<typeof createEffectActionDefinitionId>, EffectActionDefinition>([
          [enemyDamage.effectActionDefinitionId, enemyDamage],
          [cascadeWatcherAction.effectActionDefinitionId, cascadeWatcherAction],
          [consumptionWatcherAction.effectActionDefinitionId, consumptionWatcherAction],
        ]),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        parentOwner,
        cascadeWatcherOwner,
        consumptionWatcherOwner,
        holder,
      ]);

      const updatedUnits = runtime.onFactEvent(turnStarted, [
        parentOwner,
        cascadeWatcherOwner,
        consumptionWatcherOwner,
        holder,
      ]).units;

      const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updatedHolder.appliedEffects).toHaveLength(0);

      const events = recorder.getEvents();
      const expiredEvents = events.filter((e) => e.eventType === "EffectExpired");
      expect(expiredEvents).toHaveLength(2);
      expect(expiredEvents[0]!.payload).toMatchObject({
        effectInstanceId: siblingInstance.effectInstanceId,
        reason: "LINKED_GROUP_CASCADE",
        cascaded: true,
      });
      expect(expiredEvents[1]!.payload).toMatchObject({
        effectInstanceId: stealthInstance.effectInstanceId,
        reason: "CONSUMPTION",
        cascaded: false,
      });

      const cascadeWatcherActivatedEvents = events.filter(
        (e) =>
          e.eventType === "PassiveActivated" && e.sourceUnitId === cascadeWatcherOwner.battleUnitId,
      );
      const consumptionWatcherActivatedEvents = events.filter(
        (e) =>
          e.eventType === "PassiveActivated" &&
          e.sourceUnitId === consumptionWatcherOwner.battleUnitId,
      );
      expect(cascadeWatcherActivatedEvents).toHaveLength(1);
      expect(consumptionWatcherActivatedEvents).toHaveLength(1);

      const consumptionIndex = events.indexOf(expiredEvents[1]!);
      const cascadeWatcherActivatedIndex = events.indexOf(cascadeWatcherActivatedEvents[0]!);
      const consumptionWatcherActivatedIndex = events.indexOf(
        consumptionWatcherActivatedEvents[0]!,
      );
      const parentActionStartingIndex = events.findIndex(
        (e) =>
          e.eventType === "EffectActionStarting" &&
          e.payload.effectActionDefinitionId === enemyDamage.effectActionDefinitionId,
      );
      const parentResolvedIndex = events.findIndex(
        (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === parentOwner.battleUnitId,
      );
      // 両方のEffectExpired（カスケード・消費）は、その事後PS連鎖が走るより前に
      // 一括で記録済み（`expireEffects`が両方を返す前に記録する）。R-ATM-01により
      // どちらのwatcherも保留キューへ入り、親PSの効果処理完了後にイベント発生順
      // （カスケード → 消費）で発動する。
      expect(cascadeWatcherActivatedIndex).toBeGreaterThan(consumptionIndex);
      expect(consumptionWatcherActivatedIndex).toBeGreaterThan(cascadeWatcherActivatedIndex);
      expect(parentActionStartingIndex).toBeLessThan(parentResolvedIndex);
      expect(cascadeWatcherActivatedIndex).toBeGreaterThan(parentResolvedIndex);
    });
  });

  describe("SKILL_USE duration decrement on a PS's own completion (TGT-004フェーズ3)", () => {
    it("UT-R-EFF-01-052: a SKILL_USE(count:1) status granted by a PS's own EffectSequence is not decremented by that same PassiveResolved, but is decremented (and expires) by the owner's next completed PS activation — which itself grants a fresh, untouched instance", () => {
      const ownerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_STEALTH_SKILLUSE");
      const grantAction = statusEffectAction("ACT_PS_GRANT_STEALTH", 1);
      const skill: SkillDefinition = {
        ...passiveSkillOf("SKL_PS_GRANT_STEALTH", { ppCost: 1 }),
        cooldown: { unit: "TURN", count: 0 },
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: grantAction.effectActionDefinitionId }],
            },
          ],
        },
      };
      const definitions = definitionsOf(
        new Map([
          [
            ownerUnitDefinitionId,
            unitDefinitionOf(ownerUnitDefinitionId, [skill.skillDefinitionId]),
          ],
        ]),
        new Map([[skill.skillDefinitionId, skill]]),
        new Map([[grantAction.effectActionDefinitionId, grantAction]]),
      );
      // ppCost: 1固定で2回連続発動しても足りるだけのPPを持たせる（PS発動条件
      // 自体はこのテストの対象外）。
      const owner = unit("OWNER", "ALLY", {
        unitDefinitionId: ownerUnitDefinitionId,
        currentPp: 3,
      });

      // A single shared EventRecorder across both activations (matching the
      // real battle: one EventRecorder for the whole battle) — using two
      // separate recorders would let their independent nextSkillUseId()
      // counters both start at 1, colliding and defeating the very exclusion
      // this test verifies.
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted1 = recordTurnStarted(recorder);
      const runtime1 = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted1),
        [owner],
      );
      const unitsAfterFirst = runtime1.onFactEvent(turnStarted1, [owner]).units;
      const ownerAfterFirst = unitsAfterFirst.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(ownerAfterFirst.appliedEffects).toHaveLength(1);
      const firstInstance = ownerAfterFirst.appliedEffects[0]!;
      // The granting PS activation itself must not decrement its own instance.
      expect(firstInstance.duration.timeLimitRemaining).toBe(1);

      const turnStarted2 = recordTurnStarted(recorder);
      const runtime2 = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted2),
        [ownerAfterFirst],
      );
      const eventsBeforeSecond = recorder.getEvents().length;
      const unitsAfterSecond = runtime2.onFactEvent(turnStarted2, [ownerAfterFirst]).units;
      const ownerAfterSecond = unitsAfterSecond.find((u) => u.battleUnitId === owner.battleUnitId)!;

      // The first instance was decremented (1 -> 0) and expired by the SECOND
      // PassiveResolved, and a fresh instance from that same activation is
      // present untouched (not swept up by its own completion's decrement).
      expect(ownerAfterSecond.appliedEffects).toHaveLength(1);
      const secondInstance = ownerAfterSecond.appliedEffects[0]!;
      expect(secondInstance.effectInstanceId).not.toBe(firstInstance.effectInstanceId);
      expect(secondInstance.duration.timeLimitRemaining).toBe(1);

      const events2 = recorder.getEvents().slice(eventsBeforeSecond);
      const reduced = events2.find((e) => e.eventType === "EffectDurationReduced");
      expect(reduced).toBeDefined();
      expect(reduced!.payload).toMatchObject({
        effectInstanceId: firstInstance.effectInstanceId,
        battleUnitId: owner.battleUnitId,
        unit: "SKILL_USE",
        before: 1,
        after: 0,
      });
      const expired = events2.find((e) => e.eventType === "EffectExpired");
      expect(expired).toBeDefined();
      expect(expired!.payload).toMatchObject({
        effectInstanceId: firstInstance.effectInstanceId,
        battleUnitId: owner.battleUnitId,
        reason: "TIME_LIMIT",
      });
    });

    it("UT-R-EFF-01-053: PassiveInterrupted (owner defeated mid-resolution) does not decrement SKILL_USE-unit effects, matching AS/EX's SkillUseInterrupted exclusion", () => {
      const ownerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_STEALTH_INTERRUPTED");
      const grantAction = statusEffectAction("ACT_PS_INTERRUPTED_STEALTH", 1);
      const selfDamage = damageEffectAction("ACT_PS_INTERRUPTED_SELF_DAMAGE");
      const skill: SkillDefinition = {
        ...passiveSkillOf("SKL_PS_INTERRUPTED"),
        cooldown: { unit: "TURN", count: 0 },
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
            },
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: grantAction.effectActionDefinitionId }],
            },
          ],
        },
      };
      const definitions = definitionsOf(
        new Map([
          [
            ownerUnitDefinitionId,
            unitDefinitionOf(ownerUnitDefinitionId, [skill.skillDefinitionId]),
          ],
        ]),
        new Map([[skill.skillDefinitionId, skill]]),
        new Map([
          [grantAction.effectActionDefinitionId, grantAction],
          [selfDamage.effectActionDefinitionId, selfDamage],
        ]),
      );
      // Lethal self-damage interrupts the PS before it reaches the STEALTH step.
      const owner = unit("OWNER", "ALLY", {
        unitDefinitionId: ownerUnitDefinitionId,
        currentPp: 3,
        currentHp: 1,
        attack: 100,
      });

      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        owner,
      ]);
      const updatedUnits = runtime.onFactEvent(turnStarted, [owner]).units;

      expect(recorder.getEvents().some((e) => e.eventType === "PassiveInterrupted")).toBe(true);
      expect(recorder.getEvents().some((e) => e.eventType === "PassiveResolved")).toBe(false);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectDurationReduced")).toBe(false);
      const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(updatedOwner.appliedEffects).toHaveLength(0);
    });

    it("UT-R-EFF-01-056 (TGT-004フェーズ3、08_ドメインイベント.md イベント発行と処理の順序契約): a PS reacting to another PS's own PassiveResolved fully resolves before a PS reacting to the resulting EffectExpired, matching the events' own recorded (causal) order", () => {
      const ownerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_ORDER");
      const mainSkill: SkillDefinition = {
        ...passiveSkillOf("SKL_PS_MAIN_ORDER", { ppCost: 1 }),
        cooldown: { unit: "TURN", count: 0 },
      };
      const psOnCompletion: SkillDefinition = {
        skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_COMPLETION_ORDER"),
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
              value: mainSkill.skillDefinitionId,
            },
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
        metadata: { displayName: "PSOnCompletion", tags: [] },
      };
      const psOnExpiry: SkillDefinition = {
        skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_EXPIRY_ORDER"),
        skillType: "PS",
        cost: { resource: "PP", amount: 1 },
        activationCondition: { kind: "TRUE" },
        triggers: [
          {
            eventType: "EffectExpired",
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
        metadata: { displayName: "PSOnExpiry", tags: [] },
      };

      // Hand-built pre-existing SKILL_USE(count:1) effect, granted in a
      // different, earlier skillUseId than mainSkill's own activation will use.
      const preExisting: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("effect:pre-existing-order"),
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_PRE_EXISTING_ORDER"),
        kindKey: effectKindKeyFromDefinitionId(
          createEffectActionDefinitionId("ACT_PRE_EXISTING_ORDER"),
        ),
        duplicate: true,
        sourceUnitId: createBattleUnitId("OWNER"),
        targetUnitId: createBattleUnitId("OWNER"),
        magnitude: 0,
        categories: ["BUFF"],
        statusKind: "STEALTH",
        duration: {
          definition: {
            timeLimit: { unit: "SKILL_USE", count: 1 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 1,
          grantedSkillUseId: createSkillUseId("B_1:skill-use:0"),
        },
        appliedTurnNumber: 1,
      };
      const owner = {
        ...unit("OWNER", "ALLY", { unitDefinitionId: ownerUnitDefinitionId, currentPp: 3 }),
        appliedEffects: [preExisting],
      };
      const definitions = definitionsOf(
        new Map([
          [
            ownerUnitDefinitionId,
            unitDefinitionOf(ownerUnitDefinitionId, [
              mainSkill.skillDefinitionId,
              psOnCompletion.skillDefinitionId,
              psOnExpiry.skillDefinitionId,
            ]),
          ],
        ]),
        new Map([
          [mainSkill.skillDefinitionId, mainSkill],
          [psOnCompletion.skillDefinitionId, psOnCompletion],
          [psOnExpiry.skillDefinitionId, psOnExpiry],
        ]),
        new Map(),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
        owner,
      ]);

      runtime.onFactEvent(turnStarted, [owner]);

      const events = recorder.getEvents();
      const eventTypes = events.map((e) => e.eventType);
      // Recorded (causal) order: PassiveResolved (main), then
      // EffectDurationReduced, then EffectExpired.
      const mainResolvedIndex = events.findIndex(
        (e) =>
          e.eventType === "PassiveResolved" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
            mainSkill.skillDefinitionId,
      );
      expect(mainResolvedIndex).toBeGreaterThanOrEqual(0);
      expect(mainResolvedIndex).toBeLessThan(eventTypes.indexOf("EffectDurationReduced"));
      expect(eventTypes.indexOf("EffectDurationReduced")).toBeLessThan(
        eventTypes.indexOf("EffectExpired"),
      );

      const completionActivated = events.find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
            psOnCompletion.skillDefinitionId,
      );
      const expiryActivated = events.find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
            psOnExpiry.skillDefinitionId,
      );
      expect(completionActivated).toBeDefined();
      expect(expiryActivated).toBeDefined();
      // Actual PS activation order must match the events' own recorded
      // order (the main PS's own PassiveResolved candidates resolve before
      // its child duration events'), not the reverse.
      expect(events.indexOf(completionActivated!)).toBeLessThan(events.indexOf(expiryActivated!));
    });
  });

  describe("lastEventId", () => {
    it("UT-R-PS-05-030: returns the target event's own id, not an unrelated later event the caller had already pre-recorded before this call, when this call itself triggers no new reaction", () => {
      const unitDefinitionId = createUnitDefinitionId("UNIT_LAST_EVENT_ID");
      const owner = unit("OWNER", "ALLY", { unitDefinitionId });
      const definitions = definitionsOf(
        new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [])]]),
        new Map(),
      );
      const recorder = new EventRecorder(createBattleId("B_1"));
      const turnStarted = recordTurnStarted(recorder);
      const runtime = new PassiveActivationRuntime(
        contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
        [owner],
      );

      // Simulates callers (e.g. action-completion.ts's duration/marker
      // update path) that record several events in a batch up front, then
      // route each through onFactEvent one at a time — an unrelated later
      // event already sits in the recorder before onFactEvent(turnStarted,
      // ...) is even called. Naively reading recorder.getEvents()'s bare
      // tail would return this event instead of turnStarted's own id.
      const unrelatedLaterEvent = recorder.record({
        eventType: "TurnStarted",
        category: "FACT",
        turnNumber: 2,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        payload: { turnNumber: 2 },
      });

      // No PS/counterUpdates are registered for TurnStarted here, so this
      // call adds nothing new to the recorder.
      const resolved = runtime.onFactEvent(turnStarted, [owner]);

      expect(resolved.lastEventId).toBe(turnStarted.eventId);
      expect(resolved.lastEventId).not.toBe(unrelatedLaterEvent.eventId);
    });
  });
});

describe("targetCondition EVENT_PAYLOAD wiring (CAP_TRIGGER_PAYLOAD_IN_RESOLUTION, M7-001D)", () => {
  /**
   * UT-R-SKL-06-055は`evaluateEffectStepCondition`へ
   * `triggerEventPayload`を直接渡しており、`buildEffectStepPerTargetFilter`
   * （`skill-resolution-service.ts`）→`evaluateEffectStepCondition`の実配線を
   * 経由していないため、この配線を削除しても成功してしまう。この
   * テストは実際に`PassiveActivationRuntime.onFactEvent`から入り、実
   * `DamageApplied`イベントのpayloadを変えるだけで、`targetCondition`
   * （`TARGET_STATE`とのAND）が選び出す対象集合が変わることを証明する。
   */
  function setup(calculatedDamage: number) {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const markAction = statusEffectAction("ACT_TEST_MARK", 1);
    const enemyBindingId = createTargetBindingId("TGT_ALL_ENEMIES");
    const skill = passiveSkillOf("SKL_PAYLOAD_FILTER", {
      ppCost: 1,
      triggers: [
        {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
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
              includeDefeated: true,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: {
              kind: "AND",
              conditions: [
                {
                  kind: "TARGET_STATE",
                  target: { kind: "BINDING", targetBindingId: enemyBindingId },
                  field: "IS_ALIVE",
                  op: "EQ",
                  value: true,
                },
                { kind: "EVENT_PAYLOAD", field: "calculatedDamage", op: "LTE", value: 10 },
              ],
            },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: markAction.effectActionDefinitionId }],
          },
        ],
      },
    });
    const owner = unit("OWNER", "ALLY", { unitDefinitionId, currentPp: 3 });
    const enemyAlive = unit("ENEMY_ALIVE", "ENEMY", {
      unitDefinitionId: enemyUnitDefinitionId,
      currentHp: 100,
      maximumHp: 100,
    });
    const enemyDead = unit("ENEMY_DEAD", "ENEMY", {
      unitDefinitionId: enemyUnitDefinitionId,
      currentHp: 0,
      maximumHp: 100,
    });
    const definitions = definitionsOf(
      new Map([
        [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([[skill.skillDefinitionId, skill]]),
      new Map([[markAction.effectActionDefinitionId, markAction]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const damageApplied = recorder.record({
      eventType: "DamageApplied",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: owner.battleUnitId,
      targetUnitIds: [enemyAlive.battleUnitId],
      payload: {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_UNRELATED_ATTACK"),
        hitIndex: 1,
        targetUnitId: enemyAlive.battleUnitId,
        calculatedDamage,
        // DMG-004（R-SHD-02/03）: シールド未所持の対象なので全量がHPへ向かう。
        hpDirectDamage: 0,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 0,
        discardedDamage: 0,
        hitPointDamage: calculatedDamage,
        hpBefore: 100,
        hpAfter: 100 - calculatedDamage,
        defeated: false,
      },
    });
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, damageApplied, createActionId("B_1:action:1")),
      [owner, enemyAlive, enemyDead],
    );
    const updatedUnits = runtime.onFactEvent(damageApplied, [owner, enemyAlive, enemyDead]).units;
    return { updatedUnits, enemyAlive, enemyDead, markAction };
  }

  it("IT-CAP-TRIGGER-PAYLOAD-TARGETCOND-001 [R-SKL-06]: calculatedDamage<=10 — targetCondition (TARGET_STATE AND EVENT_PAYLOAD) admits the alive enemy and still excludes the already-defeated one", () => {
    const { updatedUnits, enemyAlive, enemyDead, markAction } = setup(5);
    const alive = updatedUnits.find((u) => u.battleUnitId === enemyAlive.battleUnitId)!;
    const dead = updatedUnits.find((u) => u.battleUnitId === enemyDead.battleUnitId)!;
    expect(
      alive.appliedEffects.some(
        (effect) => effect.effectActionDefinitionId === markAction.effectActionDefinitionId,
      ),
    ).toBe(true);
    expect(dead.appliedEffects).toHaveLength(0);
  });

  it("IT-CAP-TRIGGER-PAYLOAD-TARGETCOND-002 [R-SKL-06]: calculatedDamage>10 — the SAME alive enemy that passed TARGET_STATE is filtered out purely because the triggering event's payload changed, proving buildEffectStepPerTargetFilter actually threads triggerEventPayload through", () => {
    const { updatedUnits, enemyAlive, markAction } = setup(11);
    const alive = updatedUnits.find((u) => u.battleUnitId === enemyAlive.battleUnitId)!;
    expect(
      alive.appliedEffects.some(
        (effect) => effect.effectActionDefinitionId === markAction.effectActionDefinitionId,
      ),
    ).toBe(false);
  });
});

/**
 * R-HEAL-04 #4/#6（`M7-005-HEAL-LINK`・
 * PS自身のEffectSequence解決は`onFactEventForPassiveChain`を
 * 渡さず、`driveActivation`がgeneratorの`yield`境界ごとに子PS連鎖を解決する。
 * HEALが`HealApplied`と各`HealingTransferred`で`yield`しないと、HEAL EffectAction
 * 全体（転送を含む）を適用し終えてからまとめてyieldすることになり、`HealApplied`
 * 起点の子PSが転送後のHPを観測してしまう。この経路を実driverで通す回帰テスト。
 */
describe("PS-own EffectSequence HEAL with a healing link (R-HEAL-04 #4/#6)", () => {
  const parentUnitDefinitionId = createUnitDefinitionId("UNIT_PARENT_HEAL_LINK");
  const childUnitDefinitionId = createUnitDefinitionId("UNIT_CHILD_HEAL_WATCHER");
  const plainUnitDefinitionId = createUnitDefinitionId("UNIT_HEAL_LINK_PLAIN");

  const healAction: EffectActionDefinition = {
    kind: "HEAL",
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_PARENT_HEAL"),
    metadata: { tags: [] },
    payload: {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
      overheal: "DISCARD",
      distribution: "NONE",
    },
  };
  const childDamage = damageEffectAction("ACT_CHILD_KILL");

  /** 最もHP割合の低い敵単体を1件選ぶbinding（両PSが使う）。 */
  function lowestEnemyBinding(id: string) {
    return {
      targetBindingId: createTargetBindingId(id),
      selector: {
        kind: "SELECT" as const,
        side: "ENEMY" as const,
        count: 1,
        filters: [],
        order: ["LOWEST_HP_RATIO" as const],
        includeDefeated: false,
      },
    };
  }

  function actionStep(bindingId: string, effectActionDefinitionId: string) {
    return {
      kind: "ACTION" as const,
      stepCondition: { kind: "TRUE" as const },
      targetCondition: { kind: "TRUE" as const },
      target: {
        kind: "BINDING" as const,
        targetBindingId: createTargetBindingId(bindingId),
      },
      actions: [
        { effectActionDefinitionId: createEffectActionDefinitionId(effectActionDefinitionId) },
      ],
    };
  }

  /** 親PS: 最もHP割合の低い敵（＝回復リンク保持者）を回復する。 */
  const parentSkill: SkillDefinition = {
    ...passiveSkillOf("SKL_PARENT_HEAL"),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [lowestEnemyBinding("TGT_HOLDER")],
      steps: [actionStep("TGT_HOLDER", healAction.effectActionDefinitionId)],
    },
  };
  /** 子PS: `HealApplied`（HEALの内部イベントそのもの）に反応し、最もHP割合の低い敵を撃破する。 */
  const childSkill: SkillDefinition = {
    ...passiveSkillOf("SKL_CHILD_HEAL_WATCHER"),
    triggers: [
      {
        eventType: "HealApplied",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "TRUE" },
      },
    ],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [lowestEnemyBinding("TGT_VICTIM")],
      steps: [actionStep("TGT_VICTIM", childDamage.effectActionDefinitionId)],
    },
  };

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
      [plainUnitDefinitionId, unitDefinitionOf(plainUnitDefinitionId, [])],
    ]),
    new Map([
      [parentSkill.skillDefinitionId, parentSkill],
      [childSkill.skillDefinitionId, childSkill],
    ]),
    new Map([
      [healAction.effectActionDefinitionId, healAction],
      [childDamage.effectActionDefinitionId, childDamage],
    ]),
  );

  function healingLink(holderId: string, destinationId: string): AppliedEffect {
    return {
      effectInstanceId: "B_1:effect:link" as AppliedEffect["effectInstanceId"],
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_LINK"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_LINK")),
      duplicate: true,
      sourceUnitId: createBattleUnitId(destinationId),
      targetUnitId: createBattleUnitId(holderId),
      magnitude: 1,
      categories: ["BUFF"],
      healingLink: { transferToUnitId: createBattleUnitId(destinationId), transferRate: 1 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  /**
   * 盤面。`healerHp`/`destinationHp`のうち低い方が、子PSの`LOWEST_HP_RATIO`で
   * 撃破される側になる（両者ともALLY側＝子PS所有者から見たENEMY側）。
   * 保持者HOLDER(50/100) < WATCHER(100/100) なので、親PSは常にHOLDERを回復する。
   */
  function board(healerHp: number, destinationHp: number) {
    const healer = unit("HEALER", "ALLY", {
      unitDefinitionId: parentUnitDefinitionId,
      currentPp: 3,
      currentHp: healerHp,
      maximumHp: 100,
      defense: 0,
    });
    const destination = unit("DESTINATION", "ALLY", {
      unitDefinitionId: plainUnitDefinitionId,
      currentHp: destinationHp,
      maximumHp: 100,
      defense: 0,
    });
    const holder: BattleUnit = {
      ...unit("HOLDER", "ENEMY", {
        unitDefinitionId: plainUnitDefinitionId,
        currentHp: 50,
        maximumHp: 100,
      }),
      appliedEffects: [healingLink("HOLDER", "DESTINATION")],
    };
    const watcher = unit("WATCHER", "ENEMY", {
      unitDefinitionId: childUnitDefinitionId,
      currentPp: 3,
      attack: 10,
      currentHp: 100,
      maximumHp: 100,
    });
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const startingUnits = [healer, destination, holder, watcher];
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      startingUnits,
    );
    const updatedUnits = runtime.onFactEvent(turnStarted, startingUnits).units;
    return { recorder, updatedUnits, events: recorder.getEvents() };
  }

  it("UT-R-HEAL-04-017 [R-ATM-01, R-HEAL-04] (R-ATM-01「転送途中のPS/Memory発動は存在しない」): the child PS triggered by HealApplied is only detected there — the transfer completes untouched and the child activates after the parent's PassiveResolved", () => {
    // HEALER(100) > DESTINATION(1)。旧仕様では子PSが転送前に割り込んで転送先を
    // 撃破し、転送が破棄されていた。R-ATM-01の保留方式ではその経路自体が存在しない。
    const { updatedUnits, events } = board(100, 1);

    const healAppliedIndex = events.findIndex((e) => e.eventType === "HealApplied");
    const childActivatedIndex = events.findIndex(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === createBattleUnitId("WATCHER"),
    );
    const transferredIndex = events.findIndex((e) => e.eventType === "HealingTransferred");
    const parentResolvedIndex = events.findIndex(
      (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === createBattleUnitId("HEALER"),
    );
    expect(healAppliedIndex).toBeGreaterThanOrEqual(0);
    // 中核の回帰チェック: 転送は`HealApplied`の直後・親PSの効果処理の内側で完了し、
    // 子PSの発動はその後（完了イベント後の後段フェーズ）になる。
    expect(transferredIndex).toBeGreaterThan(healAppliedIndex);
    expect(transferredIndex).toBeLessThan(parentResolvedIndex);
    expect(childActivatedIndex).toBeGreaterThan(parentResolvedIndex);

    // 転送は成立する（転送先は生存したまま30回復して31になる）。
    expect(events[transferredIndex]!.payload).toMatchObject({
      fromUnitId: createBattleUnitId("HOLDER"),
      toUnitId: createBattleUnitId("DESTINATION"),
      transferredAmount: 30,
      appliedAmount: 30,
      discardedAmount: 0,
    });
    // 保持者は転送分を差し引いた残量のまま（R-HEAL-04 #2）。
    expect(
      updatedUnits.find((u) => u.battleUnitId === createBattleUnitId("HOLDER"))!.currentHp,
    ).toBe(50);
  });

  it("UT-R-HEAL-04-018 [R-ATM-01, R-HEAL-04, R-SKL-01] (R-ATM-01): a HealApplied candidate that would defeat the skill user cannot interrupt the transfer any more — the transfer completes, and the user is only defeated in the post phase", () => {
    // HEALER(1) < DESTINATION(40)。子PSの対象は「最もHP割合の低い敵」であり、
    // 保留解決の時点でもHEALERが該当するため、後段フェーズで使用者が撃破される。
    // 旧仕様ではこれが転送の途中に割り込んで`HealingTransferred`を消していた。
    const { updatedUnits, events } = board(1, 40);

    expect(events.some((e) => e.eventType === "HealApplied")).toBe(true);
    // R-ATM-01「#2 の割り当てから #5 の適用までの間にPS/Memoryの発動が挟まって
    // 転送先・使用者を戦闘不能にする経路は存在しない」。
    const transferredIndex = events.findIndex((e) => e.eventType === "HealingTransferred");
    const parentResolvedIndex = events.findIndex(
      (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === createBattleUnitId("HEALER"),
    );
    expect(transferredIndex).toBeGreaterThanOrEqual(0);
    expect(transferredIndex).toBeLessThan(parentResolvedIndex);
    const completed = events.find(
      (e) =>
        e.eventType === "EffectActionCompleted" &&
        e.payload.effectActionDefinitionId === healAction.effectActionDefinitionId,
    )!;
    expect(completed.payload).toMatchObject({ resultKind: "APPLIED" });
    // 使用者の戦闘不能は後段フェーズ（保留候補の発動）で起きる。
    expect(
      updatedUnits.find((u) => u.battleUnitId === createBattleUnitId("HEALER"))!.currentHp,
    ).toBe(0);
    const healerDefeatedIndex = events.findIndex(
      (e) => e.eventType === "UnitDefeated" && e.payload.unitId === createBattleUnitId("HEALER"),
    );
    expect(healerDefeatedIndex).toBeGreaterThan(parentResolvedIndex);
    // 転送先は転送分だけ回復している。
    expect(
      updatedUnits.find((u) => u.battleUnitId === createBattleUnitId("DESTINATION"))!.currentHp,
    ).toBe(70);
    // 保持者は転送分を差し引いた残量のまま。
    expect(
      updatedUnits.find((u) => u.battleUnitId === createBattleUnitId("HOLDER"))!.currentHp,
    ).toBe(50);
  });
  it("UT-R-ATM-03-010 (R-ATM-03 #1、R-ATM-02 #1のPS行): a PS whose own EffectSequence contains DAMAGE emits the pre-attack observation for its target after PassiveActivated and before its effect processing, and a PS triggered by it activates", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_ATTACKER_ATM03");
    const observerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_OBSERVER_ATM03");
    const psDamage = damageEffectAction("ACT_PS_ATM03_HIT");

    // ターン開始で発動し、敵1体へDAMAGEを撃つPS。
    const attackerPs: SkillDefinition = {
      ...passiveSkillOf("SKL_PS_ATM03_ATTACKER"),
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
            actions: [{ effectActionDefinitionId: psDamage.effectActionDefinitionId }],
          },
        ],
      },
    };
    // 「自身が攻撃される直前」の見張りPS。攻撃前観測からしか候補化されない。
    const observerPs: SkillDefinition = {
      ...passiveSkillOf("SKL_PS_ATM03_OBSERVER"),
      triggers: [
        {
          eventType: "UnitBeingAttacked",
          category: "TIMING",
          sourceSelector: "ENEMY",
          targetSelector: "SELF",
          condition: { kind: "TRUE" },
        },
      ],
    };

    const attacker = unit("PS_ATTACKER", "ALLY", {
      unitDefinitionId: attackerUnitDefinitionId,
      currentPp: 3,
    });
    const observer = unit("PS_OBSERVER", "ENEMY", {
      unitDefinitionId: observerUnitDefinitionId,
      currentPp: 3,
    });
    const definitions = definitionsOf(
      new Map([
        [
          attackerUnitDefinitionId,
          unitDefinitionOf(attackerUnitDefinitionId, [attackerPs.skillDefinitionId]),
        ],
        [
          observerUnitDefinitionId,
          unitDefinitionOf(observerUnitDefinitionId, [observerPs.skillDefinitionId]),
        ],
      ]),
      new Map([
        [attackerPs.skillDefinitionId, attackerPs],
        [observerPs.skillDefinitionId, observerPs],
      ]),
      new Map([[psDamage.effectActionDefinitionId, psDamage]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [attacker, observer],
    );

    runtime.onFactEvent(turnStarted, [attacker, observer]);

    const events = recorder.getEvents();
    const observations = events.filter((event) => event.eventType === "UnitBeingAttacked");
    expect(observations).toHaveLength(1);
    expect(observations[0]!.payload).toMatchObject({
      targetUnitId: observer.battleUnitId,
      skillDefinitionId: attackerPs.skillDefinitionId,
      skillType: "PS",
      damageTypes: ["PHYSICAL"],
    });
    // R-ATM-02 #1のPS行: `PassiveActivated`と候補解決 → 対象束縛 → 攻撃前観測 →
    // 効果処理フェーズ（最初の`EffectStepStarting`）。
    const attackerActivatedIndex = events.findIndex(
      (event) =>
        event.eventType === "PassiveActivated" && event.sourceUnitId === attacker.battleUnitId,
    );
    const observationIndex = events.indexOf(observations[0]!);
    const firstStepIndex = events.findIndex((event) => event.eventType === "EffectStepStarting");
    expect(observationIndex).toBeGreaterThan(attackerActivatedIndex);
    expect(firstStepIndex).toBeGreaterThan(observationIndex);
    // 前段フェーズの観測なので、その候補は保留されず効果処理より前に発動し切る。
    const observerActivatedIndex = events.findIndex(
      (event) =>
        event.eventType === "PassiveActivated" && event.sourceUnitId === observer.battleUnitId,
    );
    expect(observerActivatedIndex).toBeGreaterThan(observationIndex);
    expect(observerActivatedIndex).toBeLessThan(firstStepIndex);
  });
});
