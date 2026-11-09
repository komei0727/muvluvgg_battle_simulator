import { describe, expect, it } from "vitest";
import m4DuplicateDefinitionFixture from "../test/fixtures/m4-success-duplicate-definition.json";
import m4MinimalFixture from "../test/fixtures/m4-success-minimal.json";
import malformedSuccessFixture from "../test/fixtures/malformed-success.json";
import unknownEventFixture from "../test/fixtures/success-unknown-event.json";
import totalWarSuccessFixture from "../test/fixtures/total-war-success.json";
import { createBattleStateReplay } from "./battle-state-replay.js";
import type {
  ReplaySourceState,
  ReplaySourceTransition,
  ReplaySourceUnit,
} from "./battle-state-replay.js";

interface SuccessFixture {
  readonly initialState: ReplaySourceState;
  readonly finalState: unknown;
  readonly stateTransitions: readonly ReplaySourceTransition[];
}

// 成功応答の形を持つ全fixture。`malformed-success.json`は`unitSummaries`だけを欠く実応答で、
// 状態と遷移は正しいため対象に含める。
const successFixtures: readonly (readonly [string, SuccessFixture])[] = [
  ["m4-success-minimal.json", m4MinimalFixture],
  ["m4-success-duplicate-definition.json", m4DuplicateDefinitionFixture],
  ["success-unknown-event.json", unknownEventFixture],
  ["malformed-success.json", malformedSuccessFixture],
  ["total-war-success.json", totalWarSuccessFixture],
];

function lastVersionOf(fixture: SuccessFixture): number {
  return Math.max(0, ...fixture.stateTransitions.map((t) => Number(t["stateVersionAfter"])));
}

function unit(battleUnitId: string, overrides: Record<string, unknown> = {}) {
  return {
    battleUnitId,
    unitDefinitionId: `UNIT_${battleUnitId}`,
    side: battleUnitId.startsWith("enemy") ? "ENEMY" : "ALLY",
    combatStatus: "ACTIVE",
    hp: { current: 1000, maximum: 1000 },
    resources: {
      ap: { current: 0, maximum: 3 },
      pp: { current: 0, maximum: 3 },
      extraGauge: { current: 0, maximum: 100 },
    },
    combatStats: { attack: 100, defense: 50, criticalRate: 10 },
    shields: { physical: 0, energy: 0, untyped: 0 },
    subUnits: [],
    effects: [],
    markers: [],
    cooldowns: [],
    ...overrides,
  };
}

function state(
  units: readonly ReplaySourceUnit[],
  overrides: Record<string, unknown> = {},
): ReplaySourceState {
  return {
    stateVersion: 0,
    battleStatus: "READY",
    turnNumber: 0,
    cycleNumber: 0,
    units,
    actionQueue: [],
    ...overrides,
  };
}

function transition(stateVersionAfter: number, delta: Record<string, unknown>) {
  return {
    causedBySequence: stateVersionAfter,
    stateVersionBefore: stateVersionAfter - 1,
    stateVersionAfter,
    delta,
  };
}

function effect(effectInstanceId: string, remaining: number) {
  return {
    effectInstanceId,
    effectDefinitionId: "EFF_ATTACK_UP",
    category: "BUFF",
    effectKindKey: "EFF_ATTACK_UP",
    stackMode: "STACKABLE",
    isEffective: true,
    value: { magnitude: 0.1 },
    duration: { unit: "TURN", remaining },
    appliedTurnNumber: 1,
  };
}

interface ReplayedTestUnit {
  readonly combatStatus: string;
  readonly hp: { readonly current: number; readonly maximum: number };
  readonly resources: Readonly<
    Record<string, { readonly current: number; readonly maximum: number }>
  >;
  readonly combatStats: Readonly<Record<string, number>>;
  readonly shields: Readonly<Record<string, number>>;
  readonly effects: readonly { readonly effectInstanceId: string }[];
  readonly cooldowns: readonly { readonly skillDefinitionId: string }[];
  readonly markers: readonly unknown[];
  readonly subUnits: readonly unknown[];
}

function unitAt(replayed: { readonly units: readonly unknown[] }, battleUnitId: string) {
  return replayed.units.find(
    (candidate) => (candidate as { battleUnitId: string }).battleUnitId === battleUnitId,
  ) as ReplayedTestUnit | undefined;
}

