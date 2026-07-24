import { describe, expect, it } from "vitest";
import { createEffectSequence } from "./effect-sequence.js";
import { DomainValidationError } from "../../shared/errors.js";

const baseTrigger = {
  eventType: "EffectActionCompleted",
  category: "FACT",
  sourceSelector: "SELF",
  targetSelector: "ANY",
} as const;

describe("EffectSequence", () => {
  it("UT-CAT-SEQ-001: maps a minimal single-target ACTION sequence", () => {
    const result = createEffectSequence(
      {
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
      "resolution",
    );

    expect(result.targetBindings).toHaveLength(1);
    expect(result.targetBindings[0]?.targetBindingId).toBe("TGT_PRIMARY");
    expect(result.steps).toEqual([
      {
        kind: "ACTION",
        condition: { kind: "TRUE" },
        target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
        actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
      },
    ]);
  });

  it("UT-CAT-SEQ-002: resolves a step target against a targetBindingId declared in the same sequence", () => {
    const result = createEffectSequence(
      {
        targetBindings: [
          { targetBindingId: "TGT_MAIN", selector: { kind: "SELECT", side: "ENEMY", count: 1 } },
        ],
        steps: [
          {
            kind: "BRANCH",
            condition: {
              kind: "TARGET_STATE",
              target: { kind: "BINDING", targetBindingId: "TGT_MAIN" },
              field: "IS_ALIVE",
              op: "EQ",
              value: true,
            },
            thenSteps: [
              {
                kind: "ACTION",
                target: { kind: "BINDING", targetBindingId: "TGT_MAIN" },
                actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_5300" }],
              },
            ],
            elseSteps: [],
          },
        ],
      },
      "resolution",
    );
    expect(result.steps[0]?.kind).toBe("BRANCH");
  });

  it("UT-CAT-SEQ-003: rejects a step target referencing an undeclared targetBindingId", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_GHOST" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_1" }],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-004: rejects duplicate targetBindingId within one sequence", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [
            {
              targetBindingId: "TGT_PRIMARY",
              selector: { kind: "SELECT", side: "ENEMY", count: 1 },
            },
            {
              targetBindingId: "TGT_PRIMARY",
              selector: { kind: "SELECT", side: "ALLY", count: 1 },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_HEAL_1" }],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-005: rejects an empty steps array", () => {
    expect(() => createEffectSequence({ targetBindings: [], steps: [] }, "resolution")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-SEQ-006: maps a REPEAT step", () => {
    const result = createEffectSequence(
      {
        targetBindings: [
          { targetBindingId: "TGT_PRIMARY", selector: { kind: "SELECT", side: "ENEMY", count: 1 } },
        ],
        steps: [
          {
            kind: "REPEAT",
            count: 5,
            steps: [
              {
                kind: "ACTION",
                target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
                actions: [{ effectActionDefinitionId: "ACT_DAMAGE_EN_2340" }],
              },
            ],
          },
        ],
      },
      "resolution",
    );
    expect(result.steps[0]).toEqual({
      kind: "REPEAT",
      count: 5,
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_EN_2340" }],
        },
      ],
    });
  });

  it("UT-CAT-SEQ-007: maps a RANDOM_BRANCH step with WEIGHTED_ONE mode", () => {
    const result = createEffectSequence(
      {
        targetBindings: [],
        steps: [
          {
            kind: "RANDOM_BRANCH",
            mode: "WEIGHTED_ONE",
            branches: [
              {
                weight: 10,
                label: "DAIKICHI",
                steps: [
                  {
                    kind: "ACTION",
                    target: { kind: "SELF" },
                    actions: [{ effectActionDefinitionId: "ACT_MARKER_LUCKY" }],
                  },
                ],
              },
              { weight: 90, label: "SHOKICHI", steps: [] },
            ],
          },
        ],
      },
      "resolution",
    );
    expect(result.steps[0]?.kind).toBe("RANDOM_BRANCH");
  });

  it("UT-CAT-SEQ-008: rejects a WEIGHTED_ONE branch missing weight", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [{ kind: "RANDOM_BRANCH", mode: "WEIGHTED_ONE", branches: [{ steps: [] }] }],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-009: rejects an ACTION step with an empty actions array", () => {
    expect(() =>
      createEffectSequence(
        { targetBindings: [], steps: [{ kind: "ACTION", target: { kind: "SELF" }, actions: [] }] },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-010: maps a RANDOM_BRANCH step with INDEPENDENT mode and probability", () => {
    const result = createEffectSequence(
      {
        targetBindings: [],
        steps: [
          {
            kind: "RANDOM_BRANCH",
            mode: "INDEPENDENT",
            branches: [{ probability: 0.3, steps: [] }],
          },
        ],
      },
      "resolution",
    );
    expect(result.steps[0]).toEqual({
      kind: "RANDOM_BRANCH",
      mode: "INDEPENDENT",
      branches: [{ steps: [], probability: 0.3 }],
    });
  });

  it("UT-CAT-SEQ-011: rejects an INDEPENDENT branch missing probability", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [{ kind: "RANDOM_BRANCH", mode: "INDEPENDENT", branches: [{ steps: [] }] }],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-012: rejects an INDEPENDENT branch probability outside [0, 1]", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "INDEPENDENT",
              branches: [{ probability: 1.2, steps: [] }],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-013: rejects a WEIGHTED_ONE branch with a negative weight", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            { kind: "RANDOM_BRANCH", mode: "WEIGHTED_ONE", branches: [{ weight: -1, steps: [] }] },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-014: rejects RANDOM_BRANCH missing mode", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [{ kind: "RANDOM_BRANCH", branches: [{ weight: 1, steps: [] }] }],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-015: rejects RANDOM_BRANCH with an empty branches array", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [{ kind: "RANDOM_BRANCH", mode: "WEIGHTED_ONE", branches: [] }],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-016: rejects REPEAT missing count", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "REPEAT",
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_1" }],
                },
              ],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-017: maps a RandomBranch with a label", () => {
    const result = createEffectSequence(
      {
        targetBindings: [],
        steps: [
          {
            kind: "RANDOM_BRANCH",
            mode: "WEIGHTED_ONE",
            branches: [{ weight: 1, label: "ONLY", steps: [] }],
          },
        ],
      },
      "resolution",
    );
    expect(result.steps[0]).toEqual({
      kind: "RANDOM_BRANCH",
      mode: "WEIGHTED_ONE",
      branches: [{ steps: [], label: "ONLY", weight: 1 }],
    });
  });

  it("UT-CAT-SEQ-018: raises DomainValidationError (not a raw TypeError) when a RANDOM_BRANCH branch omits steps", () => {
    let caught: unknown;
    try {
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "WEIGHTED_ONE",
              branches: [{ weight: 1 } as unknown as { steps: never[] }],
            },
          ],
        },
        "resolution",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
  });

  it("UT-CAT-SEQ-019: rejects a RANDOM_BRANCH whose branches field is not an array", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "WEIGHTED_ONE",
              branches: "not-an-array" as unknown as never[],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-020: rejects an ACTION step whose actions field is not an array", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: "not-an-array" as unknown as never[],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-021: rejects a BRANCH step whose thenSteps field is not an array", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "BRANCH",
              condition: { kind: "TRUE" },
              thenSteps: "not-an-array" as unknown as never[],
              elseSteps: [],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-022: rejects a typo'd sibling key inside a step (steps[].typoStepField)", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_HEAL_1" }],
              typoStepField: "oops",
            } as never,
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-023: rejects a typo'd sibling key inside a targetBinding", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [
            {
              targetBindingId: "TGT_PRIMARY",
              selector: { kind: "SELECT", side: "ENEMY", count: 1 },
              typoField: "oops",
            } as never,
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
              actions: [{ effectActionDefinitionId: "ACT_HEAL_1" }],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-024: rejects a typo'd sibling key inside a RandomBranch", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "WEIGHTED_ONE",
              branches: [{ weight: 1, steps: [], typoField: "oops" } as never],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-025: rejects a stale probability on a WEIGHTED_ONE branch", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "WEIGHTED_ONE",
              branches: [{ weight: 1, probability: 0.5, steps: [] }],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-026: rejects a stale weight on an INDEPENDENT branch", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "INDEPENDENT",
              branches: [{ weight: 1, probability: 0.5, steps: [] }],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-027 (EFF-006 Issue #212): maps counterUpdates with scope EFFECT_SEQUENCE", () => {
    const result = createEffectSequence(
      {
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
          },
        ],
        counterUpdates: [
          {
            kind: "INCREMENT",
            counter: "RUNTIME_COUNTER_SEQ_HITS",
            scope: "EFFECT_SEQUENCE",
            trigger: baseTrigger,
            amount: 1,
          },
        ],
      },
      "resolution",
    );

    expect(result.counterUpdates).toEqual([
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: { ...baseTrigger, condition: { kind: "TRUE" } },
        amount: 1,
      },
    ]);
  });

  it("UT-CAT-SEQ-028 (EFF-006 Issue #212): omits counterUpdates when not declared", () => {
    const result = createEffectSequence(
      {
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
          },
        ],
      },
      "resolution",
    );

    expect(result).not.toHaveProperty("counterUpdates");
  });

  it("UT-CAT-SEQ-029 (EFF-006 Issue #212): rejects counterUpdates with a scope other than EFFECT_SEQUENCE", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
            },
          ],
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: "RUNTIME_COUNTER_SEQ_HITS",
              scope: "SKILL_RUNTIME",
              trigger: baseTrigger,
              amount: 1,
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-031 (PR #213 review [P2]): rejects counterUpdates that declares resetScope: RESOLUTION_SCOPE, since EffectSequence counters always discard at resolution end regardless of resetScope", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
            },
          ],
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: "RUNTIME_COUNTER_SEQ_HITS",
              scope: "EFFECT_SEQUENCE",
              trigger: baseTrigger,
              amount: 1,
              resetScope: "RESOLUTION_SCOPE",
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-030 (EFF-006 Issue #212): rejects a non-array counterUpdates", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
            },
          ],
          counterUpdates: "not-an-array" as unknown as never[],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-032 (PR #218 review [P2]): rejects a WEIGHTED_ONE RANDOM_BRANCH where every branch has weight: 0 (selectWeightedBranch would have no branch to choose)", () => {
    expect(() =>
      createEffectSequence(
        {
          targetBindings: [],
          steps: [
            {
              kind: "RANDOM_BRANCH",
              mode: "WEIGHTED_ONE",
              branches: [
                { weight: 0, steps: [] },
                { weight: 0, steps: [] },
              ],
            },
          ],
        },
        "resolution",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-SEQ-033 (PR #218 review [P2]): accepts a WEIGHTED_ONE RANDOM_BRANCH where only one of several branches has weight > 0", () => {
    const result = createEffectSequence(
      {
        targetBindings: [],
        steps: [
          {
            kind: "RANDOM_BRANCH",
            mode: "WEIGHTED_ONE",
            branches: [
              { weight: 0, steps: [], label: "unreachable" },
              { weight: 1, steps: [], label: "only" },
            ],
          },
        ],
      },
      "resolution",
    );

    expect(result.steps).toEqual([
      {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          { weight: 0, steps: [], label: "unreachable" },
          { weight: 1, steps: [], label: "only" },
        ],
      },
    ]);
  });
});
