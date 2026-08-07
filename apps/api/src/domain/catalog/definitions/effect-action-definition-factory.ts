import { STAT_KINDS } from "./catalog-enums.js";
import type {
  ActionKind,
  DamageType,
  EffectImmunityCategory,
  ResourceKind,
  ResourceModifyOperation,
} from "./catalog-enums.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  type EffectActionDefinitionId,
} from "./catalog-ids.js";
import {
  COMPARISON_OPERATORS,
  TARGET_STATE_FIELD_TYPES,
  type JsonPrimitive,
} from "./condition-definition.js";
import {
  createDurationDefinition,
  type DurationDefinition,
  type DurationDefinitionInput,
} from "./duration-definition.js";
import {
  EFFECT_ACTION_KINDS,
  type EffectActionDefinition,
  type EffectActionDefinitionInput,
  type EffectActionKind,
  type EffectActionPayload,
} from "./effect-action-definition.js";
import {
  CONTINUOUS_DAMAGE_KINDS,
  COOLDOWN_MANIPULATION_OPERATIONS,
  DAMAGE_MOD_STATE_FIELDS,
  DAMAGE_MOD_UNIT_REFERENCES,
  REFLECT_TIMINGS,
  RESOURCE_CAPACITY_OPERATIONS,
  STAT_MOD_STACKING_MODES,
  STATUS_AILMENT_KINDS,
  STATUS_KINDS,
  type ConfusionDefinition,
  type DamageModConditionDefinition,
  type DamageThreshold,
  type DamageToHealDefinition,
  type ShieldDecayDefinition,
  type StatModStackingMode,
} from "./effect-action-payload.js";
import {
  createFormulaDefinition,
  type FormulaDefinition,
  type FormulaDefinitionInput,
} from "./formula-definition.js";
import { createTargetReference, type TargetReferenceInput } from "./references.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertArray,
  assertBoolean,
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertKnownKeys,
  assertNonEmptyArray,
  assertNullableInteger,
  assertRange,
} from "../../shared/validate.js";

const DAMAGE_TYPES = ["PHYSICAL", "EN"] as const;
/** `ShieldDecayDefinition.owner`は`DurationTimeLimit.owner`と同じ値集合を共有する。 */
const SHIELD_DECAY_OWNERS = ["EFFECT_TARGET", "EFFECT_SOURCE", "BATTLE"] as const;
const CRITICAL_MODES = ["NORMAL", "GUARANTEED", "PREVENTED"] as const;
const ACCURACY_MODES = ["NORMAL", "GUARANTEED"] as const;
const RESOURCE_KINDS = ["AP", "PP", "EX_GAUGE", "HP"] as const;
const RESOURCE_OPERATIONS = ["ADD", "SET", "SET_TO_MAX", "DISTRIBUTE"] as const;
/** Issue #185: `APPLY_RESOURCE_GAIN_MOD`はEXゲージ増加（R-ACT-03）だけを合成対象にする。 */
const RESOURCE_GAIN_MOD_RESOURCE_KINDS = ["EX_GAUGE"] as const;
const STAT_VALUE_TYPES = ["RATIO", "FIXED"] as const;
const STACKING_MODES = ["STACKABLE"] as const;
/**
 * M7-012（Issue #266、R-EFF-05）: `APPLY_STAT_MOD`だけは重複なし
 * （`NON_STACKABLE`）と重複上限（`max`）を宣言できる。他の`stacking`保持kindは
 * 最強選択の合成経路を持たないため`STACKING_MODES`／`STACKING_ALLOWED_KEYS`の
 * ままに留める（`effect-action-payload.ts`の`STAT_MOD_STACKING_MODES`参照）。
 */
const STAT_MOD_STACKING_ALLOWED_KEYS = ["mode", "max"] as const;
const DAMAGE_MOD_DIRECTIONS = ["OUTGOING", "INCOMING"] as const;
const ACTION_KINDS = ["DAMAGE", "DEBUFF", "ANY"] as const;
const EFFECT_IMMUNITY_CATEGORIES = [
  "BUFF",
  "DEBUFF",
  "STATUS",
  "MARKER",
  "DAMAGE_MOD",
  "SHIELD",
  "SUBUNIT",
  "SPECIFIC_EFFECT",
] as const;
/** DMG-007（Issue #187）: `APPLY_DAMAGE_LINK.polarity`。 */
const DAMAGE_LINK_POLARITIES = ["BUFF", "DEBUFF"] as const;
const MARKER_STACK_POLICIES = ["ADD", "KEEP_EXISTING", "REFRESH", "REPLACE"] as const;
const OVERHEAL_POLICIES = ["DISCARD"] as const;
/** HEAL_DISTRIBUTE（M7-005、Issue #184）。`MODIFY_RESOURCE.operation: DISTRIBUTE`のHEAL版。 */
const HEAL_DISTRIBUTION_POLICIES = ["NONE", "EVEN"] as const;

const PAYLOAD_ALLOWED_KEYS: Record<EffectActionKind, readonly string[]> = {
  DAMAGE: [
    "damageType",
    "formula",
    "hitCount",
    "critical",
    "accuracy",
    "piercing",
    "damageModifiers",
    "link",
  ],
  HEAL: ["formula", "overheal", "distribution"],
  APPLY_CONTINUOUS_HEAL: ["formula", "timing", "duration"],
  APPLY_CONTINUOUS_DAMAGE: ["continuousDamageKind", "damageType", "formula", "timing", "duration"],
  APPLY_STAT_MOD: ["stat", "valueType", "formula", "stacking", "duration"],
  APPLY_DAMAGE_MOD: ["direction", "damageType", "formula", "condition", "stacking", "duration"],
  APPLY_PIERCING_MOD: [
    "defenseIgnoreRate",
    "shieldIgnoreRate",
    "damageReductionIgnoreRate",
    "stacking",
    "duration",
  ],
  APPLY_HEALING_MOD: ["direction", "formula", "stacking", "duration"],
  APPLY_HEALING_LINK: ["transferTo", "transferRate", "duration"],
  MODIFY_RESOURCE: ["resource", "operation", "formula", "bounds"],
  MODIFY_RESOURCE_CAPACITY: ["resource", "operation", "formula", "duration"],
  APPLY_STATUS: [
    "status",
    "duration",
    "probability",
    "appliesTo",
    "damageAmplificationOnBreak",
    "damageThreshold",
    "confusion",
    "damageToHeal",
  ],
  APPLY_SHIELD: ["formula", "duration", "shieldType", "decay"],
  REMOVE_EFFECTS: ["categories", "effectActionDefinitionIds", "maxRemovals"],
  EFFECT_IMMUNITY: [
    "categories",
    "effectActionDefinitionIds",
    "statusKinds",
    "duration",
    "maxBlocks",
  ],
  APPLY_MARKER: ["markerId", "stack", "duration"],
  REMOVE_MARKER: ["markerId", "count"],
  APPLY_DEATH_SURVIVAL: ["trigger", "survivalHp", "healAfterSurvival", "duration"],
  APPLY_TARGET_REDIRECT: ["redirectTo", "appliesTo", "duration"],
  APPLY_COVER: ["coverer", "damageShareRate", "guardRate", "appliesTo", "duration"],
  APPLY_REFLECT: ["reflectTo", "formula", "timing", "allowRecursiveReflect", "duration"],
  APPLY_DAMAGE_LINK: ["linkTo", "linkRate", "polarity", "duration"],
  APPLY_SUBUNIT: ["durability", "additionalDamage", "duration"],
  COOLDOWN_MANIPULATION: ["targetSkillDefinitionId", "operation", "amount"],
  APPLY_ATTACK_DAMAGE_BONUS: ["formula", "duration"],
  APPLY_RESOURCE_GAIN_MOD: ["resource", "rateDelta", "stacking", "duration"],
};

