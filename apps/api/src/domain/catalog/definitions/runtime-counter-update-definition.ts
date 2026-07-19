import { createRuntimeCounterId, type RuntimeCounterId } from "./catalog-ids.js";
import {
  createTriggerDefinition,
  type TriggerDefinition,
  type TriggerDefinitionInput,
} from "./trigger-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertKnownKeys,
} from "../../shared/validate.js";

/**
 * `05_ドメインモデル.md`「RuntimeCounter」が列挙するスコープのうち、M6が実装する
 * 最小範囲（Issue #143）。`BATTLE`はCatalogの語彙としては受理するが、この時点で
 * 対象となる本番Catalogは存在せず、評価器（`runtime-counter-matcher.ts`)は
 * 未対応として明示的に拒否する。
 */
export const RUNTIME_COUNTER_SCOPES = ["BATTLE", "BATTLE_UNIT", "SKILL_RUNTIME"] as const;
export type RuntimeCounterScope = (typeof RUNTIME_COUNTER_SCOPES)[number];

const RUNTIME_COUNTER_UPDATE_KINDS = ["INCREMENT", "CUMULATIVE_DAMAGE_THRESHOLD"] as const;
export type RuntimeCounterUpdateKind = (typeof RUNTIME_COUNTER_UPDATE_KINDS)[number];

const RUNTIME_COUNTER_UPDATE_ALLOWED_KEYS: Record<RuntimeCounterUpdateKind, readonly string[]> = {
  INCREMENT: ["kind", "counter", "scope", "trigger", "amount"],
  CUMULATIVE_DAMAGE_THRESHOLD: ["kind", "counter", "scope", "trigger", "maxHpRatio"],
};

/**
 * `14_Catalog定義スキーマ.md`「RUNTIME_COUNTERの更新契機」（Issue #143で確定）。
 * `trigger`は`TriggerDefinition`と同じ形（eventType/category/sourceSelector/
 * targetSelector/condition）を再利用し、PS発動条件のtriggerと独立にcounterの
 * 増減契機を宣言する。`INCREMENT`は発動回数・N回ごと条件（`RUNTIME_COUNTER_MODULO`）、
 * `CUMULATIVE_DAMAGE_THRESHOLD`は累計ダメージ閾値（`CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`）
 * に対応する。
 */
export type RuntimeCounterUpdateDefinition =
  | {
      readonly kind: "INCREMENT";
      readonly counter: RuntimeCounterId;
      readonly scope: RuntimeCounterScope;
      readonly trigger: TriggerDefinition;
      readonly amount: number;
    }
  | {
      readonly kind: "CUMULATIVE_DAMAGE_THRESHOLD";
      readonly counter: RuntimeCounterId;
      readonly scope: RuntimeCounterScope;
      readonly trigger: TriggerDefinition;
      readonly maxHpRatio: number;
    };

export interface RuntimeCounterUpdateDefinitionInput {
  readonly kind: string;
  readonly counter: string;
  readonly scope: string;
  readonly trigger: TriggerDefinitionInput;
  readonly amount?: number;
  readonly maxHpRatio?: number;
}

export function createRuntimeCounterUpdateDefinition(
  input: RuntimeCounterUpdateDefinitionInput,
  path: string,
): RuntimeCounterUpdateDefinition {
  assertEnumValue(input.kind, RUNTIME_COUNTER_UPDATE_KINDS, `${path}.kind`);
  assertKnownKeys(input, RUNTIME_COUNTER_UPDATE_ALLOWED_KEYS[input.kind], path);
  assertEnumValue(input.scope, RUNTIME_COUNTER_SCOPES, `${path}.scope`);
  const counter = createRuntimeCounterId(input.counter, `${path}.counter`);
  const trigger = createTriggerDefinition(input.trigger, `${path}.trigger`);

  if (input.kind === "INCREMENT") {
    if (input.amount === undefined) {
      throw new DomainValidationError(`${path}.amount`, "is required when kind is INCREMENT");
    }
    assertInteger(input.amount, `${path}.amount`, { min: 1 });
    return { kind: "INCREMENT", counter, scope: input.scope, trigger, amount: input.amount };
  }

  if (input.maxHpRatio === undefined) {
    throw new DomainValidationError(
      `${path}.maxHpRatio`,
      "is required when kind is CUMULATIVE_DAMAGE_THRESHOLD",
    );
  }
  assertFinite(input.maxHpRatio, `${path}.maxHpRatio`);
  if (input.maxHpRatio <= 0 || input.maxHpRatio > 1) {
    throw new DomainValidationError(
      `${path}.maxHpRatio`,
      `must be within (0, 1], got ${input.maxHpRatio}`,
    );
  }
  return {
    kind: "CUMULATIVE_DAMAGE_THRESHOLD",
    counter,
    scope: input.scope,
    trigger,
    maxHpRatio: input.maxHpRatio,
  };
}
