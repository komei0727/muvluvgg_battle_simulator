import type {
  ActionKind,
  ComparisonOperator,
  CriticalMode,
  AccuracyMode,
  DamageModDirection,
  DamageType,
  EffectImmunityCategory,
  MarkerStackPolicy,
  OverhealPolicy,
  ResourceKind,
  ResourceModifyOperation,
  StatKind,
} from "./catalog-enums.js";
import type { EffectActionDefinitionId, MarkerId, SkillDefinitionId } from "./catalog-ids.js";
import type { DurationDefinition } from "./duration-definition.js";
import type { FormulaDefinition } from "./formula-definition.js";
import type { TargetReference } from "./references.js";

/**
 * `APPLY_STATUS`のstatus値。`14_Catalog定義スキーマ.md`が定義する固定enumで、
 * `catalog-enums.ts`に対応する公開型がないため、この値集合自体がkind別payloadの
 * 一部としてここに属する。
 */
export const STATUS_KINDS = [
  "STUN",
  "FREEZE",
  "BLIND",
  "STEALTH",
  "EVASION",
  "DAMAGE_IMMUNITY",
  "CRITICAL_GUARANTEE",
  "CRITICAL_PREVENTION",
  "GUARANTEED_HIT",
  "HIT_EVASION",
] as const;

/** `APPLY_REFLECT`のtiming値。現時点では単一値のみ定義されている。 */
export const REFLECT_TIMINGS = ["AFTER_DAMAGE_APPLIED"] as const;

/** `MODIFY_RESOURCE_CAPACITY`のoperation値。 */
export const RESOURCE_CAPACITY_OPERATIONS = ["ADD", "SET"] as const;

/** `COOLDOWN_MANIPULATION`のoperation値（Issue #129）。 */
export const COOLDOWN_MANIPULATION_OPERATIONS = ["RESET", "REDUCE"] as const;

// ---- payload types ----

export interface DamagePayload {
  readonly damageType: DamageType;
  readonly formula: FormulaDefinition;
  readonly hitCount: number;
  readonly critical: { readonly mode: CriticalMode };
  readonly accuracy: { readonly mode: AccuracyMode };
  readonly piercing: {
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
  };
  readonly damageModifiers: readonly FormulaDefinition[];
  readonly link: { readonly enabled: boolean };
}

export interface HealPayload {
  readonly formula: FormulaDefinition;
  readonly overheal: OverhealPolicy;
}

export interface ApplyContinuousHealPayload {
  readonly formula: FormulaDefinition;
  readonly timing: { readonly eventType: string; readonly targetSelector: string };
  readonly duration: DurationDefinition;
}

/** G-02 (Issue #44): the DAMAGE-direction counterpart of `APPLY_CONTINUOUS_HEAL`. */
export interface ApplyContinuousDamagePayload {
  readonly damageType: DamageType;
  readonly formula: FormulaDefinition;
  readonly timing: { readonly eventType: string; readonly targetSelector: string };
  readonly duration: DurationDefinition;
}