const DAMAGE_CRITICAL_ALLOWED_KEYS = ["mode"] as const;
const DAMAGE_ACCURACY_ALLOWED_KEYS = ["mode"] as const;
const DAMAGE_PIERCING_ALLOWED_KEYS = [
  "defenseIgnoreRate",
  "shieldIgnoreRate",
  "damageReductionIgnoreRate",
] as const;
const LINK_ALLOWED_KEYS = ["enabled"] as const;
const TIMING_ALLOWED_KEYS = ["eventType", "targetSelector"] as const;
const STACKING_ALLOWED_KEYS = ["mode"] as const;
const BOUNDS_ALLOWED_KEYS = ["min", "max"] as const;
const APPLIES_TO_ACTION_KINDS_ALLOWED_KEYS = ["actionKinds"] as const;
const APPLIES_TO_INCOMING_ACTION_KINDS_ALLOWED_KEYS = ["incomingActionKinds"] as const;
const STACK_ALLOWED_KEYS = ["policy", "max"] as const;
const TRIGGER_LETHAL_ALLOWED_KEYS = ["lethalDamageOnly"] as const;
const SUBUNIT_FORMULA_HOLDER_ALLOWED_KEYS = ["formula"] as const;
/**
 * DMG-005（Issue #190、R-SUB-02）: `additionalDamage`だけは`formula`のほかに
 * 自身のダメージタイプと追加デバフ参照を持てる（`durability`は`formula`のまま）。
 */
const SUBUNIT_ADDITIONAL_DAMAGE_ALLOWED_KEYS = ["formula", "damageType", "debuff"] as const;
const SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF_ALLOWED_KEYS = ["effectActionDefinitionId"] as const;
const DAMAGE_THRESHOLD_ALLOWED_KEYS = ["op", "formula"] as const;
/** R-CFS-02（DMG-009、Issue #193）: `APPLY_STATUS.confusion`が持てるfield。 */
const CONFUSION_ALLOWED_KEYS = ["damageReductionRate", "lowAttackBaseDamageRate"] as const;
/** R-DTH-01（DMG-009、Issue #193）: `APPLY_STATUS.damageToHeal`が持てるfield。 */
const DAMAGE_TO_HEAL_ALLOWED_KEYS = ["healRate"] as const;

function requireField<T>(value: T | undefined, path: string): T {
  if (value === undefined) {
    throw new DomainValidationError(path, "is required");
  }
  return value;
}

function requireRate(value: number | undefined, path: string): number {
  const v = requireField(value, path);
  assertFinite(v, path);
  if (v < 0 || v > 1) {
    throw new DomainValidationError(path, `must be within [0, 1], got ${v}`);
  }
  return v;
}

function createFormulaField(
  payload: Record<string, unknown>,
  key: string,
  path: string,
): FormulaDefinition {
  const value = payload[key] as FormulaDefinitionInput | undefined;
  return createFormulaDefinition(
    requireField(value, `${path}.${key}`),
    `${path}.${key}`,
    undefined,
  );
}

function createDurationField(payload: Record<string, unknown>, path: string): DurationDefinition {
  const value = payload["duration"] as DurationDefinitionInput | undefined;
  return createDurationDefinition(
    requireField(value, `${path}.duration`),
    `${path}.duration`,
    undefined,
  );
}

const DAMAGE_MOD_CONDITION_KINDS = [
  "TRUE",
  "AND",
  "OR",
  "NOT",
  "UNIT_STATE",
  "UNIT_HAS_MARKER",
  "HP_RATIO_COMPARISON",
] as const;

const DAMAGE_MOD_CONDITION_ALLOWED_KEYS: Record<
  (typeof DAMAGE_MOD_CONDITION_KINDS)[number],
  readonly string[]
> = {
  TRUE: ["kind"],
  AND: ["kind", "conditions"],
  OR: ["kind", "conditions"],
  NOT: ["kind", "condition"],
  UNIT_STATE: ["kind", "unit", "field", "op", "value"],
  UNIT_HAS_MARKER: ["kind", "unit", "markerId", "countCondition"],
  HP_RATIO_COMPARISON: ["kind", "left", "op", "right"],
};

const MARKER_COUNT_CONDITION_ALLOWED_KEYS = ["op", "value"] as const;

const SHIELD_DECAY_ALLOWED_KEYS = ["unit", "ratio", "owner"] as const;
const SHIELD_DECAY_UNITS = ["ACTION"] as const;

/**
 * `SHIELD_DECAY_OVER_TIME`（DMG-004、Issue #194、R-SHD-01）: `APPLY_SHIELD.decay`を
 * 検証して`ShieldDecayDefinition`へ写す。`unit`は`ACTION`だけを許可し、`ratio`は
 * 「付与時最大値に対する1行動あたりの減少割合」として`0 < ratio <= 1`へ制限する
 * （0は漸減しないことと区別できず、1超は最大値以上を1回で削るため意味を持たない）。
 * `owner`は`DurationTimeLimit.owner`と同じ値集合・同じ既定を共有する。
 */
function createShieldDecay(input: unknown, path: string): ShieldDecayDefinition {
  const raw = requireField(input as Record<string, unknown> | undefined, path);
  assertKnownKeys(raw, SHIELD_DECAY_ALLOWED_KEYS, path);
  const unit = requireField(raw["unit"] as string | undefined, `${path}.unit`);
  assertEnumValue(unit, SHIELD_DECAY_UNITS, `${path}.unit`);
  const ratio = requireField(raw["ratio"] as number | undefined, `${path}.ratio`);
  assertRange(ratio, `${path}.ratio`, { min: 0, max: 1 });
  if (ratio === 0) {
    throw new DomainValidationError(`${path}.ratio`, "must be greater than 0");
  }
  const owner = raw["owner"] as string | undefined;
  if (owner !== undefined) {
    assertEnumValue(owner, SHIELD_DECAY_OWNERS, `${path}.owner`);
  }
  return { unit, ratio, ...(owner !== undefined ? { owner } : {}) };
}

/**
 * `DYNAMIC_DAMAGE_MOD_CONDITION`（DMG-002、Issue #192）: `APPLY_DAMAGE_MOD.condition`を
 * 検証して`DamageModConditionDefinition`へ写す。`ConditionDefinition`（EffectStep用）と
 * 語彙は近いが、参照できるユニットが「補正の保持者」と「そのヒットの相手」の2体だけに
 * 限られる点が異なる（`effect-action-payload.ts`の`DAMAGE_MOD_UNIT_REFERENCES`）。
 * `UNIT_STATE.field`も、ダメージ解決時点でCatalogの`unitDefinitions`を引けないため
 * `DAMAGE_MOD_STATE_FIELDS`（`UNIT_TYPE`/`ROLE`/`HAS_STATUS`を除く部分集合）へ絞る。
 */