describe("createBattleStateReplay reconstructs finalState (UI-UT-ATR-001)", () => {
  it.each(successFixtures)("applies every transition of %s to reach finalState", (_, fixture) => {
    const replay = createBattleStateReplay(fixture.initialState, fixture.stateTransitions, []);

    expect(replay.latestVersion).toBe(lastVersionOf(fixture));
    expect(replay.stateAt(replay.latestVersion)).toEqual(fixture.finalState);
  });
});

describe("createBattleStateReplay at intermediate versions (UI-UT-ATR-002)", () => {
  const initialState = state([unit("ally:1"), unit("enemy:1")]);
  const transitions = [
    transition(1, { battle: { battleStatus: { before: "READY", after: "RUNNING" } } }),
    transition(2, {
      units: {
        "enemy:1": {
          hp: { before: 1000, after: 700 },
          shields: { physical: { before: 0, after: 300 } },
        },
      },
    }),
    transition(3, {
      units: {
        "ally:1": {
          resources: { ap: { before: 0, after: 2 } },
          resourceMaximums: { ap: { before: 3, after: 4 } },
          hpMaximum: { before: 1000, after: 1200 },
          combatStats: { attack: { before: 100, after: 120 } },
        },
      },
    }),
    transition(4, {
      units: {
        "enemy:1": {
          hp: { before: 700, after: 0 },
          combatStatus: { before: "ACTIVE", after: "DEFEATED" },
          shields: { physical: { before: 300, after: 0 } },
        },
      },
    }),
  ];

  it("returns initialState at version 0", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    expect(replay.stateAt(0)).toEqual(initialState);
  });

  it("applies only the transitions at or below the requested version", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    const atTwo = replay.stateAt(2);
    expect(atTwo["stateVersion"]).toBe(2);
    expect(atTwo["battleStatus"]).toBe("RUNNING");
    expect(unitAt(atTwo, "enemy:1")?.hp).toEqual({ current: 700, maximum: 1000 });
    expect(unitAt(atTwo, "enemy:1")?.shields.physical).toBe(300);
    expect(unitAt(atTwo, "ally:1")?.resources.ap).toEqual({ current: 0, maximum: 3 });

    const atThree = replay.stateAt(3);
    expect(unitAt(atThree, "ally:1")?.resources.ap).toEqual({ current: 2, maximum: 4 });
    expect(unitAt(atThree, "ally:1")?.hp).toEqual({ current: 1000, maximum: 1200 });
    expect(unitAt(atThree, "ally:1")?.combatStats.attack).toBe(120);
    expect(unitAt(atThree, "enemy:1")?.combatStatus).toBe("ACTIVE");

    const atFour = replay.stateAt(4);
    expect(unitAt(atFour, "enemy:1")?.combatStatus).toBe("DEFEATED");
    expect(unitAt(atFour, "enemy:1")?.shields.physical).toBe(0);
  });

  it("does not let a returned state leak mutations into later queries or the input", () => {
    const replay = createBattleStateReplay(initialState, transitions, [2]);

    const first = replay.stateAt(2) as unknown as { units: { hp: { current: number } }[] };
    first.units[1]!.hp.current = -1;

    expect(unitAt(replay.stateAt(2), "enemy:1")?.hp.current).toBe(700);
    expect(unitAt(initialState, "enemy:1")?.hp.current).toBe(1000);
  });

  it("rejects versions outside the transitions", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    expect(() => replay.stateAt(-1)).toThrow(RangeError);
    expect(() => replay.stateAt(5)).toThrow(RangeError);
    expect(() => replay.stateAt(1.5)).toThrow(RangeError);
  });
});

