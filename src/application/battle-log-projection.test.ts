import { describe, expect, it } from "vitest";
import { projectEventsForLogLevel } from "./battle-log-projection.js";
import type {
  BattleDomainEvent,
  BattleDomainEventType,
} from "../domain/battle/events/domain-event.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleId } from "../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");

function recordAllM3Events(): readonly BattleDomainEvent[] {
  const recorder = new EventRecorder(BATTLE_ID);
  const scope = () => recorder.nextResolutionScopeId();
  const actionId = recorder.nextActionId();
  const skillUseId = recorder.nextSkillUseId();

  recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnLimit: 1, allySlotCount: 1, enemySlotCount: 1 },
  });
  recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnNumber: 1 },
  });
  recorder.record({
    eventType: "ResourcesRecovered",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { units: [] },
  });
  recorder.record({
    eventType: "ActionQueueCreated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: scope(),
    payload: { cycleNumber: 1, reservations: [] },
  });
  recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    payload: {
      actorUnitId: "ally:1" as never,
      reservedActionType: "AS",
      effectiveActionType: "AS",
      apBefore: 1,
      apAfter: 0,
      exBefore: 0,
      exAfter: 0,
    },
  });
  recorder.record({
    eventType: "TargetsSelected",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { skillDefinitionId: "SKL_1" as never, bindings: [] },
  });
  recorder.record({
    eventType: "SkillUseStarting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      skillDefinitionId: "SKL_1" as never,
      actorUnitId: "ally:1" as never,
      targetUnitIds: [],
      costResource: "AP",
      costAmount: 1,
    },
  });
  recorder.record({
    eventType: "SkillUseStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { skillDefinitionId: "SKL_1" as never, costResource: "AP", costAmount: 1 },
  });
  recorder.record({
    eventType: "HitConfirmed",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      skillDefinitionId: "SKL_1" as never,
      effectActionDefinitionId: "ACT_1" as never,
      hitIndex: 1,
      targetUnitId: "enemy:1" as never,
    },
  });
  recorder.record({
    eventType: "CriticalCheckResolved",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { mode: "PREVENTED", baseCriticalRate: 0, effectiveCriticalRate: 0, result: false },
  });
  recorder.record({
    eventType: "DamageCalculated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      skillDefinitionId: "SKL_1" as never,
      effectActionDefinitionId: "ACT_1" as never,
      hitIndex: 1,
      targetUnitId: "enemy:1" as never,
      attackerAttack: 10,
      defenderDefense: 0,
      effectiveDefense: 0,
      defenseIgnoreRate: 0,
      skillPower: 1,
      attributeMultiplier: 1,
      criticalMultiplier: 1,
      actionDamageMultiplier: 1,
      preTruncationDamage: 10,
      finalDamage: 10,
      damageType: "PHYSICAL",
    },
  });
  recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      effectActionDefinitionId: "ACT_1" as never,
      hitIndex: 1,
      targetUnitId: "enemy:1" as never,
      calculatedDamage: 10,
      hitPointDamage: 10,
      hpBefore: 10,
      hpAfter: 0,
      defeated: true,
    },
  });
  recorder.record({
    eventType: "UnitDefeated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { unitId: "enemy:1" as never, causeEventId: "battle-1:1" as never },
  });
  recorder.record({
    eventType: "SkillUseCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { skillDefinitionId: "SKL_1" as never, resolvedStepCount: 1, targetUnitIds: [] },
  });
  recorder.record({
    eventType: "ActionCompleting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    payload: { actorUnitId: "ally:1" as never, effectiveActionType: "AS" },
  });
  recorder.record({
    eventType: "ActionCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    payload: { actorUnitId: "ally:1" as never, effectiveActionType: "AS" },
  });
  recorder.record({
    eventType: "TurnCompleting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnNumber: 1 },
  });
  recorder.record({
    eventType: "TurnCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnNumber: 1 },
  });
  recorder.record({
    eventType: "BattleCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
  });

  return recorder.getEvents();
}

describe("projectEventsForLogLevel", () => {
  it("UT-LOG-PROJECTION-001: SUMMARY keeps only BattleStarted/ActionCompleted/UnitDefeated/TurnCompleted/BattleCompleted", () => {
    const events = recordAllM3Events();

    const projected = projectEventsForLogLevel(events, "SUMMARY");

    // Sequence order, not the order listed in 08_ドメインイベント.md's prose:
    // UnitDefeated (mid-action) precedes ActionCompleted (end of action).
    const expectedTypes: readonly BattleDomainEventType[] = [
      "BattleStarted",
      "UnitDefeated",
      "ActionCompleted",
      "TurnCompleted",
      "BattleCompleted",
    ];
    expect(projected.map((e) => e.eventType)).toEqual(expectedTypes);
  });

  it("UT-LOG-PROJECTION-002: DETAILED keeps the full M3 event set", () => {
    const events = recordAllM3Events();

    const projected = projectEventsForLogLevel(events, "DETAILED");

    expect(projected).toEqual(events);
  });

  it("UT-LOG-PROJECTION-003: DIAGNOSTIC keeps the full M3 event set (no DIAGNOSTIC-category events exist yet)", () => {
    const events = recordAllM3Events();

    const projected = projectEventsForLogLevel(events, "DIAGNOSTIC");

    expect(projected).toEqual(events);
  });

  it("UT-LOG-PROJECTION-004: preserves sequence order within the SUMMARY subset", () => {
    const events = recordAllM3Events();

    const projected = projectEventsForLogLevel(events, "SUMMARY");

    const sequences = projected.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });
});