function createDamageModCondition(
  input: Record<string, unknown>,
  path: string,
): DamageModConditionDefinition {
  const kind = requireField(input["kind"] as string | undefined, `${path}.kind`);
  assertEnumValue(kind, DAMAGE_MOD_CONDITION_KINDS, `${path}.kind`);
  assertKnownKeys(input, DAMAGE_MOD_CONDITION_ALLOWED_KEYS[kind], path);

  switch (kind) {
    case "TRUE":
      return { kind: "TRUE" };
    case "AND":
    case "OR": {
      const conditions = requireField(
        input["conditions"] as readonly Record<string, unknown>[] | undefined,
        `${path}.conditions`,
      );
      assertNonEmptyArray(conditions, `${path}.conditions`);
      return {
        kind,
        conditions: conditions.map((child, i) =>
          createDamageModCondition(child, `${path}.conditions[${i}]`),
        ),
      };
    }
    case "NOT":
      return {
        kind: "NOT",
        condition: createDamageModCondition(
          requireField(
            input["condition"] as Record<string, unknown> | undefined,
            `${path}.condition`,
          ),
          `${path}.condition`,
        ),
      };
    case "UNIT_STATE": {
      const unit = requireField(input["unit"] as string | undefined, `${path}.unit`);
      assertEnumValue(unit, DAMAGE_MOD_UNIT_REFERENCES, `${path}.unit`);
      const field = requireField(input["field"] as string | undefined, `${path}.field`);
      assertEnumValue(field, DAMAGE_MOD_STATE_FIELDS, `${path}.field`);
      const op = requireField(input["op"] as string | undefined, `${path}.op`);
      assertEnumValue(op, COMPARISON_OPERATORS, `${path}.op`);
      const value = requireField(input["value"] as JsonPrimitive | undefined, `${path}.value`);
      const expectedType = TARGET_STATE_FIELD_TYPES[field];
      if (typeof value !== expectedType) {
        throw new DomainValidationError(
          `${path}.value`,
          `must be of type ${expectedType} for field "${field}", got ${typeof value}`,
        );
      }
      return { kind: "UNIT_STATE", unit, field, op, value };
    }
    case "UNIT_HAS_MARKER": {
      const unit = requireField(input["unit"] as string | undefined, `${path}.unit`);
      assertEnumValue(unit, DAMAGE_MOD_UNIT_REFERENCES, `${path}.unit`);
      const markerId = createMarkerId(
        requireField(input["markerId"] as string | undefined, `${path}.markerId`),
        `${path}.markerId`,
      );
      const countCondition = input["countCondition"] as
        | { readonly op: string; readonly value: number }
        | undefined;
      if (countCondition === undefined) {
        return { kind: "UNIT_HAS_MARKER", unit, markerId };
      }
      assertKnownKeys(
        countCondition,
        MARKER_COUNT_CONDITION_ALLOWED_KEYS,
        `${path}.countCondition`,
      );
      assertEnumValue(countCondition.op, COMPARISON_OPERATORS, `${path}.countCondition.op`);
      assertFinite(countCondition.value, `${path}.countCondition.value`);
      return {
        kind: "UNIT_HAS_MARKER",
        unit,
        markerId,
        countCondition: { op: countCondition.op, value: countCondition.value },
      };
    }
    case "HP_RATIO_COMPARISON": {
      const left = requireField(input["left"] as string | undefined, `${path}.left`);
      assertEnumValue(left, DAMAGE_MOD_UNIT_REFERENCES, `${path}.left`);
      const right = requireField(input["right"] as string | undefined, `${path}.right`);
      assertEnumValue(right, DAMAGE_MOD_UNIT_REFERENCES, `${path}.right`);
      const op = requireField(input["op"] as string | undefined, `${path}.op`);
      assertEnumValue(op, COMPARISON_OPERATORS, `${path}.op`);
      return { kind: "HP_RATIO_COMPARISON", left, op, right };
    }
  }
}

function createActionKinds(
  value: readonly string[] | undefined,
  path: string,
): readonly ActionKind[] {
  assertNonEmptyArray(value ?? [], path);
  for (const [i, kind] of (value ?? []).entries()) {
    assertEnumValue(kind, ACTION_KINDS, `${path}[${i}]`);
  }
  return (value ?? []) as readonly ActionKind[];
}

function requireStackingMode(payload: Record<string, unknown>, path: string): "STACKABLE" {
  const stacking = requireField(
    payload["stacking"] as { mode?: string } | undefined,
    `${path}.stacking`,
  );
  assertKnownKeys(stacking, STACKING_ALLOWED_KEYS, `${path}.stacking`);
  const mode = requireField(stacking.mode, `${path}.stacking.mode`);
  assertEnumValue(mode, STACKING_MODES, `${path}.stacking.mode`);
  return mode;
}

/**
 * M7-012（Issue #266、R-EFF-05／`STACK_LIMIT_ON_STAT_MOD`）: `APPLY_STAT_MOD`の
 * `stacking`。`mode`は重複なし（`NON_STACKABLE`）も取り、`max`は重複上限
 * （省略・`null`で上限なし）を表す。`APPLY_MARKER.stack.max`と同じ検証
 * （1以上の整数、または`null`）にする。
 */
function requireStatModStacking(
  payload: Record<string, unknown>,
  path: string,
): { readonly mode: StatModStackingMode; readonly max: number | null } {
  const stacking = requireField(
    payload["stacking"] as { mode?: string; max?: number | null } | undefined,
    `${path}.stacking`,
  );
  assertKnownKeys(stacking, STAT_MOD_STACKING_ALLOWED_KEYS, `${path}.stacking`);
  const mode = requireField(stacking.mode, `${path}.stacking.mode`);
  assertEnumValue(mode, STAT_MOD_STACKING_MODES, `${path}.stacking.mode`);
  if (stacking.max !== undefined) {
    assertNullableInteger(stacking.max, `${path}.stacking.max`, { min: 1 });
  }
  return { mode, max: stacking.max ?? null };
}

function createAppliesTo(
  payload: Record<string, unknown>,
  path: string,
): { readonly actionKinds: readonly ActionKind[] } {
  const appliesTo = payload["appliesTo"] as { actionKinds?: readonly string[] } | undefined;
  const appliesToObj = requireField(appliesTo, `${path}.appliesTo`);
  assertKnownKeys(appliesToObj, APPLIES_TO_ACTION_KINDS_ALLOWED_KEYS, `${path}.appliesTo`);
  return {
    actionKinds: createActionKinds(appliesToObj.actionKinds, `${path}.appliesTo.actionKinds`),
  };
}

export function createEffectActionDefinition(
  input: EffectActionDefinitionInput,
  path: string,
): EffectActionDefinition {
  const effectActionDefinitionId = createEffectActionDefinitionId(
    input.effectActionDefinitionId,
    `${path}.effectActionDefinitionId`,
  );
  assertEnumValue(input.kind, EFFECT_ACTION_KINDS, `${path}.kind`);

  const payloadPath = `${path}.payload`;
  const payload = input.payload;
  const shape = createPayload(input.kind, payload, payloadPath);

  const tags = input.metadata?.tags ?? [];

  return deepFreeze({
    ...shape,
    effectActionDefinitionId,
    metadata: { tags },
  });
}

