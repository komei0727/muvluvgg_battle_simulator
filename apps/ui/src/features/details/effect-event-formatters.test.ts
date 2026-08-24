import { describe, expect, it } from "vitest";
import { effectEventFormatters } from "./effect-event-formatters.js";
import { buildRosterIndex } from "./event-presentation.js";
import type { RosterEntry } from "../../entities/roster.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
];

const rosterIndex = buildRosterIndex(roster);

function event(
  overrides: Partial<BattleLogEventResponse> & { type: string },
): BattleLogEventResponse {
  return {
    sequence: 1,
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    details: {},
    stateVersionBefore: 0,
    stateVersionAfter: 0,
    ...overrides,
  };
}

describe("HEAL_APPLIED", () => {
  it("resolves the applied HP and discarded overheal (R-HEAL-01〜03)", () => {
    const presentation = effectEventFormatters["HEAL_APPLIED"]?.(
      event({
        type: "HEAL_APPLIED",
        sourceUnitId: "ally:1",
        details: {
          targetUnitId: "enemy:1",
          appliedAmount: 100,
          hpBefore: 900,
          hpAfter: 1000,
          discardedAmount: 20,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("超過20を破棄");
    expect(presentation?.severity).toBe("positive");
  });

  it("returns undefined when hpAfter is missing", () => {
    const presentation = effectEventFormatters["HEAL_APPLIED"]?.(
      event({
        type: "HEAL_APPLIED",
        sourceUnitId: "ally:1",
        details: { targetUnitId: "enemy:1", appliedAmount: 100, hpBefore: 900 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });

  // 付与元がユニットIDでも陣営(Memory)でも無い場合、resolveOriginは"-"へ落ちる。
  it("shows a dash origin when neither a source unit nor a source side is present", () => {
    const presentation = effectEventFormatters["HEAL_APPLIED"]?.(
      event({
        type: "HEAL_APPLIED",
        details: { targetUnitId: "enemy:1", appliedAmount: 100, hpBefore: 900, hpAfter: 1000 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary.startsWith("- →")).toBe(true);
  });
});

describe("HEALING_TRANSFERRED", () => {
  it("resolves the transfer source and destination (R-HEAL-04)", () => {
    const presentation = effectEventFormatters["HEALING_TRANSFERRED"]?.(
      event({
        type: "HEALING_TRANSFERRED",
        details: {
          fromUnitId: "ally:1",
          toUnitId: "enemy:1",
          appliedAmount: 50,
          hpBefore: 900,
          hpAfter: 950,
          discardedAmount: 10,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("転送分のうち10を破棄");
    expect(presentation?.severity).toBe("positive");
  });

  it("reports a fully discarded transfer as no HP increase (R-HEAL-04)", () => {
    const presentation = effectEventFormatters["HEALING_TRANSFERRED"]?.(
      event({
        type: "HEALING_TRANSFERRED",
        details: {
          fromUnitId: "ally:1",
          toUnitId: "enemy:1",
          appliedAmount: 0,
          hpBefore: 0,
          hpAfter: 0,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("HPは増えませんでした");
    expect(presentation?.severity).toBe("neutral");
  });

  it("returns undefined when hpAfter is missing", () => {
    const presentation = effectEventFormatters["HEALING_TRANSFERRED"]?.(
      event({
        type: "HEALING_TRANSFERRED",
        details: { fromUnitId: "ally:1", toUnitId: "enemy:1", appliedAmount: 50, hpBefore: 900 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EFFECT_APPLIED", () => {
  it("resolves the effect kind, duration and duplicate flag", () => {
    const presentation = effectEventFormatters["EFFECT_APPLIED"]?.(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        details: {
          targetUnitId: "enemy:1",
          effectActionDefinitionId: "EFF_1",
          duplicate: true,
          durationUnit: "TURN",
          initialRemaining: 3,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("効果「EFF_1」");
    expect(presentation?.summary).toContain("期間 TURN 3");
    expect(presentation?.summary).toContain("重複あり");
  });

  it("returns undefined when duplicate is missing", () => {
    const presentation = effectEventFormatters["EFFECT_APPLIED"]?.(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        details: { targetUnitId: "enemy:1", effectActionDefinitionId: "EFF_1" },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EFFECT_APPLICATION_REJECTED", () => {
  it("resolves the blocked status and the blocking instance (R-EFF-03)", () => {
    const presentation = effectEventFormatters["EFFECT_APPLICATION_REJECTED"]?.(
      event({
        type: "EFFECT_APPLICATION_REJECTED",
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "EFF_1",
          blockingEffectInstanceId: "inst:1",
          reason: "IMMUNE",
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("拒否されました（理由: IMMUNE");
    expect(presentation?.summary).toContain("inst:1");
  });

  it("returns undefined when reason is missing", () => {
    const presentation = effectEventFormatters["EFFECT_APPLICATION_REJECTED"]?.(
      event({
        type: "EFFECT_APPLICATION_REJECTED",
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "EFF_1",
          blockingEffectInstanceId: "inst:1",
        },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EFFECT_EXPIRED / EFFECT_REMOVED", () => {
  it("resolves EFFECT_EXPIRED with its expiry reason and cascade flag (R-EFF-04/09)", () => {
    const presentation = effectEventFormatters["EFFECT_EXPIRED"]?.(
      event({
        type: "EFFECT_EXPIRED",
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "EFF_1",
          reason: "DURATION_ZERO",
          cascaded: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("失効しました（理由: DURATION_ZERO）");
  });

  it("marks a cascaded EFFECT_REMOVED as linked-group removal (R-EFF-02/09)", () => {
    const presentation = effectEventFormatters["EFFECT_REMOVED"]?.(
      event({
        type: "EFFECT_REMOVED",
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "EFF_1",
          reason: "DISPEL",
          cascaded: true,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("連動グループの連鎖");
  });

  it("returns undefined when cascaded is missing", () => {
    const presentation = effectEventFormatters["EFFECT_EXPIRED"]?.(
      event({
        type: "EFFECT_EXPIRED",
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "EFF_1",
          reason: "DURATION_ZERO",
        },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EFFECT_DURATION_REDUCED / EFFECT_CONSUMPTION_CHANGED", () => {
  it("resolves before → after transitions", () => {
    const presentation = effectEventFormatters["EFFECT_DURATION_REDUCED"]?.(
      event({
        type: "EFFECT_DURATION_REDUCED",
        details: {
          battleUnitId: "enemy:1",
          effectInstanceId: "inst:1",
          unit: "TURN",
          before: 3,
          after: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("残り回数（TURN）が3 → 2になりました");
  });

  it("returns undefined when after is missing", () => {
    const presentation = effectEventFormatters["EFFECT_CONSUMPTION_CHANGED"]?.(
      event({
        type: "EFFECT_CONSUMPTION_CHANGED",
        details: { battleUnitId: "enemy:1", effectInstanceId: "inst:1", kind: "HIT", before: 3 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EFFECTIVE_EFFECT_CHANGED", () => {
  it("resolves the group's kindKey and before/after effective effect (R-EFF-05)", () => {
    const presentation = effectEventFormatters["EFFECTIVE_EFFECT_CHANGED"]?.(
      event({
        type: "EFFECTIVE_EFFECT_CHANGED",
        details: { battleUnitId: "enemy:1", kindKey: "BUFF_ATK", before: "EFF_1", after: "EFF_2" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("EFF_1 → EFF_2");
  });

  // beforeがグループに1件も採用中が無い最初の付与は、before/afterが欠ける。
  it("shows なし when there is no previously effective instance in the group", () => {
    const presentation = effectEventFormatters["EFFECTIVE_EFFECT_CHANGED"]?.(
      event({
        type: "EFFECTIVE_EFFECT_CHANGED",
        details: { battleUnitId: "enemy:1", kindKey: "BUFF_ATK", after: "EFF_1" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("なし → EFF_1");
  });

  it("shows なし on both sides when the group has no effective instance at all", () => {
    const presentation = effectEventFormatters["EFFECTIVE_EFFECT_CHANGED"]?.(
      event({
        type: "EFFECTIVE_EFFECT_CHANGED",
        details: { battleUnitId: "enemy:1", kindKey: "BUFF_ATK" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("なし → なし");
  });

  it("returns undefined when kindKey is missing", () => {
    const presentation = effectEventFormatters["EFFECTIVE_EFFECT_CHANGED"]?.(
      event({ type: "EFFECTIVE_EFFECT_CHANGED", details: { battleUnitId: "enemy:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("COMBAT_STAT_CHANGED", () => {
  it("resolves before/after and reason (R-STA-04)", () => {
    const presentation = effectEventFormatters["COMBAT_STAT_CHANGED"]?.(
      event({
        type: "COMBAT_STAT_CHANGED",
        details: { battleUnitId: "enemy:1", stat: "ATK", before: 100, after: 80, reason: "DEBUFF" },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("ATKが100 → 80になりました（理由: DEBUFF）");
  });

  it("returns undefined when reason is missing", () => {
    const presentation = effectEventFormatters["COMBAT_STAT_CHANGED"]?.(
      event({
        type: "COMBAT_STAT_CHANGED",
        details: { battleUnitId: "enemy:1", stat: "ATK", before: 100, after: 80 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("STUN_DURATION_CHANGED", () => {
  it("resolves the remaining count change as a negative event (R-STS-02)", () => {
    const presentation = effectEventFormatters["STUN_DURATION_CHANGED"]?.(
      event({
        type: "STUN_DURATION_CHANGED",
        details: {
          battleUnitId: "enemy:1",
          remainingBefore: 1,
          remainingAfter: 2,
          reason: "REAPPLIED",
        },
      }),
      rosterIndex,
    );

    expect(presentation?.severity).toBe("negative");
  });

  it("returns undefined when reason is missing", () => {
    const presentation = effectEventFormatters["STUN_DURATION_CHANGED"]?.(
      event({
        type: "STUN_DURATION_CHANGED",
        details: { battleUnitId: "enemy:1", remainingBefore: 1, remainingAfter: 2 },
      }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("FREEZE_REMOVED", () => {
  it("resolves the triggering damage (R-STS-03)", () => {
    const presentation = effectEventFormatters["FREEZE_REMOVED"]?.(
      event({
        type: "FREEZE_REMOVED",
        details: { battleUnitId: "enemy:1", triggeringDamage: 120 },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("120");
  });

  it("returns undefined when triggeringDamage is missing", () => {
    const presentation = effectEventFormatters["FREEZE_REMOVED"]?.(
      event({ type: "FREEZE_REMOVED", details: { battleUnitId: "enemy:1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("BLINDNESS_CHECK_RESOLVED", () => {
  it("resolves a missed check as a negative event (R-HIT-03)", () => {
    const presentation = effectEventFormatters["BLINDNESS_CHECK_RESOLVED"]?.(
      event({
        type: "BLINDNESS_CHECK_RESOLVED",
        sourceUnitId: "ally:1",
        details: { probability: 0.2, missed: true },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("エー");
    expect(presentation?.summary).toContain("MISS");
    expect(presentation?.severity).toBe("negative");
  });

  it("resolves a hit check as neutral without a source unit", () => {
    const presentation = effectEventFormatters["BLINDNESS_CHECK_RESOLVED"]?.(
      event({ type: "BLINDNESS_CHECK_RESOLVED", details: { probability: 0.2, missed: false } }),
      rosterIndex,
    );

    expect(presentation?.summary.startsWith("-の暗闇判定")).toBe(true);
    expect(presentation?.summary).toContain("命中でした");
    expect(presentation?.severity).toBe("neutral");
  });

  it("returns undefined when missed is not a boolean", () => {
    const presentation = effectEventFormatters["BLINDNESS_CHECK_RESOLVED"]?.(
      event({ type: "BLINDNESS_CHECK_RESOLVED", details: { probability: 0.2 } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

// formatEvent経由の間接テストが無く、SKILL_MISSED/EVASION_ACTIVATEDは本モジュールでしか駆動されない。
describe("SKILL_MISSED", () => {
  it("resolves the skill id and the number of blinded effects as a negative event (R-HIT-03)", () => {
    const presentation = effectEventFormatters["SKILL_MISSED"]?.(
      event({
        type: "SKILL_MISSED",
        sourceUnitId: "ally:1",
        details: { skillDefinitionId: "SKL_1", missedByEffectInstanceIds: ["inst:1", "inst:2"] },
      }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("エー");
    expect(presentation?.summary).toContain("SKL_1");
    expect(presentation?.summary).toContain("2件の暗闇");
    expect(presentation?.severity).toBe("negative");
  });

  it("falls back to a dash actor name without a source unit", () => {
    const presentation = effectEventFormatters["SKILL_MISSED"]?.(
      event({
        type: "SKILL_MISSED",
        details: { skillDefinitionId: "SKL_1", missedByEffectInstanceIds: [] },
      }),
      rosterIndex,
    );

    expect(presentation?.summary.startsWith("-のスキル")).toBe(true);
  });

  it("returns undefined when missedByEffectInstanceIds is not an array", () => {
    const presentation = effectEventFormatters["SKILL_MISSED"]?.(
      event({ type: "SKILL_MISSED", details: { skillDefinitionId: "SKL_1" } }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});

describe("EVASION_ACTIVATED", () => {
  it("resolves the evading unit as a neutral event (R-STS-04)", () => {
    const presentation = effectEventFormatters["EVASION_ACTIVATED"]?.(
      event({ type: "EVASION_ACTIVATED", details: { targetUnitId: "enemy:1" } }),
      rosterIndex,
    );

    expect(presentation?.summary).toContain("ビーが回避しました");
    expect(presentation?.severity).toBe("neutral");
  });

  it("returns undefined when targetUnitId is missing", () => {
    const presentation = effectEventFormatters["EVASION_ACTIVATED"]?.(
      event({ type: "EVASION_ACTIVATED", details: {} }),
      rosterIndex,
    );

    expect(presentation).toBeUndefined();
  });
});
