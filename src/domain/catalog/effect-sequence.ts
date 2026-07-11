import {
  createConditionDefinition,
  type ConditionDefinition,
  type ConditionDefinitionInput,
} from "./condition-definition.js";
import {
  createEffectActionDefinitionId,
  createTargetBindingId,
  type EffectActionDefinitionId,
  type TargetBindingId,
} from "./catalog-ids.js";
import {
  createTargetReference,
  type TargetBindingScope,
  type TargetReference,
  type TargetReferenceInput,
} from "./references.js";
import {
  createTargetSelectorDefinition,
  type TargetSelectorDefinition,
  type TargetSelectorDefinitionInput,
} from "./target-selector-definition.js";
import { DomainValidationError } from "../shared/errors.js";
import {
  assertArray,
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertNonEmptyArray,
} from "../shared/validate.js";

const TRUE_CONDITION: ConditionDefinition = { kind: "TRUE" };

// ---- TargetBindingDefinition ----

export interface TargetBindingDefinition {
  readonly targetBindingId: TargetBindingId;
  readonly selector: TargetSelectorDefinition;
}

export interface TargetBindingDefinitionInput {
  readonly targetBindingId: string;
  readonly selector: TargetSelectorDefinitionInput;
}

// ---- EffectActionReference (within an ACTION step) ----

export interface EffectActionReference {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
}

export interface EffectActionReferenceInput {
  readonly effectActionDefinitionId: string;
}

// ---- EffectStepDefinition ----

const EFFECT_STEP_KINDS = ["ACTION", "BRANCH", "RANDOM_BRANCH", "REPEAT"] as const;
const RANDOM_BRANCH_MODES = ["WEIGHTED_ONE", "INDEPENDENT"] as const;

export interface RandomBranch {
  readonly label?: string;
  readonly weight?: number;
  readonly probability?: number;
  readonly steps: readonly EffectStepDefinition[];
}

export interface RandomBranchInput {
  readonly label?: string;
  readonly weight?: number;
  readonly probability?: number;
  readonly steps: readonly EffectStepDefinitionInput[];
}

export type EffectStepDefinition =
  | {
      readonly kind: "ACTION";
      readonly condition: ConditionDefinition;
      readonly target: TargetReference;
      readonly actions: readonly EffectActionReference[];
    }
  | {
      readonly kind: "BRANCH";
      readonly condition: ConditionDefinition;
      readonly thenSteps: readonly EffectStepDefinition[];
      readonly elseSteps: readonly EffectStepDefinition[];
    }
  | {
      readonly kind: "RANDOM_BRANCH";
      readonly mode: (typeof RANDOM_BRANCH_MODES)[number];
      readonly branches: readonly RandomBranch[];
    }
  | {
      readonly kind: "REPEAT";
      readonly count: number;
      readonly steps: readonly EffectStepDefinition[];
    };

export interface EffectStepDefinitionInput {
  readonly kind: string;
  readonly condition?: ConditionDefinitionInput;
  readonly target?: TargetReferenceInput;
  readonly actions?: readonly EffectActionReferenceInput[];
  readonly thenSteps?: readonly EffectStepDefinitionInput[];
  readonly elseSteps?: readonly EffectStepDefinitionInput[];
  readonly mode?: string;
  readonly branches?: readonly RandomBranchInput[];
  readonly count?: number;
  readonly steps?: readonly EffectStepDefinitionInput[];
}

function createEffectActionReference(
  input: EffectActionReferenceInput,
  path: string,
): EffectActionReference {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(
      input.effectActionDefinitionId,
      `${path}.effectActionDefinitionId`,
    ),
  };
}

