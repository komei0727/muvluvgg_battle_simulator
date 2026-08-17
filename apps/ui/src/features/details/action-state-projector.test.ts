import { describe, expect, it } from "vitest";
import { selectUnitActionStates } from "./action-state-projector.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type {
  BattleLogEventResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
];

function cooldownStartedEvent(overrides: {
  sequence: number;
  actorUnitId: string;
  skillDefinitionId: string;
  initialRemaining: number;
  unit?: string;
}): BattleLogEventResponse {
  return {
    sequence: overrides.sequence,
    type: "COOLDOWN_STARTED",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    sourceUnitId: overrides.actorUnitId,
    targetUnitIds: [],
    details: {
      actorUnitId: overrides.actorUnitId,
      skillDefinitionId: overrides.skillDefinitionId,
      unit: overrides.unit ?? "TURN",
      initialRemaining: overrides.initialRemaining,
    },
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  };
}

function cooldownReducedEvent(overrides: {
  sequence: number;
  actorUnitId: string;
  skillDefinitionId: string;
  before: number;
  after: number;
}): BattleLogEventResponse {
  return {
    sequence: overrides.sequence,
    type: "COOLDOWN_REDUCED",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    sourceUnitId: overrides.actorUnitId,
    targetUnitIds: [],
    details: {
      actorUnitId: overrides.actorUnitId,
      skillDefinitionId: overrides.skillDefinitionId,
      unit: "TURN",
      before: overrides.before,
      after: overrides.after,
    },
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  };
}

function cooldownCompletedEvent(overrides: {
  sequence: number;
  actorUnitId: string;
  skillDefinitionId: string;
}): BattleLogEventResponse {
  return {
    sequence: overrides.sequence,
    type: "COOLDOWN_COMPLETED",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    sourceUnitId: overrides.actorUnitId,
    targetUnitIds: [],
    details: {
      actorUnitId: overrides.actorUnitId,
      skillDefinitionId: overrides.skillDefinitionId,
      unit: "TURN",
    },
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  };
}

function chargeStartedEvent(overrides: {
  sequence: number;
  actorUnitId: string;
  skillDefinitionId: string;
}): BattleLogEventResponse {
  return {
    sequence: overrides.sequence,
    type: "CHARGE_STARTED",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    sourceUnitId: overrides.actorUnitId,
    targetUnitIds: [],
    details: {
      actorUnitId: overrides.actorUnitId,
      skillDefinitionId: overrides.skillDefinitionId,
      startedActionId: "action-1",
    },
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  };
}

function chargeReleasedEvent(overrides: {
  sequence: number;
  actorUnitId: string;
  skillDefinitionId: string;
}): BattleLogEventResponse {
  return {
    sequence: overrides.sequence,
    type: "CHARGE_RELEASED",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    sourceUnitId: overrides.actorUnitId,
    targetUnitIds: [],
    details: {
      actorUnitId: overrides.actorUnitId,
      skillDefinitionId: overrides.skillDefinitionId,
      chargeStartActionId: "action-1",
      releaseActionId: "action-3",
    },
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  };
}

function responseWith(overrides: {
  finalUnits: readonly Record<string, unknown>[];
  events?: readonly BattleLogEventResponse[];
}): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: overrides.finalUnits as never },
    finalState: { units: overrides.finalUnits as never },
    unitSummaries: [],
    events: overrides.events ?? [],
    stateTransitions: [],
  };
}

