import { describe, expect, it } from "vitest";
import { buildCombatStatTimeline } from "./combat-stat-timeline.js";
import { compareRankCandidates } from "./candidate-comparison.js";
import type { BattleLogResponse, BattleUnitStateResponse } from "../simulation/api-contract.js";
import type { EffectTraceInstance } from "./effect-trace-projector.js";

function unit(battleUnitId: string, attack: number): BattleUnitStateResponse {
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
  };
}

const RESPONSE: BattleLogResponse = {
  schemaVersion: 1,
  battleId: "b-1",
  catalogRevision: "rev-1",
  initialState: {
    units: [unit("ally:1", 1000), unit("ally:2", 1200), unit("ally:3", 800), unit("enemy:1", 5000)],
  },
  unitSummaries: [],
  events: [
    {
      sequence: 10,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      rootSequence: 1,
      targetUnitIds: [],
      stateVersionBefore: 10,
      stateVersionAfter: 11,
      details: { effectInstanceId: "ei-boost", effectActionDefinitionId: "ACT_BOOST" },
    },
    {
      sequence: 11,
      type: "COMBAT_STAT_CHANGED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      rootSequence: 1,
      parentSequence: 10,
      targetUnitIds: [],
      stateVersionBefore: 11,
      stateVersionAfter: 12,
      details: { battleUnitId: "ally:1", stat: "ATTACK", reason: "EFFECT_APPLIED" },
    },
  ],
  // ally:1 は開始時1000だが、バフで1500へ上がり ally:2(1200) を抜く。
  stateTransitions: [
    {
      causedBySequence: 11,
      stateVersionBefore: 11,
      stateVersionAfter: 12,
      delta: { units: { "ally:1": { combatStats: { attack: { before: 1000, after: 1500 } } } } },
    },
  ],
};

const SIDE_BY_UNIT_ID: ReadonlyMap<string, string> = new Map([
  ["ally:1", "ALLY"],
  ["ally:2", "ALLY"],
  ["ally:3", "ALLY"],
  ["enemy:1", "ENEMY"],
]);

function instance(overrides: Partial<EffectTraceInstance> = {}): EffectTraceInstance {
  return {
    effectInstanceId: "ei-elena",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
    holderUnitId: "ally:1",
    appliedSequence: 50,
    appliedTurnNumber: 2,
    resolutionStartSequence: 50,
    consumptions: [],
    outcome: "ONGOING",
    ...overrides,
  };
}

function compare(overrides: Partial<EffectTraceInstance> = {}) {
  return compareRankCandidates({
    instance: instance(overrides),
    timeline: buildCombatStatTimeline(RESPONSE),
    sideByUnitId: SIDE_BY_UNIT_ID,
  });
}