export function createEffectStepDefinition(
  input: EffectStepDefinitionInput,
  path: string,
  scope: TargetBindingScope,
): EffectStepDefinition {
  assertEnumValue(input.kind, EFFECT_STEP_KINDS, `${path}.kind`);

  switch (input.kind) {
    case "ACTION": {
      if (input.target === undefined) {
        throw new DomainValidationError(`${path}.target`, "is required");
      }
      const actions = input.actions;
      if (actions === undefined) {
        throw new DomainValidationError(`${path}.actions`, "is required");
      }
      assertNonEmptyArray(actions, `${path}.actions`);
      return {
        kind: "ACTION",
        condition:
          input.condition === undefined
            ? TRUE_CONDITION
            : createConditionDefinition(input.condition, `${path}.condition`, scope),
        target: createTargetReference(input.target, `${path}.target`, scope),
        actions: actions.map((a, i) => createEffectActionReference(a, `${path}.actions[${i}]`)),
      };
    }
    case "BRANCH": {
      if (input.condition === undefined) {
        throw new DomainValidationError(`${path}.condition`, "is required");
      }
      if (input.thenSteps !== undefined) {
        assertArray(input.thenSteps, `${path}.thenSteps`);
      }
      if (input.elseSteps !== undefined) {
        assertArray(input.elseSteps, `${path}.elseSteps`);
      }
      const thenSteps = input.thenSteps ?? [];
      const elseSteps = input.elseSteps ?? [];
      return {
        kind: "BRANCH",
        condition: createConditionDefinition(input.condition, `${path}.condition`, scope),
        thenSteps: thenSteps.map((s, i) =>
          createEffectStepDefinition(s, `${path}.thenSteps[${i}]`, scope),
        ),
        elseSteps: elseSteps.map((s, i) =>
          createEffectStepDefinition(s, `${path}.elseSteps[${i}]`, scope),
        ),
      };
    }
    case "RANDOM_BRANCH": {
      const mode = input.mode;
      if (mode === undefined) {
        throw new DomainValidationError(`${path}.mode`, "is required");
      }
      assertEnumValue(mode, RANDOM_BRANCH_MODES, `${path}.mode`);
      const branches = input.branches;
      if (branches === undefined) {
        throw new DomainValidationError(`${path}.branches`, "is required");
      }
      assertNonEmptyArray(branches, `${path}.branches`);
      return {
        kind: "RANDOM_BRANCH",
        mode,
        branches: branches.map((b, i) =>
          createRandomBranch(b, mode, `${path}.branches[${i}]`, scope),
        ),
      };
    }
    case "REPEAT": {
      if (input.count === undefined) {
        throw new DomainValidationError(`${path}.count`, "is required");
      }
      assertInteger(input.count, `${path}.count`, { min: 1 });
      const steps = input.steps;
      assertNonEmptyArray(steps ?? [], `${path}.steps`);
      return {
        kind: "REPEAT",
        count: input.count,
        steps: (steps ?? []).map((s, i) =>
          createEffectStepDefinition(s, `${path}.steps[${i}]`, scope),
        ),
      };
    }
  }
}

function createRandomBranch(
  input: RandomBranchInput,
  mode: (typeof RANDOM_BRANCH_MODES)[number],
  path: string,
  scope: TargetBindingScope,
): RandomBranch {
  // Branches may legitimately have no mechanical effect yet (`14_Catalog定義スキーマ.md` の
  // RANDOM_BRANCH例: 全枝が `steps: []`), so an empty array is valid here.
  assertArray(input.steps, `${path}.steps`);
  const steps = input.steps.map((s, i) =>
    createEffectStepDefinition(s, `${path}.steps[${i}]`, scope),
  );

  const result: {
    label?: string;
    weight?: number;
    probability?: number;
    steps: readonly EffectStepDefinition[];
  } = {
    steps,
  };
  if (input.label !== undefined) {
    result.label = input.label;
  }

  if (mode === "WEIGHTED_ONE") {
    if (input.weight === undefined) {
      throw new DomainValidationError(`${path}.weight`, "is required when mode is WEIGHTED_ONE");
    }
    assertFinite(input.weight, `${path}.weight`);
    if (input.weight < 0) {
      throw new DomainValidationError(`${path}.weight`, `must be >= 0, got ${input.weight}`);
    }
    result.weight = input.weight;
  } else {
    if (input.probability === undefined) {
      throw new DomainValidationError(
        `${path}.probability`,
        "is required when mode is INDEPENDENT",
      );
    }
    assertFinite(input.probability, `${path}.probability`);
    if (input.probability < 0 || input.probability > 1) {
      throw new DomainValidationError(
        `${path}.probability`,
        `must be within [0, 1], got ${input.probability}`,
      );
    }
    result.probability = input.probability;
  }
  return result;
}

// ---- EffectSequence ----

export interface EffectSequence {
  readonly targetBindings: readonly TargetBindingDefinition[];
  readonly steps: readonly EffectStepDefinition[];
}

export interface EffectSequenceInput {
  readonly targetBindings?: readonly TargetBindingDefinitionInput[];
  readonly steps: readonly EffectStepDefinitionInput[];
}

export function createEffectSequence(input: EffectSequenceInput, path: string): EffectSequence {
  if (input.targetBindings !== undefined) {
    assertArray(input.targetBindings, `${path}.targetBindings`);
  }
  const bindingInputs = input.targetBindings ?? [];

  const ids = bindingInputs.map((b, i) =>
    createTargetBindingId(b.targetBindingId, `${path}.targetBindings[${i}].targetBindingId`),
  );
  const seen = new Set<string>();
  for (const [i, id] of ids.entries()) {
    if (seen.has(id)) {
      throw new DomainValidationError(
        `${path}.targetBindings[${i}].targetBindingId`,
        `duplicate targetBindingId "${id}" within this EffectSequence`,
      );
    }
    seen.add(id);
  }
  const scope: TargetBindingScope = seen;

  const targetBindings: TargetBindingDefinition[] = bindingInputs.map((b, i) => ({
    targetBindingId: ids[i] as TargetBindingId,
    selector: createTargetSelectorDefinition(
      b.selector,
      `${path}.targetBindings[${i}].selector`,
      scope,
    ),
  }));

  assertNonEmptyArray(input.steps, `${path}.steps`);
  const steps = input.steps.map((s, i) =>
    createEffectStepDefinition(s, `${path}.steps[${i}]`, scope),
  );

  return { targetBindings, steps };
}
