import { describe, expect, it } from "vitest";
import { createEffectSequence, type EffectStepDefinition } from "./effect-sequence.js";
import {
  collectEffectSteps,
  effectStepChildSteps,
  effectStepOwnConditions,
  someEffectStep,
} from "./effect-step-walk.js";

/**
 * 走査対象の形は「ACTION／BRANCH（then・else）／RANDOM_BRANCH（branches）／REPEAT」の
 * 4 kindすべてと、BRANCH配下のREPEATという入れ子を1つ含む。降下漏れがあれば収集結果の
 * pathが欠けるため、どのkindの子step列を辿り損ねたかが特定できる。
 */
function buildNestedSequenceSteps(): readonly EffectStepDefinition[] {
  return createEffectSequence(
    {
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "AND", conditions: [{ kind: "TRUE" }] },
          targetCondition: { kind: "NOT", condition: { kind: "TRUE" } },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_ROOT" }],
        },
        {
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_THEN" }],
            },
          ],
          elseSteps: [
            {
              kind: "REPEAT",
              count: 2,
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_REPEATED" }],
                },
              ],
            },
          ],
        },
        {
          kind: "RANDOM_BRANCH",
          mode: "INDEPENDENT",
          branches: [
            {
              probability: 0.5,
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_RANDOM" }],
                },
              ],
            },
            { probability: 0.5, steps: [] },
          ],
        },
      ],
    },
    "resolution",
  ).steps;
}

function findStepOfKind(
  steps: readonly EffectStepDefinition[],
  kind: EffectStepDefinition["kind"],
): EffectStepDefinition {
  const found = collectEffectSteps(steps, (step) => (step.kind === kind ? [step] : []))[0];
  if (found === undefined) {
    throw new Error(`fixture has no ${kind} step`);
  }
  return found;
}

describe("effectStepChildSteps", () => {
  it("UT-CAT-WALK-001: exposes each step kind's child step lists with their path segments", () => {
    const steps = buildNestedSequenceSteps();

    expect(effectStepChildSteps(findStepOfKind(steps, "ACTION"))).toEqual([]);
    expect(
      effectStepChildSteps(findStepOfKind(steps, "BRANCH")).map((child) => child.pathSegment),
    ).toEqual(["thenSteps", "elseSteps"]);
    expect(
      effectStepChildSteps(findStepOfKind(steps, "RANDOM_BRANCH")).map(
        (child) => child.pathSegment,
      ),
    ).toEqual(["branches[0].steps", "branches[1].steps"]);
    expect(
      effectStepChildSteps(findStepOfKind(steps, "REPEAT")).map((child) => child.pathSegment),
    ).toEqual(["steps"]);
  });
});

describe("effectStepOwnConditions", () => {
  it("UT-CAT-WALK-007: lists the conditions a step declares itself, ACTION's stepCondition first", () => {
    const steps = buildNestedSequenceSteps();

    expect(
      effectStepOwnConditions(findStepOfKind(steps, "ACTION")).map((condition) => condition.kind),
    ).toEqual(["AND", "NOT"]);
    expect(
      effectStepOwnConditions(findStepOfKind(steps, "BRANCH")).map((condition) => condition.kind),
    ).toEqual(["TRUE"]);
    expect(effectStepOwnConditions(findStepOfKind(steps, "RANDOM_BRANCH"))).toEqual([]);
    expect(effectStepOwnConditions(findStepOfKind(steps, "REPEAT"))).toEqual([]);
  });
});

describe("someEffectStep", () => {
  it("UT-CAT-WALK-002: reaches steps nested under BRANCH, RANDOM_BRANCH and REPEAT", () => {
    const reachedActionIds = new Set<string>();
    someEffectStep(buildNestedSequenceSteps(), (step) => {
      if (step.kind === "ACTION") {
        for (const action of step.actions) {
          reachedActionIds.add(action.effectActionDefinitionId);
        }
      }
      return false;
    });

    expect([...reachedActionIds].sort()).toEqual([
      "ACT_RANDOM",
      "ACT_REPEATED",
      "ACT_ROOT",
      "ACT_THEN",
    ]);
  });

  it("UT-CAT-WALK-003: stops at the first matching step instead of visiting the whole tree", () => {
    const visited: EffectStepDefinition["kind"][] = [];

    expect(
      someEffectStep(buildNestedSequenceSteps(), (step) => {
        visited.push(step.kind);
        return step.kind === "BRANCH";
      }),
    ).toBe(true);
    expect(visited).toEqual(["ACTION", "BRANCH"]);
  });

  it("UT-CAT-WALK-008: reports a match found only inside a nested child step list", () => {
    const visited: EffectStepDefinition["kind"][] = [];

    expect(
      someEffectStep(buildNestedSequenceSteps(), (step) => {
        visited.push(step.kind);
        return step.kind === "REPEAT";
      }),
    ).toBe(true);
    // BRANCH配下（elseSteps）で一致したので、その後のRANDOM_BRANCHへは進まない。
    expect(visited).toEqual(["ACTION", "BRANCH", "ACTION", "REPEAT"]);
  });

  it("UT-CAT-WALK-004: reports false when no step in the whole tree matches", () => {
    expect(someEffectStep(buildNestedSequenceSteps(), () => false)).toBe(false);
  });
});

describe("collectEffectSteps", () => {
  it("UT-CAT-WALK-005: visits every step pre-order and hands each its definition path", () => {
    const paths = collectEffectSteps(buildNestedSequenceSteps(), (step, path) => [
      `${path}:${step.kind}`,
    ]);

    expect(paths).toEqual([
      "steps[0]:ACTION",
      "steps[1]:BRANCH",
      "steps[1].thenSteps[0]:ACTION",
      "steps[1].elseSteps[0]:REPEAT",
      "steps[1].elseSteps[0].steps[0]:ACTION",
      "steps[2]:RANDOM_BRANCH",
      "steps[2].branches[0].steps[0]:ACTION",
    ]);
  });

  it("UT-CAT-WALK-006: roots the reported paths at the caller-supplied prefix", () => {
    const paths = collectEffectSteps(
      buildNestedSequenceSteps(),
      (_step, path) => [path],
      "chargeRelease.steps",
    );

    expect(paths[0]).toBe("chargeRelease.steps[0]");
    expect(paths).toContain("chargeRelease.steps[1].elseSteps[0].steps[0]");
  });
});
