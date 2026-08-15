import type { Side } from "./catalog-enums.js";
import { createMarkerId, type MarkerId } from "./catalog-ids.js";
import {
  createFormulaSourceReference,
  LAST_RESULT_REFERENCE_KINDS,
  type FormulaSourceReference,
  type FormulaSourceReferenceInput,
  type LastResultReference,
  type TargetBindingScope,
} from "./references.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertEnumValue,
  assertFinite,
  assertKnownKeys,
  assertNonEmptyArray,
} from "../../shared/validate.js";

/**
 * Payload shapes documented in `14_Catalog定義スキーマ.md`.
 *
 * DMG-002（Issue #192）: `HP_RATIO_SCALE`の`direction`は長らく値候補が
 * schema上どこにも列挙されておらずMapperが未サポートとしていた。本Taskが
 * `HP_RATIO_SCALE_DIRECTIONS`の2値を`14_Catalog定義スキーマ.md`へ定義し、
 * ここで受理する。
 */
const FORMULA_KINDS = [
  "CONSTANT",
  "SKILL_POWER",
  "SUBUNIT_ADDITIONAL_DAMAGE",
  "STAT_RATIO",
  "MAX_HP_RATIO",
  "CURRENT_HP_RATIO",
  "MISSING_HP_RATIO",
  "LOST_HP_RATIO",
  "DAMAGE_DEALT_RATIO",
  "DAMAGE_RECEIVED_RATIO",
  "MARKER_COUNT_SCALE",
  "ALIVE_UNIT_COUNT_SCALE",
  "HP_RATIO_SCALE",
  "SUM",
  "PRODUCT",
  "MIN",
  "MAX",
  "CLAMP",
] as const;
export type FormulaKind = (typeof FORMULA_KINDS)[number];

const STAT_RATIO_STATS = [
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
  "CRITICAL_RATE",
  "CRITICAL_DAMAGE_BONUS",
  "AFFINITY_BONUS",
  "ACTION_SPEED",
] as const;
export type StatRatioStat = (typeof STAT_RATIO_STATS)[number];

const SIDES = ["ALLY", "ENEMY", "ALL"] as const;

/**
 * DMG-002（Issue #192、`HP_RATIO_SCALE_FORMULA`）: `HP_RATIO_SCALE`が`min`〜`max`を
 * どちら向きに線形補間するかを表す。raw表現に現れるのは「HPが少ないほど高い効果」
 * （`LOWER_HP_IS_MAX`、例: `SKL_MERU_SIRIUS_AS2`「敵のHPが少ないほどダメージが増加する
 * (+200%まで)」）と「HPが多いほど高い効果」（`HIGHER_HP_IS_MAX`、例:
 * `SKL_MEIYA_FATED_PS2`「攻撃対象のHPが多いほど高い効果を発揮する」）の2方向だけである。
 * 値は`max`側がどちらのHP端に対応するかを名前で示す（`14_Catalog定義スキーマ.md`
 * 「HP_RATIO_SCALE」）。
 */
export const HP_RATIO_SCALE_DIRECTIONS = ["LOWER_HP_IS_MAX", "HIGHER_HP_IS_MAX"] as const;
export type HpRatioScaleDirection = (typeof HP_RATIO_SCALE_DIRECTIONS)[number];

const FORMULA_ALLOWED_KEYS: Record<FormulaKind, readonly string[]> = {
  CONSTANT: ["kind", "value"],
  SKILL_POWER: ["kind", "power"],
  SUBUNIT_ADDITIONAL_DAMAGE: [
    "kind",
    "ownerAttack",
    "providerAttack",
    "skillMultiplier",
    "targetDefense",
  ],
  STAT_RATIO: ["kind", "source", "stat", "ratio"],
  MAX_HP_RATIO: ["kind", "source", "ratio"],
  CURRENT_HP_RATIO: ["kind", "source", "ratio"],
  MISSING_HP_RATIO: ["kind", "source", "ratio"],
  LOST_HP_RATIO: ["kind", "source", "ratio"],
  DAMAGE_DEALT_RATIO: ["kind", "sourceResult", "ratio"],
  DAMAGE_RECEIVED_RATIO: ["kind", "sourceResult", "ratio"],
  MARKER_COUNT_SCALE: ["kind", "target", "markerId", "perStack", "max"],
  ALIVE_UNIT_COUNT_SCALE: ["kind", "side", "perUnit", "max"],
  HP_RATIO_SCALE: ["kind", "target", "min", "max", "direction"],
  SUM: ["kind", "formulas"],
  PRODUCT: ["kind", "formulas"],
  MIN: ["kind", "formulas"],
  MAX: ["kind", "formulas"],
  CLAMP: ["kind", "formula", "min", "max"],
};

