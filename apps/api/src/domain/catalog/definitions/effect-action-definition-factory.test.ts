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

  it("UT-CAT-ACT-002: rejects a kind that is not in EFFECT_ACTION_KINDS", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_UNKNOWN_1",
          kind: "APPLY_TIME_STOP",
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
      payload: { stat: "ATTACK", valueType: "RATIO", stacking: { mode: "STACKABLE", max: null } },
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
            // M7-012（Issue #266）で`NON_STACKABLE`が有効値になったため、この
            // 拒否ケースはenumに存在しない値（Marker側の`stack.policy`と混同した
            // 誤authoring）へ差し替えた。
            stacking: { mode: "REFRESH" },
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

  it("UT-CAT-ACT-083 (DMG-002, Issue #192): maps an APPLY_DAMAGE_MOD dynamic condition tree", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_MOD_1",
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction: "INCOMING",
          formula: { kind: "CONSTANT", value: -0.3 },
          condition: {
            kind: "AND",
            conditions: [
              {
                kind: "UNIT_STATE",
                unit: "EFFECT_OWNER",
                field: "HP_RATIO",
                op: "GTE",
                value: 0.65,
              },
              { kind: "UNIT_HAS_MARKER", unit: "OPPONENT", markerId: "MARKER_UKIASHI" },
              { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
            ],
          },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_DAMAGE_MOD");
    if (result.kind === "APPLY_DAMAGE_MOD") {
      expect(result.payload.condition).toEqual({
        kind: "AND",
        conditions: [
          { kind: "UNIT_STATE", unit: "EFFECT_OWNER", field: "HP_RATIO", op: "GTE", value: 0.65 },
          { kind: "UNIT_HAS_MARKER", unit: "OPPONENT", markerId: "MARKER_UKIASHI" },
          { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
        ],
      });
    }
  });

  it("UT-CAT-ACT-084 (DMG-002, Issue #192): leaves an APPLY_DAMAGE_MOD condition undefined when the payload omits it", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_MOD_1",
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction: "OUTGOING",
          formula: { kind: "CONSTANT", value: 0.1 },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 } },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_DAMAGE_MOD");
    if (result.kind === "APPLY_DAMAGE_MOD") {
      expect(result.payload.condition).toBeUndefined();
    }
  });

  it("UT-CAT-ACT-085 (DMG-002, Issue #192): rejects an APPLY_DAMAGE_MOD condition that references a unit outside the two-unit damage scope", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_MOD_1",
          kind: "APPLY_DAMAGE_MOD",
          payload: {
            direction: "INCOMING",
            formula: { kind: "CONSTANT", value: -0.3 },
            condition: {
              kind: "UNIT_STATE",
              unit: "TRIGGER_SOURCE",
              field: "HP_RATIO",
              op: "GTE",
              value: 0.65,
            },
            stacking: { mode: "STACKABLE" },
            duration: { timeLimit: { unit: "BATTLE", count: 1 } },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-086 (DMG-002, Issue #192): rejects an APPLY_DAMAGE_MOD UNIT_STATE field that damage-time resolution cannot evaluate", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DAMAGE_MOD_1",
          kind: "APPLY_DAMAGE_MOD",
          payload: {
            direction: "INCOMING",
            formula: { kind: "CONSTANT", value: -0.3 },
            condition: {
              kind: "UNIT_STATE",
              unit: "EFFECT_OWNER",
              field: "UNIT_TYPE",
              op: "EQ",
              value: "TSF",
            },
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
          duration: { dispellable: true },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_SUBUNIT");
  });

  it("UT-CAT-ACT-092: maps APPLY_SUBUNIT duration so the subunit can expire on its own (SUBUNIT_DURATION)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SUBUNIT_1",
        kind: "APPLY_SUBUNIT",
        payload: {
          durability: { formula: { kind: "CONSTANT", value: 100 } },
          additionalDamage: {
            formula: {
              kind: "SUBUNIT_ADDITIONAL_DAMAGE",
              ownerAttack: "CURRENT_ATTACK",
              providerAttack: "SOURCE_SNAPSHOT_ATTACK",
              skillMultiplier: 0.5,
              targetDefense: "TARGET_CURRENT_DEFENSE",
            },
          },
          duration: { timeLimit: { unit: "ACTION", count: 3 }, dispellable: true },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_SUBUNIT");
    if (result.kind === "APPLY_SUBUNIT") {
      expect(result.payload.duration.timeLimit).toEqual({ unit: "ACTION", count: 3 });
    }
  });

  it("UT-CAT-ACT-093: rejects APPLY_SUBUNIT without duration", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_SUBUNIT_1",
          kind: "APPLY_SUBUNIT",
          payload: {
            durability: { formula: { kind: "CONSTANT", value: 100 } },
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
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-094: maps APPLY_SUBUNIT additionalDamage damageType and debuff (SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SUBUNIT_1",
        kind: "APPLY_SUBUNIT",
        payload: {
          durability: { formula: { kind: "CONSTANT", value: 100 } },
          additionalDamage: {
            formula: {
              kind: "SUBUNIT_ADDITIONAL_DAMAGE",
              ownerAttack: "CURRENT_ATTACK",
              providerAttack: "SOURCE_SNAPSHOT_ATTACK",
              skillMultiplier: 0.5,
              targetDefense: "TARGET_CURRENT_DEFENSE",
            },
            damageType: "EN",
            debuff: { effectActionDefinitionId: "ACT_SPEED_DOWN" },
          },
          duration: { dispellable: true },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_SUBUNIT");
    if (result.kind === "APPLY_SUBUNIT") {
      expect(result.payload.additionalDamage.damageType).toBe("EN");
      expect(result.payload.additionalDamage.debuff).toEqual({
        effectActionDefinitionId: "ACT_SPEED_DOWN",
      });
    }
  });

  it("UT-CAT-ACT-095: rejects APPLY_SUBUNIT additionalDamage with an unknown damageType", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_SUBUNIT_1",
          kind: "APPLY_SUBUNIT",
          payload: {
            durability: { formula: { kind: "CONSTANT", value: 100 } },
            additionalDamage: {
              formula: {
                kind: "SUBUNIT_ADDITIONAL_DAMAGE",
                ownerAttack: "CURRENT_ATTACK",
                providerAttack: "SOURCE_SNAPSHOT_ATTACK",
                skillMultiplier: 0.5,
                targetDefense: "TARGET_CURRENT_DEFENSE",
              },
              damageType: "FIRE",
            },
            duration: { dispellable: true },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
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

  it("UT-CAT-ACT-070: maps EFFECT_IMMUNITY with categories STATUS and no statusKinds (whole-category immunity)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_IMMUNITY_STATUS",
        kind: "EFFECT_IMMUNITY",
        payload: {
          categories: ["STATUS"],
          duration: { timeLimit: { unit: "ACTION", count: 1 } },
          maxBlocks: null,
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("EFFECT_IMMUNITY");
    if (result.kind === "EFFECT_IMMUNITY") {
      expect(result.payload.statusKinds).toBeUndefined();
    }
  });

  it("UT-CAT-ACT-071: maps EFFECT_IMMUNITY with categories STATUS and statusKinds scoped to STUN (R-EFF-03 granularity)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_IMMUNITY_STUN",
        kind: "EFFECT_IMMUNITY",
        payload: {
          categories: ["STATUS"],
          statusKinds: ["STUN"],
          duration: { timeLimit: { unit: "ACTION", count: 2 } },
          maxBlocks: null,
        },
        requiredCapabilities: ["CAP_SPECIFIC_IMMUNITY"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("EFFECT_IMMUNITY");
    if (result.kind === "EFFECT_IMMUNITY") {
      expect(result.payload.statusKinds).toEqual(["STUN"]);
    }
  });

  it("UT-CAT-ACT-072: rejects EFFECT_IMMUNITY statusKinds when categories does not include STATUS (would be silently ignored)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_1",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["DEBUFF"],
            statusKinds: ["STUN"],
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            maxBlocks: null,
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-073: rejects EFFECT_IMMUNITY with an empty statusKinds array", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_1",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["STATUS"],
            statusKinds: [],
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            maxBlocks: null,
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-074: rejects EFFECT_IMMUNITY statusKinds containing an invalid StatusKind value", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_1",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["STATUS"],
            statusKinds: ["NOT_A_STATUS_KIND"],
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            maxBlocks: null,
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-075 (PR #245 re-review [P2] fix): rejects EFFECT_IMMUNITY statusKinds containing a StatusKind that is schema-valid but not a status ailment (R-STS-01 only classifies STUN/FREEZE/BLIND as STATUS at runtime — anything else, e.g. STEALTH, would silently never block)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_IMMUNITY_1",
          kind: "EFFECT_IMMUNITY",
          payload: {
            categories: ["STATUS"],
            statusKinds: ["STEALTH"],
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
            maxBlocks: null,
          },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
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

  // --- M7-005-HEAL-LINK (Issue #229, R-HEAL-04): APPLY_HEALING_LINK ---

  it("UT-CAT-ACT-076: maps APPLY_HEALING_LINK transferring 100% of the holder's incoming healing to the granter (SKL_ELENA_MOODMAKER_AS1)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_HEALING_LINK_1",
        kind: "APPLY_HEALING_LINK",
        payload: {
          transferTo: { kind: "SELF" },
          transferRate: 1,
          duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
        },
        requiredCapabilities: ["CAP_HEALING_LINK"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_HEALING_LINK");
    if (result.kind === "APPLY_HEALING_LINK") {
      expect(result.payload.transferTo).toEqual({ kind: "SELF" });
      expect(result.payload.transferRate).toBe(1);
      expect(result.payload.duration.timeLimit).toEqual({
        unit: "ACTION",
        count: 1,
        owner: "EFFECT_SOURCE",
      });
    }
  });

  it("UT-CAT-ACT-077: rejects APPLY_HEALING_LINK with a transferRate outside [0, 1]", () => {
    for (const transferRate of [-0.1, 1.5]) {
      expect(() =>
        createEffectActionDefinition(
          {
            effectActionDefinitionId: "ACT_HEALING_LINK_1",
            kind: "APPLY_HEALING_LINK",
            payload: {
              transferTo: { kind: "SELF" },
              transferRate,
              duration: { timeLimit: { unit: "ACTION", count: 1 } },
            },
            requiredCapabilities: ["CAP_HEALING_LINK"],
          },
          "effectAction",
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-CAT-ACT-078: rejects APPLY_HEALING_LINK without transferTo (the transfer destination has no default)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_HEALING_LINK_1",
          kind: "APPLY_HEALING_LINK",
          payload: {
            transferRate: 1,
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
          },
          requiredCapabilities: ["CAP_HEALING_LINK"],
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
          continuousDamageKind: "BURN",
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
      expect(result.payload.continuousDamageKind).toBe("BURN");
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
            continuousDamageKind: "BURN",
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

  // R-DOT-02/03/04（DMG-008、Issue #189）: 固定継続ダメージ・炎上・毒はそれぞれ
  // 別のダメージ算出・重複・シールド適用規則を持つため、Catalog上で判別できる
  // 必要がある（`continuousDamageKind`）。
  it("UT-CAT-ACT-089: maps APPLY_CONTINUOUS_DAMAGE continuousDamageKind POISON", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_POISON_1",
        kind: "APPLY_CONTINUOUS_DAMAGE",
        payload: {
          continuousDamageKind: "POISON",
          damageType: "PHYSICAL",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
          timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
          duration: { timeLimit: { unit: "ACTION", count: 2 } },
        },
        requiredCapabilities: ["CAP_CONTINUOUS_DAMAGE"],
      },
      "effectAction",
    );
    expect(result.kind).toBe("APPLY_CONTINUOUS_DAMAGE");
    if (result.kind === "APPLY_CONTINUOUS_DAMAGE") {
      expect(result.payload.continuousDamageKind).toBe("POISON");
    }
  });

  it("UT-CAT-ACT-090: rejects APPLY_CONTINUOUS_DAMAGE without continuousDamageKind", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_BURN_1",
          kind: "APPLY_CONTINUOUS_DAMAGE",
          payload: {
            damageType: "PHYSICAL",
            formula: { kind: "CONSTANT", value: 1 },
            timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
          },
          requiredCapabilities: ["CAP_CONTINUOUS_DAMAGE"],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-091: rejects APPLY_CONTINUOUS_DAMAGE with an unknown continuousDamageKind", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_BURN_1",
          kind: "APPLY_CONTINUOUS_DAMAGE",
          payload: {
            continuousDamageKind: "BLEED",
            damageType: "PHYSICAL",
            formula: { kind: "CONSTANT", value: 1 },
            timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
            duration: { timeLimit: { unit: "ACTION", count: 1 } },
          },
          requiredCapabilities: ["CAP_CONTINUOUS_DAMAGE"],
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

  // --- M7-001 (Issue #181): REMOVE_BUFF_CATEGORY / REMOVE_EFFECTS_COUNT_LIMIT / CATEGORY_GAP ---

  it("UT-CAT-ACT-062: maps REMOVE_EFFECTS clearing the BUFF category (REMOVE_BUFF_CATEGORY)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REMOVE_BUFFS",
        kind: "REMOVE_EFFECTS",
        payload: { categories: ["BUFF"] },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result).toMatchObject({ kind: "REMOVE_EFFECTS", payload: { categories: ["BUFF"] } });
  });

  it("UT-CAT-ACT-063: maps REMOVE_EFFECTS with maxRemovals as a count limit (REMOVE_EFFECTS_COUNT_LIMIT)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REMOVE_3_DEBUFFS",
        kind: "REMOVE_EFFECTS",
        payload: { categories: ["DEBUFF"], maxRemovals: 3 },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("REMOVE_EFFECTS");
    if (result.kind === "REMOVE_EFFECTS") {
      expect(result.payload.maxRemovals).toBe(3);
    }
  });

  it("UT-CAT-ACT-064: rejects REMOVE_EFFECTS with a non-positive maxRemovals", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_1",
          kind: "REMOVE_EFFECTS",
          payload: { categories: ["DEBUFF"], maxRemovals: 0 },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-064b: rejects REMOVE_EFFECTS with a non-integer maxRemovals", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_1",
          kind: "REMOVE_EFFECTS",
          payload: { categories: ["DEBUFF"], maxRemovals: 1.5 },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-066: maps REMOVE_MARKER with a count limiting how many stacks are removed (REMOVE_EFFECTS_COUNT_LIMIT)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_REMOVE_3_STACKS",
        kind: "REMOVE_MARKER",
        payload: { markerId: "MARKER_MAKENKI", count: 3 },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(result.kind).toBe("REMOVE_MARKER");
    if (result.kind === "REMOVE_MARKER") {
      expect(result.payload.count).toBe(3);
    }
  });

  it("UT-CAT-ACT-068: rejects REMOVE_EFFECTS with the MARKER category (use REMOVE_MARKER instead; would otherwise be a silent no-op)", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_MARKER_CAT",
          kind: "REMOVE_EFFECTS",
          payload: { categories: ["MARKER"] },
          requiredCapabilities: [],
        },
        "effectAction",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-ACT-069: maps REMOVE_EFFECTS with SHIELD/SUBUNIT categories at the Factory level (M7-001A/Issue #242: fully supported at runtime; the CAP_SHIELD/CAP_SUBUNIT declaration gate lives in catalog-integrity.ts, not here — see UT-CAT-IDX-018..021)", () => {
    for (const category of ["SHIELD", "SUBUNIT"] as const) {
      const result = createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_GAP",
          kind: "REMOVE_EFFECTS",
          payload: { categories: [category] },
          requiredCapabilities: [],
        },
        "effectAction",
      );
      expect(result).toMatchObject({ kind: "REMOVE_EFFECTS", payload: { categories: [category] } });
    }
  });

  it("UT-CAT-ACT-067: rejects REMOVE_MARKER with a non-positive count", () => {
    expect(() =>
      createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_REMOVE_STACKS",
          kind: "REMOVE_MARKER",
          payload: { markerId: "MARKER_MAKENKI", count: 0 },
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

  // DMG-004（Issue #194、R-SHD-01）: shieldType（省略時タイプなし）と
  // SHIELD_DECAY_OVER_TIMEのdecay宣言。
  it("UT-CAT-ACT-087: maps APPLY_SHIELD shieldType and decay, defaulting shieldType to untyped", () => {
    const typed = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SHIELD_EN",
        kind: "APPLY_SHIELD",
        payload: {
          formula: { kind: "CONSTANT", value: 100 },
          duration: { timeLimit: { unit: "ACTION", count: 2 } },
          shieldType: "EN",
          decay: { unit: "ACTION", ratio: 0.25 },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    expect(typed.kind).toBe("APPLY_SHIELD");
    if (typed.kind === "APPLY_SHIELD") {
      expect(typed.payload.shieldType).toBe("EN");
      expect(typed.payload.decay).toEqual({ unit: "ACTION", ratio: 0.25 });
    }

    const untyped = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_SHIELD_UNTYPED",
        kind: "APPLY_SHIELD",
        payload: {
          formula: { kind: "CONSTANT", value: 100 },
          duration: { timeLimit: { unit: "ACTION", count: 2 } },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );
    if (untyped.kind === "APPLY_SHIELD") {
      expect(untyped.payload.shieldType).toBeUndefined();
      expect(untyped.payload.decay).toBeUndefined();
    }
  });

  it("UT-CAT-ACT-088: rejects APPLY_SHIELD decay with an unsupported unit or a non-positive ratio", () => {
    for (const decay of [
      { unit: "TURN", ratio: 0.25 },
      { unit: "ACTION", ratio: 0 },
      { unit: "ACTION", ratio: 1.5 },
    ]) {
      expect(() =>
        createEffectActionDefinition(
          {
            effectActionDefinitionId: "ACT_SHIELD_1",
            kind: "APPLY_SHIELD",
            payload: {
              formula: { kind: "CONSTANT", value: 100 },
              duration: { timeLimit: { unit: "ACTION", count: 2 } },
              decay,
            },
            requiredCapabilities: [],
          },
          "effectAction",
        ),
      ).toThrow(DomainValidationError);
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

  // M7-012（Issue #266、R-EFF-05／`STACK_LIMIT_ON_STAT_MOD`）: `APPLY_STAT_MOD`の
  // 重複なし表現（`NON_STACKABLE`）と重複上限（`stacking.max`）。
  it("UT-CAT-ACT-079: maps APPLY_STAT_MOD with NON_STACKABLE stacking (R-EFF-05)", () => {
    const result = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_STAT_MOD_NON_STACKABLE",
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
    );
    expect(result).toMatchObject({
      kind: "APPLY_STAT_MOD",
      payload: { stacking: { mode: "NON_STACKABLE", max: null } },
    });
  });

  it("UT-CAT-ACT-080: maps APPLY_STAT_MOD stacking.max and accepts an explicit null (no limit)", () => {
    for (const [max, expected] of [
      [14, 14],
      [1, 1],
      [null, null],
    ] as const) {
      const result = createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_STAT_MOD_MAX",
          kind: "APPLY_STAT_MOD",
          payload: {
            stat: "ATTACK",
            valueType: "RATIO",
            formula: { kind: "CONSTANT", value: 0.025 },
            stacking: { mode: "STACKABLE", max },
            duration: { timeLimit: { unit: "BATTLE", count: 1 } },
          },
          requiredCapabilities: [],
        },
        "effectAction",
      );
      expect(result).toMatchObject({
        kind: "APPLY_STAT_MOD",
        payload: { stacking: { mode: "STACKABLE", max: expected } },
      });
    }
  });

  it("UT-CAT-ACT-081: rejects a non-positive or fractional APPLY_STAT_MOD stacking.max", () => {
    for (const max of [0, -1, 1.5]) {
      expect(() =>
        createEffectActionDefinition(
          {
            effectActionDefinitionId: "ACT_STAT_MOD_BAD_MAX",
            kind: "APPLY_STAT_MOD",
            payload: {
              stat: "ATTACK",
              valueType: "RATIO",
              formula: { kind: "CONSTANT", value: 0.025 },
              stacking: { mode: "STACKABLE", max },
              duration: { timeLimit: { unit: "BATTLE", count: 1 } },
            },
            requiredCapabilities: [],
          },
          "effectAction",
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-CAT-ACT-082: rejects NON_STACKABLE and stacking.max on the other stacking-bearing kinds", () => {
    const payloadsByKind = {
      APPLY_DAMAGE_MOD: {
        direction: "OUTGOING",
        formula: { kind: "CONSTANT", value: 0.03 },
        duration: { timeLimit: { unit: "BATTLE", count: 1 } },
      },
      APPLY_HEALING_MOD: {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: -0.2 },
        duration: { timeLimit: { unit: "ACTION", count: 1 } },
      },
      APPLY_RESOURCE_GAIN_MOD: {
        resource: "EX_GAUGE",
        rateDelta: { kind: "CONSTANT", value: 0.5 },
        duration: { timeLimit: { unit: "ACTION", count: 1 } },
      },
    } as const;
    for (const [kind, base] of Object.entries(payloadsByKind)) {
      // 重複なし最強選択の合成経路を持たないkindでは`NON_STACKABLE`を許可しない
      // （受理しても`composeDamageModifier`等が全インスタンスを合算するだけで
      // 何も変わらない silent partial implementation になるため）。
      expect(() =>
        createEffectActionDefinition(
          {
            effectActionDefinitionId: "ACT_OTHER_MOD",
            kind,
            payload: { ...base, stacking: { mode: "NON_STACKABLE" } },
            requiredCapabilities: [],
          },
          "effectAction",
        ),
      ).toThrow(DomainValidationError);
      // 同じ理由で`stacking.max`も未知キーとして拒否する。
      expect(() =>
        createEffectActionDefinition(
          {
            effectActionDefinitionId: "ACT_OTHER_MOD",
            kind,
            payload: { ...base, stacking: { mode: "STACKABLE", max: 3 } },
            requiredCapabilities: [],
          },
          "effectAction",
        ),
      ).toThrow(DomainValidationError);
    }
  });

  describe("APPLY_PIERCING_MOD (TEMP_PIERCING_GRANT, DMG-003/Issue #196)", () => {
    const base = {
      effectActionDefinitionId: "ACT_TEMP_PIERCING",
      kind: "APPLY_PIERCING_MOD",
      requiredCapabilities: ["CAP_PARTIAL_PIERCING"],
    } as const;

    it("UT-CAT-ACT-096: maps the three ignore rates and defaults the omitted ones to 0", () => {
      const result = createEffectActionDefinition(
        {
          ...base,
          payload: {
            defenseIgnoreRate: 0.5,
            stacking: { mode: "STACKABLE" },
            duration: { consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 } },
          },
        },
        "effectAction",
      );
      expect(result.kind).toBe("APPLY_PIERCING_MOD");
      if (result.kind !== "APPLY_PIERCING_MOD") {
        throw new Error("expected APPLY_PIERCING_MOD");
      }
      expect(result.payload.defenseIgnoreRate).toBe(0.5);
      expect(result.payload.shieldIgnoreRate).toBe(0);
      expect(result.payload.damageReductionIgnoreRate).toBe(0);
    });

    it("UT-CAT-ACT-097: rejects an ignore rate outside [0, 1] (R-DMG-03: 0 は通常処理、1 は全量無視)", () => {
      for (const payload of [
        { defenseIgnoreRate: 1.5 },
        { shieldIgnoreRate: -0.1 },
        { damageReductionIgnoreRate: 2 },
      ]) {
        expect(() =>
          createEffectActionDefinition(
            {
              ...base,
              payload: {
                ...payload,
                stacking: { mode: "STACKABLE" },
                duration: { consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 } },
              },
            },
            "effectAction",
          ),
        ).toThrow(DomainValidationError);
      }
    });

    it("UT-CAT-ACT-098: rejects a definition that ignores nothing at all (all three rates 0 or omitted)", () => {
      expect(() =>
        createEffectActionDefinition(
          {
            ...base,
            payload: {
              stacking: { mode: "STACKABLE" },
              duration: { consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 } },
            },
          },
          "effectAction",
        ),
      ).toThrow(DomainValidationError);
    });
  });

  // --- DMG-007 (Issue #187, R-LNK-01〜03): APPLY_DAMAGE_LINK ---

  describe("APPLY_DAMAGE_LINK (DMG-007, Issue #187, R-LNK-01〜03)", () => {
    const base = {
      effectActionDefinitionId: "ACT_DAMAGE_LINK_1",
      kind: "APPLY_DAMAGE_LINK",
      requiredCapabilities: ["CAP_DAMAGE_LINK_STATE"],
    };

    it("UT-CAT-ACT-099: maps APPLY_DAMAGE_LINK linking 50% of the holder's incoming damage to the granter (SKL_SUIRAN_CASINO_AS1)", () => {
      const result = createEffectActionDefinition(
        {
          ...base,
          payload: {
            linkTo: { kind: "SELF" },
            linkRate: 0.5,
            duration: { timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" } },
          },
        },
        "effectAction",
      );
      expect(result.kind).toBe("APPLY_DAMAGE_LINK");
      if (result.kind === "APPLY_DAMAGE_LINK") {
        expect(result.payload.linkTo).toEqual({ kind: "SELF" });
        expect(result.payload.linkRate).toBe(0.5);
        expect(result.payload.duration.timeLimit).toEqual({
          unit: "ACTION",
          count: 2,
          owner: "EFFECT_SOURCE",
        });
      }
    });

    it("UT-CAT-ACT-100: maps a BINDING linkTo so a mutual link can name the other side (SKL_DOROTHEA_PIONEER_PS1)", () => {
      const result = createEffectActionDefinition(
        {
          ...base,
          payload: {
            linkTo: { kind: "BINDING", targetBindingId: "TGT_FARTHEST" },
            linkRate: 0.35,
            duration: { timeLimit: { unit: "TURN", count: 1, owner: "EFFECT_SOURCE" } },
          },
        },
        "effectAction",
      );
      expect(result.kind).toBe("APPLY_DAMAGE_LINK");
      if (result.kind === "APPLY_DAMAGE_LINK") {
        expect(result.payload.linkTo).toEqual({
          kind: "BINDING",
          targetBindingId: "TGT_FARTHEST",
        });
        expect(result.payload.linkRate).toBe(0.35);
      }
    });

    it("UT-CAT-ACT-101: rejects a linkRate outside [0, 1]", () => {
      for (const linkRate of [-0.1, 1.5]) {
        expect(() =>
          createEffectActionDefinition(
            {
              ...base,
              payload: {
                linkTo: { kind: "SELF" },
                linkRate,
                duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
              },
            },
            "effectAction",
          ),
        ).toThrow(DomainValidationError);
      }
    });

    it("UT-CAT-ACT-102: requires linkTo, linkRate and duration (no defaults)", () => {
      for (const payload of [
        {
          linkRate: 0.5,
          duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
        },
        {
          linkTo: { kind: "SELF" },
          duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
        },
        { linkTo: { kind: "SELF" }, linkRate: 0.5 },
      ]) {
        expect(() => createEffectActionDefinition({ ...base, payload }, "effectAction")).toThrow(
          DomainValidationError,
        );
      }
    });
  });
});
