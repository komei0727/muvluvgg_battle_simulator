import { describe, expect, it } from "vitest";
import { buildRosterIndex, formatEvent } from "./event-formatters.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY", displayName: "ビー" },
];

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

describe("formatEvent", () => {
  it("resolves DAMAGE_APPLIED into a Japanese summary using roster names", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "EFFECT_1",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 250,
          hitPointDamage: 200,
          hpBefore: 1000,
          hpAfter: 800,
          defeated: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("DAMAGE_APPLIED");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("200");
    expect(presentation.severity).toBe("negative");
  });

  it("falls back to a generic presentation for an unknown event type without crashing (UI-AC-011)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "SOME_FUTURE_EVENT_TYPE",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: { anything: "goes", nested: { value: 1 } },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("SOME_FUTURE_EVENT_TYPE");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.severity).toBe("neutral");
    expect(presentation.details).toEqual({ anything: "goes", nested: { value: 1 } });
  });

  it("falls back to a generic presentation when a known type's details don't match the expected shape", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: { unexpected: true },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("DAMAGE_APPLIED");
    expect(presentation.severity).toBe("neutral");
  });

  it("falls back to the raw battleUnitId when the roster has no matching entry", () => {
    const rosterIndex = buildRosterIndex([]);
    const presentation = formatEvent(
      event({ type: "UNKNOWN_TYPE", sourceUnitId: "ally:99", targetUnitIds: ["enemy:99"] }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ally:99");
    expect(presentation.summary).toContain("enemy:99");
  });

  it("shows no targets as a dash rather than an empty string", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({ type: "BATTLE_STARTED", targetUnitIds: [], details: { turnLimit: 10 } }),
      rosterIndex,
    );

    expect(presentation.summary).not.toBe("");
  });

  it("resolves ACTION_STARTED with AP/EX resource change and no wait reason", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          reservedActionType: "AS",
          effectiveActionType: "AS",
          apBefore: 3,
          apAfter: 2,
          exBefore: 10,
          exAfter: 20,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("ACTION_STARTED");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("AP 3 → 2");
    expect(presentation.summary).toContain("EX 10 → 20");
    expect(presentation.summary).not.toContain("待機理由");
  });

  it("resolves ACTION_STARTED with a wait reason when effectiveActionType is WAIT", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          reservedActionType: "AS",
          effectiveActionType: "WAIT",
          apBefore: 0,
          apAfter: 0,
          exBefore: 100,
          exAfter: 100,
          waitReason: "AP_EXHAUSTED",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("待機理由: AP_EXHAUSTED");
  });

  it("resolves ACTION_QUEUE_CREATED into a Japanese summary with reservation count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_QUEUE_CREATED",
        details: {
          cycleNumber: 2,
          reservations: [
            { battleUnitId: "ally:1", reservedActionKind: "AS", actionSpeed: 120 },
            { battleUnitId: "enemy:1", reservedActionKind: "EX", actionSpeed: 95 },
          ],
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("ACTION_QUEUE_CREATED");
    expect(presentation.summary).toContain("2");
    expect(presentation.summary).toContain("2件");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves ACTION_QUEUE_REORDERED into a Japanese summary", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_QUEUE_REORDERED",
        details: {
          before: [{ battleUnitId: "ally:1", actionSpeed: 90 }],
          after: [{ battleUnitId: "enemy:1", actionSpeed: 110 }],
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("ACTION_QUEUE_REORDERED");
    expect(presentation.summary).toContain("1件");
  });

  it("resolves ACTION_RESERVATION_REMOVED with the removal reason", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_RESERVATION_REMOVED",
        sourceUnitId: "enemy:1",
        details: { battleUnitId: "enemy:1", reason: "DEFEATED" },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("DEFEATED");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves ACTION_WAITED with wait reason and consumed resource", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "ACTION_WAITED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          waitReason: "NO_VALID_ACTION",
          consumedResource: "AP",
          consumedAmount: 1,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("NO_VALID_ACTION");
    expect(presentation.summary).toContain("AP");
    expect(presentation.summary).toContain("1");
  });

  it("resolves COOLDOWN_STARTED with the skill id and initial remaining count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "COOLDOWN_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          unit: "TURN",
          initialRemaining: 3,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_1");
    expect(presentation.summary).toContain("3");
  });

  it("resolves COOLDOWN_REDUCED with the before/after remaining count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "COOLDOWN_REDUCED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_1",
          unit: "TURN",
          before: 3,
          after: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("3 → 2");
  });

  it("resolves COOLDOWN_COMPLETED with the skill id", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "COOLDOWN_COMPLETED",
        sourceUnitId: "ally:1",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKILL_1", unit: "TURN" },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_1");
  });

  it("resolves CHARGE_STARTED with the skill id", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "CHARGE_STARTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_2",
          startedActionId: "action-1",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_2");
  });

  it("resolves CHARGE_RELEASED with the skill id", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "CHARGE_RELEASED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKILL_2",
          chargeStartActionId: "action-1",
          releaseActionId: "action-3",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKILL_2");
  });

  it("resolves PASSIVE_ACTIVATED with the skill id and PP/EX change (R-PS-05)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "PASSIVE_ACTIVATED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKL_PS_1",
          ppBefore: 5,
          ppAfter: 3,
          exBefore: 10,
          exAfter: 12,
          triggerEventId: "evt-1",
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("PASSIVE_ACTIVATED");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKL_PS_1");
    expect(presentation.summary).toContain("PP 5 → 3");
    expect(presentation.summary).toContain("EX 10 → 12");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves PASSIVE_RESOLVED with the resolved step count", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "PASSIVE_RESOLVED",
        sourceUnitId: "ally:1",
        details: { actorUnitId: "ally:1", skillDefinitionId: "SKL_PS_1", resolvedStepCount: 3 },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKL_PS_1");
    expect(presentation.summary).toContain("3");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves PASSIVE_INTERRUPTED with the reason and unresolved effect count as negative severity (R-PS-05 #6)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "PASSIVE_INTERRUPTED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKL_PS_1",
          reason: "OWNER_DEFEATED",
          unresolvedEffectCount: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKL_PS_1");
    expect(presentation.summary).toContain("OWNER_DEFEATED");
    expect(presentation.summary).toContain("2");
    expect(presentation.severity).toBe("negative");
  });

  it("resolves PASSIVE_POINT_CONSUMED with the before/after PP and consumed amount (R-PS-05 #2)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "PASSIVE_POINT_CONSUMED",
        sourceUnitId: "ally:1",
        details: {
          actorUnitId: "ally:1",
          skillDefinitionId: "SKL_PS_1",
          before: 5,
          after: 3,
          consumedAmount: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("SKL_PS_1");
    expect(presentation.summary).toContain("5 → 3");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves RESOURCE_CHANGED with the resource kind, before/after, and reason", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "RESOURCE_CHANGED",
        sourceUnitId: "ally:1",
        details: {
          battleUnitId: "ally:1",
          resource: "PP",
          before: 5,
          after: 3,
          delta: -2,
          reason: "SKILL_COST",
          causeEventId: "evt-1",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("PP");
    expect(presentation.summary).toContain("5 → 3");
    expect(presentation.summary).toContain("SKILL_COST");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves EXTRA_GAUGE_INCREASED with the cause resource and increased amount (R-ACT-03)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EXTRA_GAUGE_INCREASED",
        sourceUnitId: "ally:1",
        details: {
          battleUnitId: "ally:1",
          causeResource: "PP",
          before: 10,
          after: 12,
          increasedAmount: 2,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("10 → 12");
    expect(presentation.summary).toContain("PP");
    expect(presentation.severity).toBe("neutral");
  });

  it("resolves EXTRA_GAUGE_OVERFLOW_DISCARDED as a DIAGNOSTIC event with the discarded amount", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EXTRA_GAUGE_OVERFLOW_DISCARDED",
        category: "DIAGNOSTIC",
        sourceUnitId: "ally:1",
        details: {
          battleUnitId: "ally:1",
          requestedAmount: 15,
          actualAmount: 10,
          discardedAmount: 5,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("5");
    expect(presentation.severity).toBe("neutral");
  });
  it("resolves HEAL_APPLIED with the actually applied HP and the discarded overheal", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "HEAL_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_HEAL_1",
          sourceUnitId: "ally:1",
          targetUnitId: "enemy:1",
          formulaResult: 60,
          distributionShareCount: 1,
          healingModifierMultiplier: 1,
          healAmount: 60,
          appliedAmount: 40,
          discardedAmount: 20,
          hpBefore: 60,
          hpAfter: 100,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("HEAL_APPLIED");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("40");
    expect(presentation.summary).toContain("60 → 100");
    expect(presentation.summary).toContain("20");
    expect(presentation.severity).toBe("positive");
  });

  it("resolves HEALING_TRANSFERRED into the transfer source and destination (R-HEAL-04)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "HEALING_TRANSFERRED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          effectActionDefinitionId: "ACT_HEAL_LINK_1",
          fromUnitId: "ally:1",
          toUnitId: "enemy:1",
          transferRate: 0.5,
          transferredAmount: 20,
          appliedAmount: 15,
          discardedAmount: 5,
          hpBefore: 85,
          hpAfter: 100,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("15");
    // 転送先の最大HP超過で破棄された5を黙って落とさない。
    expect(presentation.summary).toContain("5");
    expect(presentation.summary).toContain("破棄");
    expect(presentation.severity).toBe("positive");
  });

  it("reports a fully discarded HEALING_TRANSFERRED as discarded rather than as a 0 heal (R-HEAL-04)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "HEALING_TRANSFERRED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          effectActionDefinitionId: "ACT_HEAL_LINK_1",
          fromUnitId: "ally:1",
          toUnitId: "enemy:1",
          transferRate: 0.5,
          transferredAmount: 20,
          appliedAmount: 0,
          discardedAmount: 20,
          hpBefore: 0,
          hpAfter: 0,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("20");
    expect(presentation.summary).toContain("破棄");
    expect(presentation.summary).not.toContain("0回復");
    expect(presentation.severity).not.toBe("positive");
  });

  it("resolves EFFECT_APPLIED with the effect kind, duration and duplicate flag", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          effectActionDefinitionId: "ACT_ATTACK_DOWN",
          sourceUnitId: "ally:1",
          targetUnitId: "enemy:1",
          duplicate: true,
          kindKey: "ACT_ATTACK_DOWN",
          magnitude: -0.1,
          durationUnit: "TURN",
          initialRemaining: 2,
          linkedEffectGroupId: null,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("ACT_ATTACK_DOWN");
    expect(presentation.summary).toContain("TURN");
    expect(presentation.summary).toContain("2");
    expect(presentation.summary).toContain("重複");
  });

  it("names the status kind of an APPLY_STATUS-derived EFFECT_APPLIED instead of only its definition id (M7-009)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:2",
          effectActionDefinitionId: "ACT_STUN_1",
          sourceUnitId: "ally:1",
          targetUnitId: "enemy:1",
          duplicate: false,
          kindKey: "ACT_STUN_1",
          magnitude: 0,
          statusKind: "STUN",
          durationUnit: "ACTION",
          initialRemaining: 1,
          linkedEffectGroupId: null,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("STUN");
  });

  it("does not classify an advantageous APPLY_STATUS as a status abnormality or a negative event", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:4",
          effectActionDefinitionId: "ACT_STEALTH_1",
          sourceUnitId: "ally:1",
          targetUnitId: "ally:1",
          duplicate: false,
          kindKey: "ACT_STEALTH_1",
          magnitude: 0,
          statusKind: "STEALTH",
          linkedEffectGroupId: null,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("STEALTH");
    expect(presentation.summary).not.toContain("状態異常");
    expect(presentation.severity).not.toBe("negative");
  });

  it("does not call a rejected advantageous APPLY_STATUS a status abnormality either", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLICATION_REJECTED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["ally:1"],
        details: {
          battleUnitId: "ally:1",
          effectActionDefinitionId: "ACT_STEALTH_1",
          sourceUnitId: "ally:1",
          blockingEffectInstanceId: "battle-1:effect:9",
          reason: "IMMUNITY",
          statusKind: "STEALTH",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("STEALTH");
    expect(presentation.summary).not.toContain("状態異常");
  });

  it("uses the Memory grant's sourceSide when EFFECT_APPLIED has no source unit (R-MEM-04)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLIED",
        sourceSide: "ALLY",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:3",
          effectActionDefinitionId: "ACT_ATTACK_UP",
          sourceSide: "ALLY",
          targetUnitId: "ally:1",
          duplicate: false,
          kindKey: "ACT_ATTACK_UP",
          magnitude: 0.1,
          linkedEffectGroupId: null,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ALLY");
    expect(presentation.summary).toContain("エー");
  });

  it("resolves EFFECT_APPLICATION_REJECTED into the blocked status and the blocking instance (R-EFF-03)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLICATION_REJECTED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_STUN_1",
          sourceUnitId: "ally:1",
          blockingEffectInstanceId: "battle-1:effect:9",
          reason: "IMMUNITY",
          statusKind: "STUN",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("IMMUNITY");
    expect(presentation.summary).toContain("STUN");
  });

  it("resolves EFFECT_EXPIRED with its expiry reason and cascade flag (R-EFF-04/09)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_EXPIRED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_ATTACK_DOWN",
          kindKey: "ACT_ATTACK_DOWN",
          reason: "TIME_LIMIT",
          linkedEffectGroupId: null,
          cascaded: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("ACT_ATTACK_DOWN");
    expect(presentation.summary).toContain("TIME_LIMIT");
  });

  it("marks a cascaded EFFECT_REMOVED as linked-group removal (R-EFF-02/09)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_REMOVED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_ATTACK_DOWN",
          kindKey: "ACT_ATTACK_DOWN",
          reason: "LINKED_GROUP_CASCADE",
          linkedEffectGroupId: "GRP_1",
          cascaded: true,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("LINKED_GROUP_CASCADE");
    expect(presentation.summary).toContain("連動");
  });

  it("resolves EFFECT_DURATION_REDUCED and EFFECT_CONSUMPTION_CHANGED as before → after transitions", () => {
    const rosterIndex = buildRosterIndex(roster);
    const duration = formatEvent(
      event({
        type: "EFFECT_DURATION_REDUCED",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "ally:1",
          unit: "TURN",
          before: 2,
          after: 1,
        },
      }),
      rosterIndex,
    );
    const consumption = formatEvent(
      event({
        type: "EFFECT_CONSUMPTION_CHANGED",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "ally:1",
          kind: "ON_DAMAGE_TAKEN",
          before: 2,
          after: 1,
        },
      }),
      rosterIndex,
    );

    expect(duration.summary).toContain("エー");
    expect(duration.summary).toContain("2 → 1");
    expect(consumption.summary).toContain("エー");
    expect(consumption.summary).toContain("2 → 1");
  });

  // Issue #519（R-STA-03）: `kindKey`はCatalog宣言由来の同種グループ鍵になり、
  // 複数の定義が共有し得る。効果そのものの表示は付与元を名指しできる
  // `effectActionDefinitionId`へ寄せ、`kindKey`はグループを指すイベントだけで使う。
  it("names the effect by its definition id, not its kindKey group (EFFECT_APPLIED / EXPIRED / REMOVED)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const applied = formatEvent(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
          sourceUnitId: "ally:1",
          targetUnitId: "ally:1",
          duplicate: false,
          kindKey: "KIND_ELENA_MOODMAKER_EX_ATK_UP",
          magnitude: 0.35,
          durationUnit: "TURN",
          initialRemaining: 2,
          linkedEffectGroupId: null,
        },
      }),
      rosterIndex,
    );
    const expired = formatEvent(
      event({
        type: "EFFECT_EXPIRED",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "ally:1",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
          kindKey: "KIND_ELENA_MOODMAKER_EX_ATK_UP",
          reason: "TIME_LIMIT",
          linkedEffectGroupId: null,
          cascaded: false,
        },
      }),
      rosterIndex,
    );
    const removed = formatEvent(
      event({
        type: "EFFECT_REMOVED",
        targetUnitIds: ["ally:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "ally:1",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
          kindKey: "KIND_ELENA_MOODMAKER_EX_ATK_UP",
          reason: "DISPELLED",
          linkedEffectGroupId: null,
          cascaded: false,
        },
      }),
      rosterIndex,
    );

    for (const presentation of [applied, expired, removed]) {
      expect(presentation.summary).toContain("ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH");
      expect(presentation.summary).not.toContain("KIND_ELENA_MOODMAKER_EX_ATK_UP");
    }
  });

  // グループ単位のイベントは単一の定義IDを名指しできないため、`kindKey`表示のままにする。
  it("keeps naming the group by its kindKey in EFFECTIVE_EFFECT_CHANGED (Issue #519)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECTIVE_EFFECT_CHANGED",
        targetUnitIds: ["ally:1"],
        details: {
          battleUnitId: "ally:1",
          kindKey: "KIND_ELENA_MOODMAKER_EX_ATK_UP",
          before: "battle-1:effect:1",
          after: "battle-1:effect:2",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("KIND_ELENA_MOODMAKER_EX_ATK_UP");
  });

  it("resolves EFFECTIVE_EFFECT_CHANGED and COMBAT_STAT_CHANGED (R-EFF-05 / R-STA-04)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const effective = formatEvent(
      event({
        type: "EFFECTIVE_EFFECT_CHANGED",
        targetUnitIds: ["ally:1"],
        details: {
          battleUnitId: "ally:1",
          kindKey: "ACT_ATTACK_UP",
          before: "battle-1:effect:1",
          after: "battle-1:effect:2",
        },
      }),
      rosterIndex,
    );
    const stat = formatEvent(
      event({
        type: "COMBAT_STAT_CHANGED",
        targetUnitIds: ["ally:1"],
        details: {
          battleUnitId: "ally:1",
          stat: "ATTACK",
          before: 100,
          after: 110,
          reason: "EFFECT_APPLIED",
        },
      }),
      rosterIndex,
    );

    expect(effective.summary).toContain("ACT_ATTACK_UP");
    expect(stat.summary).toContain("ATTACK");
    expect(stat.summary).toContain("100 → 110");
    expect(stat.severity).toBe("neutral");
  });

  it("resolves the stun/freeze/blind status events (R-STS-02/03, R-HIT-03)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const stun = formatEvent(
      event({
        type: "STUN_DURATION_CHANGED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:1",
          battleUnitId: "enemy:1",
          remainingBefore: 1,
          remainingAfter: 2,
          reason: "REGRANT_EXTENDED",
        },
      }),
      rosterIndex,
    );
    const freeze = formatEvent(
      event({
        type: "FREEZE_REMOVED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle-1:effect:2",
          battleUnitId: "enemy:1",
          triggeringDamage: 300,
        },
      }),
      rosterIndex,
    );
    const blind = formatEvent(
      event({
        type: "BLINDNESS_CHECK_RESOLVED",
        sourceUnitId: "ally:1",
        details: {
          effectActionDefinitionId: "ACT_BLIND_1",
          effectInstanceId: "battle-1:effect:3",
          probability: 30,
          missed: true,
        },
      }),
      rosterIndex,
    );

    expect(stun.summary).toContain("ビー");
    expect(stun.summary).toContain("1 → 2");
    expect(freeze.summary).toContain("ビー");
    expect(freeze.summary).toContain("300");
    expect(blind.summary).toContain("エー");
    expect(blind.summary).toContain("30");
    expect(blind.severity).toBe("negative");
  });

  it("falls back to the generic presentation when an M7 event's details are malformed (UI-AC-011)", () => {
    const rosterIndex = buildRosterIndex(roster);
    const presentation = formatEvent(
      event({
        type: "EFFECT_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: { effectInstanceId: 42 },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("EFFECT_APPLIED");
    expect(presentation.summary).toBe("エー → ビー");
    expect(presentation.severity).toBe("neutral");
  });
});
