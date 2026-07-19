import { describe, expect, it } from "vitest";
import { createSkillDefinition, type SkillDefinitionInput } from "./skill-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

function minimalAsInput() {
  return {
    skillDefinitionId: "SKL_001_AS1",
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: 1,
            order: ["NEAREST", "FRONT_ROW", "LEFT_TO_RIGHT"],
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "ジャマしちゃ、めっ……だよ？" },
  };
}

describe("SkillDefinition", () => {
  it("UT-CAT-SKL-001: maps the doc's minimal AS example", () => {
    const result = createSkillDefinition(minimalAsInput());
    expect(result.skillDefinitionId).toBe("SKL_001_AS1");
    expect(result.cost).toEqual({ resource: "AP", amount: 1 });
    expect(result.activationCondition).toEqual({ kind: "TRUE" });
    expect(result.triggers).toEqual([]);
    expect(result.traits.exclusiveActivationGroupId).toBeNull();
    expect(result.resolution.kind).toBe("IMMEDIATE");
  });

  it("UT-CAT-SKL-002: rejects AS cost.resource mismatched with skillType (PP for an AS skill)", () => {
    const input = minimalAsInput();
    expect(() => createSkillDefinition({ ...input, cost: { resource: "PP", amount: 1 } })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-SKL-003: rejects a negative AP cost amount", () => {
    const input = minimalAsInput();
    expect(() => createSkillDefinition({ ...input, cost: { resource: "AP", amount: -1 } })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-SKL-019 (R-ACT-03: ASのAPコストは1以上): rejects an AS cost.amount of 0", () => {
    const input = minimalAsInput();
    expect(() => createSkillDefinition({ ...input, cost: { resource: "AP", amount: 0 } })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-SKL-020 (R-ACT-03: PSのPPコストは1以上): rejects a PS cost.amount of 0", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        skillType: "PS",
        cost: { resource: "PP", amount: 0 },
        triggers: [
          {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "SELF",
          },
        ],
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-021 (R-ACT-03: EXのゲージコストは1以上): rejects an EX cost.amount of 0", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        skillType: "EX",
        cost: { resource: "EX_GAUGE", amount: 0 },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-004: rejects an AS skill declaring triggers", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        triggers: [
          {
            eventType: "TurnStarted",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "SELF",
          },
        ],
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-005: requires at least one trigger for a PS skill", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        skillType: "PS",
        cost: { resource: "PP", amount: 1 },
        triggers: [],
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-006: maps a PS skill with a trigger and exclusiveActivationGroupId", () => {
    const input = minimalAsInput();
    const result = createSkillDefinition({
      ...input,
      skillDefinitionId: "SKL_001_PS1",
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      triggers: [
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "SELF",
        },
      ],
      traits: { exclusiveActivationGroupId: "GROUP_STUN" },
    });
    expect(result.triggers).toHaveLength(1);
    expect(result.traits.exclusiveActivationGroupId).toBe("GROUP_STUN");
  });

  it("UT-CAT-SKL-007: maps an EX skill whose cost.resource is EX_GAUGE", () => {
    const input = minimalAsInput();
    const result = createSkillDefinition({
      ...input,
      skillDefinitionId: "SKL_001_EX",
      skillType: "EX",
      cost: { resource: "EX_GAUGE", amount: 7 },
    });
    expect(result.cost).toEqual({ resource: "EX_GAUGE", amount: 7 });
  });

  it("UT-CAT-SKL-008: maps a CHARGE resolution with a chargeRelease sequence", () => {
    const input = minimalAsInput();
    const result = createSkillDefinition({
      ...input,
      resolution: {
        kind: "CHARGE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: "ACT_MARKER_CHARGING" }],
          },
        ],
        chargeRelease: {
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ENEMIES",
              selector: { kind: "SELECT", side: "ENEMY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_ALL_ENEMIES" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_EN_21200" }],
            },
          ],
        },
      },
    });
    expect(result.resolution.kind).toBe("CHARGE");
    if (result.resolution.kind === "CHARGE") {
      expect(result.resolution.chargeRelease.targetBindings).toHaveLength(1);
    }
  });

  it("UT-CAT-SKL-009: rejects a CHARGE resolution missing chargeRelease", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        resolution: {
          kind: "CHARGE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_MARKER_CHARGING" }],
            },
          ],
        },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-010: rejects cooldown.count below 0", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({ ...input, cooldown: { unit: "ACTION", count: -1 } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-011: rejects an unknown cooldown.unit", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({ ...input, cooldown: { unit: "SKILL_USE", count: 1 } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-012: rejects an unknown resolution.kind", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({ ...input, resolution: { ...input.resolution, kind: "INSTANT" } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-013: maps an explicit activationCondition", () => {
    const input = minimalAsInput();
    const result = createSkillDefinition({
      ...input,
      activationCondition: {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      },
    });
    expect(result.activationCondition).toEqual({
      kind: "TARGET_STATE",
      target: { kind: "SELF" },
      field: "IS_ALIVE",
      op: "EQ",
      value: true,
    });
  });

  it("UT-CAT-SKL-014: maps fully-specified traits (priorityAttack, simultaneousActivationLimited, guaranteedHit, piercing)", () => {
    const input = minimalAsInput();
    const result = createSkillDefinition({
      ...input,
      traits: {
        priorityAttack: true,
        simultaneousActivationLimited: true,
        exclusiveActivationGroupId: "GROUP_1",
        accuracy: { guaranteedHit: true },
        piercing: { defenseIgnoreRate: 0.5, shieldIgnoreRate: 0.5, damageReductionIgnoreRate: 1 },
      },
    });
    expect(result.traits).toEqual({
      priorityAttack: true,
      simultaneousActivationLimited: true,
      exclusiveActivationGroupId: "GROUP_1",
      accuracy: { guaranteedHit: true },
      piercing: { defenseIgnoreRate: 0.5, shieldIgnoreRate: 0.5, damageReductionIgnoreRate: 1 },
    });
  });

  it("UT-CAT-SKL-015: rejects a piercing rate outside [0, 1]", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({ ...input, traits: { piercing: { defenseIgnoreRate: 1.5 } } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-015b: rejects a non-boolean priorityAttack", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        traits: { priorityAttack: "true" as unknown as boolean },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-015c: rejects a non-boolean accuracy.guaranteedHit", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        traits: { accuracy: { guaranteedHit: 1 as unknown as boolean } },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-015d: rejects an exclusiveActivationGroupId that is neither a string nor null", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        traits: { exclusiveActivationGroupId: 123 as unknown as string },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-016: maps requiredCapabilities as branded CapabilityIds", () => {
    const input = minimalAsInput();
    const result = createSkillDefinition({ ...input, requiredCapabilities: ["CAP_HEAL"] });
    expect(result.requiredCapabilities).toEqual(["CAP_HEAL"]);
  });

  it("UT-CAT-SKL-017: rejects a typo'd sibling key inside traits (traits.typoTraitField)", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        traits: { priorityAttack: true, typoTraitField: true } as unknown as typeof input.traits,
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-018: rejects a typo'd sibling key inside traits.accuracy", () => {
    const input = minimalAsInput();
    expect(() =>
      createSkillDefinition({
        ...input,
        traits: {
          accuracy: { guaranteedHit: true, typoField: 1 },
        } as unknown as typeof input.traits,
      }),
    ).toThrow(DomainValidationError);
  });

  function psWithCounterInput(overrides: {
    readonly counterUpdates?: readonly unknown[];
    readonly triggerCondition?: unknown;
  }): SkillDefinitionInput {
    const input = minimalAsInput();
    const trigger: Record<string, unknown> = {
      eventType: "CriticalCheckResolved",
      category: "FACT",
      sourceSelector: "SELF",
      targetSelector: "ENEMY",
    };
    if (overrides.triggerCondition !== undefined) {
      trigger.condition = overrides.triggerCondition;
    }
    const result: Record<string, unknown> = {
      ...input,
      skillDefinitionId: "SKL_001_PS1",
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      triggers: [trigger],
    };
    if (overrides.counterUpdates !== undefined) {
      result.counterUpdates = overrides.counterUpdates;
    }
    return result as unknown as SkillDefinitionInput;
  }

  it("UT-CAT-SKL-022: maps counterUpdates and an RUNTIME_COUNTER trigger condition referencing them (Issue #143)", () => {
    const result = createSkillDefinition(
      psWithCounterInput({
        counterUpdates: [
          {
            kind: "INCREMENT",
            counter: "RUNTIME_COUNTER_CRIT",
            scope: "SKILL_RUNTIME",
            trigger: {
              eventType: "CriticalCheckResolved",
              category: "FACT",
              sourceSelector: "SELF",
              targetSelector: "ANY",
            },
            amount: 1,
          },
        ],
        triggerCondition: {
          kind: "RUNTIME_COUNTER",
          counter: "RUNTIME_COUNTER_CRIT",
          op: "GTE",
          value: 1,
          modulo: 4,
        },
      }),
    );
    expect(result.counterUpdates).toHaveLength(1);
    expect(result.counterUpdates[0]).toMatchObject({
      kind: "INCREMENT",
      counter: "RUNTIME_COUNTER_CRIT",
      scope: "SKILL_RUNTIME",
      amount: 1,
    });
    expect(result.triggers[0]?.condition).toEqual({
      kind: "RUNTIME_COUNTER",
      counter: "RUNTIME_COUNTER_CRIT",
      op: "GTE",
      value: 1,
      modulo: 4,
    });
  });

  it("UT-CAT-SKL-023: defaults counterUpdates to an empty array when omitted", () => {
    const result = createSkillDefinition(minimalAsInput());
    expect(result.counterUpdates).toEqual([]);
  });

  it("UT-CAT-SKL-024: rejects a RUNTIME_COUNTER trigger condition referencing an undefined counter (Issue #143)", () => {
    expect(() =>
      createSkillDefinition(
        psWithCounterInput({
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: "RUNTIME_COUNTER_OTHER",
              scope: "SKILL_RUNTIME",
              trigger: {
                eventType: "CriticalCheckResolved",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ANY",
              },
              amount: 1,
            },
          ],
          triggerCondition: {
            kind: "RUNTIME_COUNTER",
            counter: "RUNTIME_COUNTER_UNDECLARED",
            op: "GTE",
            value: 1,
          },
        }),
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-025: rejects a RUNTIME_COUNTER activationCondition referencing an undefined counter (Issue #143)", () => {
    const input = psWithCounterInput({
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_OTHER",
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "CriticalCheckResolved",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
          },
          amount: 1,
        },
      ],
    });
    expect(() =>
      createSkillDefinition({
        ...input,
        activationCondition: {
          kind: "RUNTIME_COUNTER",
          counter: "RUNTIME_COUNTER_UNDECLARED",
          op: "GTE",
          value: 1,
        },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SKL-027: does not cross-check RUNTIME_COUNTER references when counterUpdates is empty (grandfathers pre-Issue-#143 production placeholders such as '<id>_ACTIVATIONS')", () => {
    const result = createSkillDefinition(
      psWithCounterInput({
        triggerCondition: {
          kind: "RUNTIME_COUNTER",
          counter: "SKL_001_PS1_ACTIVATIONS",
          op: "LT",
          value: 1,
        },
      }),
    );
    expect(result.counterUpdates).toEqual([]);
  });

  it("UT-CAT-SKL-026: accepts a RUNTIME_COUNTER condition nested inside AND/NOT when the counter is declared (Issue #143)", () => {
    const result = createSkillDefinition(
      psWithCounterInput({
        counterUpdates: [
          {
            kind: "INCREMENT",
            counter: "RUNTIME_COUNTER_CRIT",
            scope: "SKILL_RUNTIME",
            trigger: {
              eventType: "CriticalCheckResolved",
              category: "FACT",
              sourceSelector: "SELF",
              targetSelector: "ANY",
            },
            amount: 1,
          },
        ],
        triggerCondition: {
          kind: "AND",
          conditions: [
            { kind: "TRUE" },
            {
              kind: "NOT",
              condition: {
                kind: "RUNTIME_COUNTER",
                counter: "RUNTIME_COUNTER_CRIT",
                op: "LT",
                value: 1,
              },
            },
          ],
        },
      }),
    );
    expect(result.triggers).toHaveLength(1);
  });
});