describe("createBattleStateReplay applies EntityCollectionDelta by ID (UI-UT-ATR-003)", () => {
  const initialState = state([
    unit("ally:1", {
      effects: [effect("eff-1", 2), effect("eff-2", 1)],
      cooldowns: [{ skillDefinitionId: "SKL_A", unit: "TURN", remaining: 2, setAtTurnNumber: 1 }],
    }),
  ]);
  const transitions = [
    transition(1, {
      units: {
        "ally:1": {
          effects: {
            added: [effect("eff-3", 3)],
            updated: [{ id: "eff-1", before: effect("eff-1", 2), after: effect("eff-1", 1) }],
            removed: [{ id: "eff-2", before: effect("eff-2", 1) }],
          },
          cooldowns: {
            added: [
              { skillDefinitionId: "SKL_B", unit: "ACTION", remaining: 1, setAtActionId: "a" },
            ],
            updated: [
              {
                id: "SKL_A",
                before: { skillDefinitionId: "SKL_A", unit: "TURN", remaining: 2 },
                after: {
                  skillDefinitionId: "SKL_A",
                  unit: "TURN",
                  remaining: 1,
                  setAtTurnNumber: 1,
                },
              },
            ],
            removed: [],
          },
          markers: {
            added: [{ markerInstanceId: "mk-1", markerId: "MARKER_X", stackCount: 1, stackMax: 3 }],
            updated: [],
            removed: [],
          },
          subUnits: {
            added: [
              {
                subUnitInstanceId: "sub-1",
                subUnitDefinitionId: "SUB_X",
                durability: { current: 500, maximum: 500 },
                appliedTurnNumber: 1,
              },
            ],
            updated: [],
            removed: [],
          },
        },
      },
    }),
    transition(2, {
      units: {
        "ally:1": {
          effects: {
            added: [],
            updated: [],
            removed: [{ id: "eff-1", before: effect("eff-1", 1) }],
          },
          cooldowns: {
            added: [],
            updated: [],
            removed: [{ id: "SKL_A", before: { skillDefinitionId: "SKL_A" } }],
          },
          markers: {
            added: [],
            updated: [
              {
                id: "mk-1",
                before: { markerInstanceId: "mk-1", stackCount: 1 },
                after: {
                  markerInstanceId: "mk-1",
                  markerId: "MARKER_X",
                  stackCount: 2,
                  stackMax: 3,
                },
              },
            ],
            removed: [],
          },
          subUnits: {
            added: [],
            updated: [],
            removed: [{ id: "sub-1", before: { subUnitInstanceId: "sub-1" } }],
          },
        },
      },
    }),
  ];

  it("adds, updates in place, and removes elements by their ID fields", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    const atOne = unitAt(replay.stateAt(1), "ally:1");
    expect(atOne?.effects).toEqual([effect("eff-1", 1), effect("eff-3", 3)]);
    expect(atOne?.cooldowns).toEqual([
      { skillDefinitionId: "SKL_A", unit: "TURN", remaining: 1, setAtTurnNumber: 1 },
      { skillDefinitionId: "SKL_B", unit: "ACTION", remaining: 1, setAtActionId: "a" },
    ]);
    expect(atOne?.markers).toEqual([
      { markerInstanceId: "mk-1", markerId: "MARKER_X", stackCount: 1, stackMax: 3 },
    ]);
    expect(atOne?.subUnits).toHaveLength(1);

    const atTwo = unitAt(replay.stateAt(2), "ally:1");
    expect(atTwo?.effects).toEqual([effect("eff-3", 3)]);
    expect(atTwo?.cooldowns.map((c) => c.skillDefinitionId)).toEqual(["SKL_B"]);
    expect(atTwo?.markers).toEqual([
      { markerInstanceId: "mk-1", markerId: "MARKER_X", stackCount: 2, stackMax: 3 },
    ]);
    expect(atTwo?.subUnits).toEqual([]);
  });

  it("copies delta elements so a returned state cannot alter the transitions", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    const first = unitAt(replay.stateAt(1), "ally:1") as unknown as {
      effects: { duration: { remaining: number } }[];
    };
    first.effects[1]!.duration.remaining = 99;

    expect(unitAt(replay.stateAt(1), "ally:1")?.effects[1]).toEqual(effect("eff-3", 3));
  });

  it("creates the optional markers array when a unit without one receives a marker", () => {
    const { markers: _omitted, ...withoutMarkers } = unit("ally:1");
    const replay = createBattleStateReplay(
      { ...state([]), units: [withoutMarkers] },
      [
        transition(1, {
          units: {
            "ally:1": {
              markers: {
                added: [{ markerInstanceId: "mk-1", markerId: "MARKER_X", stackCount: 1 }],
                updated: [],
                removed: [],
              },
            },
          },
        }),
      ],
      [],
    );

    expect(unitAt(replay.stateAt(1), "ally:1")?.markers).toEqual([
      { markerInstanceId: "mk-1", markerId: "MARKER_X", stackCount: 1 },
    ]);
  });

  it("sets charge from a ValueChange and removes it when after is null", () => {
    const charge = { skillDefinitionId: "SKL_C", startedActionId: "a1", status: "CHARGING" };
    const replay = createBattleStateReplay(
      state([unit("ally:1")]),
      [
        transition(1, { units: { "ally:1": { charge: { before: null, after: charge } } } }),
        transition(2, { units: { "ally:1": { charge: { before: charge, after: null } } } }),
      ],
      [],
    );

    expect(unitAt(replay.stateAt(1), "ally:1")).toHaveProperty("charge", charge);
    expect(unitAt(replay.stateAt(2), "ally:1")).not.toHaveProperty("charge");
  });

  it("replaces the action queue and applies battle counters", () => {
    const queue = [
      {
        order: 1,
        battleUnitId: "ally:1",
        actionSpeedAtOrdering: 10,
        reservedActionType: "ACTIVE_SKILL",
      },
    ];
    const replay = createBattleStateReplay(
      state([unit("ally:1")]),
      [
        transition(1, {
          battle: { turnNumber: { before: 0, after: 1 }, cycleNumber: { before: 0, after: 1 } },
          actionQueue: { before: [], after: queue },
        }),
      ],
      [],
    );

    const atOne = replay.stateAt(1);
    expect(atOne["turnNumber"]).toBe(1);
    expect(atOne["cycleNumber"]).toBe(1);
    expect(atOne["actionQueue"]).toEqual(queue);
  });
});

