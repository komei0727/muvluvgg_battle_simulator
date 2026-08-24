import { describe, expect, it } from "vitest";

import { effectCategoriesOf } from "./effect-category-classifier.js";
import { createEffectActionDefinition } from "../../catalog/definitions/effect-action-definition-factory.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";

/** R-EFF-02: 効果カテゴリ分類（`effect-category-classifier.ts`）のUnitテスト。 */
describe("effectCategoriesOf", () => {
  function statModDefinition(id: string): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: id,
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "RATIO",
          formula: { kind: "CONSTANT", value: 0.3 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
      },
      "effectAction",
    );
  }

  function statusDefinition(id: string, status: StatusKind): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: id,
        kind: "APPLY_STATUS",
        payload: { status, duration: { timeLimit: { unit: "ACTION", count: 1 } } },
      },
      "effectAction",
    );
  }

  function damageModDefinition(id: string): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: id,
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction: "OUTGOING",
          formula: { kind: "CONSTANT", value: 0.2 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
      },
      "effectAction",
    );
  }

  function incomingDamageModDefinition(id: string): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: id,
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction: "INCOMING",
          formula: { kind: "CONSTANT", value: -0.75 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
      },
      "effectAction",
    );
  }

  // `effectCategoriesOf` only reads `magnitude`/`statusKind` (Pick), so the
  // fixture is exactly that projection — no full AppliedEffect construction.
  // `exactOptionalPropertyTypes` forbids an explicit `statusKind: undefined`,
  // so include the key only when a status is given.
  function effect(overrides: {
    magnitude: number;
    statusKind?: NonNullable<AppliedEffect["statusKind"]>;
  }): Pick<AppliedEffect, "magnitude" | "statusKind"> {
    return {
      magnitude: overrides.magnitude,
      ...(overrides.statusKind !== undefined ? { statusKind: overrides.statusKind } : {}),
    };
  }

  it("UT-R-EFF-02-001: classifies a positive-magnitude APPLY_STAT_MOD as BUFF", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0.3 }),
      statModDefinition("ACT_ATK_UP"),
    );
    expect([...categories]).toEqual(["BUFF"]);
  });

  it("UT-R-EFF-02-002: classifies a negative-magnitude APPLY_STAT_MOD as DEBUFF", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: -0.3 }),
      statModDefinition("ACT_ATK_DOWN"),
    );
    expect([...categories]).toEqual(["DEBUFF"]);
  });

  it("UT-R-EFF-02-003: classifies a beneficial APPLY_STATUS (STEALTH) as BUFF, not STATUS", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0, statusKind: "STEALTH" }),
      statusDefinition("ACT_STEALTH", "STEALTH"),
    );
    expect([...categories]).toEqual(["BUFF"]);
  });

  it("UT-R-EFF-02-004 [R-EFF-02, R-STS-01]: classifies a 状態異常 APPLY_STATUS (STUN) as both STATUS and DEBUFF (R-STS-01)", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0, statusKind: "STUN" }),
      statusDefinition("ACT_STUN", "STUN"),
    );
    expect(new Set(categories)).toEqual(new Set(["STATUS", "DEBUFF"]));
  });

  it("UT-R-EFF-02-005: classifies FREEZE and BLIND as STATUS+DEBUFF ailments", () => {
    for (const status of ["FREEZE", "BLIND"] as const) {
      const categories = effectCategoriesOf(
        effect({ magnitude: 0, statusKind: status }),
        statusDefinition(`ACT_${status}`, status),
      );
      expect(new Set(categories)).toEqual(new Set(["STATUS", "DEBUFF"]));
    }
  });

  it("UT-R-EFF-02-026 (R-CRT-03, DMG-003A/Issue #295): classifies CRITICAL_PREVENTION as DEBUFF only — it weakens its own holder's attacks, but is not one of the defined 状態異常", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0, statusKind: "CRITICAL_PREVENTION" }),
      statusDefinition("ACT_CRIT_PREVENTION", "CRITICAL_PREVENTION"),
    );
    expect([...categories]).toEqual(["DEBUFF"]);
  });

  it("UT-R-EFF-02-028 [R-DTH-01] (R-CFS-01/R-DTH-01, DMG-009/Issue #193): classifies CONFUSION and DAMAGE_TO_HEAL as DEBUFF only — neither is one of the defined 状態異常", () => {
    const confusion = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_CONFUSION",
        kind: "APPLY_STATUS",
        payload: {
          status: "CONFUSION",
          duration: { timeLimit: { unit: "ACTION", count: 1 } },
          confusion: { damageReductionRate: 0.3, lowAttackBaseDamageRate: 0.1 },
        },
      },
      "effectAction",
    );
    const damageToHeal = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_TO_HEAL",
        kind: "APPLY_STATUS",
        payload: {
          status: "DAMAGE_TO_HEAL",
          duration: { timeLimit: { unit: "ACTION", count: 1 } },
          damageToHeal: { healRate: 0.7 },
        },
      },
      "effectAction",
    );
    expect([
      ...effectCategoriesOf(effect({ magnitude: 0, statusKind: "CONFUSION" }), confusion),
    ]).toEqual(["DEBUFF"]);
    expect([
      ...effectCategoriesOf(effect({ magnitude: 0, statusKind: "DAMAGE_TO_HEAL" }), damageToHeal),
    ]).toEqual(["DEBUFF"]);
  });

  it("UT-R-EFF-02-027 (R-CRT-03, DMG-003A/Issue #295): classifies CRITICAL_GUARANTEE as BUFF — the counterpart status strengthens its holder's attacks", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0, statusKind: "CRITICAL_GUARANTEE" }),
      statusDefinition("ACT_CRIT_GUARANTEE", "CRITICAL_GUARANTEE"),
    );
    expect([...categories]).toEqual(["BUFF"]);
  });

  function continuousDamageDefinition(
    id: string,
    continuousDamageKind: "FIXED" | "BURN" | "POISON",
  ): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: id,
        kind: "APPLY_CONTINUOUS_DAMAGE",
        payload: {
          continuousDamageKind,
          damageType: "PHYSICAL",
          formula: { kind: "CONSTANT", value: 100 },
          timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
          duration: { timeLimit: { unit: "ACTION", count: 3 } },
        },
      },
      "effectAction",
    );
  }

  it("UT-R-EFF-02-007 [R-EFF-02, R-STS-01] (RES-004-STATUS-CONDITION, Issue #224): classifies POISON continuous damage as STATUS+DEBUFF", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 120 }),
      continuousDamageDefinition("ACT_POISON", "POISON"),
    );
    expect(new Set(categories)).toEqual(new Set(["STATUS", "DEBUFF"]));
  });

  it("UT-R-EFF-02-008 [R-EFF-02, R-STS-01] (RES-004-STATUS-CONDITION, Issue #224): classifies BURN continuous damage as STATUS+DEBUFF", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 120 }),
      continuousDamageDefinition("ACT_BURN", "BURN"),
    );
    expect(new Set(categories)).toEqual(new Set(["STATUS", "DEBUFF"]));
  });

  it("UT-R-EFF-02-009 [R-EFF-02, R-STS-01] (RES-004-STATUS-CONDITION, Issue #224): classifies FIXED continuous damage as DEBUFF only, not STATUS", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 120 }),
      continuousDamageDefinition("ACT_FIXED_DOT", "FIXED"),
    );
    expect([...categories]).toEqual(["DEBUFF"]);
  });

  it("UT-R-EFF-02-006: classifies APPLY_DAMAGE_MOD as DAMAGE_MOD plus a polarity (BUFF for positive)", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0.2 }),
      damageModDefinition("ACT_DMG_UP"),
    );
    expect(new Set(categories)).toEqual(new Set(["DAMAGE_MOD", "BUFF"]));
  });

  // R-EFF-05 の「弱化量」は保持者から見た不利であり`magnitude`の符号ではない。
  // 被ダメージ補正は符号の意味が与ダメージ側と逆で、負値が保持者を強化する。
  // 符号だけで決めると「デバフをすべて解除」（`ACT_MEIYA_FATED_PS1_REMOVE_DEBUFF`）が
  // 自分の被ダメージ減少バフを剥がし、「自身にデバフが付与された際に発動」する
  // PSが自分への防御バフで発動してしまう。
  it("UT-R-EFF-02-029: classifies an incoming damage reduction as BUFF — the negative magnitude strengthens its holder", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: -0.75 }),
      incomingDamageModDefinition("ACT_INCOMING_DMG_DOWN"),
    );
    expect(new Set(categories)).toEqual(new Set(["DAMAGE_MOD", "BUFF"]));
  });

  it("UT-R-EFF-02-030: classifies an incoming damage increase as DEBUFF — the positive magnitude weakens its holder", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 0.3 }),
      incomingDamageModDefinition("ACT_INCOMING_DMG_UP"),
    );
    expect(new Set(categories)).toEqual(new Set(["DAMAGE_MOD", "DEBUFF"]));
  });

  // M7-001A（Issue #242、`REMOVE_EFFECTS_CATEGORY_GAP`）: シールド／サブユニットは
  // 保持者にとって有利な効果であり`magnitude`（付与時の最大値・最大耐久力）は常に
  // 非負のため、符号から導く既定の分岐に落ちると`BUFF`として分類される。そうなると
  // 「バフを解除する」`REMOVE_EFFECTS`（`ACT_MAO_COMMITTEE_PS2_CLEANSE`等）が
  // シールド・サブユニットまで巻き込み、逆に`categories: ["SHIELD"]`
  // （`ACT_YUI_HEIR_EX_REMOVE_SHIELD`）は何も解除できなくなる。定義kindから固定で
  // 決めることを実state（`AppliedEffect.shield`/`.subUnit`を持つ付与）の
  // `magnitude`に対して固定する。
  it("UT-R-EFF-02-024 (M7-001A, Issue #242): classifies APPLY_SHIELD as SHIELD only — never BUFF, even though a shield's magnitude is positive", () => {
    const shieldDefinition = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SHIELD",
        kind: "APPLY_SHIELD",
        payload: {
          formula: { kind: "CONSTANT", value: 120 },
          shieldType: "EN",
          duration: { dispellable: true },
        },
      },
      "effectAction",
    );
    const categories = effectCategoriesOf(effect({ magnitude: 120 }), shieldDefinition);
    expect([...categories]).toEqual(["SHIELD"]);
  });

  it("UT-R-EFF-02-025 (M7-001A, Issue #242): classifies APPLY_SUBUNIT as SUBUNIT only — never BUFF, even though a sub-unit's magnitude is positive", () => {
    const subUnitDefinition = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SUBUNIT",
        kind: "APPLY_SUBUNIT",
        payload: {
          durability: { formula: { kind: "CONSTANT", value: 80 } },
          additionalDamage: {
            formula: {
              kind: "SUBUNIT_ADDITIONAL_DAMAGE",
              ownerAttack: "CURRENT_ATTACK",
              providerAttack: "SOURCE_SNAPSHOT_ATTACK",
              skillMultiplier: 0.106,
              targetDefense: "TARGET_CURRENT_DEFENSE",
            },
            damageType: "EN",
          },
          duration: { dispellable: true, timeLimit: { unit: "ACTION", count: 2 } },
        },
      },
      "effectAction",
    );
    const categories = effectCategoriesOf(effect({ magnitude: 80 }), subUnitDefinition);
    expect([...categories]).toEqual(["SUBUNIT"]);
  });

  it("UT-R-EFF-03-001 (M7-001B, Issue #243): classifies APPLY_MARKER as MARKER, for EFFECT_IMMUNITY block-candidate classification", () => {
    const markerDefinition = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARK",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_TEST",
          stack: { policy: "ADD", max: null },
          duration: { dispellable: true },
        },
      },
      "effectAction",
    );
    const categories = effectCategoriesOf(effect({ magnitude: 0 }), markerDefinition);
    expect([...categories]).toEqual(["MARKER"]);
  });
});
