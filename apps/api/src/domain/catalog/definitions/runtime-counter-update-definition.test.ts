import { describe, expect, it } from "vitest";
import { createRuntimeCounterUpdateDefinition } from "./runtime-counter-update-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const baseTrigger = {
  eventType: "SkillUseCompleted",
  category: "FACT",
  sourceSelector: "SELF",
  targetSelector: "ANY",
} as const;

describe("RuntimeCounterUpdateDefinition", () => {
  it("UT-CAT-RCU-001 [R-EFF-11]: maps an INCREMENT update definition (Issue #143)", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_AS_USE",
        scope: "SKILL_RUNTIME",
        trigger: {
          ...baseTrigger,
          condition: { kind: "EVENT_PAYLOAD", field: "skillType", op: "EQ", value: "AS" },
        },
        amount: 1,
      },
      "counterUpdate",
    );
    expect(result).toEqual({
      kind: "INCREMENT",
      counter: "RUNTIME_COUNTER_AS_USE",
      scope: "SKILL_RUNTIME",
      trigger: {
        ...baseTrigger,
        condition: { kind: "EVENT_PAYLOAD", field: "skillType", op: "EQ", value: "AS" },
      },
      amount: 1,
    });
  });

  it("UT-CAT-RCU-002 [R-EFF-11]: maps a CUMULATIVE_DAMAGE_THRESHOLD update definition (Issue #143)", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_CUMULATIVE_DAMAGE",
        scope: "SKILL_RUNTIME",
        trigger: {
          ...baseTrigger,
          eventType: "DamageApplied",
          sourceSelector: "ENEMY",
          targetSelector: "SELF",
        },
        maxHpRatio: 0.4,
      },
      "counterUpdate",
    );
    expect(result).toEqual({
      kind: "CUMULATIVE_DAMAGE_THRESHOLD",
      counter: "RUNTIME_COUNTER_CUMULATIVE_DAMAGE",
      scope: "SKILL_RUNTIME",
      trigger: {
        ...baseTrigger,
        eventType: "DamageApplied",
        sourceSelector: "ENEMY",
        targetSelector: "SELF",
        condition: { kind: "TRUE" },
      },
      maxHpRatio: 0.4,
    });
  });

  it("UT-CAT-RCU-003 [R-EFF-11]: rejects an unknown kind", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "DECREMENT",
          counter: "RUNTIME_COUNTER_AS_USE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
          amount: 1,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-004 [R-EFF-11]: rejects an invalid scope", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_AS_USE",
          scope: "MEMORY",
          trigger: baseTrigger,
          amount: 1,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-005 [R-EFF-11]: rejects INCREMENT missing amount", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_AS_USE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-006 [R-EFF-11]: rejects INCREMENT with a zero amount", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_AS_USE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
          amount: 0,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-007 [R-EFF-11]: rejects CUMULATIVE_DAMAGE_THRESHOLD missing maxHpRatio", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "CUMULATIVE_DAMAGE_THRESHOLD",
          counter: "RUNTIME_COUNTER_CUMULATIVE_DAMAGE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-008 [R-EFF-11]: rejects a zero maxHpRatio", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "CUMULATIVE_DAMAGE_THRESHOLD",
          counter: "RUNTIME_COUNTER_CUMULATIVE_DAMAGE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
          maxHpRatio: 0,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-009 [R-EFF-11]: rejects a maxHpRatio greater than 1", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "CUMULATIVE_DAMAGE_THRESHOLD",
          counter: "RUNTIME_COUNTER_CUMULATIVE_DAMAGE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
          maxHpRatio: 1.2,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-010 [R-EFF-11]: rejects a typo'd sibling key (maxHpRatio on INCREMENT)", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_AS_USE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
          amount: 1,
          maxHpRatio: 0.4,
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-RCU-012 [R-EFF-11]: maps an INCREMENT update definition with resetScope: RESOLUTION_SCOPE", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_AS_USE",
        scope: "SKILL_RUNTIME",
        trigger: baseTrigger,
        amount: 1,
        resetScope: "RESOLUTION_SCOPE",
      },
      "counterUpdate",
    );
    expect(result).toEqual({
      kind: "INCREMENT",
      counter: "RUNTIME_COUNTER_AS_USE",
      scope: "SKILL_RUNTIME",
      trigger: { ...baseTrigger, condition: { kind: "TRUE" } },
      amount: 1,
      resetScope: "RESOLUTION_SCOPE",
    });
  });

  it("UT-CAT-RCU-013 [R-EFF-11]: omitting resetScope means the counter persists for the whole battle (no resetScope key on the result)", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_AS_USE",
        scope: "SKILL_RUNTIME",
        trigger: baseTrigger,
        amount: 1,
      },
      "counterUpdate",
    );
    expect(result).not.toHaveProperty("resetScope");
  });

  it("UT-CAT-RCU-014 [R-EFF-11]: rejects an invalid resetScope value", () => {
    expect(() =>
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_AS_USE",
          scope: "SKILL_RUNTIME",
          trigger: baseTrigger,
          amount: 1,
          resetScope: "TURN",
        },
        "counterUpdate",
      ),
    ).toThrow(DomainValidationError);
  });

  it.each(["BATTLE", "BATTLE_UNIT"])(
    "UT-CAT-RCU-011 [R-EFF-11] (EFF-006 Issue #212): rejects scope %s at Catalog load time (only SKILL_RUNTIME/APPLIED_EFFECT/EFFECT_SEQUENCE are implemented; Catalog must not accept a scope the runtime rejects)",
    (scope) => {
      expect(() =>
        createRuntimeCounterUpdateDefinition(
          {
            kind: "INCREMENT",
            counter: "RUNTIME_COUNTER_AS_USE",
            scope,
            trigger: baseTrigger,
            amount: 1,
          },
          "counterUpdate",
        ),
      ).toThrow(DomainValidationError);
    },
  );

  it("UT-CAT-RCU-015 [R-EFF-11] (EFF-005 Issue #162): accepts scope APPLIED_EFFECT", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_AS_USE",
        scope: "APPLIED_EFFECT",
        trigger: baseTrigger,
        amount: 1,
      },
      "counterUpdate",
    );
    expect(result.scope).toBe("APPLIED_EFFECT");
  });

  it("UT-CAT-RCU-016 [R-EFF-11] (EFF-006 Issue #212): accepts scope EFFECT_SEQUENCE", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_AS_USE",
        scope: "EFFECT_SEQUENCE",
        trigger: baseTrigger,
        amount: 1,
      },
      "counterUpdate",
    );
    expect(result.scope).toBe("EFFECT_SEQUENCE");
  });

  it("UT-CAT-RCU-017 [R-EFF-11] (Issue #553): maps a RESET update definition", () => {
    const result = createRuntimeCounterUpdateDefinition(
      {
        kind: "RESET",
        counter: "RUNTIME_COUNTER_CRIT",
        scope: "SKILL_RUNTIME",
        trigger: {
          ...baseTrigger,
          eventType: "PassiveActivated",
          condition: {
            kind: "EVENT_PAYLOAD",
            field: "skillDefinitionId",
            op: "EQ",
            value: "SKL_EXAMPLE_PS2",
          },
        },
      },
      "counterUpdate",
    );
    expect(result).toEqual({
      kind: "RESET",
      counter: "RUNTIME_COUNTER_CRIT",
      scope: "SKILL_RUNTIME",
      trigger: {
        ...baseTrigger,
        eventType: "PassiveActivated",
        condition: {
          kind: "EVENT_PAYLOAD",
          field: "skillDefinitionId",
          op: "EQ",
          value: "SKL_EXAMPLE_PS2",
        },
      },
    });
  });

  it("UT-CAT-RCU-018 [R-EFF-11] (Issue #553): rejects a RESET that carries another kind's sibling key (amount / maxHpRatio / resetScope)", () => {
    for (const extra of [{ amount: 1 }, { maxHpRatio: 0.4 }, { resetScope: "RESOLUTION_SCOPE" }]) {
      expect(() =>
        createRuntimeCounterUpdateDefinition(
          {
            kind: "RESET",
            counter: "RUNTIME_COUNTER_CRIT",
            scope: "SKILL_RUNTIME",
            trigger: baseTrigger,
            ...extra,
          },
          "counterUpdate",
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-CAT-RCU-019 [R-EFF-11] (Issue #553): rejects a RESET whose scope is not SKILL_RUNTIME (APPLIED_EFFECT / EFFECT_SEQUENCE discard their counters on their own lifecycle)", () => {
    for (const scope of ["APPLIED_EFFECT", "EFFECT_SEQUENCE"]) {
      expect(() =>
        createRuntimeCounterUpdateDefinition(
          {
            kind: "RESET",
            counter: "RUNTIME_COUNTER_CRIT",
            scope,
            trigger: baseTrigger,
          },
          "counterUpdate",
        ),
      ).toThrow(DomainValidationError);
    }
  });
});