export interface ApplyStatModPayload {
  readonly stat: StatKind;
  readonly valueType: "RATIO" | "FIXED";
  readonly formula: FormulaDefinition;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

export interface ApplyDamageModPayload {
  readonly direction: DamageModDirection;
  readonly damageType: DamageType | null;
  readonly formula: FormulaDefinition;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

/** G-01 (Issue #44): the healing-amount counterpart of `APPLY_DAMAGE_MOD` (no `damageType` — healing isn't typed). */
export interface ApplyHealingModPayload {
  readonly direction: DamageModDirection;
  readonly formula: FormulaDefinition;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

export interface ModifyResourcePayload {
  readonly resource: ResourceKind;
  readonly operation: ResourceModifyOperation;
  readonly formula: FormulaDefinition;
  readonly bounds?: { readonly min: number; readonly max: number | "CURRENT_MAX" };
}

/** G-09 (Issue #44): raises/lowers a resource's maximum, as opposed to `MODIFY_RESOURCE`'s one-off current-value change. */
export interface ModifyResourceCapacityPayload {
  readonly resource: ResourceKind;
  readonly operation: (typeof RESOURCE_CAPACITY_OPERATIONS)[number];
  readonly formula: FormulaDefinition;
  readonly duration: DurationDefinition;
}

/**
 * G-06 (Issue #44): gates `DAMAGE_IMMUNITY` by the size of the incoming hit.
 * The immunity applies only when the incoming raw damage compares true
 * against `formula` via `op` (e.g. `op: GT` with a `CURRENT_HP_RATIO` formula
 * blocks only hits exceeding a fraction of the holder's current HP — a ward
 * against a single big hit, not chip damage).
 */
export interface DamageThreshold {
  readonly op: ComparisonOperator;
  readonly formula: FormulaDefinition;
}

export interface ApplyStatusPayload {
  readonly status: (typeof STATUS_KINDS)[number];
  readonly duration: DurationDefinition;
  readonly probability?: number;
  readonly appliesTo?: { readonly incomingActionKinds: readonly ActionKind[] };
  readonly damageAmplificationOnBreak?: number;
  readonly damageThreshold?: DamageThreshold;
}

export interface EffectImmunityPayload {
  readonly categories: readonly EffectImmunityCategory[];
  readonly effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
  readonly duration: DurationDefinition;
  readonly maxBlocks: number | null;
}

/** G-08 (Issue #44): a damage-absorbing pool separate from HP. */
export interface ApplyShieldPayload {
  readonly formula: FormulaDefinition;
  readonly duration: DurationDefinition;
}

/**
 * G-04 (Issue #44): immediate effect removal (as opposed to `EFFECT_IMMUNITY`,
 * which blocks future applications for a duration). Shares its `categories`
 * enum with `EFFECT_IMMUNITY` for the same reason: "which kinds of effect
 * does this target" is the same taxonomy whether blocking or clearing.
 */
export interface RemoveEffectsPayload {
  readonly categories: readonly EffectImmunityCategory[];
  readonly effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
}

export interface ApplyMarkerPayload {
  readonly markerId: MarkerId;
  readonly stack: { readonly policy: MarkerStackPolicy; readonly max: number | null };
  readonly duration: DurationDefinition;
}

export interface RemoveMarkerPayload {
  readonly markerId: MarkerId;
}

export interface ApplyDeathSurvivalPayload {
  readonly trigger: { readonly lethalDamageOnly: boolean };
  readonly survivalHp: FormulaDefinition;
  readonly healAfterSurvival: FormulaDefinition | null;
  readonly duration: DurationDefinition;
}

export interface ApplyTargetRedirectPayload {
  readonly redirectTo: TargetReference;
  readonly appliesTo: { readonly actionKinds: readonly ActionKind[] };
  readonly duration: DurationDefinition;
}

export interface ApplyCoverPayload {
  readonly coverer: TargetReference;
  readonly damageShareRate: number;
  readonly guardRate: number;
  readonly appliesTo: { readonly actionKinds: readonly ActionKind[] };
  readonly duration: DurationDefinition;
}

export interface ApplyReflectPayload {
  readonly reflectTo: TargetReference;
  readonly formula: FormulaDefinition;
  readonly timing: (typeof REFLECT_TIMINGS)[number];
  readonly allowRecursiveReflect: boolean;
  readonly duration: DurationDefinition;
}

export interface ApplySubunitPayload {
  readonly durability: { readonly formula: FormulaDefinition };
  readonly additionalDamage: { readonly formula: FormulaDefinition };
}

/**
 * Issue #129 `COOLDOWN_MANIPULATION`: resets or reduces another skill's
 * cooldown. `RESET` sets the remaining count to 0; `REDUCE` subtracts
 * `amount` without going below 0. `amount` is required for `REDUCE` and
 * unused for `RESET`.
 */
export interface CooldownManipulationPayload {
  readonly targetSkillDefinitionId: SkillDefinitionId;
  readonly operation: (typeof COOLDOWN_MANIPULATION_OPERATIONS)[number];
  readonly amount?: number;
}
