import { describe, expect, it } from "vitest";
import { createEffectActionDefinition } from "./effect-action-definition-factory.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("EffectActionDefinition", () => {
  it("UT-CAT-ACT-001: maps a minimal DAMAGE action with defaults filled in", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_15600",
        kind: "DAMAGE",
        payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1.56 } },
        requiredCapabilities: [],
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

  it("UT-CAT-ACT-002: rejects an unsupported (undocumented-payload) kind such as APPLY_DAMAGE_LINK", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_LINK_1",
          kind: "APPLY_DAMAGE_LINK",
          payload: {},
          requiredCapabilities: [],
        },
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-005b: rejects EFFECT_IMMUNITY when maxBlocks is omitted entirely", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_DEBUFF",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["DEBUFF"],
            duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-005c: rejects EFFECT_IMMUNITY when maxBlocks is a non-integer, non-null value", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_DEBUFF",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["DEBUFF"],
            duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
            maxBlocks: -1,
          },
          requiredCapabilities: [],
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
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_DEATH_SURVIVAL");
    if (result.kind === "APPLY_DEATH_SURVIVAL") {
      expect(result.payload.duration.consumption).toEqual({ kind: "LETHAL_DAMAGE", maxCount: 1 });
      expect(result.payload.survivalHp).toEqual({ kind: "CONSTANT", value: 1 });
    }
  });

  it("UT-CAT-ACT-006b: rejects APPLY_DEATH_SURVIVAL when trigger.lethalDamageOnly is not a boolean", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DEATH_SURVIVAL_1",
          kind: "APPLY_DEATH_SURVIVAL",
          payload: {
            trigger: { lethalDamageOnly: "true" },
            survivalHp: { kind: "CONSTANT", value: 1 },
            healAfterSurvival: null,
            duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: true },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_REFLECT");
  });

  it("UT-CAT-ACT-010b: rejects APPLY_REFLECT when allowRecursiveReflect is not a boolean", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REFLECT_1",
          kind: "APPLY_REFLECT",
          payload: {
            reflectTo: { kind: "TRIGGER_SOURCE" },
            formula: { kind: "CONSTANT", value: 1 },
            timing: "AFTER_DAMAGE_APPLIED",
            allowRecursiveReflect: "yes",
            duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
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
          requiredCapabilities: [],
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

  it("UT-CAT-ACT-012b: rejects a non-array requiredCapabilities", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REFLECT_1",
          kind: "APPLY_REFLECT",
          payload: {
            reflectTo: { kind: "TRIGGER_SOURCE" },
            formula: { kind: "CONSTANT", value: 1 },
            timing: "AFTER_DAMAGE_APPLIED",
            duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
          },
          requiredCapabilities: "CAP_REFLECT_DAMAGE" as unknown as readonly string[],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
      },
      "effectAction",
    );
    if (result.kind === "APPLY_MARKER") {
      expect(result.payload.stack).toEqual({ policy: "REFRESH", max: null });
    }
  });

  it("UT-CAT-ACT-029b: rejects APPLY_MARKER stack.max that is not an integer or null", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_MARKER_CURSE",
          kind: "APPLY_MARKER",
          payload: {
            markerId: "MARKER_CURSE",
            stack: { policy: "REFRESH", max: "unlimited" },
            duration: { timeLimit: { unit: "BATTLE", count: 1 } },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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
          requiredCapabilities: [],
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
        requiredCapabilities: [],
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

  it("UT-CAT-ACT-036b: rejects DAMAGE when link.enabled is not a boolean", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_2",
          kind: "DAMAGE",
          payload: {
            damageType: "EN",
            formula: { kind: "CONSTANT", value: 1 },
            link: { enabled: "yes" },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-036c: rejects DAMAGE when damageModifiers is not an array", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_2",
          kind: "DAMAGE",
          payload: {
            damageType: "EN",
            formula: { kind: "CONSTANT", value: 1 },
            damageModifiers: { kind: "CONSTANT", value: 0.1 },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-037: rejects an unknown EffectActionDefinitionId prefix", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "BAD_ID",
          kind: "DAMAGE",
          payload: { damageType: "PHYSICAL", formula: { kind: "CONSTANT", value: 1 } },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-038: rejects a non-array requiredCapabilities at the top level (redundant guard, defense-in-depth)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_1",
          kind: "DAMAGE",
          payload: { damageType: "PHYSICAL", formula: { kind: "CONSTANT", value: 1 } },
          requiredCapabilities: null as unknown as readonly string[],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-039: rejects a typo'd sibling key inside payload (payload.typoDamageFiled)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_1",
          kind: "DAMAGE",
          payload: {
            damageType: "PHYSICAL",
            formula: { kind: "CONSTANT", value: 1 },
            typoDamageFiled: "oops",
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-040: rejects a typo'd sibling key inside a nested payload sub-object (piercing)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_1",
          kind: "DAMAGE",
          payload: {
            damageType: "PHYSICAL",
            formula: { kind: "CONSTANT", value: 1 },
            piercing: { defenseIgnoreRate: 0.5, typoRate: 0.1 },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-041: rejects a typo'd sibling key inside EFFECT_IMMUNITY payload", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_1",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["DEBUFF"],
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            maxBlocks: null,
            typoField: true,
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #44 G-01: APPLY_HEALING_MOD ---

  it("UT-CAT-ACT-042: maps APPLY_HEALING_MOD reducing incoming healing by a fixed ratio", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_HEALING_MOD_1",
        kind: "APPLY_HEALING_MOD",
        payload: {
          direction: "INCOMING",
          formula: { kind: "CONSTANT", value: -0.2 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
        },
        requiredCapabilities: ["CAP_HEAL"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_HEALING_MOD");
    if (result.kind === "APPLY_HEALING_MOD") {
      expect(result.payload.direction).toBe("INCOMING");
      expect(result.payload.formula).toEqual({ kind: "CONSTANT", value: -0.2 });
    }
  });

  it("UT-CAT-ACT-043: rejects APPLY_HEALING_MOD with an unknown direction", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_HEALING_MOD_1",
          kind: "APPLY_HEALING_MOD",
          payload: {
            direction: "SIDEWAYS",
            formula: { kind: "CONSTANT", value: -0.2 },
            stacking: { mode: "STACKABLE" },
            duration: {},
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #44 G-02: APPLY_CONTINUOUS_DAMAGE ---

  it("UT-CAT-ACT-044: maps APPLY_CONTINUOUS_DAMAGE (DoT) ticking on ActionStarted", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_BURN_1",
        kind: "APPLY_CONTINUOUS_DAMAGE",
        payload: {
          damageType: "PHYSICAL",
          formula: {
            kind: "STAT_RATIO",
            source: { kind: "SKILL_SOURCE" },
            stat: "ATTACK",
            ratio: 0.3,
          },
          timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
          duration: { timeLimit: { unit: "ACTION", count: 1 } },
        },
        requiredCapabilities: ["CAP_CONTINUOUS_DAMAGE"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_CONTINUOUS_DAMAGE");
    if (result.kind === "APPLY_CONTINUOUS_DAMAGE") {
      expect(result.payload.damageType).toBe("PHYSICAL");
      expect(result.payload.timing).toEqual({
        eventType: "ActionStarted",
        targetSelector: "EFFECT_OWNER",
      });
    }
  });

  it("UT-CAT-ACT-045: rejects APPLY_CONTINUOUS_DAMAGE with an unknown damageType", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_BURN_1",
          kind: "APPLY_CONTINUOUS_DAMAGE",
          payload: {
            damageType: "FIRE",
            formula: { kind: "CONSTANT", value: 1 },
            timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
            duration: {},
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #44 G-04: REMOVE_EFFECTS ---

  it("UT-CAT-ACT-046: maps REMOVE_EFFECTS clearing every DEBUFF category", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REMOVE_DEBUFFS",
        kind: "REMOVE_EFFECTS",
        payload: { categories: ["DEBUFF"] },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result).toMatchObject({
      kind: "REMOVE_EFFECTS",
      payload: { categories: ["DEBUFF"] },
    });
  });

  it("UT-CAT-ACT-047: maps REMOVE_EFFECTS with SPECIFIC_EFFECT and effectActionDefinitionIds", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REMOVE_SPECIFIC",
        kind: "REMOVE_EFFECTS",
        payload: {
          categories: ["SPECIFIC_EFFECT"],
          effectActionDefinitionIds: ["ACT_MARKER_CURSE_DEBUFF"],
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("REMOVE_EFFECTS");
    if (result.kind === "REMOVE_EFFECTS") {
      expect(result.payload.effectActionDefinitionIds).toEqual(["ACT_MARKER_CURSE_DEBUFF"]);
    }
  });

  it("UT-CAT-ACT-048: rejects REMOVE_EFFECTS with SPECIFIC_EFFECT but no effectActionDefinitionIds", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_SPECIFIC",
          kind: "REMOVE_EFFECTS",
          payload: { categories: ["SPECIFIC_EFFECT"] },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-048b: rejects REMOVE_EFFECTS with effectActionDefinitionIds but no SPECIFIC_EFFECT category (would otherwise be silently dropped, widening the removal to every DEBUFF)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_1",
          kind: "REMOVE_EFFECTS",
          payload: {
            categories: ["DEBUFF"],
            effectActionDefinitionIds: ["ACT_MARKER_CURSE_DEBUFF"],
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-049: rejects REMOVE_EFFECTS with an empty categories array", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_1",
          kind: "REMOVE_EFFECTS",
          payload: { categories: [] },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #44 G-06: APPLY_STATUS.damageThreshold ---

  it("UT-CAT-ACT-050: maps APPLY_STATUS DAMAGE_IMMUNITY with a damageThreshold (only large hits are nullified)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_BARRIER_1",
        kind: "APPLY_STATUS",
        payload: {
          status: "DAMAGE_IMMUNITY",
          duration: {
            timeLimit: { unit: "ACTION", count: 2 },
            consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          },
          damageThreshold: {
            op: "GT",
            formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
          },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_STATUS");
    if (result.kind === "APPLY_STATUS") {
      expect(result.payload.damageThreshold).toEqual({
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
      });
    }
  });

  it("UT-CAT-ACT-051: rejects APPLY_STATUS damageThreshold with an unknown op", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_BARRIER_1",
          kind: "APPLY_STATUS",
          payload: {
            status: "DAMAGE_IMMUNITY",
            duration: {},
            damageThreshold: { op: "ALMOST", formula: { kind: "CONSTANT", value: 0.35 } },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-051b: rejects APPLY_STATUS damageThreshold on a status other than DAMAGE_IMMUNITY (e.g. STUN)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_STUN_1",
          kind: "APPLY_STATUS",
          payload: {
            status: "STUN",
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            damageThreshold: {
              op: "GT",
              formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
            },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #44 G-08: APPLY_SHIELD ---

  it("UT-CAT-ACT-052: maps APPLY_SHIELD sized as a ratio of the source's attack", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SHIELD_1",
        kind: "APPLY_SHIELD",
        payload: {
          formula: {
            kind: "STAT_RATIO",
            source: { kind: "SKILL_SOURCE" },
            stat: "ATTACK",
            ratio: 0.45,
          },
          duration: { timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" } },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_SHIELD");
    if (result.kind === "APPLY_SHIELD") {
      expect(result.payload.formula).toEqual({
        kind: "STAT_RATIO",
        source: { kind: "SKILL_SOURCE" },
        stat: "ATTACK",
        ratio: 0.45,
      });
    }
  });

  it("UT-CAT-ACT-053: rejects APPLY_SHIELD when duration is omitted", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_SHIELD_1",
          kind: "APPLY_SHIELD",
          payload: { formula: { kind: "CONSTANT", value: 100 } },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #44 G-09: MODIFY_RESOURCE_CAPACITY ---

  it("UT-CAT-ACT-054: maps MODIFY_RESOURCE_CAPACITY adding 1 to maximum AP for the rest of the battle", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MAX_AP_UP",
        kind: "MODIFY_RESOURCE_CAPACITY",
        payload: {
          resource: "AP",
          operation: "ADD",
          formula: { kind: "CONSTANT", value: 1 },
          duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: false },
        },
        requiredCapabilities: ["CAP_RESOURCE_CAPACITY_MOD"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("MODIFY_RESOURCE_CAPACITY");
    if (result.kind === "MODIFY_RESOURCE_CAPACITY") {
      expect(result.payload.resource).toBe("AP");
      expect(result.payload.operation).toBe("ADD");
    }
  });

  it("UT-CAT-ACT-055: rejects MODIFY_RESOURCE_CAPACITY with an unsupported operation (SET_TO_MAX is not meaningful for a capacity change)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_MAX_AP_UP",
          kind: "MODIFY_RESOURCE_CAPACITY",
          payload: {
            resource: "AP",
            operation: "SET_TO_MAX",
            formula: { kind: "CONSTANT", value: 1 },
            duration: {},
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  // --- Issue #129: COOLDOWN_MANIPULATION ---

  it("UT-CAT-ACT-056: maps COOLDOWN_MANIPULATION with operation RESET and no amount", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_CD_RESET",
        kind: "COOLDOWN_MANIPULATION",
        payload: { targetSkillDefinitionId: "SKL_SAYA_BUNNY_AS1", operation: "RESET" },
        requiredCapabilities: ["CAP_COOLDOWN_MANIPULATION"],
      },
      "effectAction",
    );
    expect(result).toEqual({
      effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_CD_RESET",
      kind: "COOLDOWN_MANIPULATION",
      payload: { targetSkillDefinitionId: "SKL_SAYA_BUNNY_AS1", operation: "RESET" },
      requiredCapabilities: ["CAP_COOLDOWN_MANIPULATION"],
      metadata: { tags: [] },
    });
  });

  it("UT-CAT-ACT-057: maps COOLDOWN_MANIPULATION with operation REDUCE and a required amount", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MERU_PS1_CD_REDUCE",
        kind: "COOLDOWN_MANIPULATION",
        payload: {
          targetSkillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
          operation: "REDUCE",
          amount: 1,
        },
        requiredCapabilities: ["CAP_COOLDOWN_MANIPULATION"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("COOLDOWN_MANIPULATION");
    if (result.kind === "COOLDOWN_MANIPULATION") {
      expect(result.payload).toEqual({
        targetSkillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
        operation: "REDUCE",
        amount: 1,
      });
    }
  });

  it("UT-CAT-ACT-058: rejects COOLDOWN_MANIPULATION REDUCE without an amount", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_CD_REDUCE_NO_AMOUNT",
          kind: "COOLDOWN_MANIPULATION",
          payload: { targetSkillDefinitionId: "SKL_MERU_FLATSPIN_PS1", operation: "REDUCE" },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-059: rejects COOLDOWN_MANIPULATION REDUCE with a non-positive amount", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_CD_REDUCE_ZERO",
          kind: "COOLDOWN_MANIPULATION",
          payload: {
            targetSkillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
            operation: "REDUCE",
            amount: 0,
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-060: rejects COOLDOWN_MANIPULATION with an unknown operation", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_CD_BAD_OP",
          kind: "COOLDOWN_MANIPULATION",
          payload: { targetSkillDefinitionId: "SKL_MERU_FLATSPIN_PS1", operation: "REVERSE" },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-061: rejects COOLDOWN_MANIPULATION with a targetSkillDefinitionId missing the SKL_ prefix", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_CD_BAD_TARGET",
          kind: "COOLDOWN_MANIPULATION",
          payload: { targetSkillDefinitionId: "BAD_ID", operation: "RESET" },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });
});
