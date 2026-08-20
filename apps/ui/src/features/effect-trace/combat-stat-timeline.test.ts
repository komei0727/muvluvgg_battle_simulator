import { describe, expect, it } from "vitest";
import { buildCombatStatTimeline } from "./combat-stat-timeline.js";
import type {
  BattleLogEventResponse,
  BattleLogResponse,
  BattleUnitStateResponse,
  StateTransitionResponse,
} from "../simulation/api-contract.js";

function unit(
  battleUnitId: string,
  attack: number,
  overrides: Record<string, unknown> = {},
): BattleUnitStateResponse {
  return {
    battleUnitId,
    unitDefinitionId: "UNIT_X",
    side: battleUnitId.startsWith("ally") ? "ALLY" : "ENEMY",
    combatStatus: "ACTIVE",
    combatStats: {
      attack,
      defense: 100,
      criticalRate: 20,
      actionSpeed: 500,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    },
    hp: { current: 1000, maximum: 1000 },
    ...overrides,
  };
}

interface TransitionSeed {
  readonly causedBySequence: number;
  readonly battleUnitId: string;
  readonly field?: string;
  readonly before: number;
  readonly after: number;
  readonly hpMaximum?: boolean;
}

function transition(seed: TransitionSeed): StateTransitionResponse {
  const change = { before: seed.before, after: seed.after };
  return {
    causedBySequence: seed.causedBySequence,
    stateVersionBefore: seed.causedBySequence,
    stateVersionAfter: seed.causedBySequence + 1,
    delta: {
      units: {
        [seed.battleUnitId]:
          seed.hpMaximum === true
            ? { hpMaximum: change }
            : { combatStats: { [seed.field ?? "attack"]: change } },
      },
    },
  };
}

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly parentSequence?: number;
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    stateVersionBefore: seed.sequence,
    stateVersionAfter: seed.sequence + 1,
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    details: seed.details ?? {},
  };
}

/** 効果の付与とそれが起こしたステータス変化のペア（実ログと同じ親子関係）。 */
function statChangeByEffect(
  grantSequence: number,
  changeSequence: number,
  effectActionDefinitionId: string,
  battleUnitId: string,
): BattleLogEventResponse[] {
  return [
    event({
      sequence: grantSequence,
      type: "EFFECT_APPLIED",
      details: { effectInstanceId: `ei-${grantSequence.toString()}`, effectActionDefinitionId },
    }),
    event({
      sequence: changeSequence,
      type: "COMBAT_STAT_CHANGED",
      parentSequence: grantSequence,
      details: { battleUnitId, stat: "ATTACK", reason: "EFFECT_APPLIED" },
    }),
  ];
}

function response(overrides: Partial<BattleLogResponse> = {}): BattleLogResponse {
  return {
    schemaVersion: 1,
    battleId: "b-1",
    catalogRevision: "rev-1",
    initialState: { units: [unit("ally:1", 1000), unit("ally:2", 900), unit("enemy:1", 5000)] },
    unitSummaries: [],
    events: [],
    stateTransitions: [],
    ...overrides,
  };
}

