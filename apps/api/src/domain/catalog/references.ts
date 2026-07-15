import { createTargetBindingId, type TargetBindingId } from "./catalog-ids.js";
import { DomainValidationError } from "../shared/errors.js";
import { assertEnumValue, assertKnownKeys } from "../shared/validate.js";

const REFERENCE_ALLOWED_KEYS = ["kind", "targetBindingId"] as const;

/**
 * `scope` is the set of `TargetBindingId`s declared by the enclosing
 * `EffectSequence`. It is `undefined` when mapping a standalone
 * `EffectActionDefinition` (`effects.json`), which is reused across many
 * sequences and cannot know their binding names in advance — in that case a
 * `BINDING` reference is format-checked only, never existence-checked.
 * Existence-checking within a sequence is `参照整合性規則 #4`.
 */
export type TargetBindingScope = ReadonlySet<string>;

const TARGET_REFERENCE_KINDS = [
  "BINDING",
  "SELF",
  "TRIGGER_SOURCE",
  "TRIGGER_TARGET",
  "LAST_ACTION_TARGETS",
  "LAST_DAMAGED_TARGETS",
] as const;
export type TargetReferenceKind = (typeof TARGET_REFERENCE_KINDS)[number];

export interface TargetReference {
  readonly kind: TargetReferenceKind;
  readonly targetBindingId?: TargetBindingId;
}

export interface TargetReferenceInput {
  readonly kind: string;
  readonly targetBindingId?: string;
}

function checkBindingScope(
  id: TargetBindingId,
  scope: TargetBindingScope | undefined,
  path: string,
): void {
  if (scope !== undefined && !scope.has(id)) {
    throw new DomainValidationError(
      path,
      `targetBindingId "${id}" is not declared in this EffectSequence`,
    );
  }
}

export function createTargetReference(
  input: TargetReferenceInput,
  path: string,
  scope: TargetBindingScope | undefined,
): TargetReference {
  assertEnumValue(input.kind, TARGET_REFERENCE_KINDS, `${path}.kind`);
  assertKnownKeys(input, REFERENCE_ALLOWED_KEYS, path);
  if (input.kind === "BINDING") {
    if (input.targetBindingId === undefined) {
      throw new DomainValidationError(
        `${path}.targetBindingId`,
        "is required when kind is BINDING",
      );
    }
    const targetBindingId = createTargetBindingId(input.targetBindingId, `${path}.targetBindingId`);
    checkBindingScope(targetBindingId, scope, `${path}.targetBindingId`);
    return { kind: input.kind, targetBindingId };
  }
  if (input.targetBindingId !== undefined) {
    throw new DomainValidationError(
      `${path}.targetBindingId`,
      `must not be set when kind is "${input.kind}" (only valid when kind is BINDING)`,
    );
  }
  return { kind: input.kind };
}

const FORMULA_SOURCE_REFERENCE_KINDS = [
  "SKILL_SOURCE",
  "TARGET",
  "TRIGGER_SOURCE",
  "TRIGGER_TARGET",
  "BINDING",
] as const;
export type FormulaSourceReferenceKind = (typeof FORMULA_SOURCE_REFERENCE_KINDS)[number];

export interface FormulaSourceReference {
  readonly kind: FormulaSourceReferenceKind;
  readonly targetBindingId?: TargetBindingId;
}

export interface FormulaSourceReferenceInput {
  readonly kind: string;
  readonly targetBindingId?: string;
}

export function createFormulaSourceReference(
  input: FormulaSourceReferenceInput,
  path: string,
  scope: TargetBindingScope | undefined,
): FormulaSourceReference {
  assertEnumValue(input.kind, FORMULA_SOURCE_REFERENCE_KINDS, `${path}.kind`);
  assertKnownKeys(input, REFERENCE_ALLOWED_KEYS, path);
  if (input.kind === "BINDING") {
    if (input.targetBindingId === undefined) {
      throw new DomainValidationError(
        `${path}.targetBindingId`,
        "is required when kind is BINDING",
      );
    }
    const targetBindingId = createTargetBindingId(input.targetBindingId, `${path}.targetBindingId`);
    checkBindingScope(targetBindingId, scope, `${path}.targetBindingId`);
    return { kind: input.kind, targetBindingId };
  }
  if (input.targetBindingId !== undefined) {
    throw new DomainValidationError(
      `${path}.targetBindingId`,
      `must not be set when kind is "${input.kind}" (only valid when kind is BINDING)`,
    );
  }
  return { kind: input.kind };
}

/**
 * `SUM_*` (G-10, Issue #44) sums every `DAMAGE` result produced so far within
 * the current `EffectSequence` execution, unlike `LAST_*` which only looks at
 * the immediately preceding one.
 */
export const LAST_RESULT_REFERENCE_KINDS = [
  "LAST_DAMAGE_DEALT",
  "LAST_DAMAGE_RECEIVED",
  "SUM_DAMAGE_DEALT",
  "SUM_DAMAGE_RECEIVED",
] as const;
export type LastResultReference = (typeof LAST_RESULT_REFERENCE_KINDS)[number];
