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
    // R-TEX-03 #2: ブレイクの発生源ユニット。`UNIT_ALLY_A`はcatalog.tsで
    // 「アライアルファ」として解決される。
    breaks: [
      {
        breakNumber: 1,
        turnNumber: 3,
        cumulativeScoreAtBreak: 2100,
        sourceUnitDefinitionId: "UNIT_ALLY_A",
      },
    ],
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
        unitDefinitionId: "UNIT_EXERCISE_A",
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
        unitDefinitionId: "UNIT_EXERCISE_A",
        side: "ENEMY",
        combatStatus: "ACTIVE",
        hp: { current: 80, maximum: 80 },
      },
    ],
  },
  // サーバー集計（docs/ddd/10_API設計.md「UnitBattleSummaryResponse」）。
  // 演習も通常戦闘と同じ形で返る。
  unitSummaries: [
    {
      battleUnitId: "bu-ally-1",
      side: "ALLY",
      damageDealt: 200,
      damageTaken: 40,
      healingDone: 0,
      finalHp: 60,
      maximumHp: 100,
      combatStatus: "ACTIVE",
    },
    {
      battleUnitId: "bu-enemy-1",
      side: "ENEMY",
      damageDealt: 40,
      damageTaken: 200,
      healingDone: 0,
      finalHp: 80,
      maximumHp: 80,
      combatStatus: "ACTIVE",
    },
  ],

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