describe("buildCombatStatTimeline", () => {
  it("reads the effective value strictly before a sequence, so a grant's own change is excluded (UI-UT-CST-001)", () => {
    const timeline = buildCombatStatTimeline(
      response({
        events: statChangeByEffect(10, 11, "ACT_BUFF", "ally:1"),
        stateTransitions: [
          transition({ causedBySequence: 11, battleUnitId: "ally:1", before: 1000, after: 1350 }),
        ],
      }),
    );

    // 順位セレクタは付与より前に解決するため、付与自身が起こした変化は候補比較に含めない。
    expect(timeline.valueBefore("ally:1", "attack", 10)).toBe(1000);
    expect(timeline.valueBefore("ally:1", "attack", 11)).toBe(1000);
    expect(timeline.valueBefore("ally:1", "attack", 12)).toBe(1350);
  });

  it("folds buff, expiry and break enhancement in sequence order (R-TEX-04, UI-UT-CST-002)", () => {
    const timeline = buildCombatStatTimeline(
      response({
        stateTransitions: [
          transition({ causedBySequence: 20, battleUnitId: "enemy:1", before: 5000, after: 6500 }),
          transition({ causedBySequence: 30, battleUnitId: "enemy:1", before: 6500, after: 5000 }),
          // R-TEX-04のブレイク強化も同じ経路（`BREAK_ENHANCEMENT`）で届く。
          transition({ causedBySequence: 40, battleUnitId: "enemy:1", before: 5000, after: 5500 }),
        ],
      }),
    );

    expect(timeline.valueBefore("enemy:1", "attack", 25)).toBe(6500);
    expect(timeline.valueBefore("enemy:1", "attack", 35)).toBe(5000);
    expect(timeline.valueBefore("enemy:1", "attack", 45)).toBe(5500);
  });

  it("folds hpMaximum, which the delta carries outside combatStats (UI-UT-CST-003)", () => {
    const timeline = buildCombatStatTimeline(
      response({
        stateTransitions: [
          transition({
            causedBySequence: 20,
            battleUnitId: "enemy:1",
            before: 1000,
            after: 1800,
            hpMaximum: true,
          }),
        ],
      }),
    );

    expect(timeline.valueBefore("enemy:1", "maximumHp", 10)).toBe(1000);
    expect(timeline.valueBefore("enemy:1", "maximumHp", 30)).toBe(1800);
  });

  it("reports a series as unknown rather than guessing when the initial snapshot lacks it (UI-UT-CST-004)", () => {
    const timeline = buildCombatStatTimeline(
      response({ initialState: { units: [unit("ally:1", 1000)] } }),
    );

    expect(timeline.valueBefore("ally:1", "attack", 99)).toBe(1000);
    expect(timeline.valueBefore("ally:9", "attack", 99)).toBeUndefined();
  });

  // R-NUM-01: `COMBAT_STAT_CHANGED`のdetailsは内部の割合スケール（0.2）、
  // `initialState`と`stateTransitions`はパーセントポイント（20）である。取り違えると
  // 桁違いの値を自信満々に出すことになるため、`before`が手元の値と合わない系列は
  // 「値が読めない」に倒す。
  it("refuses to report a value once a delta's before does not match the folded value (UI-UT-CST-005)", () => {
    const timeline = buildCombatStatTimeline(
      response({
        stateTransitions: [
          transition({
            causedBySequence: 20,
            battleUnitId: "ally:1",
            field: "criticalRate",
            before: 0.2,
            after: 0.35,
          }),
        ],
      }),
    );

    // 折り畳む前は初期値を返してよい。
    expect(timeline.valueBefore("ally:1", "criticalRate", 10)).toBe(20);
    // 不整合を跨いだ後は値を出さない。
    expect(timeline.valueBefore("ally:1", "criticalRate", 30)).toBeUndefined();
    // 他の系列は巻き添えにしない。
    expect(timeline.valueBefore("ally:1", "attack", 30)).toBe(1000);
  });

  it("breaks the value down into the net contribution of each effect that is still in force (UI-UT-CST-006)", () => {
    const timeline = buildCombatStatTimeline(
      response({
        events: [
          ...statChangeByEffect(10, 11, "ACT_ELENA_BUFF", "ally:1"),
          ...statChangeByEffect(20, 21, "ACT_SUIRAN_BUFF", "ally:1"),
          // 付与と失効が打ち消しあった効果は「適用中」ではないので内訳に残さない。
          ...statChangeByEffect(30, 31, "ACT_SHORTLIVED", "ally:1"),
          event({
            sequence: 40,
            type: "EFFECT_EXPIRED",
            details: { effectInstanceId: "ei-30", effectActionDefinitionId: "ACT_SHORTLIVED" },
          }),
          event({
            sequence: 41,
            type: "COMBAT_STAT_CHANGED",
            parentSequence: 40,
            details: { battleUnitId: "ally:1", stat: "ATTACK", reason: "EFFECT_EXPIRED" },
          }),
        ],
        stateTransitions: [
          transition({ causedBySequence: 11, battleUnitId: "ally:1", before: 1000, after: 1350 }),
          transition({ causedBySequence: 21, battleUnitId: "ally:1", before: 1350, after: 1650 }),
          transition({ causedBySequence: 31, battleUnitId: "ally:1", before: 1650, after: 1750 }),
          transition({ causedBySequence: 41, battleUnitId: "ally:1", before: 1750, after: 1650 }),
        ],
      }),
    );

    expect(timeline.valueBefore("ally:1", "attack", 50)).toBe(1650);
    expect(timeline.contributionsBefore("ally:1", "attack", 50)).toEqual([
      { effectActionDefinitionId: "ACT_ELENA_BUFF", amount: 350 },
      { effectActionDefinitionId: "ACT_SUIRAN_BUFF", amount: 300 },
    ]);
    expect(timeline.initialValue("ally:1", "attack")).toBe(1000);
  });

  it("keeps a change whose cause cannot be attributed to an effect instead of dropping it from the total (UI-UT-CST-007)", () => {
    const timeline = buildCombatStatTimeline(
      response({
        events: [
          event({
            sequence: 11,
            type: "COMBAT_STAT_CHANGED",
            details: { battleUnitId: "ally:1", stat: "ATTACK", reason: "BREAK_ENHANCEMENT" },
          }),
        ],
        stateTransitions: [
          transition({ causedBySequence: 11, battleUnitId: "ally:1", before: 1000, after: 1200 }),
        ],
      }),
    );

    expect(timeline.valueBefore("ally:1", "attack", 50)).toBe(1200);
    expect(timeline.contributionsBefore("ally:1", "attack", 50)).toEqual([
      { reason: "BREAK_ENHANCEMENT", amount: 200 },
    ]);
  });
});