describe("selectUnitActionStates", () => {
  it("reads AP/PP/EX current and maximum from finalState.units[].resources (UI-UT-ACT-001)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          resources: {
            ap: { current: 2, maximum: 3 },
            pp: { current: 5, maximum: 8 },
            extraGauge: { current: 40, maximum: 100 },
          },
        },
        { battleUnitId: "enemy:1" },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]).toMatchObject({
      battleUnitId: "ally:1",
      ap: { current: 2, maximum: 3 },
      pp: { current: 5, maximum: 8 },
      extraGauge: { current: 40, maximum: 100 },
    });
  });

  it("returns undefined resources for a unit without a resources field, without crashing (M4 fixture back-compat)", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.ap).toBeUndefined();
    expect(states[0]?.pp).toBeUndefined();
    expect(states[0]?.extraGauge).toBeUndefined();
    expect(states[0]?.cooldowns).toEqual([]);
    expect(states[0]?.charge).toBeUndefined();
    expect(states[0]?.cooldownChargeKnown).toBe(true);
  });

  it("tracks a cooldown from COOLDOWN_STARTED for the acting battleUnitId (UI-UT-ACT-002)", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [
        cooldownStartedEvent({
          sequence: 1,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          initialRemaining: 3,
        }),
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.cooldowns).toEqual([
      { skillDefinitionId: "SKILL_1", unit: "TURN", remaining: 3 },
    ]);
    expect(states[1]?.cooldowns).toEqual([]);
  });

  it("updates the remaining count on COOLDOWN_REDUCED and removes it on COOLDOWN_COMPLETED, in sequence order", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [
        cooldownCompletedEvent({
          sequence: 3,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
        }),
        cooldownStartedEvent({
          sequence: 1,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          initialRemaining: 3,
        }),
        cooldownReducedEvent({
          sequence: 2,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          before: 3,
          after: 2,
        }),
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.cooldowns).toEqual([]);
  });

  it("keeps a reduced-but-not-completed cooldown at its latest remaining count", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [
        cooldownStartedEvent({
          sequence: 1,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          initialRemaining: 3,
        }),
        cooldownReducedEvent({
          sequence: 2,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          before: 3,
          after: 2,
        }),
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.cooldowns).toEqual([
      { skillDefinitionId: "SKILL_1", unit: "TURN", remaining: 2 },
    ]);
  });

  it("tracks charge from CHARGE_STARTED and clears it on CHARGE_RELEASED, in sequence order", () => {
    const stillCharging = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [
        chargeStartedEvent({ sequence: 1, actorUnitId: "ally:1", skillDefinitionId: "SKILL_2" }),
      ],
    });
    expect(selectUnitActionStates(stillCharging, roster, "DETAILED")[0]?.charge).toEqual({
      skillDefinitionId: "SKILL_2",
    });

    const released = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [
        chargeStartedEvent({ sequence: 1, actorUnitId: "ally:1", skillDefinitionId: "SKILL_2" }),
        chargeReleasedEvent({ sequence: 2, actorUnitId: "ally:1", skillDefinitionId: "SKILL_2" }),
      ],
    });
    expect(selectUnitActionStates(released, roster, "DETAILED")[0]?.charge).toBeUndefined();
  });

  it("ignores a cooldown/charge event with a malformed details shape instead of crashing (UI-AC-011)", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [
        {
          sequence: 1,
          type: "COOLDOWN_STARTED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 1,
          targetUnitIds: [],
          details: { unexpected: true },
          stateVersionBefore: 0,
          stateVersionAfter: 0,
        },
      ],
    });

    expect(() => selectUnitActionStates(response, roster, "DETAILED")).not.toThrow();
    expect(selectUnitActionStates(response, roster, "DETAILED")[0]?.cooldowns).toEqual([]);
  });

  it('marks cooldown/charge as unknown (not "none") when logLevel is SUMMARY, since COOLDOWN_*/CHARGE_* events are excluded from the SUMMARY log', () => {
    // apps/api/src/application/observation/battle-log-projection.ts SUMMARY_EVENT_TYPES does not
    // include CooldownStarted/CooldownReduced/CooldownCompleted/ChargeStarted/
    // ChargeReleased, so a SUMMARY-level response never carries these events even
    // when a skill is genuinely on cooldown or charging.
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
      events: [],
    });

    const states = selectUnitActionStates(response, roster, "SUMMARY");

    expect(states[0]?.cooldownChargeKnown).toBe(false);
    expect(states[1]?.cooldownChargeKnown).toBe(false);
  });

  it("marks cooldown/charge as known for the DETAILED log level", () => {
    const response = responseWith({ finalUnits: [{ battleUnitId: "ally:1" }] });

    expect(selectUnitActionStates(response, roster, "DETAILED")[0]?.cooldownChargeKnown).toBe(true);
  });

  it("reads cooldowns/charge directly from finalState.units[] when it carries the M5+ shape (cooldowns is an array), ignoring events entirely", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [{ skillDefinitionId: "SKILL_1", unit: "ACTION", remaining: 2 }],
          charge: { skillDefinitionId: "SKILL_2", startedActionId: "action-1", status: "CHARGING" },
        },
        { battleUnitId: "enemy:1", cooldowns: [] },
      ],
      // Deliberately contradicts finalState (would show a different cooldown
      // if the events[] fallback were still consulted) — proves finalState wins.
      events: [
        cooldownStartedEvent({
          sequence: 1,
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_STALE",
          initialRemaining: 9,
        }),
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.cooldowns).toEqual([
      { skillDefinitionId: "SKILL_1", unit: "ACTION", remaining: 2 },
    ]);
    expect(states[0]?.charge).toEqual({ skillDefinitionId: "SKILL_2" });
    expect(states[1]?.cooldowns).toEqual([]);
    expect(states[1]?.charge).toBeUndefined();
  });

  it("treats cooldownChargeKnown as true from finalState even at SUMMARY logLevel, since finalState is complete regardless of logLevel (the SUMMARY 'unknown' problem no longer applies once finalState carries real cooldowns/charge)", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1", cooldowns: [] }],
      events: [],
    });

    const states = selectUnitActionStates(response, roster, "SUMMARY");

    expect(states[0]?.cooldownChargeKnown).toBe(true);
    expect(states[0]?.cooldowns).toEqual([]);
  });
  it("reads finalState.units[].effects into per-unit effect states, keeping the API's category/statusKind (UI-UT-EFF-001)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [],
          effects: [
            {
              effectInstanceId: "battle-1:effect:1",
              effectDefinitionId: "ACT_ATTACK_UP",
              sourceUnitId: "ally:1",
              category: "BUFF",
              effectKindKey: "ACT_ATTACK_UP",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0.1 },
              duration: { unit: "TURN", remaining: 2 },
              appliedTurnNumber: 1,
            },
            {
              effectInstanceId: "battle-1:effect:2",
              effectDefinitionId: "ACT_STUN_1",
              sourceUnitId: "enemy:1",
              category: "STATUS_ABNORMALITY",
              effectKindKey: "ACT_STUN_1",
              statusKind: "STUN",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0 },
              duration: { unit: "ACTION", remaining: 1 },
              appliedTurnNumber: 2,
            },
          ],
        },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.effectsKnown).toBe(true);
    expect(states[0]?.effects).toEqual([
      {
        effectInstanceId: "battle-1:effect:1",
        effectDefinitionId: "ACT_ATTACK_UP",
        category: "BUFF",
        isEffective: true,
        duration: { unit: "TURN", remaining: 2 },
      },
      {
        effectInstanceId: "battle-1:effect:2",
        effectDefinitionId: "ACT_STUN_1",
        category: "STATUS_ABNORMALITY",
        statusKind: "STUN",
        isEffective: true,
        duration: { unit: "ACTION", remaining: 1 },
      },
    ]);
    expect(states[1]?.effects).toEqual([]);
    expect(states[1]?.effectsKnown).toBe(true);
  });

  it("keeps a permanent effect (no duration) and a superseded duplicate (isEffective=false) instead of dropping them (UI-UT-EFF-002)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [],
          effects: [
            {
              effectInstanceId: "battle-1:effect:1",
              effectDefinitionId: "ACT_ATTACK_UP",
              category: "BUFF",
              effectKindKey: "ACT_ATTACK_UP",
              stackMode: "NON_STACKING",
              isEffective: false,
              value: { magnitude: 0.1 },
              appliedTurnNumber: 1,
            },
          ],
        },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.effects).toEqual([
      {
        effectInstanceId: "battle-1:effect:1",
        effectDefinitionId: "ACT_ATTACK_UP",
        category: "BUFF",
        isEffective: false,
      },
    ]);
  });

  it("reports effects as unknown, not as an empty list, when finalState has no effects array (M4〜M6 fixture back-compat, UI-UT-EFF-003)", () => {
    const response = responseWith({
      finalUnits: [{ battleUnitId: "ally:1" }, { battleUnitId: "enemy:1" }],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.effects).toEqual([]);
    expect(states[0]?.effectsKnown).toBe(false);
  });

  it("skips an effect entry whose required shape is broken without dropping the well-formed ones (UI-UT-EFF-004)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [],
          effects: [
            { effectInstanceId: 42 },
            {
              effectInstanceId: "battle-1:effect:2",
              effectDefinitionId: "ACT_ATTACK_UP",
              category: "BUFF",
              effectKindKey: "ACT_ATTACK_UP",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0.1 },
              appliedTurnNumber: 1,
            },
          ],
        },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.effects.map((effect) => effect.effectInstanceId)).toEqual([
      "battle-1:effect:2",
    ]);
    expect(states[0]?.effectsKnown).toBe(true);
  });
});

