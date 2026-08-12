import { CATALOG_REVISION } from "./catalog.js";

// Regression fixture: a minimal successful tactical exercise response for the
// 1-ally vs 1-enemy formation catalog.ts allows. Carries one of each exercise
// event (score/break/revive) plus an unknown one, so the mock-API E2E suite
// exercises both the exercise formatters and the generic fallback
// (UI-AC-022, UI-API-016).
export const exerciseSuccessFixture = {
  schemaVersion: 1,
  battleId: "exercise-e2e-001",
  catalogRevision: CATALOG_REVISION,
  result: {
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    totalScore: 4200,
    breakCount: 1,
    breaks: [{ breakNumber: 1, turnNumber: 3, cumulativeScoreAtBreak: 2100 }],
  },
  initialState: {
    stateVersion: 0,
    battleStatus: "READY",
    turnNumber: 0,
    cycleNumber: 0,
    units: [
      {
        battleUnitId: "bu-ally-1",
        unitDefinitionId: "UNIT_ALLY_A",
        side: "ALLY",
        combatStatus: "ACTIVE",
        hp: { current: 100, maximum: 100 },
      },
      {
        battleUnitId: "bu-enemy-1",
        unitDefinitionId: "UNIT_ENEMY_A",
        side: "ENEMY",
        combatStatus: "ACTIVE",
        hp: { current: 80, maximum: 80 },
      },
    ],
  },
  finalState: {
    stateVersion: 5,
    battleStatus: "COMPLETED",
    turnNumber: 5,
    cycleNumber: 2,
    units: [
      {
        battleUnitId: "bu-ally-1",
        unitDefinitionId: "UNIT_ALLY_A",
        side: "ALLY",
        combatStatus: "ACTIVE",
        hp: { current: 60, maximum: 100 },
      },
      {
        battleUnitId: "bu-enemy-1",
        unitDefinitionId: "UNIT_ENEMY_A",
        side: "ENEMY",
        combatStatus: "ACTIVE",
        hp: { current: 80, maximum: 80 },
      },
    ],
  },
  events: [
    {
      eventId: "evt-1",
      type: "EXERCISE_SCORE_ACCUMULATED",
      details: {
        targetUnitId: "bu-enemy-1",
        amount: 2100,
        totalScore: 2100,
        causeEventId: "evt-0",
      },
    },
    {
      eventId: "evt-2",
      type: "UNIT_BROKEN",
      details: {
        unitId: "bu-enemy-1",
        breakNumber: 1,
        turnNumber: 3,
        totalScore: 2100,
        causeEventId: "evt-1",
      },
    },
    {
      eventId: "evt-3",
      type: "UNIT_REVIVED",
      details: { unitId: "bu-enemy-1", breakNumber: 1, hpAfter: 80 },
    },
    { eventId: "evt-4", type: "MYSTERIOUS_FUTURE_EXERCISE_EVENT", details: { note: "unknown" } },
  ],
  stateTransitions: [],
};
