import { createTargetBindingId, type TargetBindingId } from "./catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { assertEnumValue, assertKnownKeys } from "../../shared/validate.js";

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

/**
 * `TRIGGER_TARGET_SINGLE`（Issue #661、Q-CAT-EFF-24）: `TRIGGER_TARGET`と同じ
 * `triggerContext.triggerTargetUnitIds`を参照するが、実行時にちょうど1件で
 * あることを要求する（0件・2件以上は`DomainValidationError`）。EffectSequence
 * 解決内のBRANCHの`condition`のような、対象ごとの評価コンテキストを持たない
 * 位置は、量化規則を発明しないため`TARGET_STATE`等の`target`に高々1体しか
 * 解決されないTargetReferenceしか許可しない
 * （`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`、Issue #230）。`TRIGGER_TARGET`
 * 自体は複数体になりうる契機（AS/EXの範囲攻撃等）があるため一律には許可できないが、
 * 呼び出し側がCatalog定義そのもの（`counterUpdates`の`trigger.eventType`が
 * 単一対象しか持たない`DamageApplied`等）から「常に1件」であることを保証できる
 * 場合に限り、この種別を使って`targetReferenceIsSingleUnit`を満たす。
 *
 * `activationCondition`では（skill typeを問わず）使えない —
 * `skill-integrity.ts`の`ACTIVATION_CONDITION_REFERENCE_KINDS`が
 * `TRIGGER_TARGET_SINGLE`を含まない別個の許可リストで、ACTION（AS/EX）は
 * `{SELF, BINDING}`、PASSIVE（PS）は`{SELF, TRIGGER_SOURCE, TRIGGER_TARGET}`
 * のみを許可する（PSの評価器`evaluateTriggerCondition`はそもそも対象ごとの
 * カーディナリティ制約自体を課さず存在量化するため、ここでの単一性保証は
 * 意味を持たない）。`activationCondition`でこの種別を使いたければ、まず
 * その許可リストへ追加したうえでPS側の`resolveTargetReferenceIds`
 * （`trigger-condition-evaluator.ts`）にも同じexactly-one解決を実装する必要がある。
 */
const TARGET_REFERENCE_KINDS = [
  "BINDING",
  "SELF",
  "TRIGGER_SOURCE",
  "TRIGGER_TARGET",
  "TRIGGER_TARGET_SINGLE",
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

/** Issue #230 RES-004-CONDITION-SCOPE: 2つの`TargetReference`が同じ対象を指すかどうか。 */
export function targetReferenceEquals(a: TargetReference, b: TargetReference): boolean {
  return a.kind === b.kind && a.targetBindingId === b.targetBindingId;
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
