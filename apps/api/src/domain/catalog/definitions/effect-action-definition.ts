import type { CapabilityId, EffectActionDefinitionId } from "./catalog-ids.js";
import type {
  ApplyContinuousDamagePayload,
  ApplyContinuousHealPayload,
  ApplyCoverPayload,
  ApplyDamageModPayload,
  ApplyDeathSurvivalPayload,
  ApplyHealingModPayload,
  ApplyMarkerPayload,
  ApplyReflectPayload,
  ApplyShieldPayload,
  ApplyStatModPayload,
  ApplyStatusPayload,
  ApplySubunitPayload,
  ApplyTargetRedirectPayload,
  CooldownManipulationPayload,
  DamagePayload,
  EffectImmunityPayload,
  HealPayload,
  ModifyResourceCapacityPayload,
  ModifyResourcePayload,
  RemoveEffectsPayload,
  RemoveMarkerPayload,
} from "./effect-action-payload.js";

/**
 * Kinds documented with a complete payload in `14_Catalog定義スキーマ.md`.
 * `APPLY_HEALING_MOD`, `MODIFY_RESOURCE_CAPACITY`, `APPLY_SHIELD`,
 * `REMOVE_EFFECTS` were unsupported pending payload design; Issue #44
 * (G-01/G-02/G-04/G-08/G-09) adds their payload shapes below.
 * `APPLY_DAMAGE_LINK` remains unsupported — the doc's own "後続設計で具体化
 * する点" still flags Cover/Reflect/DamageLink ordering as open.
 */
export const EFFECT_ACTION_KINDS = [
  "DAMAGE",
  "HEAL",
  "APPLY_CONTINUOUS_HEAL",
  "APPLY_CONTINUOUS_DAMAGE",
  "APPLY_STAT_MOD",
  "APPLY_DAMAGE_MOD",
  "APPLY_HEALING_MOD",
  "MODIFY_RESOURCE",
  "MODIFY_RESOURCE_CAPACITY",
  "APPLY_STATUS",
  "APPLY_SHIELD",
  "REMOVE_EFFECTS",
  "EFFECT_IMMUNITY",
  "APPLY_MARKER",
  "REMOVE_MARKER",
  "APPLY_DEATH_SURVIVAL",
  "APPLY_TARGET_REDIRECT",
  "APPLY_COVER",
  "APPLY_REFLECT",
  "APPLY_SUBUNIT",
  "COOLDOWN_MANIPULATION",
] as const;
export type EffectActionKind = (typeof EFFECT_ACTION_KINDS)[number];

export type EffectActionPayload =
  | { readonly kind: "DAMAGE"; readonly payload: DamagePayload }
  | { readonly kind: "HEAL"; readonly payload: HealPayload }
  | { readonly kind: "APPLY_CONTINUOUS_HEAL"; readonly payload: ApplyContinuousHealPayload }
  | { readonly kind: "APPLY_CONTINUOUS_DAMAGE"; readonly payload: ApplyContinuousDamagePayload }
  | { readonly kind: "APPLY_STAT_MOD"; readonly payload: ApplyStatModPayload }
  | { readonly kind: "APPLY_DAMAGE_MOD"; readonly payload: ApplyDamageModPayload }
  | { readonly kind: "APPLY_HEALING_MOD"; readonly payload: ApplyHealingModPayload }
  | { readonly kind: "MODIFY_RESOURCE"; readonly payload: ModifyResourcePayload }
  | { readonly kind: "MODIFY_RESOURCE_CAPACITY"; readonly payload: ModifyResourceCapacityPayload }
  | { readonly kind: "APPLY_STATUS"; readonly payload: ApplyStatusPayload }
  | { readonly kind: "APPLY_SHIELD"; readonly payload: ApplyShieldPayload }
  | { readonly kind: "REMOVE_EFFECTS"; readonly payload: RemoveEffectsPayload }
  | { readonly kind: "EFFECT_IMMUNITY"; readonly payload: EffectImmunityPayload }
  | { readonly kind: "APPLY_MARKER"; readonly payload: ApplyMarkerPayload }
  | { readonly kind: "REMOVE_MARKER"; readonly payload: RemoveMarkerPayload }
  | { readonly kind: "APPLY_DEATH_SURVIVAL"; readonly payload: ApplyDeathSurvivalPayload }
  | { readonly kind: "APPLY_TARGET_REDIRECT"; readonly payload: ApplyTargetRedirectPayload }
  | { readonly kind: "APPLY_COVER"; readonly payload: ApplyCoverPayload }
  | { readonly kind: "APPLY_REFLECT"; readonly payload: ApplyReflectPayload }
  | { readonly kind: "APPLY_SUBUNIT"; readonly payload: ApplySubunitPayload }
  | { readonly kind: "COOLDOWN_MANIPULATION"; readonly payload: CooldownManipulationPayload };

export type EffectActionDefinition = EffectActionPayload & {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly metadata: { readonly tags: readonly string[] };
};

// ---- input types ----

export interface EffectActionDefinitionInput {
  readonly effectActionDefinitionId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly requiredCapabilities: readonly string[];
  readonly metadata?: { readonly tags?: readonly string[] };
}