describe("createBattleStateReplay applies addedUnits first (UI-UT-ATR-004)", () => {
  function totalWarUnit(battleUnitId: string, formationNumber: number) {
    return { ...unit(battleUnitId), formationNumber };
  }

  const initialState = state([totalWarUnit("ally:1:1", 1), totalWarUnit("enemy:1:1", 1)], {
    formations: {
      ally: { formationCount: 2, activeFormationNumber: 1, defeatedCount: 0 },
      enemy: { formationCount: 1, activeFormationNumber: 1, defeatedCount: 0 },
    },
  });
  const deployed = totalWarUnit("ally:2:1", 2);
  const transitions = [
    transition(1, {
      formations: { ally: { defeatedCount: { before: 0, after: 1 } } },
    }),
    transition(2, {
      addedUnits: [deployed],
      units: { "ally:2:1": { hp: { before: 1000, after: 900 } } },
      formations: { ally: { activeFormationNumber: { before: 1, after: 2 } } },
    }),
    transition(3, { units: { "ally:2:1": { hp: { before: 900, after: 800 } } } }),
  ];

  it("inserts the deployed unit after its side's earlier formations and applies the same delta to it", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    const atTwo = replay.stateAt(2);
    expect(atTwo.units.map((u) => (u as { battleUnitId: string }).battleUnitId)).toEqual([
      "ally:1:1",
      "ally:2:1",
      "enemy:1:1",
    ]);
    expect(unitAt(atTwo, "ally:2:1")?.hp.current).toBe(900);
    expect(atTwo["formations"]).toEqual({
      ally: { formationCount: 2, activeFormationNumber: 2, defeatedCount: 1 },
      enemy: { formationCount: 1, activeFormationNumber: 1, defeatedCount: 0 },
    });
    expect(unitAt(replay.stateAt(3), "ally:2:1")?.hp.current).toBe(800);
  });

  it("does not contain the unit before it is deployed", () => {
    const replay = createBattleStateReplay(initialState, transitions, []);

    expect(unitAt(replay.stateAt(1), "ally:2:1")).toBeUndefined();
  });
});

