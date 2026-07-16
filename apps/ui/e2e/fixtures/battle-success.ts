import { CATALOG_REVISION } from "./catalog.js";

// Regression fixture: a minimal successful battle response for a 1v1 formed
// from catalog.ts's two selectable units. Includes one intentionally unknown
// event type (MYSTERIOUS_FUTURE_EVENT) so the mock-API E2E suite exercises
// the generic event fallback end-to-end (UI-AC-011, UI-TEST-003) without
// waiting for a real future-milestone event contract.
export const battleSuccessFixture = {
  schemaVersion: 1,
  battleId: "battle-e2e-001",
  catalogRevision: CATALOG_REVISION,
  result: {
    outcome: "ALLY_WIN",
    completionReason: "ENEMY_DEFEATED",
    completedTurn: 2,
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
    stateVersion: 2,
    battleStatus: "COMPLETED",
    turnNumber: 2,
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
        combatStatus: "DEFEATED",
        hp: { current: 0, maximum: 80 },
      },
    ],
  },
  events: [
    {
      sequence: 0,
      type: "TURN_STARTED",
      turnNumber: 1,
      cycleNumber: 1,
      stateVersionAfter: 1,
      details: { turnNumber: 1 },
    },
    {
      sequence: 1,
      type: "DAMAGE_APPLIED",
      turnNumber: 1,
      cycleNumber: 1,
      sourceUnitId: "bu-ally-1",
      targetUnitIds: ["bu-enemy-1"],
      stateVersionAfter: 2,
      stateTransitionIndex: 0,
      details: {
        targetUnitId: "bu-enemy-1",
        calculatedDamage: 80,
        hitPointDamage: 80,
        hpBefore: 80,
        hpAfter: 0,
      },
    },
    {
      sequence: 2,
      type: "MYSTERIOUS_FUTURE_EVENT",
      turnNumber: 2,
      cycleNumber: 1,
      sourceUnitId: "bu-ally-1",
      targetUnitIds: ["bu-enemy-1"],
      stateVersionAfter: 2,
      details: { note: "not yet contracted by any milestone" },
    },
  ],
  stateTransitions: [
    {
      stateVersionBefore: 1,
      stateVersionAfter: 2,
      causedBySequence: 1,
      delta: {
        units: {
          "bu-enemy-1": { hp: { current: 0 }, combatStatus: "DEFEATED" },
        },
      },
    },
  ],
};
