// DMG-010 (Issue #191): 「M8 高度ダメージ拡張」完了条件
// 「calculated、shield absorbed、HP damageを混同せず表示する」。
// 各payloadの正本は apps/api/src/domain/battle/events/domain-event.ts と
// apps/api/src/presentation/http/schemas/battle-log/battle-log-schema.ts。

import { describe, expect, it } from "vitest";
import { buildRosterIndex, formatEvent } from "./event-formatters.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

const roster: readonly RosterEntry[] = [
  { battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "エー" },
  { battleUnitId: "ally:2", unitDefinitionId: "UNIT_C", side: "ALLY", displayName: "シー" },
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

describe("DAMAGE_APPLIED breakdown (R-SHD-02/R-SUB-01/R-SHD-03, DMG-004/005)", () => {
  // UI-UT-DMG-001
  it("separates calculated damage, typed/untyped shield absorption, sub unit absorption and HP damage", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 2,
          targetUnitId: "enemy:1",
          calculatedDamage: 250,
          hpDirectDamage: 20,
          typedShieldAbsorbed: 30,
          untypedShieldAbsorbed: 10,
          subUnitAbsorbed: 5,
          discardedDamage: 15,
          hitPointDamage: 190,
          hpBefore: 190,
          hpAfter: 0,
          defeated: true,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("DAMAGE_APPLIED");
    expect(presentation.summary).toContain("ヒット3");
    expect(presentation.summary).toContain("計算ダメージ250");
    expect(presentation.summary).toContain("タイプありシールド吸収30");
    expect(presentation.summary).toContain("タイプなしシールド吸収10");
    expect(presentation.summary).toContain("サブユニット吸収5");
    expect(presentation.summary).toContain("破棄15");
    expect(presentation.summary).toContain("HPダメージ190");
    expect(presentation.summary).toContain("HP 190 → 0");
    expect(presentation.severity).toBe("negative");
  });

  // UI-UT-DMG-002: M4〜M7 fixtureは内訳フィールドを持たない。
  it("keeps rendering an M4-era DAMAGE_APPLIED without the M8 breakdown fields", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 120,
          hitPointDamage: 80,
          hpBefore: 80,
          hpAfter: 0,
          defeated: true,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("HPダメージ80");
    expect(presentation.summary).toContain("HP 80 → 0");
    expect(presentation.summary).not.toContain("シールド吸収");
    expect(presentation.summary).not.toContain("サブユニット吸収");
  });

  // UI-UT-DMG-003: 吸収が0のヒットで内訳ノイズを増やさない。
  it("omits zero-valued absorption terms so an ordinary hit stays readable", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 100,
          hpDirectDamage: 0,
          typedShieldAbsorbed: 0,
          untypedShieldAbsorbed: 0,
          subUnitAbsorbed: 0,
          discardedDamage: 0,
          hitPointDamage: 100,
          hpBefore: 300,
          hpAfter: 200,
          defeated: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("計算ダメージ100");
    expect(presentation.summary).toContain("HPダメージ100");
    expect(presentation.summary).not.toContain("シールド吸収");
    expect(presentation.summary).not.toContain("サブユニット吸収");
    expect(presentation.summary).not.toContain("破棄");
  });

  // UI-UT-DMG-004: R-INT-03第3項 / R-LNK-03第1項。反射・リンク由来を通常ヒットと混同しない。
  it("labels reflected and linked damage instead of showing them as an ordinary hit", () => {
    const reflected = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "enemy:1",
        targetUnitIds: ["ally:1"],
        details: {
          effectActionDefinitionId: "ACT_REFLECT",
          hitIndex: 0,
          targetUnitId: "ally:1",
          calculatedDamage: 30,
          hitPointDamage: 30,
          hpBefore: 100,
          hpAfter: 70,
          defeated: false,
          isReflectedDamage: true,
        },
      }),
      rosterIndex,
    );
    const linked = formatEvent(
      event({
        type: "DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_LINK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 40,
          hitPointDamage: 40,
          hpBefore: 100,
          hpAfter: 60,
          defeated: false,
          isLinkedDamage: true,
        },
      }),
      rosterIndex,
    );

    expect(reflected.summary).toContain("反射ダメージ");
    expect(reflected.summary).not.toContain("ヒット1");
    expect(linked.summary).toContain("リンクダメージ");
    expect(linked.summary).not.toContain("ヒット1");
  });
});