export type FormulaDefinition =
  | { readonly kind: "CONSTANT"; readonly value: number }
  | { readonly kind: "SKILL_POWER"; readonly power: number }
  | {
      readonly kind: "SUBUNIT_ADDITIONAL_DAMAGE";
      readonly ownerAttack: "CURRENT_ATTACK";
      readonly providerAttack: "SOURCE_SNAPSHOT_ATTACK";
      readonly skillMultiplier: number;
      readonly targetDefense: "TARGET_CURRENT_DEFENSE";
    }
  | {
      readonly kind: "STAT_RATIO";
      readonly source: FormulaSourceReference;
      readonly stat: StatRatioStat;
      readonly ratio: number;
    }
  | {
      readonly kind: "MAX_HP_RATIO" | "CURRENT_HP_RATIO" | "MISSING_HP_RATIO" | "LOST_HP_RATIO";
      readonly source: FormulaSourceReference;
      readonly ratio: number;
    }
  | {
      readonly kind: "DAMAGE_DEALT_RATIO" | "DAMAGE_RECEIVED_RATIO";
      readonly sourceResult: LastResultReference;
      readonly ratio: number;
    }
  | {
      readonly kind: "MARKER_COUNT_SCALE";
      readonly target: FormulaSourceReference;
      readonly markerId: MarkerId;
      readonly perStack: number;
      readonly max: number;
    }
  | {
      readonly kind: "ALIVE_UNIT_COUNT_SCALE";
      readonly side: Side;
      readonly perUnit: number;
      readonly max: number;
    }
  | {
      readonly kind: "HP_RATIO_SCALE";
      readonly target: FormulaSourceReference;
      readonly min: number;
      readonly max: number;
      readonly direction: HpRatioScaleDirection;
    }
  | {
      readonly kind: "SUM" | "PRODUCT" | "MIN" | "MAX";
      readonly formulas: readonly FormulaDefinition[];
    }
  | {
      readonly kind: "CLAMP";
      readonly formula: FormulaDefinition;
      readonly min: number;
      readonly max: number;
    };

export interface FormulaDefinitionInput {
  readonly kind: string;
  readonly value?: number;
  readonly power?: number;
  readonly ownerAttack?: string;
  readonly providerAttack?: string;
  readonly skillMultiplier?: number;
  readonly targetDefense?: string;
  readonly source?: FormulaSourceReferenceInput;
  readonly stat?: string;
  readonly ratio?: number;
  readonly sourceResult?: string;
  readonly target?: FormulaSourceReferenceInput;
  readonly markerId?: string;
  readonly perStack?: number;
  readonly max?: number;
  readonly side?: string;
  readonly perUnit?: number;
  readonly direction?: string;
  readonly formulas?: readonly FormulaDefinitionInput[];
  readonly formula?: FormulaDefinitionInput;
  readonly min?: number;
}

function requireNumber(value: number | undefined, path: string): number {
  if (value === undefined) {
    throw new DomainValidationError(path, "is required");
  }
  assertFinite(value, path);
  return value;
}

function requireString(value: string | undefined, path: string): string {
  if (value === undefined) {
    throw new DomainValidationError(path, "is required");
  }
  return value;
}