describe("createBattleStateReplay with checkpoints (UI-UT-ATR-005)", () => {
  // 各遷移でHPとEXゲージを動かし、効果を1つずつ付けて2つ前のものを外す。
  const initialState = state([unit("ally:1"), unit("enemy:1")]);
  const transitions = Array.from({ length: 30 }, (_, index) => {
    const version = index + 1;
    return transition(version, {
      units: {
        "enemy:1": {
          hp: { before: 1000 - index * 10, after: 1000 - version * 10 },
          effects: {
            added: [effect(`eff-${version}`, version)],
            updated: [],
            removed: version > 2 ? [{ id: `eff-${version - 2}`, before: {} }] : [],
          },
        },
        "ally:1": { resources: { extraGauge: { before: index, after: version } } },
      },
    });
  });

  it("returns the same state from any checkpoint as from replaying all transitions", () => {
    const withoutCheckpoints = createBattleStateReplay(initialState, transitions, []);
    const withCheckpoints = createBattleStateReplay(initialState, transitions, [7, 12, 20, 29]);

    for (let version = 0; version <= 30; version += 1) {
      expect(withCheckpoints.stateAt(version)).toEqual(withoutCheckpoints.stateAt(version));
    }
    expect(
      unitAt(withCheckpoints.stateAt(15), "enemy:1")?.effects.map((e) => e.effectInstanceId),
    ).toEqual(["eff-14", "eff-15"]);
  });

  it("accepts transitions out of order and ignores checkpoint versions outside the range", () => {
    const replay = createBattleStateReplay(initialState, [...transitions].reverse(), [-3, 99, 10]);

    expect(unitAt(replay.stateAt(30), "enemy:1")?.hp.current).toBe(700);
    expect(unitAt(replay.stateAt(10), "ally:1")?.resources["extraGauge"]?.current).toBe(10);
  });

  it("ignores unknown keys and malformed parts of a delta", () => {
    const replay = createBattleStateReplay(
      initialState,
      [
        transition(1, {
          futureTopLevel: { anything: true },
          battle: { futureCounter: { before: 0, after: 1 }, turnNumber: "not-a-change" },
          units: {
            "ally:1": {
              futureStat: { before: 0, after: 1 },
              hp: { before: 1000, after: 950 },
              effects: { added: "nope", updated: [{ id: 3 }], removed: [null] },
              resources: { unknownGauge: { before: 0, after: 1 }, ap: 5 },
            },
            "ghost:1": { hp: { before: 1, after: 0 } },
          },
          addedUnits: [{ notAUnit: true }],
          formations: { neutral: { defeatedCount: { before: 0, after: 1 } } },
          actionQueue: { before: [], after: "broken" },
        }),
        { stateVersionAfter: "x", delta: {} },
      ],
      [],
    );

    const atOne = replay.stateAt(1);
    expect(replay.latestVersion).toBe(1);
    expect(atOne.units).toHaveLength(2);
    expect(unitAt(atOne, "ally:1")?.hp.current).toBe(950);
    expect(unitAt(atOne, "ally:1")?.effects).toEqual([]);
    expect(unitAt(atOne, "ally:1")?.resources.ap).toEqual({ current: 0, maximum: 3 });
    expect(atOne["turnNumber"]).toBe(0);
    expect(atOne["actionQueue"]).toEqual([]);
  });
});

describe("createBattleStateReplay exercise-only deltas", () => {
  // `exercise`と`baseCombatStats`は`BattleStateResponse`に適用先を持たないため、
  // 状態へは混ぜずに別の口で返す（混ぜると`finalState`と一致しなくなる）。
  const initialState = state([unit("ally:1"), unit("enemy:1")]);
  const transitions = [
    transition(1, { exercise: { totalScore: { before: 0, after: 1500 } } }),
    transition(2, {
      exercise: { breakCount: { before: 0, after: 1 } },
      units: { "enemy:1": { baseCombatStats: { attack: { before: 100, after: 150 } } } },
    }),
  ];

  it("tracks totalScore, breakCount and base combat stats outside the battle state", () => {
    const replay = createBattleStateReplay(initialState, transitions, [1]);

    expect(replay.exerciseAt(0)).toEqual({
      totalScore: 0,
      breakCount: 0,
      baseCombatStats: { "enemy:1": { attack: 100 } },
    });
    expect(replay.exerciseAt(1)).toEqual({
      totalScore: 1500,
      breakCount: 0,
      baseCombatStats: { "enemy:1": { attack: 100 } },
    });
    expect(replay.exerciseAt(2)).toEqual({
      totalScore: 1500,
      breakCount: 1,
      baseCombatStats: { "enemy:1": { attack: 150 } },
    });
    expect(replay.stateAt(2)).not.toHaveProperty("exercise");
    expect(unitAt(replay.stateAt(2), "enemy:1")).not.toHaveProperty("baseCombatStats");
  });

  it("returns undefined for responses without exercise deltas", () => {
    const replay = createBattleStateReplay(initialState, [transition(1, {})], []);

    expect(replay.exerciseAt(1)).toBeUndefined();
  });
});
