import { describe, expect, it } from "vitest";
import { createEffectActionDefinition } from "./effect-action-definition.js";
import { DomainValidationError } from "../shared/errors.js";

describe("EffectActionDefinition", () => {
  it("UT-CAT-ACT-001: maps a minimal DAMAGE action with defaults filled in", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_15600",
        kind: "DAMAGE",
        payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1.56 } },
      },
      "effectAction",
    );
    expect(result).toEqual({
      effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_15600",
      kind: "DAMAGE",
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1.56 },
        hitCount: 1,
        critical: { mode: "NORMAL" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
      requiredCapabilities: [],
      metadata: { tags: [] },
    });
  });

  it("UT-CAT-ACT-002: rejects an unsupported (undocumented-payload) kind such as APPLY_SHIELD", () => {
    expect(() =>
      createEffectActionDefinition(
        { effectActionDefinitionId: "ACT_SHIELD_1", kind: "APPLY_SHIELD", payload: {} },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-003: rejects DAMAGE piercing rates outside [0, 1]", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_1",
          kind: "DAMAGE",
          payload: {
            damageType: "PHYSICAL",
            formula: { kind: "CONSTANT", value: 1 },
            piercing: { defenseIgnoreRate: 1.5, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-004: maps EFFECT_IMMUNITY with maxBlocks null and a required duration", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_IMMUNITY_DEBUFF",
        kind: "EFFECT_IMMUNITY",
        payload: {
          categories: ["DEBUFF"],
          duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
          maxBlocks: null,
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("EFFECT_IMMUNITY");
    if (result.kind === "EFFECT_IMMUNITY") {
      expect(result.payload.maxBlocks).toBeNull();
      expect(result.payload.duration.timeLimit).toEqual({ unit: "ACTION", count: 1 });
    }
  });

  it("UT-CAT-ACT-005: rejects EFFECT_IMMUNITY when duration is omitted (instantaneous is invalid)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_DEBUFF",
          kind: "EFFECT_IMMUNITY",
          payload: { categories: ["DEBUFF"], maxBlocks: null },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-006: maps APPLY_DEATH_SURVIVAL with LETHAL_DAMAGE consumption and maxCount", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DEATH_SURVIVAL_1",
        kind: "APPLY_DEATH_SURVIVAL",
        payload: {
          trigger: { lethalDamageOnly: true },
          survivalHp: { kind: "CONSTANT", value: 1 },
          healAfterSurvival: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.65 },
          duration: {
            timeLimit: { unit: "BATTLE", count: 1 },
            consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
            dispellable: true,
          },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_DEATH_SURVIVAL");
    if (result.kind === "APPLY_DEATH_SURVIVAL") {
      expect(result.payload.duration.consumption).toEqual({ kind: "LETHAL_DAMAGE", maxCount: 1 });
      expect(result.payload.survivalHp).toEqual({ kind: "CONSTANT", value: 1 });
    }
  });

  it("UT-CAT-ACT-007: maps APPLY_TARGET_REDIRECT with a SELF redirect", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REDIRECT_SELF",
        kind: "APPLY_TARGET_REDIRECT",
        payload: {
          redirectTo: { kind: "SELF" },
          appliesTo: { actionKinds: ["DAMAGE"] },
          duration: { timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" }, dispellable: true },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_TARGET_REDIRECT");
  });

  it("UT-CAT-ACT-008: maps APPLY_COVER with damageShareRate and guardRate", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_COVER_1",
        kind: "APPLY_COVER",
        payload: {
          coverer: { kind: "SELF" },
          damageShareRate: 1.0,
          guardRate: 0.5,
          appliesTo: { actionKinds: ["DAMAGE"] },
          duration: { timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" }, dispellable: true },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_COVER");
    if (result.kind === "APPLY_COVER") {
      expect(result.payload.damageShareRate).toBe(1.0);
      expect(result.payload.guardRate).toBe(0.5);
    }
  });

  it("UT-CAT-ACT-009: rejects APPLY_COVER guardRate outside [0, 1]", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_COVER_1",
          kind: "APPLY_COVER",
          payload: {
            coverer: { kind: "SELF" },
            damageShareRate: 1,
            guardRate: 1.2,
            appliesTo: { actionKinds: ["DAMAGE"] },
            duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-010: maps APPLY_REFLECT reflecting to TRIGGER_SOURCE", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REFLECT_1",
        kind: "APPLY_REFLECT",
        payload: {
          reflectTo: { kind: "TRIGGER_SOURCE" },
          formula: {
            kind: "DAMAGE_RECEIVED_RATIO",
            sourceResult: "LAST_DAMAGE_RECEIVED",
            ratio: 0.5,
          },
          timing: "AFTER_DAMAGE_APPLIED",
          allowRecursiveReflect: false,
          duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_REFLECT");
  });

  it("UT-CAT-ACT-011: rejects APPLY_REFLECT when duration is omitted", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REFLECT_1",
          kind: "APPLY_REFLECT",
          payload: {
            reflectTo: { kind: "TRIGGER_SOURCE" },
            formula: { kind: "CONSTANT", value: 1 },
            timing: "AFTER_DAMAGE_APPLIED",
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-012: maps requiredCapabilities as branded CapabilityIds", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REFLECT_1",
        kind: "APPLY_REFLECT",
        payload: {
          reflectTo: { kind: "TRIGGER_SOURCE" },
          formula: { kind: "CONSTANT", value: 1 },
          timing: "AFTER_DAMAGE_APPLIED",
          duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
        },
        requiredCapabilities: ["CAP_REFLECT_DAMAGE"],
      },
      "effectAction",
    );
    expect(result.requiredCapabilities).toEqual(["CAP_REFLECT_DAMAGE"]);
  });

  it("UT-CAT-ACT-013: does not existence-check a BINDING TargetReference inside a standalone payload", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REDIRECT_1",
        kind: "APPLY_TARGET_REDIRECT",
        payload: {
          redirectTo: { kind: "BINDING", targetBindingId: "TGT_WHATEVER" },
          appliesTo: { actionKinds: ["DAMAGE"] },
          duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_TARGET_REDIRECT");
  });

  it("UT-CAT-ACT-014: maps a HEAL action with an explicit overheal policy", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_HEAL_1",
        kind: "HEAL",
        payload: {
          formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.45 },
          overheal: "DISCARD",
        },
      },
      "effectAction",
    );
    expect(result).toMatchObject({ kind: "HEAL", payload: { overheal: "DISCARD" } });
  });

  it("UT-CAT-ACT-015: rejects an unknown overheal policy", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_HEAL_1",
          kind: "HEAL",
          payload: { formula: { kind: "CONSTANT", value: 1 }, overheal: "BANK" },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-016: maps APPLY_CONTINUOUS_HEAL with timing and duration", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_CONT_HEAL_1",
        kind: "APPLY_CONTINUOUS_HEAL",
        payload: {
          formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
          timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
          duration: { timeLimit: { unit: "ACTION", count: 2 }, dispellable: true },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_CONTINUOUS_HEAL");
    if (result.kind === "APPLY_CONTINUOUS_HEAL") {
      expect(result.payload.timing).toEqual({
        eventType: "ActionStarted",
        targetSelector: "EFFECT_OWNER",
      });
    }
  });

  it("UT-CAT-ACT-017: maps APPLY_STAT_MOD with RATIO valueType and STACKABLE stacking", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_STAT_MOD_1",
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "RATIO",
          formula: { kind: "CONSTANT", value: 0.2 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "ACTION", count: 2 }, dispellable: true },
        },
      },
      "effectAction",
    );
    expect(result).toMatchObject({
      kind: "APPLY_STAT_MOD",
      payload: { stat: "ATTACK", valueType: "RATIO" },
    });
  });

  it("UT-CAT-ACT-018: rejects APPLY_STAT_MOD with an unknown stacking mode", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_STAT_MOD_1",
          kind: "APPLY_STAT_MOD",
          payload: {
            stat: "ATTACK",
            valueType: "RATIO",
            formula: { kind: "CONSTANT", value: 0.2 },
            stacking: { mode: "NON_STACKABLE" },
            duration: { timeLimit: { unit: "ACTION", count: 2 } },
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-019: maps APPLY_DAMAGE_MOD with a null damageType (applies to any damage type)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_MOD_1",
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction: "OUTGOING",
          formula: { kind: "CONSTANT", value: 0.03 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_DAMAGE_MOD");
    if (result.kind === "APPLY_DAMAGE_MOD") {
      expect(result.payload.damageType).toBeNull();
    }
  });

  it("UT-CAT-ACT-020: rejects APPLY_DAMAGE_MOD with an unknown direction", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_MOD_1",
          kind: "APPLY_DAMAGE_MOD",
          payload: {
            direction: "SIDEWAYS",
            formula: { kind: "CONSTANT", value: 0.03 },
            stacking: { mode: "STACKABLE" },
            duration: { timeLimit: { unit: "BATTLE", count: 1 } },
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-021: maps MODIFY_RESOURCE with bounds.max as CURRENT_MAX", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MODIFY_PP_1",
        kind: "MODIFY_RESOURCE",
        payload: {
          resource: "PP",
          operation: "ADD",
          formula: { kind: "CONSTANT", value: -2 },
          bounds: { min: 0, max: "CURRENT_MAX" },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("MODIFY_RESOURCE");
    if (result.kind === "MODIFY_RESOURCE") {
      expect(result.payload.bounds).toEqual({ min: 0, max: "CURRENT_MAX" });
    }
  });

  it("UT-CAT-ACT-022: maps MODIFY_RESOURCE without bounds", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MODIFY_PP_1",
        kind: "MODIFY_RESOURCE",
        payload: {
          resource: "EX_GAUGE",
          operation: "SET_TO_MAX",
          formula: { kind: "CONSTANT", value: 0 },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("MODIFY_RESOURCE");
    if (result.kind === "MODIFY_RESOURCE") {
      expect(result.payload.bounds).toBeUndefined();
    }
  });

  it("UT-CAT-ACT-023: rejects MODIFY_RESOURCE with an unknown operation", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_MODIFY_PP_1",
          kind: "MODIFY_RESOURCE",
          payload: {
            resource: "PP",
            operation: "MULTIPLY",
            formula: { kind: "CONSTANT", value: 1 },
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-024: maps APPLY_STATUS FREEZE with damageAmplificationOnBreak", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_FREEZE_1",
        kind: "APPLY_STATUS",
        payload: {
          status: "FREEZE",
          duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
          damageAmplificationOnBreak: 0.5,
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_STATUS");
    if (result.kind === "APPLY_STATUS") {
      expect(result.payload.damageAmplificationOnBreak).toBe(0.5);
    }
  });

  it("UT-CAT-ACT-025: maps APPLY_STATUS EVASION with probability and appliesTo.incomingActionKinds", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_EVASION_1",
        kind: "APPLY_STATUS",
        payload: {
          status: "EVASION",
          duration: {
            timeLimit: { unit: "ACTION", count: 1 },
            consumption: { kind: "INCOMING_HIT", maxCount: 1 },
            dispellable: true,
          },
          probability: 1.0,
          appliesTo: { incomingActionKinds: ["DAMAGE"] },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_STATUS");
    if (result.kind === "APPLY_STATUS") {
      expect(result.payload.probability).toBe(1.0);
      expect(result.payload.appliesTo).toEqual({ incomingActionKinds: ["DAMAGE"] });
      expect(result.payload.duration.consumption).toEqual({ kind: "INCOMING_HIT", maxCount: 1 });
    }
  });

  it("UT-CAT-ACT-026: rejects APPLY_STATUS with an out-of-range probability", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_EVASION_1",
          kind: "APPLY_STATUS",
          payload: {
            status: "EVASION",
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            probability: 1.5,
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-027: rejects an unknown status", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_UNKNOWN_STATUS",
          kind: "APPLY_STATUS",
          payload: { status: "CONFUSED", duration: { timeLimit: { unit: "ACTION", count: 1 } } },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-028: maps APPLY_MARKER with a stack policy and max", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_CURSE",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_CURSE",
          stack: { policy: "ADD", max: 4 },
          duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: false },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_MARKER");
    if (result.kind === "APPLY_MARKER") {
      expect(result.payload.stack).toEqual({ policy: "ADD", max: 4 });
      expect(result.payload.duration.dispellable).toBe(false);
    }
  });

  it("UT-CAT-ACT-029: maps APPLY_MARKER stack.max as null (no cap)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_CURSE",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_CURSE",
          stack: { policy: "REFRESH" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
      },
      "effectAction",
    );
    if (result.kind === "APPLY_MARKER") {
      expect(result.payload.stack).toEqual({ policy: "REFRESH", max: null });
    }
  });

  it("UT-CAT-ACT-030: rejects APPLY_MARKER with an unknown stack policy", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_MARKER_CURSE",
          kind: "APPLY_MARKER",
          payload: {
            markerId: "MARKER_CURSE",
            stack: { policy: "MULTIPLY" },
            duration: { timeLimit: { unit: "BATTLE", count: 1 } },
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-031: maps REMOVE_MARKER", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REMOVE_CURSE",
        kind: "REMOVE_MARKER",
        payload: { markerId: "MARKER_CURSE" },
      },
      "effectAction",
    );
    expect(result).toMatchObject({ kind: "REMOVE_MARKER", payload: { markerId: "MARKER_CURSE" } });
  });

  it("UT-CAT-ACT-032: maps APPLY_SUBUNIT with durability and additionalDamage formulas", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SUBUNIT_1",
        kind: "APPLY_SUBUNIT",
        payload: {
          durability: {
            formula: {
              kind: "STAT_RATIO",
              source: { kind: "SKILL_SOURCE" },
              stat: "ATTACK",
              ratio: 1.0,
            },
          },
          additionalDamage: {
            formula: {
              kind: "SUBUNIT_ADDITIONAL_DAMAGE",
              ownerAttack: "CURRENT_ATTACK",
              providerAttack: "SOURCE_SNAPSHOT_ATTACK",
              skillMultiplier: 0.5,
              targetDefense: "TARGET_CURRENT_DEFENSE",
            },
          },
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_SUBUNIT");
  });

  it("UT-CAT-ACT-033: rejects EFFECT_IMMUNITY with SPECIFIC_EFFECT but no effectActionDefinitionIds", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_1",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["SPECIFIC_EFFECT"],
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            maxBlocks: null,
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-034: maps EFFECT_IMMUNITY with SPECIFIC_EFFECT and effectActionDefinitionIds", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_IMMUNITY_1",
        kind: "EFFECT_IMMUNITY",
        payload: {
          categories: ["SPECIFIC_EFFECT"],
          effectActionDefinitionIds: ["ACT_DAMAGE_PHYSICAL_7020"],
          duration: { timeLimit: { unit: "ACTION", count: 1 } },
          maxBlocks: 2,
        },
      },
      "effectAction",
    );
    expect(result.kind).toBe("EFFECT_IMMUNITY");
    if (result.kind === "EFFECT_IMMUNITY") {
      expect(result.payload.effectActionDefinitionIds).toEqual(["ACT_DAMAGE_PHYSICAL_7020"]);
      expect(result.payload.maxBlocks).toBe(2);
    }
  });

  it("UT-CAT-ACT-035: rejects DAMAGE with an invalid hitCount", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_1",
          kind: "DAMAGE",
          payload: {
            damageType: "PHYSICAL",
            formula: { kind: "CONSTANT", value: 1 },
            hitCount: 0,
          },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-036: maps DAMAGE with critical/accuracy modes and a link", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_2",
        kind: "DAMAGE",
        payload: {
          damageType: "EN",
          formula: { kind: "CONSTANT", value: 1 },
          critical: { mode: "GUARANTEED" },
          accuracy: { mode: "GUARANTEED" },
          damageModifiers: [{ kind: "CONSTANT", value: 0.1 }],
          link: { enabled: true },
        },
      },
      "effectAction",
    );
    if (result.kind === "DAMAGE") {
      expect(result.payload.critical).toEqual({ mode: "GUARANTEED" });
      expect(result.payload.accuracy).toEqual({ mode: "GUARANTEED" });
      expect(result.payload.damageModifiers).toEqual([{ kind: "CONSTANT", value: 0.1 }]);
      expect(result.payload.link).toEqual({ enabled: true });
    }
  });

  it("UT-CAT-ACT-037: rejects an unknown EffectActionDefinitionId prefix", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "BAD_ID",
          kind: "DAMAGE",
          payload: { damageType: "PHYSICAL", formula: { kind: "CONSTANT", value: 1 } },
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });
});