export function createFormulaDefinition(
  input: FormulaDefinitionInput,
  path: string,
  scope: TargetBindingScope | undefined,
): FormulaDefinition {
  assertEnumValue(input.kind, FORMULA_KINDS, `${path}.kind`);
  assertKnownKeys(input, FORMULA_ALLOWED_KEYS[input.kind], path);

  switch (input.kind) {
    case "CONSTANT":
      return { kind: "CONSTANT", value: requireNumber(input.value, `${path}.value`) };
    case "SKILL_POWER":
      return { kind: "SKILL_POWER", power: requireNumber(input.power, `${path}.power`) };
    case "SUBUNIT_ADDITIONAL_DAMAGE": {
      const ownerAttack = requireString(input.ownerAttack, `${path}.ownerAttack`);
      assertEnumValue(ownerAttack, ["CURRENT_ATTACK"], `${path}.ownerAttack`);
      const providerAttack = requireString(input.providerAttack, `${path}.providerAttack`);
      assertEnumValue(providerAttack, ["SOURCE_SNAPSHOT_ATTACK"], `${path}.providerAttack`);
      const targetDefense = requireString(input.targetDefense, `${path}.targetDefense`);
      assertEnumValue(targetDefense, ["TARGET_CURRENT_DEFENSE"], `${path}.targetDefense`);
      return {
        kind: "SUBUNIT_ADDITIONAL_DAMAGE",
        ownerAttack,
        providerAttack,
        skillMultiplier: requireNumber(input.skillMultiplier, `${path}.skillMultiplier`),
        targetDefense,
      };
    }
    case "STAT_RATIO": {
      if (input.source === undefined) {
        throw new DomainValidationError(`${path}.source`, "is required");
      }
      const stat = requireString(input.stat, `${path}.stat`);
      assertEnumValue(stat, STAT_RATIO_STATS, `${path}.stat`);
      return {
        kind: "STAT_RATIO",
        source: createFormulaSourceReference(input.source, `${path}.source`, scope),
        stat,
        ratio: requireNumber(input.ratio, `${path}.ratio`),
      };
    }
    case "MAX_HP_RATIO":
    case "CURRENT_HP_RATIO":
    case "MISSING_HP_RATIO":
    case "LOST_HP_RATIO": {
      if (input.source === undefined) {
        throw new DomainValidationError(`${path}.source`, "is required");
      }
      return {
        kind: input.kind,
        source: createFormulaSourceReference(input.source, `${path}.source`, scope),
        ratio: requireNumber(input.ratio, `${path}.ratio`),
      };
    }
    case "DAMAGE_DEALT_RATIO":
    case "DAMAGE_RECEIVED_RATIO": {
      const sourceResult = requireString(input.sourceResult, `${path}.sourceResult`);
      assertEnumValue(sourceResult, LAST_RESULT_REFERENCE_KINDS, `${path}.sourceResult`);
      return { kind: input.kind, sourceResult, ratio: requireNumber(input.ratio, `${path}.ratio`) };
    }
    case "MARKER_COUNT_SCALE": {
      if (input.target === undefined) {
        throw new DomainValidationError(`${path}.target`, "is required");
      }
      const markerId = createMarkerId(
        requireString(input.markerId, `${path}.markerId`),
        `${path}.markerId`,
      );
      return {
        kind: "MARKER_COUNT_SCALE",
        target: createFormulaSourceReference(input.target, `${path}.target`, scope),
        markerId,
        perStack: requireNumber(input.perStack, `${path}.perStack`),
        max: requireNumber(input.max, `${path}.max`),
      };
    }
    case "ALIVE_UNIT_COUNT_SCALE": {
      const side = requireString(input.side, `${path}.side`);
      assertEnumValue(side, SIDES, `${path}.side`);
      return {
        kind: "ALIVE_UNIT_COUNT_SCALE",
        side,
        perUnit: requireNumber(input.perUnit, `${path}.perUnit`),
        max: requireNumber(input.max, `${path}.max`),
      };
    }
    case "HP_RATIO_SCALE": {
      if (input.target === undefined) {
        throw new DomainValidationError(`${path}.target`, "is required");
      }
      const direction = requireString(input.direction, `${path}.direction`);
      assertEnumValue(direction, HP_RATIO_SCALE_DIRECTIONS, `${path}.direction`);
      return {
        kind: "HP_RATIO_SCALE",
        target: createFormulaSourceReference(input.target, `${path}.target`, scope),
        min: requireNumber(input.min, `${path}.min`),
        max: requireNumber(input.max, `${path}.max`),
        direction,
      };
    }
    case "SUM":
    case "PRODUCT":
    case "MIN":
    case "MAX": {
      const formulas = input.formulas;
      if (formulas === undefined) {
        throw new DomainValidationError(`${path}.formulas`, "is required");
      }
      assertNonEmptyArray(formulas, `${path}.formulas`);
      return {
        kind: input.kind,
        formulas: formulas.map((f, i) =>
          createFormulaDefinition(f, `${path}.formulas[${i}]`, scope),
        ),
      };
    }
    case "CLAMP": {
      if (input.formula === undefined) {
        throw new DomainValidationError(`${path}.formula`, "is required");
      }
      return {
        kind: "CLAMP",
        formula: createFormulaDefinition(input.formula, `${path}.formula`, scope),
        min: requireNumber(input.min, `${path}.min`),
        max: requireNumber(input.max, `${path}.max`),
      };
    }
  }
}