describe("damage pipeline events (R-DMG-01〜05, DMG-001〜003)", () => {
  // UI-UT-DMG-005
  it("shows the DAMAGE_CALCULATED inputs including defense ignore and the final damage", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_CALCULATED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          skillDefinitionId: "SKL_A",
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 1,
          targetUnitId: "enemy:1",
          attackerAttack: 500,
          defenderDefense: 200,
          effectiveDefense: 120,
          defenseIgnoreRate: 0.4,
          shieldIgnoreRate: 0,
          damageReductionIgnoreRate: 0,
          skillPower: 1.5,
          attributeMultiplier: 1.2,
          criticalMultiplier: 1.5,
          outgoingDamageMultiplier: 1.1,
          incomingDamageMultiplier: 0.9,
          actionDamageMultiplier: 1,
          confusionDamageMultiplier: 1,
          preTruncationDamage: 312.4,
          finalDamage: 312,
          damageType: "PHYSICAL",
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("DAMAGE_CALCULATED");
    expect(presentation.summary).toContain("ヒット2");
    expect(presentation.summary).toContain("計算ダメージ312");
    expect(presentation.summary).toContain("実効防御120");
    expect(presentation.summary).toContain("防御貫通40%");
    expect(presentation.summary).toContain("PHYSICAL");
    expect(presentation.severity).toBe("neutral");
  });

  // UI-UT-DMG-006: R-CFS-02の混乱倍率は与ダメージ倍率と別枠で表示する。
  it("shows the confusion multiplier separately from the outgoing damage multiplier", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_CALCULATED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          skillDefinitionId: "SKL_A",
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          attackerAttack: 500,
          defenderDefense: 200,
          effectiveDefense: 200,
          defenseIgnoreRate: 0,
          shieldIgnoreRate: 0,
          damageReductionIgnoreRate: 0,
          skillPower: 1,
          attributeMultiplier: 1,
          criticalMultiplier: 1,
          outgoingDamageMultiplier: 1,
          incomingDamageMultiplier: 1,
          actionDamageMultiplier: 1,
          confusionDamageMultiplier: 0.5,
          preTruncationDamage: 150,
          finalDamage: 150,
          damageType: "EN",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("混乱倍率0.5");
  });

  // UI-UT-DMG-007: R-DMG-03の貫通3割合（DamageWillBeApplied）。
  it("shows the three piercing rates of DAMAGE_WILL_BE_APPLIED", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_WILL_BE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          skillDefinitionId: "SKL_A",
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          damageType: "PHYSICAL",
          isCritical: true,
          criticalMultiplier: 1.5,
          defenseIgnoreRate: 0.3,
          shieldIgnoreRate: 0.2,
          damageReductionIgnoreRate: 0.1,
          outgoingDamageMultiplier: 1,
          incomingDamageMultiplier: 1,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("防御貫通30%");
    expect(presentation.summary).toContain("シールド貫通20%");
    expect(presentation.summary).toContain("軽減貫通10%");
    expect(presentation.summary).toContain("会心");
  });

  // UI-UT-DMG-008: R-CRT-01。
  it("shows the effective critical rate and the resolved result", () => {
    const presentation = formatEvent(
      event({
        type: "CRITICAL_CHECK_RESOLVED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          mode: "PROBABILISTIC",
          baseCriticalRate: 1.2,
          effectiveCriticalRate: 1,
          result: true,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("会心");
    expect(presentation.summary).toContain("100%");
    expect(presentation.summary).toContain("PROBABILISTIC");
  });

  // UI-UT-DMG-009: HitPointReducedがHP変化のStateDeltaを持つ（DamageAppliedは持たない）。
  it("shows the HP reduction of HIT_POINT_REDUCED", () => {
    const presentation = formatEvent(
      event({
        type: "HIT_POINT_REDUCED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          hitPointDamage: 80,
          hpBefore: 100,
          hpAfter: 20,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("HPダメージ80");
    expect(presentation.summary).toContain("HP 100 → 20");
    expect(presentation.severity).toBe("negative");
  });
});

describe("shield and sub unit absorption events (R-SHD-01〜03, R-SUB-01)", () => {
  // UI-UT-DMG-010
  it("shows the consumed shield pool type and the absorbed amount", () => {
    const presentation = formatEvent(
      event({
        type: "SHIELD_CONSUMED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          battleUnitId: "enemy:1",
          reason: "DAMAGE_ABSORPTION",
          shieldType: "PHYSICAL",
          before: 100,
          after: 40,
          absorbed: 60,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("PHYSICAL");
    expect(presentation.summary).toContain("60");
    expect(presentation.summary).toContain("100 → 40");
    expect(presentation.summary).toContain("DAMAGE_ABSORPTION");
  });

  // UI-UT-DMG-011: `shieldType: null`はタイプなしプール。
  it("names the untyped shield pool instead of printing null", () => {
    const presentation = formatEvent(
      event({
        type: "SHIELD_CONSUMED",
        targetUnitIds: ["enemy:1"],
        details: {
          battleUnitId: "enemy:1",
          reason: "DECAY",
          shieldType: null,
          before: 30,
          after: 25,
          absorbed: 5,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("タイプなし");
    expect(presentation.summary).not.toContain("null");
    expect(presentation.summary).toContain("DECAY");
  });

  // UI-UT-DMG-012: R-SUB-01第3項。サブユニットはインスタンス単位。
  it("shows the sub unit instance durability change", () => {
    const presentation = formatEvent(
      event({
        type: "SUB_UNIT_DAMAGED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 1,
          battleUnitId: "enemy:1",
          effectInstanceId: "battle:effect:7",
          subUnitDefinitionId: "ACT_SUBUNIT_DRONE",
          reason: "DAMAGE_ABSORPTION",
          before: 50,
          after: 0,
          absorbed: 50,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ACT_SUBUNIT_DRONE");
    expect(presentation.summary).toContain("50");
    expect(presentation.summary).toContain("50 → 0");
    expect(presentation.summary).toContain("ヒット2");
  });
});

describe("defensive intervention events (R-INT-01〜03, R-LNK-01〜03)", () => {
  // UI-UT-DMG-013
  it("distinguishes a target redirect from a cover with its guard rate", () => {
    const redirect = formatEvent(
      event({
        type: "DAMAGE_REDIRECTED",
        sourceUnitId: "ally:1",
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          reason: "TARGET_REDIRECT",
          originalTargetUnitId: "enemy:1",
          newTargetUnitId: "ally:2",
          effectInstanceId: "battle:effect:1",
          causeEffectActionDefinitionId: "ACT_TAUNT",
        },
      }),
      rosterIndex,
    );
    const cover = formatEvent(
      event({
        type: "DAMAGE_REDIRECTED",
        sourceUnitId: "ally:1",
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          reason: "COVER",
          originalTargetUnitId: "enemy:1",
          newTargetUnitId: "ally:2",
          effectInstanceId: "battle:effect:2",
          causeEffectActionDefinitionId: "ACT_COVER",
          damageShareRate: 1,
          guardRate: 0.3,
        },
      }),
      rosterIndex,
    );

    expect(redirect.summary).toContain("引き寄せ");
    expect(redirect.summary).toContain("ビー");
    expect(redirect.summary).toContain("シー");
    expect(redirect.summary).not.toContain("軽減率");
    expect(cover.summary).toContain("肩代わり");
    expect(cover.summary).toContain("軽減率30%");
  });

  // UI-UT-DMG-014: R-INT-03。
  it("shows the reflected damage with its source amount", () => {
    const presentation = formatEvent(
      event({
        type: "REFLECTED_DAMAGE_GENERATED",
        details: {
          sourceDamageEventId: "battle:event:12",
          effectInstanceId: "battle:effect:3",
          effectActionDefinitionId: "ACT_REFLECT",
          reflectedByUnitId: "enemy:1",
          reflectToUnitId: "ally:1",
          sourceDamage: 200,
          formulaResult: 40.5,
          reflectedDamage: 40,
          damageType: "EN",
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("元ダメージ200");
    expect(presentation.summary).toContain("反射ダメージ40");
    expect(presentation.summary).toContain("EN");
  });

  // UI-UT-DMG-015: R-LNK-01/02。
  it("shows the link rate and whether the linked damage bypasses shields", () => {
    const presentation = formatEvent(
      event({
        type: "LINKED_DAMAGE_GENERATED",
        details: {
          sourceDamageEventId: "battle:event:20",
          effectInstanceId: "battle:effect:4",
          effectActionDefinitionId: "ACT_LINK",
          linkedFromUnitId: "enemy:1",
          linkToUnitId: "ally:2",
          sourceDamage: 300,
          linkRate: 0.25,
          linkedDamage: 75,
          damageType: "PHYSICAL",
          shieldApplicable: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("元ダメージ300");
    expect(presentation.summary).toContain("リンク率25%");
    expect(presentation.summary).toContain("リンクダメージ75");
    expect(presentation.summary).toContain("シールド適用なし");
  });

  // UI-UT-DMG-016: R-INT-01 #5。
  it("shows the survival HP of a lethal damage that was survived", () => {
    const presentation = formatEvent(
      event({
        type: "LETHAL_DAMAGE_SURVIVED",
        details: {
          effectInstanceId: "battle:effect:5",
          effectActionDefinitionId: "ACT_GUTS",
          battleUnitId: "ally:1",
          lethalDamage: 500,
          hpBefore: 120,
          survivalHp: 1,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("エー");
    expect(presentation.summary).toContain("致死");
    expect(presentation.summary).toContain("500");
    expect(presentation.summary).toContain("HP 120 → 1");
    expect(presentation.severity).toBe("positive");
  });

  // UI-UT-DMG-017: R-DTH-01（DMG-009）。ダメージではなく回復として読める。
  it("shows a damage-to-heal conversion as healing, not as damage", () => {
    const presentation = formatEvent(
      event({
        type: "DAMAGE_CONVERTED_TO_HEAL",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectActionDefinitionId: "ACT_ATTACK",
          hitIndex: 0,
          targetUnitId: "enemy:1",
          calculatedDamage: 200,
          healRate: 0.5,
          healAmount: 100,
          appliedHeal: 60,
          hpBefore: 40,
          hpAfter: 100,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("計算ダメージ200");
    expect(presentation.summary).toContain("回復60");
    expect(presentation.summary).toContain("HP 40 → 100");
    expect(presentation.severity).toBe("positive");
  });
});

describe("continuous damage events (R-DOT-01〜04, DMG-008)", () => {
  // UI-UT-DMG-018
  it("shows the continuous damage kind and its shield absorption breakdown", () => {
    const presentation = formatEvent(
      event({
        type: "CONTINUOUS_DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle:effect:6",
          effectActionDefinitionId: "ACT_BURN",
          continuousDamageKind: "BURN",
          damageType: "EN",
          targetUnitId: "enemy:1",
          snapshotAttack: 400,
          formulaResult: 40,
          burnStackMultiplier: 2,
          cappedBySnapshotAttack: false,
          calculatedDamage: 80,
          typedShieldAbsorbed: 0,
          untypedShieldAbsorbed: 0,
          discardedDamage: 0,
          hitPointDamage: 80,
          hpBefore: 200,
          hpAfter: 120,
          defeated: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("BURN");
    expect(presentation.summary).toContain("計算ダメージ80");
    expect(presentation.summary).toContain("HPダメージ80");
    expect(presentation.summary).toContain("HP 200 → 120");
    expect(presentation.summary).toContain("炎上3スタック");
    expect(presentation.severity).toBe("negative");
  });

  // UI-UT-DMG-018B: R-SUB-01第1項どおり`FIXED`継続ダメージは
  // サブユニットへも吸収される。この項が内訳から落ちると`計算ダメージ100 → HPダメージ20`の
  // 差分80を説明できない。
  it("shows the sub unit absorption of a FIXED continuous damage so the breakdown still adds up", () => {
    const presentation = formatEvent(
      event({
        type: "CONTINUOUS_DAMAGE_APPLIED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle:effect:7",
          effectActionDefinitionId: "ACT_DOT",
          continuousDamageKind: "FIXED",
          damageType: "PHYSICAL",
          targetUnitId: "enemy:1",
          snapshotAttack: 400,
          formulaResult: 100,
          burnStackMultiplier: 1,
          cappedBySnapshotAttack: false,
          calculatedDamage: 100,
          typedShieldAbsorbed: 30,
          untypedShieldAbsorbed: 0,
          subUnitAbsorbed: 50,
          discardedDamage: 0,
          hitPointDamage: 20,
          hpBefore: 200,
          hpAfter: 180,
          defeated: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("計算ダメージ100");
    expect(presentation.summary).toContain("タイプありシールド吸収30");
    expect(presentation.summary).toContain("サブユニット吸収50");
    expect(presentation.summary).toContain("HPダメージ20");
  });

  // UI-UT-DMG-019: R-DOT-04の上限到達。
  it("flags a continuous damage capped by the snapshot attack", () => {
    const presentation = formatEvent(
      event({
        type: "CONTINUOUS_DAMAGE_APPLIED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle:effect:6",
          effectActionDefinitionId: "ACT_POISON",
          continuousDamageKind: "POISON",
          damageType: "PHYSICAL",
          targetUnitId: "enemy:1",
          snapshotAttack: 100,
          formulaResult: 350,
          burnStackMultiplier: 1,
          cappedBySnapshotAttack: true,
          calculatedDamage: 100,
          typedShieldAbsorbed: 0,
          untypedShieldAbsorbed: 0,
          discardedDamage: 0,
          hitPointDamage: 100,
          hpBefore: 300,
          hpAfter: 200,
          defeated: false,
        },
      }),
      rosterIndex,
    );

    expect(presentation.summary).toContain("POISON");
    expect(presentation.summary).toContain("上限");
  });

  // UI-UT-DMG-020: R-DOT-04の毒統合。
  it("shows the merged magnitude and duration of a re-applied poison", () => {
    const presentation = formatEvent(
      event({
        type: "EFFECT_MERGED",
        targetUnitIds: ["enemy:1"],
        details: {
          effectInstanceId: "battle:effect:6",
          battleUnitId: "enemy:1",
          effectActionDefinitionId: "ACT_POISON_STRONG",
          reason: "POISON_REAPPLY",
          magnitudeBefore: 0.05,
          magnitudeAfter: 0.1,
        },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("EFFECT_MERGED");
    expect(presentation.summary).toContain("ビー");
    expect(presentation.summary).toContain("POISON_REAPPLY");
    expect(presentation.summary).toContain("0.05 → 0.1");
  });
});

describe("contract mismatch fallback (UI-AC-011)", () => {
  // UI-UT-DMG-021: 想定shapeでないdetailsはgeneric fallbackへ落ちる。
  it("falls back to the generic presentation when a damage payload loses a required field", () => {
    const presentation = formatEvent(
      event({
        type: "SHIELD_CONSUMED",
        sourceUnitId: "ally:1",
        targetUnitIds: ["enemy:1"],
        details: { battleUnitId: "enemy:1", reason: "DAMAGE_ABSORPTION" },
      }),
      rosterIndex,
    );

    expect(presentation.title).toBe("SHIELD_CONSUMED");
    expect(presentation.summary).toBe("エー → ビー");
    expect(presentation.severity).toBe("neutral");
  });
});
