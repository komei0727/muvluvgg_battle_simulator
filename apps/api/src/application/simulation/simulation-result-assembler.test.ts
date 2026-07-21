import { describe, expect, it } from "vitest";
import { assembleSimulationResult } from "./simulation-result-assembler.js";
import { ApplicationError } from "../contracts/application-error.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import {
  createActionId,
  createDomainEventId,
  createEffectInstanceId,
} from "../../domain/shared/event-ids.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");

function recordBattleStarted(recorder: EventRecorder): void {
  recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
    stateDelta: { battleStatus: { before: "READY", after: "RUNNING" } },
  });
}

/** BattleStarted(version 0->1) -> TurnStarted(version 1->2)の2件のstateDelta付きイベント。 */
function recordTwoDeltaEvents(recorder: EventRecorder): void {
  recordBattleStarted(recorder);
  recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
    stateDelta: { turnNumber: { before: 0, after: 1 } },
  });
}

function baseInput(events: readonly BattleDomainEvent[]) {
  return {
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    logLevel: "DETAILED" as const,
    result: {
      outcome: "ALLY_WIN" as const,
      completionReason: "ENEMY_DEFEATED" as const,
      completedTurn: 3,
    },
    initialState: { status: "READY" as const, currentTurn: 0, units: {} },
    finalState: { status: "RUNNING" as const, currentTurn: 1, units: {} },
    events,
    unitRoster: [],
  };
}

