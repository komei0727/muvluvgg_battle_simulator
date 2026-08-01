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
        requiredCapabilities: ["CAP_STAT_MOD"],
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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

  it("UT-R-EFF-02-004: classifies a 状態異常 APPLY_STATUS (STUN) as both STATUS and DEBUFF (R-STS-01)", () => {
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
        requiredCapabilities: ["CAP_CONTINUOUS_DAMAGE"],
      },
      "effectAction",
    );
  }

  it("UT-R-EFF-02-007 (RES-004-STATUS-CONDITION, Issue #224): classifies POISON continuous damage as STATUS+DEBUFF", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 120 }),
      continuousDamageDefinition("ACT_POISON", "POISON"),
    );
    expect(new Set(categories)).toEqual(new Set(["STATUS", "DEBUFF"]));
  });

  it("UT-R-EFF-02-008 (RES-004-STATUS-CONDITION, Issue #224): classifies BURN continuous damage as STATUS+DEBUFF", () => {
    const categories = effectCategoriesOf(
      effect({ magnitude: 120 }),
      continuousDamageDefinition("ACT_BURN", "BURN"),
    );
    expect(new Set(categories)).toEqual(new Set(["STATUS", "DEBUFF"]));
  });

  it("UT-R-EFF-02-009 (RES-004-STATUS-CONDITION, Issue #224): classifies FIXED continuous damage as DEBUFF only, not STATUS", () => {
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
        requiredCapabilities: [],
      },
      "effectAction",
    );
    const categories = effectCategoriesOf(effect({ magnitude: 0 }), markerDefinition);
    expect([...categories]).toEqual(["MARKER"]);
  });
});