describe("compareRankCandidates", () => {
  it("ranks the target's own side by the effective value at the moment of resolution (UI-UT-CMP-001)", () => {
    const comparison = compare();

    expect(comparison).toBeDefined();
    expect(comparison?.orderKey).toBe("HIGHEST_ATTACK");
    // 開始時の順位は ally:2 > ally:1 > ally:3 だが、解決時点ではバフで入れ替わる。
    expect(comparison?.candidates.map((c) => c.battleUnitId)).toEqual([
      "ally:1",
      "ally:2",
      "ally:3",
    ]);
    expect(comparison?.candidates.map((c) => c.value)).toEqual([1500, 1200, 800]);
    // 敵は候補に入らない。
    expect(comparison?.candidates.some((c) => c.battleUnitId === "enemy:1")).toBe(false);
  });

  it("marks the chosen candidate and reports the gap to the runner-up as both an amount and a ratio (UI-UT-CMP-002)", () => {
    const comparison = compare();

    expect(comparison?.candidates[0]).toMatchObject({ battleUnitId: "ally:1", isChosen: true });
    expect(comparison?.candidates[1]?.isChosen).toBe(false);
    expect(comparison?.gapToRunnerUp).toEqual({
      runnerUpUnitId: "ally:2",
      amount: 300,
      // 1500 / 1200 - 1 = 0.25
      ratio: 0.25,
    });
  });

  it("breaks the chosen value into its starting value and the effects in force (UI-UT-CMP-003)", () => {
    const chosen = compare()?.candidates[0];

    expect(chosen?.initialValue).toBe(1000);
    expect(chosen?.contributions).toEqual([{ effectActionDefinitionId: "ACT_BOOST", amount: 500 }]);
  });

  it("orders ascending for a LOWEST_* selector (UI-UT-CMP-004)", () => {
    const comparison = compare({
      effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW",
      holderUnitId: "ally:3",
    });

    expect(comparison?.orderKey).toBe("LOWEST_ATTACK");
    expect(comparison?.candidates.map((c) => c.battleUnitId)).toEqual([
      "ally:3",
      "ally:2",
      "ally:1",
    ]);
    // 割合は向きに依らず次点の値を分母にする（400 / 1200）。分母を選択側にすると、
    // `HIGHEST_*`と`LOWEST_*`で同じ差が別の数字になり読み比べられない。
    expect(comparison?.gapToRunnerUp).toEqual({
      runnerUpUnitId: "ally:2",
      amount: 400,
      ratio: 400 / 1200,
    });
  });

  it("returns nothing for an effect that no rank selector chose (UI-UT-CMP-005)", () => {
    expect(compare({ effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DEBUFF" })).toBeUndefined();
  });

  // 逆算であることの限界: 同点や、順位以外の要因で対象が決まった場合は一致しない。
  it("still renders, and flags the mismatch, when the chosen unit is not the reconstructed extremum (UI-UT-CMP-006)", () => {
    const comparison = compare({ holderUnitId: "ally:3" });

    expect(comparison?.matchesReconstruction).toBe(false);
    expect(comparison?.candidates.find((c) => c.isChosen)?.battleUnitId).toBe("ally:3");
    expect(comparison?.candidates[0]?.battleUnitId).toBe("ally:1");
  });

  it("marks the comparison as incomplete rather than ranking on values it could not read (UI-UT-CMP-007)", () => {
    const comparison = compareRankCandidates({
      instance: instance(),
      timeline: buildCombatStatTimeline({
        ...RESPONSE,
        // 初期スナップショットに ally:2 が居ないので、その候補の値は読めない。
        initialState: { units: [unit("ally:1", 1000), unit("ally:3", 800)] },
      }),
      sideByUnitId: SIDE_BY_UNIT_ID,
    });

    expect(comparison?.hasUnreadableCandidate).toBe(true);
    const unreadable = comparison?.candidates.find((c) => c.battleUnitId === "ally:2");
    expect(unreadable?.value).toBeUndefined();
    // 値が読めない候補は順位に混ぜず、末尾へ置く。
    expect(comparison?.candidates.map((c) => c.battleUnitId)).toEqual([
      "ally:1",
      "ally:3",
      "ally:2",
    ]);
  });

  // 同じスキル解決の前段が起こしたバフを織り込まない。実測でエレーナEXの
  // `DMGUP_LOW` は付与時点だと6件中0件しか一致せず、解決起点だと6/6一致した。
  it("evaluates candidates at the start of the skill resolution, not at the grant (UI-UT-CMP-009)", () => {
    // 付与は seq 50 だが、解決は seq 5 に始まっている。seq 11 のバフはまだ効いていない。
    const comparison = compare({ resolutionStartSequence: 5 });

    expect(comparison?.resolvedBeforeSequence).toBe(5);
    expect(comparison?.candidates.map((c) => c.value)).toEqual([1200, 1000, 800]);
    expect(comparison?.candidates[0]?.battleUnitId).toBe("ally:2");
    // 付与先は ally:1 なので、この解決起点では逆算が一致しない。
    expect(comparison?.matchesReconstruction).toBe(false);
  });

  it("reports no runner-up when the side has a single candidate (UI-UT-CMP-008)", () => {
    const comparison = compareRankCandidates({
      instance: instance({ holderUnitId: "enemy:1" }),
      timeline: buildCombatStatTimeline(RESPONSE),
      sideByUnitId: SIDE_BY_UNIT_ID,
    });

    expect(comparison?.candidates).toHaveLength(1);
    expect(comparison?.gapToRunnerUp).toBeUndefined();
  });
});