describe("assembleSimulationResult", () => {
  it("UT-RESULT-ASSEMBLER-001: packages the battle outcome fields and initialState/finalState/events/stateTransitions at the top level (09_アプリケーション設計.md SimulateBattleResult)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder);
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    // Consistent with the single recorded delta (READY -> RUNNING only).
    const finalState = { status: "RUNNING" as const, currentTurn: 0, units: {} };

    const result = assembleSimulationResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "DETAILED",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      initialState,
      finalState,
      events: recorder.getEvents(),
      unitRoster: [],
    });

    expect(result.battleId).toBe(BATTLE_ID);
    expect(result.catalogRevision).toBe("rev-1");
    expect(result.outcome).toBe("ALLY_WIN");
    expect(result.completionReason).toBe("ENEMY_DEFEATED");
    expect(result.completedTurn).toBe(3);
    expect(result.initialState).toBe(initialState);
    expect(result.finalState).toBe(finalState);
    expect(result.events).toHaveLength(1);
    expect(result.stateTransitions).toHaveLength(1);
  });

  it("UT-RESULT-ASSEMBLER-002: throws INTERNAL_INVARIANT_VIOLATION when the given finalState does not match initialState + stateTransitions restored through the independent Reducer", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder);
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    // Only a READY -> RUNNING delta was recorded, so a finalState claiming
    // COMPLETED/turn 3 is inconsistent with the recorded event log.
    const finalState = { status: "COMPLETED" as const, currentTurn: 3, units: {} };

    expect(() =>
      assembleSimulationResult({
        battleId: BATTLE_ID,
        catalogRevision: "rev-1",
        logLevel: "DETAILED",
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
        initialState,
        finalState,
        events: recorder.getEvents(),
        unitRoster: [],
      }),
    ).toThrow(ApplicationError);
  });

  it("UT-RESULT-ASSEMBLER-007: filters events by logLevel (SUMMARY) while keeping stateTransitions complete", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // BattleStarted is SUMMARY-visible and carries the only delta.
    recorder.record({
      eventType: "TargetsSelected",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { skillDefinitionId: "SKL_1" as never, bindings: [] },
    });
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    const finalState = { status: "RUNNING" as const, currentTurn: 0, units: {} };

    const result = assembleSimulationResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "SUMMARY",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      initialState,
      finalState,
      events: recorder.getEvents(),
      unitRoster: [],
    });

    expect(result.events.map((e) => e.type)).toEqual(["BATTLE_STARTED"]);
    // stateTransitions is unaffected by logLevel: it stays complete either way.
    expect(result.stateTransitions).toHaveLength(1);
  });

  it("UT-RESULT-ASSEMBLER-003: converts a Reducer-detected broken delta sequence (DomainValidationError) into INTERNAL_INVARIANT_VIOLATION, not INVALID_COMMAND", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
      // before ("RUNNING") does not match initialState.status ("READY"): the
      // independent Reducer rejects this as a DomainValidationError.
      stateDelta: { battleStatus: { before: "RUNNING", after: "COMPLETED" } },
    });

    try {
      assembleSimulationResult(baseInput(recorder.getEvents()));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-004: throws INTERNAL_INVARIANT_VIOLATION when a transition's stateVersionAfter skips ahead of stateVersionBefore + 1 (missing version)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordTwoDeltaEvents(recorder);
    const [battleStarted, turnStarted] = recorder.getEvents();
    const corrupted: readonly BattleDomainEvent[] = [
      battleStarted!,
      { ...turnStarted!, stateVersionBefore: 1, stateVersionAfter: 3 },
    ];

    try {
      assembleSimulationResult(baseInput(corrupted));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-005: throws INTERNAL_INVARIANT_VIOLATION when the first transition's stateVersionBefore is not 0 (reversed order)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordTwoDeltaEvents(recorder);
    const [battleStarted, turnStarted] = recorder.getEvents();
    const reversed: readonly BattleDomainEvent[] = [turnStarted!, battleStarted!];

    try {
      assembleSimulationResult(baseInput(reversed));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-006: throws INTERNAL_INVARIANT_VIOLATION when a stateVersion is duplicated across transitions", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder);
    const [battleStarted] = recorder.getEvents();
    const duplicated: readonly BattleDomainEvent[] = [battleStarted!, battleStarted!];

    try {
      assembleSimulationResult(baseInput(duplicated));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-008 (P2: 内部因果関係の破損はINTERNAL_INVARIANT_VIOLATION): converts a BattleLogEvent conversion failure (dangling rootEventId) into INTERNAL_INVARIANT_VIOLATION, not INVALID_COMMAND", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
    });
    const [battleStarted] = recorder.getEvents();
    // No stateDelta, so version-continuity/Reducer checks trivially pass —
    // this isolates the failure to BattleLogEvent conversion (rootSequence
    // resolution) rather than the state-restoration path already covered above.
    const dangling: readonly BattleDomainEvent[] = [
      { ...battleStarted!, rootEventId: createDomainEventId("battle-1:999") },
    ];
    const state = { status: "READY" as const, currentTurn: 0, units: {} };

    try {
      assembleSimulationResult({
        battleId: BATTLE_ID,
        catalogRevision: "rev-1",
        logLevel: "DETAILED",
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
        initialState: state,
        finalState: state,
        events: dangling,
        unitRoster: [],
      });
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-009 (R-SKL-05 / regression PR#128 review [P1]): restores a real ChargeStarted->ChargeReleased StateDelta sequence without INTERNAL_INVARIANT_VIOLATION, even though each event independently builds its own ChargeState payload object", () => {
    const UNIT_A = createBattleUnitId("unit-a");
    const skillDefinitionId = createSkillDefinitionId("SKL_CHARGE");
    const startedActionId = createActionId("battle-1:action:1");

    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // version 0->1: battleStatus READY->RUNNING.
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId: startedActionId,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      payload: {
        actorUnitId: UNIT_A,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
      stateDelta: { units: { [UNIT_A]: { ap: { before: 1, after: 0 } } } }, // version 1->2.
    });
    // Mirrors `resolveChargeStart`: builds its own ChargeState object literal.
    recorder.record({
      eventType: "ChargeStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId: startedActionId,
      resolutionScopeId: actionStarted.resolutionScopeId,
      parentEventId: actionStarted.eventId,
      rootEventId: actionStarted.eventId,
      sourceUnitId: UNIT_A,
      payload: { actorUnitId: UNIT_A, skillDefinitionId, startedActionId },
      stateDelta: {
        units: {
          [UNIT_A]: {
            charge: { before: undefined, after: { skillDefinitionId, startedActionId } },
          },
        },
      },
    }); // version 2->3.
    const releaseActionId = createActionId("battle-1:action:2");
    recorder.record({
      eventType: "ChargeReleased",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 2,
      actionId: releaseActionId,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      payload: {
        actorUnitId: UNIT_A,
        skillDefinitionId,
        chargeStartActionId: startedActionId,
        releaseActionId,
      },
      stateDelta: {
        // Mirrors `resolveChargeRelease`: an independently-built ChargeState
        // object, structurally identical to ChargeStarted's `.after` but not
        // the same reference.
        units: {
          [UNIT_A]: {
            charge: { before: { skillDefinitionId, startedActionId }, after: undefined },
          },
        },
      },
    }); // version 3->4.

    const initialState = {
      status: "READY" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 1, pp: 0, extraGauge: 0 } },
    };
    const finalState = {
      status: "RUNNING" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 0, pp: 0, extraGauge: 0 } },
    };

    const result = assembleSimulationResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "DETAILED",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      initialState,
      finalState,
      events: recorder.getEvents(),
      unitRoster: [],
    });

    expect(result.stateTransitions).toHaveLength(4);
  });

  it("UT-RESULT-ASSEMBLER-010 (M5 review [P2] fix): restores a CooldownStarted->CooldownReduced StateDelta sequence without INTERNAL_INVARIANT_VIOLATION", () => {
    const UNIT_A = createBattleUnitId("unit-a");
    const skillDefinitionId = createSkillDefinitionId("SKL_CD");

    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // version 0->1.
    recorder.record({
      eventType: "CooldownStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      payload: { actorUnitId: UNIT_A, skillDefinitionId, unit: "ACTION", initialRemaining: 2 },
      stateDelta: {
        units: {
          [UNIT_A]: { cooldowns: { [skillDefinitionId]: { unit: "ACTION", before: 0, after: 2 } } },
        },
      },
    }); // version 1->2.
    recorder.record({
      eventType: "CooldownReduced",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 2,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      payload: { actorUnitId: UNIT_A, skillDefinitionId, unit: "ACTION", before: 2, after: 1 },
      stateDelta: {
        units: {
          [UNIT_A]: { cooldowns: { [skillDefinitionId]: { unit: "ACTION", before: 2, after: 1 } } },
        },
      },
    }); // version 2->3.

    const initialState = {
      status: "READY" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 1, pp: 0, extraGauge: 0 } },
    };
    const finalState = {
      status: "RUNNING" as const,
      currentTurn: 0,
      units: {
        [UNIT_A]: {
          hp: 100,
          ap: 1,
          pp: 0,
          extraGauge: 0,
          cooldowns: { [skillDefinitionId]: { unit: "ACTION" as const, remaining: 1 } },
        },
      },
    };

    const result = assembleSimulationResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "DETAILED",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      initialState,
      finalState,
      events: recorder.getEvents(),
      unitRoster: [],
    });

    expect(result.stateTransitions).toHaveLength(3);
  });

  it("UT-RESULT-ASSEMBLER-011 (M5 review [P2] regression): throws INTERNAL_INVARIANT_VIOLATION when the given finalState's cooldowns disagree with initialState + stateTransitions restored through the independent Reducer (previously unitSnapshotsEqual ignored cooldowns entirely and let this slip through)", () => {
    const UNIT_A = createBattleUnitId("unit-a");
    const skillDefinitionId = createSkillDefinitionId("SKL_CD");

    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // version 0->1.
    recorder.record({
      eventType: "CooldownStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      payload: { actorUnitId: UNIT_A, skillDefinitionId, unit: "ACTION", initialRemaining: 2 },
      stateDelta: {
        units: {
          [UNIT_A]: { cooldowns: { [skillDefinitionId]: { unit: "ACTION", before: 0, after: 2 } } },
        },
      },
    }); // version 1->2.

    const initialState = {
      status: "READY" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 1, pp: 0, extraGauge: 0 } },
    };
    // The recorded delta sets remaining to 2, but this finalState (wrongly)
    // claims 3 — a state-changing event's stateDelta silently dropped the real
    // value.
    const finalState = {
      status: "RUNNING" as const,
      currentTurn: 0,
      units: {
        [UNIT_A]: {
          hp: 100,
          ap: 1,
          pp: 0,
          extraGauge: 0,
          cooldowns: { [skillDefinitionId]: { unit: "ACTION" as const, remaining: 3 } },
        },
      },
    };

    let error: unknown;
    try {
      assembleSimulationResult({
        battleId: BATTLE_ID,
        catalogRevision: "rev-1",
        logLevel: "DETAILED",
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
        initialState,
        finalState,
        events: recorder.getEvents(),
        unitRoster: [],
      });
      expect.unreachable("expected assembleSimulationResult to throw");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
  });

  it("UT-RESULT-ASSEMBLER-012 (M5 review round 2 [P1] fix): throws INTERNAL_INVARIANT_VIOLATION when the given finalState's cooldown setActionId disagrees with the CooldownStarted delta's setActionId (setActionId/setTurnNumber are now delta-tracked, not exempted from restoration)", () => {
    const UNIT_A = createBattleUnitId("unit-a");
    const skillDefinitionId = createSkillDefinitionId("SKL_CD");
    const recordedActionId = createActionId("battle-1:action:1");
    const claimedActionId = createActionId("battle-1:action:9");

    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // version 0->1.
    recorder.record({
      eventType: "CooldownStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      payload: { actorUnitId: UNIT_A, skillDefinitionId, unit: "ACTION", initialRemaining: 2 },
      stateDelta: {
        units: {
          [UNIT_A]: {
            cooldowns: {
              [skillDefinitionId]: {
                unit: "ACTION",
                before: 0,
                after: 2,
                setActionId: recordedActionId,
              },
            },
          },
        },
      },
    }); // version 1->2.

    const initialState = {
      status: "READY" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 1, pp: 0, extraGauge: 0 } },
    };
    // Claims a different setActionId than the one the delta actually recorded.
    const finalState = {
      status: "RUNNING" as const,
      currentTurn: 0,
      units: {
        [UNIT_A]: {
          hp: 100,
          ap: 1,
          pp: 0,
          extraGauge: 0,
          cooldowns: {
            [skillDefinitionId]: {
              unit: "ACTION" as const,
              remaining: 2,
              setActionId: claimedActionId,
            },
          },
        },
      },
    };

    let error: unknown;
    try {
      assembleSimulationResult({
        battleId: BATTLE_ID,
        catalogRevision: "rev-1",
        logLevel: "DETAILED",
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
        initialState,
        finalState,
        events: recorder.getEvents(),
        unitRoster: [],
      });
      expect.unreachable("expected assembleSimulationResult to throw");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
  });

  it("UT-R-EFF-01-013 (R-EFF-01): throws INTERNAL_INVARIANT_VIOLATION when the given finalState's applied effects disagree with initialState + stateTransitions restored through the independent Reducer (unitSnapshotsEqual must not ignore effects, mirroring UT-RESULT-ASSEMBLER-011's cooldowns regression)", () => {
    const UNIT_A = createBattleUnitId("unit-a");
    const effectInstanceId = createEffectInstanceId("battle-1:effect:1");

    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // version 0->1.
    recorder.record({
      eventType: "EffectApplied",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: UNIT_A,
      targetUnitIds: [UNIT_A],
      payload: {
        effectInstanceId,
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_UP"),
        sourceUnitId: UNIT_A,
        targetUnitId: UNIT_A,
        duplicate: true,
        kindKey: "ACT_ATK_UP",
        magnitude: 20,
        linkedEffectGroupId: null,
      },
      stateDelta: {
        units: {
          [UNIT_A]: {
            effects: {
              [effectInstanceId]: {
                before: undefined,
                after: {
                  effectInstanceId,
                  effectDefinitionId: "ACT_ATK_UP",
                  sourceUnitId: UNIT_A,
                  kindKey: "ACT_ATK_UP",
                  duplicate: true,
                  magnitude: 20,
                  appliedTurnNumber: 1,
                },
              },
            },
          },
        },
      },
    }); // version 1->2.

    const initialState = {
      status: "READY" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 1, pp: 0, extraGauge: 0 } },
    };
    // The recorded delta grants an effect with magnitude 20, but this
    // finalState (wrongly) claims no effects at all — a state-changing
    // event's stateDelta silently dropped the real value.
    const finalState = {
      status: "RUNNING" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 1, pp: 0, extraGauge: 0 } },
    };

    let error: unknown;
    try {
      assembleSimulationResult({
        battleId: BATTLE_ID,
        catalogRevision: "rev-1",
        logLevel: "DETAILED",
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
        initialState,
        finalState,
        events: recorder.getEvents(),
        unitRoster: [],
      });
      expect.unreachable("expected assembleSimulationResult to throw");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
  });
});