function createPayload(
  kind: EffectActionKind,
  payload: Record<string, unknown>,
  path: string,
): EffectActionPayload {
  assertKnownKeys(payload, PAYLOAD_ALLOWED_KEYS[kind], path);
  switch (kind) {
    case "DAMAGE": {
      const damageType = requireField(
        payload["damageType"] as string | undefined,
        `${path}.damageType`,
      );
      assertEnumValue(damageType, DAMAGE_TYPES, `${path}.damageType`);
      const hitCount = (payload["hitCount"] as number | undefined) ?? 1;
      assertInteger(hitCount, `${path}.hitCount`, { min: 1 });
      const criticalRaw = payload["critical"] as { mode?: string } | undefined;
      if (criticalRaw !== undefined) {
        assertKnownKeys(criticalRaw, DAMAGE_CRITICAL_ALLOWED_KEYS, `${path}.critical`);
      }
      const criticalMode = criticalRaw?.mode ?? "NORMAL";
      assertEnumValue(criticalMode, CRITICAL_MODES, `${path}.critical.mode`);
      const accuracyRaw = payload["accuracy"] as { mode?: string } | undefined;
      if (accuracyRaw !== undefined) {
        assertKnownKeys(accuracyRaw, DAMAGE_ACCURACY_ALLOWED_KEYS, `${path}.accuracy`);
      }
      const accuracyMode = accuracyRaw?.mode ?? "NORMAL";
      assertEnumValue(accuracyMode, ACCURACY_MODES, `${path}.accuracy.mode`);
      const piercingRaw = payload["piercing"] as
        | {
            defenseIgnoreRate?: number;
            shieldIgnoreRate?: number;
            damageReductionIgnoreRate?: number;
          }
        | undefined;
      if (piercingRaw !== undefined) {
        assertKnownKeys(piercingRaw, DAMAGE_PIERCING_ALLOWED_KEYS, `${path}.piercing`);
      }
      const piercing = piercingRaw ?? {};
      const defenseIgnoreRate = piercing.defenseIgnoreRate ?? 0;
      const shieldIgnoreRate = piercing.shieldIgnoreRate ?? 0;
      const damageReductionIgnoreRate = piercing.damageReductionIgnoreRate ?? 0;
      for (const [key, value] of Object.entries({
        defenseIgnoreRate,
        shieldIgnoreRate,
        damageReductionIgnoreRate,
      })) {
        assertFinite(value, `${path}.piercing.${key}`);
        if (value < 0 || value > 1) {
          throw new DomainValidationError(
            `${path}.piercing.${key}`,
            `must be within [0, 1], got ${value}`,
          );
        }
      }
      const damageModifiersRaw = payload["damageModifiers"];
      if (damageModifiersRaw !== undefined) {
        assertArray(damageModifiersRaw, `${path}.damageModifiers`);
      }
      const damageModifiersInput =
        (damageModifiersRaw as readonly FormulaDefinitionInput[] | undefined) ?? [];
      const linkRaw = payload["link"] as { enabled?: unknown } | undefined;
      if (linkRaw !== undefined) {
        assertKnownKeys(linkRaw, LINK_ALLOWED_KEYS, `${path}.link`);
      }
      let linkEnabled = false;
      if (linkRaw?.enabled !== undefined) {
        assertBoolean(linkRaw.enabled, `${path}.link.enabled`);
        linkEnabled = linkRaw.enabled;
      }
      return {
        kind: "DAMAGE",
        payload: {
          damageType,
          formula: createFormulaField(payload, "formula", path),
          hitCount,
          critical: { mode: criticalMode },
          accuracy: { mode: accuracyMode },
          piercing: { defenseIgnoreRate, shieldIgnoreRate, damageReductionIgnoreRate },
          damageModifiers: damageModifiersInput.map((f, i) =>
            createFormulaDefinition(f, `${path}.damageModifiers[${i}]`, undefined),
          ),
          link: { enabled: linkEnabled },
        },
      };
    }
    case "HEAL": {
      const overheal = (payload["overheal"] as string | undefined) ?? "DISCARD";
      assertEnumValue(overheal, OVERHEAL_POLICIES, `${path}.overheal`);
      // HEAL_DISTRIBUTE（M7-005、Issue #184）: 省略時は既定の`NONE`（対象ごとに
      // Formula評価結果全量を回復する、本fieldが存在しなかった時点の動作）。
      const distribution = (payload["distribution"] as string | undefined) ?? "NONE";
      assertEnumValue(distribution, HEAL_DISTRIBUTION_POLICIES, `${path}.distribution`);
      return {
        kind: "HEAL",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          overheal,
          distribution,
        },
      };
    }
    case "APPLY_CONTINUOUS_HEAL": {
      const timing = requireField(
        payload["timing"] as { eventType?: string; targetSelector?: string } | undefined,
        `${path}.timing`,
      );
      assertKnownKeys(timing, TIMING_ALLOWED_KEYS, `${path}.timing`);
      const eventType = requireField(timing.eventType, `${path}.timing.eventType`);
      const targetSelector = requireField(timing.targetSelector, `${path}.timing.targetSelector`);
      return {
        kind: "APPLY_CONTINUOUS_HEAL",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          timing: { eventType, targetSelector },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_CONTINUOUS_DAMAGE": {
      // R-DOT-02〜04（DMG-008、Issue #189）: 固定継続ダメージ／炎上／毒は算出式も
      // 重複規則もシールド適用可否も異なるため、種別を必須fieldとして受け取る。
      const continuousDamageKind = requireField(
        payload["continuousDamageKind"] as string | undefined,
        `${path}.continuousDamageKind`,
      );
      assertEnumValue(
        continuousDamageKind,
        CONTINUOUS_DAMAGE_KINDS,
        `${path}.continuousDamageKind`,
      );
      const damageType = requireField(
        payload["damageType"] as string | undefined,
        `${path}.damageType`,
      );
      assertEnumValue(damageType, DAMAGE_TYPES, `${path}.damageType`);
      const timing = requireField(
        payload["timing"] as { eventType?: string; targetSelector?: string } | undefined,
        `${path}.timing`,
      );
      assertKnownKeys(timing, TIMING_ALLOWED_KEYS, `${path}.timing`);
      const eventType = requireField(timing.eventType, `${path}.timing.eventType`);
      const targetSelector = requireField(timing.targetSelector, `${path}.timing.targetSelector`);
      return {
        kind: "APPLY_CONTINUOUS_DAMAGE",
        payload: {
          continuousDamageKind,
          damageType,
          formula: createFormulaField(payload, "formula", path),
          timing: { eventType, targetSelector },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_STAT_MOD": {
      const stat = requireField(payload["stat"] as string | undefined, `${path}.stat`);
      assertEnumValue(stat, STAT_KINDS, `${path}.stat`);
      const valueType = requireField(
        payload["valueType"] as string | undefined,
        `${path}.valueType`,
      );
      assertEnumValue(valueType, STAT_VALUE_TYPES, `${path}.valueType`);
      // `stacking`は`formula`より先に検証する（`requireStackingMode`を呼んで
      // いた時点と同じ順序 — 不正な定義がどのフィールドのエラーを報告するかを
      // 変えないため）。
      const stacking = requireStatModStacking(payload, path);
      return {
        kind: "APPLY_STAT_MOD",
        payload: {
          stat,
          valueType,
          formula: createFormulaField(payload, "formula", path),
          stacking,
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_DAMAGE_MOD": {
      const direction = requireField(
        payload["direction"] as string | undefined,
        `${path}.direction`,
      );
      assertEnumValue(direction, DAMAGE_MOD_DIRECTIONS, `${path}.direction`);
      const damageTypeRaw = payload["damageType"] as string | null | undefined;
      let damageType: DamageType | null = null;
      if (damageTypeRaw !== undefined && damageTypeRaw !== null) {
        assertEnumValue(damageTypeRaw, DAMAGE_TYPES, `${path}.damageType`);
        damageType = damageTypeRaw;
      }
      const stackingMode = requireStackingMode(payload, path);
      const conditionInput = payload["condition"] as Record<string, unknown> | undefined;
      return {
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction,
          damageType,
          formula: createFormulaField(payload, "formula", path),
          ...(conditionInput !== undefined
            ? { condition: createDamageModCondition(conditionInput, `${path}.condition`) }
            : {}),
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_PIERCING_MOD": {
      // `TEMP_PIERCING_GRANT`（DMG-003、Issue #196）: 3つの率は
      // `DamagePayload.piercing`と同じ意味・同じ定義域（R-DMG-03の[0, 1]）を持ち、
      // 省略時は0。`DAMAGE`側は`payload.piercing`というネストだが、こちらは
      // EffectAction自身が貫通付与そのものであるためpayload直下に置く。
      const stackingMode = requireStackingMode(payload, path);
      const rates = {
        defenseIgnoreRate: (payload["defenseIgnoreRate"] as number | undefined) ?? 0,
        shieldIgnoreRate: (payload["shieldIgnoreRate"] as number | undefined) ?? 0,
        damageReductionIgnoreRate:
          (payload["damageReductionIgnoreRate"] as number | undefined) ?? 0,
      };
      for (const [key, value] of Object.entries(rates)) {
        assertFinite(value, `${path}.${key}`);
        if (value < 0 || value > 1) {
          throw new DomainValidationError(`${path}.${key}`, `must be within [0, 1], got ${value}`);
        }
      }
      // 3つとも0の定義は何も無視しないno-opであり、付与しても実行時に一切
      // 観測できない（`CAP_PARTIAL_PIERCING`の silent partial implementation）。
      if (Object.values(rates).every((value) => value === 0)) {
        throw new DomainValidationError(
          path,
          "must ignore something: at least one of defenseIgnoreRate/shieldIgnoreRate/damageReductionIgnoreRate must be greater than 0",
        );
      }
      return {
        kind: "APPLY_PIERCING_MOD",
        payload: {
          ...rates,
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_HEALING_MOD": {
      const direction = requireField(
        payload["direction"] as string | undefined,
        `${path}.direction`,
      );
      assertEnumValue(direction, DAMAGE_MOD_DIRECTIONS, `${path}.direction`);
      const stackingMode = requireStackingMode(payload, path);
      return {
        kind: "APPLY_HEALING_MOD",
        payload: {
          direction,
          formula: createFormulaField(payload, "formula", path),
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_HEALING_LINK": {
      // R-HEAL-04（M7-005-HEAL-LINK、Issue #229）: 転送先は既定を持たないため必須。
      // `transferTo`のkindごとの実装範囲（現時点は`SELF`のみ）はCatalog整合性検証
      // （`UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET`）が担う — Factoryは
      // `APPLY_TARGET_REDIRECT`/`APPLY_COVER`と同じく形式検証だけを行う。
      const transferTo = requireField(
        payload["transferTo"] as TargetReferenceInput | undefined,
        `${path}.transferTo`,
      );
      return {
        kind: "APPLY_HEALING_LINK",
        payload: {
          transferTo: createTargetReference(transferTo, `${path}.transferTo`, undefined),
          transferRate: requireRate(
            payload["transferRate"] as number | undefined,
            `${path}.transferRate`,
          ),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "MODIFY_RESOURCE": {
      const resource = requireField(payload["resource"] as string | undefined, `${path}.resource`);
      assertEnumValue(resource, RESOURCE_KINDS, `${path}.resource`);
      const operation = requireField(
        payload["operation"] as string | undefined,
        `${path}.operation`,
      );
      assertEnumValue(operation, RESOURCE_OPERATIONS, `${path}.operation`);
      const boundsInput = payload["bounds"] as
        | { min?: number; max?: number | "CURRENT_MAX" }
        | undefined;
      const result: {
        resource: ResourceKind;
        operation: ResourceModifyOperation;
        formula: FormulaDefinition;
        bounds?: { min: number; max: number | "CURRENT_MAX" };
      } = {
        resource,
        operation,
        formula: createFormulaField(payload, "formula", path),
      };
      if (boundsInput !== undefined) {
        assertKnownKeys(boundsInput, BOUNDS_ALLOWED_KEYS, `${path}.bounds`);
        const min = requireField(boundsInput.min, `${path}.bounds.min`);
        assertFinite(min, `${path}.bounds.min`);
        const max = requireField(boundsInput.max, `${path}.bounds.max`);
        if (max !== "CURRENT_MAX") {
          assertFinite(max, `${path}.bounds.max`);
        }
        result.bounds = { min, max };
      }
      return { kind: "MODIFY_RESOURCE", payload: result };
    }
    case "MODIFY_RESOURCE_CAPACITY": {
      const resource = requireField(payload["resource"] as string | undefined, `${path}.resource`);
      assertEnumValue(resource, RESOURCE_KINDS, `${path}.resource`);
      const operation = requireField(
        payload["operation"] as string | undefined,
        `${path}.operation`,
      );
      assertEnumValue(operation, RESOURCE_CAPACITY_OPERATIONS, `${path}.operation`);
      return {
        kind: "MODIFY_RESOURCE_CAPACITY",
        payload: {
          resource,
          operation,
          formula: createFormulaField(payload, "formula", path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_STATUS": {
      const status = requireField(payload["status"] as string | undefined, `${path}.status`);
      assertEnumValue(status, STATUS_KINDS, `${path}.status`);
      const result: {
        status: (typeof STATUS_KINDS)[number];
        duration: DurationDefinition;
        probability?: number;
        appliesTo?: { incomingActionKinds: readonly ActionKind[] };
        damageAmplificationOnBreak?: number;
        damageThreshold?: DamageThreshold;
        confusion?: ConfusionDefinition;
        damageToHeal?: DamageToHealDefinition;
      } = {
        status,
        duration: createDurationField(payload, path),
      };
      const probability = payload["probability"] as number | undefined;
      if (probability !== undefined) {
        assertFinite(probability, `${path}.probability`);
        if (probability < 0 || probability > 1) {
          throw new DomainValidationError(
            `${path}.probability`,
            `must be within [0, 1], got ${probability}`,
          );
        }
        result.probability = probability;
      }
      const appliesTo = payload["appliesTo"] as
        | { incomingActionKinds?: readonly string[] }
        | undefined;
      if (appliesTo !== undefined) {
        assertKnownKeys(
          appliesTo,
          APPLIES_TO_INCOMING_ACTION_KINDS_ALLOWED_KEYS,
          `${path}.appliesTo`,
        );
        result.appliesTo = {
          incomingActionKinds: createActionKinds(
            appliesTo.incomingActionKinds,
            `${path}.appliesTo.incomingActionKinds`,
          ),
        };
      }
      const damageAmplificationOnBreak = payload["damageAmplificationOnBreak"] as
        | number
        | undefined;
      if (damageAmplificationOnBreak !== undefined) {
        assertFinite(damageAmplificationOnBreak, `${path}.damageAmplificationOnBreak`);
        result.damageAmplificationOnBreak = damageAmplificationOnBreak;
      }
      const damageThresholdRaw = payload["damageThreshold"] as
        | { op?: string; formula?: FormulaDefinitionInput }
        | undefined;
      if (damageThresholdRaw !== undefined) {
        if (status !== "DAMAGE_IMMUNITY") {
          throw new DomainValidationError(
            `${path}.damageThreshold`,
            `is only meaningful when status is "DAMAGE_IMMUNITY", got "${status}"`,
          );
        }
        assertKnownKeys(
          damageThresholdRaw,
          DAMAGE_THRESHOLD_ALLOWED_KEYS,
          `${path}.damageThreshold`,
        );
        const op = requireField(damageThresholdRaw.op, `${path}.damageThreshold.op`);
        assertEnumValue(op, COMPARISON_OPERATORS, `${path}.damageThreshold.op`);
        result.damageThreshold = {
          op,
          formula: createFormulaField(damageThresholdRaw, "formula", `${path}.damageThreshold`),
        };
      }
      // R-CFS-02／R-DTH-01（DMG-009、Issue #193）: 混乱・幻惑の数値は、その状態
      // でしか意味を持たない。`damageThreshold`が`DAMAGE_IMMUNITY`以外を拒否する
      // のと同じ理由で、宣言先のstatusと1対1に固定する — 別のstatusへ書いても
      // 実行時に一切参照されず、silent no-opになるためである。逆に、対応する
      // statusで宣言を省略すると「混乱しているのにダメージが変わらない」近似へ
      // 退行するため、既定値でfallbackせず必須にする。
      const confusionRaw = payload["confusion"] as
        | { damageReductionRate?: number; lowAttackBaseDamageRate?: number }
        | undefined;
      if (confusionRaw !== undefined && status !== "CONFUSION") {
        throw new DomainValidationError(
          `${path}.confusion`,
          `is only meaningful when status is "CONFUSION", got "${status}"`,
        );
      }
      if (status === "CONFUSION") {
        const raw = requireField(confusionRaw, `${path}.confusion`);
        assertKnownKeys(raw, CONFUSION_ALLOWED_KEYS, `${path}.confusion`);
        result.confusion = {
          damageReductionRate: requireRate(
            raw.damageReductionRate,
            `${path}.confusion.damageReductionRate`,
          ),
          lowAttackBaseDamageRate: requireRate(
            raw.lowAttackBaseDamageRate,
            `${path}.confusion.lowAttackBaseDamageRate`,
          ),
        };
      }
      const damageToHealRaw = payload["damageToHeal"] as { healRate?: number } | undefined;
      if (damageToHealRaw !== undefined && status !== "DAMAGE_TO_HEAL") {
        throw new DomainValidationError(
          `${path}.damageToHeal`,
          `is only meaningful when status is "DAMAGE_TO_HEAL", got "${status}"`,
        );
      }
      if (status === "DAMAGE_TO_HEAL") {
        const raw = requireField(damageToHealRaw, `${path}.damageToHeal`);
        assertKnownKeys(raw, DAMAGE_TO_HEAL_ALLOWED_KEYS, `${path}.damageToHeal`);
        const healRate = requireField(raw.healRate, `${path}.damageToHeal.healRate`);
        assertFinite(healRate, `${path}.damageToHeal.healRate`);
        if (healRate < 0) {
          throw new DomainValidationError(
            `${path}.damageToHeal.healRate`,
            `must not be negative, got ${healRate}`,
          );
        }
        result.damageToHeal = { healRate };
      }
      return { kind: "APPLY_STATUS", payload: result };
    }
    case "APPLY_SHIELD": {
      // DMG-004（Issue #194、R-SHD-01）: `shieldType`省略時はタイプなしシールド
      // （`ApplyShieldPayload.shieldType`のコメント参照）。
      const shieldTypeRaw = payload["shieldType"] as string | undefined;
      if (shieldTypeRaw !== undefined) {
        assertEnumValue(shieldTypeRaw, DAMAGE_TYPES, `${path}.shieldType`);
      }
      return {
        kind: "APPLY_SHIELD",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          duration: createDurationField(payload, path),
          ...(shieldTypeRaw !== undefined ? { shieldType: shieldTypeRaw } : {}),
          ...(payload["decay"] !== undefined
            ? { decay: createShieldDecay(payload["decay"], `${path}.decay`) }
            : {}),
        },
      };
    }
    case "REMOVE_EFFECTS": {
      const categories = payload["categories"] as readonly string[] | undefined;
      assertNonEmptyArray(categories ?? [], `${path}.categories`);
      for (const [i, category] of (categories ?? []).entries()) {
        assertEnumValue(category, EFFECT_IMMUNITY_CATEGORIES, `${path}.categories[${i}]`);
        // M7-001（Issue #181）: `MARKER`は`REMOVE_EFFECTS`（AppliedEffect
        // だけを走査する）では解除できず黙ってno-opになるため、Catalogロード時点で
        // 拒否する。Markerの解除は`REMOVE_MARKER`（`markerId`指定）を使う。
        if (category === "MARKER") {
          throw new DomainValidationError(
            `${path}.categories[${i}]`,
            'REMOVE_EFFECTS does not support the "MARKER" category — use REMOVE_MARKER (markerId) for marker removal',
          );
        }
        // M7-001A（Issue #242、`REMOVE_EFFECTS_CATEGORY_GAP`）: SHIELD/SUBUNITは
        // DMG-004（`CAP_SHIELD`）/DMG-005（`CAP_SUBUNIT`）が実行時状態
        // （`AppliedEffect.shield`/`AppliedEffect.subUnit`）を持つようになったため、
        // 他のカテゴリと同じく無条件で受理する（`effect-action-group-resolver.ts`の
        // REMOVE_EFFECTS branchが`effect-removal-service.ts`へそのまま渡す）。
        // `catalog-integrity.ts`は引き続き対応する`CAP_SHIELD`/`CAP_SUBUNIT`宣言を
        // 必須にする — 解除対象の実行時状態を持つCapabilityへの依存自体は残るためで、
        // 未実装へ差し戻された場合に`SimulationPreflightValidator`が選択時
        // `UNSUPPORTED_RULE`として拒否できる形を保つ。
      }
      const typedCategories = (categories ?? []) as readonly EffectImmunityCategory[];
      const result: {
        categories: readonly EffectImmunityCategory[];
        effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
        maxRemovals?: number;
      } = { categories: typedCategories };
      // M7-001（Issue #181、REMOVE_EFFECTS_COUNT_LIMIT）: 解除件数の上限。
      const maxRemovals = payload["maxRemovals"];
      if (maxRemovals !== undefined) {
        if (typeof maxRemovals !== "number") {
          throw new DomainValidationError(
            `${path}.maxRemovals`,
            `must be a positive integer, got ${typeof maxRemovals}`,
          );
        }
        assertInteger(maxRemovals, `${path}.maxRemovals`, { min: 1 });
        result.maxRemovals = maxRemovals;
      }
      if (typedCategories.includes("SPECIFIC_EFFECT")) {
        const ids = payload["effectActionDefinitionIds"] as readonly string[] | undefined;
        assertNonEmptyArray(ids ?? [], `${path}.effectActionDefinitionIds`);
        result.effectActionDefinitionIds = (ids ?? []).map((id, i) =>
          createEffectActionDefinitionId(id, `${path}.effectActionDefinitionIds[${i}]`),
        );
        return { kind: "REMOVE_EFFECTS", payload: result };
      }
      if (payload["effectActionDefinitionIds"] !== undefined) {
        throw new DomainValidationError(
          `${path}.effectActionDefinitionIds`,
          'must not be set when "categories" does not include "SPECIFIC_EFFECT" (it would otherwise be silently ignored)',
        );
      }
      return { kind: "REMOVE_EFFECTS", payload: result };
    }
    case "EFFECT_IMMUNITY": {
      const categories = payload["categories"] as readonly string[] | undefined;
      assertNonEmptyArray(categories ?? [], `${path}.categories`);
      for (const [i, category] of (categories ?? []).entries()) {
        assertEnumValue(category, EFFECT_IMMUNITY_CATEGORIES, `${path}.categories[${i}]`);
      }
      const typedCategories = (categories ?? []) as readonly EffectImmunityCategory[];
      const maxBlocksRaw = payload["maxBlocks"];
      if (maxBlocksRaw === undefined) {
        throw new DomainValidationError(`${path}.maxBlocks`, "is required");
      }
      assertNullableInteger(maxBlocksRaw, `${path}.maxBlocks`, { min: 1 });
      const result: {
        categories: readonly EffectImmunityCategory[];
        effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
        statusKinds?: readonly (typeof STATUS_KINDS)[number][];
        duration: DurationDefinition;
        maxBlocks: number | null;
      } = {
        categories: typedCategories,
        duration: createDurationField(payload, path),
        maxBlocks: maxBlocksRaw,
      };
      // M7-001B（Issue #243、`EFFECT_IMMUNITY_STATUS_GRANULARITY`、R-EFF-03）:
      // `statusKinds`は`categories`が`STATUS`を含む場合だけ意味を持つ。
      // `effectActionDefinitionIds`（SPECIFIC_EFFECT専用）と同じ理由で、
      // 無関係な場合に指定すると黙って無視されてしまうため拒否する。
      // 値は`STATUS_KINDS`全体ではなく`STATUS_AILMENT_KINDS`
      // （気絶・凍結・暗闇）へ限定する — `effect-category-classifier.ts`が実行時に
      // `STATUS`カテゴリへ分類するのはこの部分集合だけで、`STEALTH`等を指定すると
      // 実行時のカテゴリ一致に一切到達せず免疫が黙って無効になる。
      const statusKindsRaw = payload["statusKinds"] as readonly string[] | undefined;
      if (statusKindsRaw !== undefined) {
        if (!typedCategories.includes("STATUS")) {
          throw new DomainValidationError(
            `${path}.statusKinds`,
            'must not be set when "categories" does not include "STATUS" (it would otherwise be silently ignored)',
          );
        }
        assertNonEmptyArray(statusKindsRaw, `${path}.statusKinds`);
        for (const [i, statusKind] of statusKindsRaw.entries()) {
          assertEnumValue(statusKind, STATUS_AILMENT_KINDS, `${path}.statusKinds[${i}]`);
        }
        result.statusKinds = statusKindsRaw as readonly (typeof STATUS_KINDS)[number][];
      }
      if (typedCategories.includes("SPECIFIC_EFFECT")) {
        const ids = payload["effectActionDefinitionIds"] as readonly string[] | undefined;
        assertNonEmptyArray(ids ?? [], `${path}.effectActionDefinitionIds`);
        result.effectActionDefinitionIds = (ids ?? []).map((id, i) =>
          createEffectActionDefinitionId(id, `${path}.effectActionDefinitionIds[${i}]`),
        );
      }
      return { kind: "EFFECT_IMMUNITY", payload: result };
    }
    case "APPLY_MARKER": {
      const markerId = createMarkerId(
        requireField(payload["markerId"] as string | undefined, `${path}.markerId`),
        `${path}.markerId`,
      );
      const stackInput = requireField(
        payload["stack"] as { policy?: string; max?: number | null } | undefined,
        `${path}.stack`,
      );
      assertKnownKeys(stackInput, STACK_ALLOWED_KEYS, `${path}.stack`);
      const policy = requireField(stackInput.policy, `${path}.stack.policy`);
      assertEnumValue(policy, MARKER_STACK_POLICIES, `${path}.stack.policy`);
      if (stackInput.max !== undefined) {
        assertNullableInteger(stackInput.max, `${path}.stack.max`, { min: 1 });
      }
      return {
        kind: "APPLY_MARKER",
        payload: {
          markerId,
          stack: { policy, max: stackInput.max ?? null },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "REMOVE_MARKER": {
      const markerId = createMarkerId(
        requireField(payload["markerId"] as string | undefined, `${path}.markerId`),
        `${path}.markerId`,
      );
      // M7-001（Issue #181、REMOVE_EFFECTS_COUNT_LIMIT）: 解除スタック数の上限。
      const count = payload["count"];
      if (count !== undefined) {
        if (typeof count !== "number") {
          throw new DomainValidationError(
            `${path}.count`,
            `must be a positive integer, got ${typeof count}`,
          );
        }
        assertInteger(count, `${path}.count`, { min: 1 });
        return { kind: "REMOVE_MARKER", payload: { markerId, count } };
      }
      return { kind: "REMOVE_MARKER", payload: { markerId } };
    }
    case "APPLY_DEATH_SURVIVAL": {
      const trigger = requireField(
        payload["trigger"] as { lethalDamageOnly?: boolean } | undefined,
        `${path}.trigger`,
      );
      assertKnownKeys(trigger, TRIGGER_LETHAL_ALLOWED_KEYS, `${path}.trigger`);
      const lethalDamageOnly = requireField(
        trigger.lethalDamageOnly,
        `${path}.trigger.lethalDamageOnly`,
      );
      assertBoolean(lethalDamageOnly, `${path}.trigger.lethalDamageOnly`);
      const healAfterSurvivalInput = payload["healAfterSurvival"] as
        | FormulaDefinitionInput
        | null
        | undefined;
      return {
        kind: "APPLY_DEATH_SURVIVAL",
        payload: {
          trigger: { lethalDamageOnly },
          survivalHp: createFormulaField(payload, "survivalHp", path),
          healAfterSurvival:
            healAfterSurvivalInput === undefined || healAfterSurvivalInput === null
              ? null
              : createFormulaDefinition(
                  healAfterSurvivalInput,
                  `${path}.healAfterSurvival`,
                  undefined,
                ),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_TARGET_REDIRECT": {
      const redirectTo = requireField(
        payload["redirectTo"] as TargetReferenceInput | undefined,
        `${path}.redirectTo`,
      );
      return {
        kind: "APPLY_TARGET_REDIRECT",
        payload: {
          redirectTo: createTargetReference(redirectTo, `${path}.redirectTo`, undefined),
          appliesTo: createAppliesTo(payload, path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_COVER": {
      const coverer = requireField(
        payload["coverer"] as TargetReferenceInput | undefined,
        `${path}.coverer`,
      );
      return {
        kind: "APPLY_COVER",
        payload: {
          coverer: createTargetReference(coverer, `${path}.coverer`, undefined),
          damageShareRate: requireRate(
            payload["damageShareRate"] as number | undefined,
            `${path}.damageShareRate`,
          ),
          guardRate: requireRate(payload["guardRate"] as number | undefined, `${path}.guardRate`),
          appliesTo: createAppliesTo(payload, path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_REFLECT": {
      const reflectTo = requireField(
        payload["reflectTo"] as TargetReferenceInput | undefined,
        `${path}.reflectTo`,
      );
      const timing = requireField(payload["timing"] as string | undefined, `${path}.timing`);
      assertEnumValue(timing, REFLECT_TIMINGS, `${path}.timing`);
      const allowRecursiveReflectRaw = payload["allowRecursiveReflect"];
      let allowRecursiveReflect = false;
      if (allowRecursiveReflectRaw !== undefined) {
        assertBoolean(allowRecursiveReflectRaw, `${path}.allowRecursiveReflect`);
        allowRecursiveReflect = allowRecursiveReflectRaw;
      }
      return {
        kind: "APPLY_REFLECT",
        payload: {
          reflectTo: createTargetReference(reflectTo, `${path}.reflectTo`, undefined),
          formula: createFormulaField(payload, "formula", path),
          timing,
          allowRecursiveReflect,
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_DAMAGE_LINK": {
      // R-LNK-01〜03（DMG-007、Issue #187）: リンク先も割合も既定を持たないため必須。
      // `linkTo`のkindごとの実装範囲（`SELF`/`BINDING`）はCatalog整合性検証
      // （`UNSUPPORTED_DAMAGE_LINK_TARGET`）が担う — Factoryは`APPLY_HEALING_LINK`と
      // 同じく形式検証だけを行う。`EffectActionDefinition`は自分を使う
      // EffectSequenceのTargetBinding集合を知らないため、`BINDING`が実在する
      // bindingを指すかは`DAMAGE_LINK_UNBOUNDED_BINDING`（`catalog-integrity.ts`、
      // `ACTIVATION_CONDITION_UNBOUNDED_REFERENCE`と同じ扱い）がSkill側から検証する。
      const linkTo = requireField(
        payload["linkTo"] as TargetReferenceInput | undefined,
        `${path}.linkTo`,
      );
      // `polarity`も既定を持たない必須fieldである（同じkindが
      // 味方向け・敵向けの両方で使われるため、符号からもkindからも導けない）。
      const polarity = requireField(payload["polarity"] as string | undefined, `${path}.polarity`);
      assertEnumValue(polarity, DAMAGE_LINK_POLARITIES, `${path}.polarity`);
      return {
        kind: "APPLY_DAMAGE_LINK",
        payload: {
          linkTo: createTargetReference(linkTo, `${path}.linkTo`, undefined),
          linkRate: requireRate(payload["linkRate"] as number | undefined, `${path}.linkRate`),
          polarity,
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_SUBUNIT": {
      const durability = requireField(
        payload["durability"] as { formula?: FormulaDefinitionInput } | undefined,
        `${path}.durability`,
      );
      const additionalDamage = requireField(
        payload["additionalDamage"] as
          | {
              formula?: FormulaDefinitionInput;
              damageType?: string;
              debuff?: { effectActionDefinitionId?: string };
            }
          | undefined,
        `${path}.additionalDamage`,
      );
      assertKnownKeys(durability, SUBUNIT_FORMULA_HOLDER_ALLOWED_KEYS, `${path}.durability`);
      assertKnownKeys(
        additionalDamage,
        SUBUNIT_ADDITIONAL_DAMAGE_ALLOWED_KEYS,
        `${path}.additionalDamage`,
      );
      const durabilityFormula = requireField(durability.formula, `${path}.durability.formula`);
      const additionalDamageFormula = requireField(
        additionalDamage.formula,
        `${path}.additionalDamage.formula`,
      );
      // R-SUB-02（DMG-005、Issue #190）: 省略時は契機になった攻撃のダメージタイプを
      // 引き継ぐ（`ApplySubunitPayload.additionalDamage.damageType`のコメント参照）。
      const additionalDamageType = additionalDamage.damageType;
      if (additionalDamageType !== undefined) {
        assertEnumValue(additionalDamageType, DAMAGE_TYPES, `${path}.additionalDamage.damageType`);
      }
      const debuff = additionalDamage.debuff;
      if (debuff !== undefined) {
        assertKnownKeys(
          debuff,
          SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF_ALLOWED_KEYS,
          `${path}.additionalDamage.debuff`,
        );
      }
      return {
        kind: "APPLY_SUBUNIT",
        payload: {
          durability: {
            formula: createFormulaDefinition(
              durabilityFormula,
              `${path}.durability.formula`,
              undefined,
            ),
          },
          additionalDamage: {
            formula: createFormulaDefinition(
              additionalDamageFormula,
              `${path}.additionalDamage.formula`,
              undefined,
            ),
            ...(additionalDamageType !== undefined ? { damageType: additionalDamageType } : {}),
            ...(debuff !== undefined
              ? {
                  debuff: {
                    effectActionDefinitionId: createEffectActionDefinitionId(
                      requireField(
                        debuff.effectActionDefinitionId,
                        `${path}.additionalDamage.debuff.effectActionDefinitionId`,
                      ),
                      `${path}.additionalDamage.debuff.effectActionDefinitionId`,
                    ),
                  },
                }
              : {}),
          },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "COOLDOWN_MANIPULATION": {
      const targetSkillDefinitionId = createSkillDefinitionId(
        requireField(
          payload["targetSkillDefinitionId"] as string | undefined,
          `${path}.targetSkillDefinitionId`,
        ),
        `${path}.targetSkillDefinitionId`,
      );
      const operation = requireField(
        payload["operation"] as string | undefined,
        `${path}.operation`,
      );
      assertEnumValue(operation, COOLDOWN_MANIPULATION_OPERATIONS, `${path}.operation`);
      if (operation === "REDUCE") {
        const amount = requireField(payload["amount"] as number | undefined, `${path}.amount`);
        assertInteger(amount, `${path}.amount`, { min: 1 });
        return {
          kind: "COOLDOWN_MANIPULATION",
          payload: {
            targetSkillDefinitionId,
            operation,
            amount,
          },
        };
      }
      return {
        kind: "COOLDOWN_MANIPULATION",
        payload: {
          targetSkillDefinitionId,
          operation,
        },
      };
    }
    case "APPLY_ATTACK_DAMAGE_BONUS": {
      return {
        kind: "APPLY_ATTACK_DAMAGE_BONUS",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_RESOURCE_GAIN_MOD": {
      // Issue #185: 合成経路（`composeResourceGainRate`）は
      // EXゲージ増加だけを対象にするため、共有の`RESOURCE_KINDS`（AP/PP/EX_GAUGE/
      // HP）ではなく`EX_GAUGE`単一値へ絞る — AP/PP/HP指定は検証を通過しても
      // 何の獲得経路にも作用しない「無効な定義」になってしまうため。
      const resource = requireField(payload["resource"] as string | undefined, `${path}.resource`);
      assertEnumValue(resource, RESOURCE_GAIN_MOD_RESOURCE_KINDS, `${path}.resource`);
      const stackingMode = requireStackingMode(payload, path);
      return {
        kind: "APPLY_RESOURCE_GAIN_MOD",
        payload: {
          resource,
          rateDelta: createFormulaField(payload, "rateDelta", path),
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
  }
}