// DMG-010（Issue #191）: 「shield吸収、HP damage内訳」
// 「sub unit」。`finalState.units[].shields`（プール合計、R-SHD-01第3項）と
// `subUnits`（インスタンス単位、R-SUB-01第3項）を正本として読む。
describe("selectUnitActionStates shields and sub units (DMG-010)", () => {
  it("reads the three shield pools from finalState.units[].shields (UI-UT-DMG-022)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [],
          effects: [],
          shields: { physical: 120, energy: 0, untyped: 30 },
          subUnits: [],
        },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [], shields: null, subUnits: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.shields).toEqual({ physical: 120, energy: 0, untyped: 30 });
    // 契約違反のshieldsは「0」と断定せず不明として落とす。
    expect(states[1]?.shields).toBeUndefined();
  });

  it("keeps sub units as instances with their durability instead of a pool total (UI-UT-DMG-023)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [],
          effects: [],
          shields: { physical: 0, energy: 0, untyped: 0 },
          subUnits: [
            {
              subUnitInstanceId: "battle-1:effect:9",
              subUnitDefinitionId: "ACT_SUBUNIT_DRONE",
              durability: { current: 20, maximum: 50 },
              appliedTurnNumber: 1,
            },
            {
              subUnitInstanceId: "battle-1:effect:10",
              subUnitDefinitionId: "ACT_SUBUNIT_SHELL",
              durability: { current: 50, maximum: 50 },
              appliedTurnNumber: 2,
            },
          ],
        },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [], shields: null, subUnits: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.subUnits).toEqual([
      {
        subUnitInstanceId: "battle-1:effect:9",
        subUnitDefinitionId: "ACT_SUBUNIT_DRONE",
        durability: { current: 20, maximum: 50 },
      },
      {
        subUnitInstanceId: "battle-1:effect:10",
        subUnitDefinitionId: "ACT_SUBUNIT_SHELL",
        durability: { current: 50, maximum: 50 },
      },
    ]);
    expect(states[0]?.subUnitsKnown).toBe(true);
  });

  it("reports sub units as unknown, not as none, for a fixture recorded before the DMG-005 contract (UI-UT-DMG-024)", () => {
    const response = responseWith({
      finalUnits: [
        { battleUnitId: "ally:1", cooldowns: [], effects: [] },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.shields).toBeUndefined();
    expect(states[0]?.subUnits).toEqual([]);
    expect(states[0]?.subUnitsKnown).toBe(false);
  });

  it("skips a sub unit entry whose required shape is broken without dropping the well-formed ones (UI-UT-DMG-025)", () => {
    const response = responseWith({
      finalUnits: [
        {
          battleUnitId: "ally:1",
          cooldowns: [],
          effects: [],
          subUnits: [
            { subUnitInstanceId: 42 },
            {
              subUnitInstanceId: "battle-1:effect:11",
              subUnitDefinitionId: "ACT_SUBUNIT_DRONE",
              durability: { current: 5, maximum: 50 },
              appliedTurnNumber: 1,
            },
          ],
        },
        { battleUnitId: "enemy:1", cooldowns: [], effects: [] },
      ],
    });

    const states = selectUnitActionStates(response, roster, "DETAILED");

    expect(states[0]?.subUnits.map((subUnit) => subUnit.subUnitInstanceId)).toEqual([
      "battle-1:effect:11",
    ]);
    expect(states[0]?.subUnitsKnown).toBe(true);
  });
});
