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
 * `05_ドメインモデル.md`「RuntimeCounter」が列挙するスコープ全体（型としての語彙）。
 */
export const RUNTIME_COUNTER_SCOPES = ["BATTLE", "BATTLE_UNIT", "SKILL_RUNTIME"] as const;
export type RuntimeCounterScope = (typeof RUNTIME_COUNTER_SCOPES)[number];

/**
 * M6が実際に実装するスコープ（Issue #143）。`BATTLE`/`BATTLE_UNIT`は
 * `RuntimeCounterScope`の語彙としては存在するが、`runtime-counter-matcher.ts`の
 * 評価器が未実装のため、Catalogロード時点でこの2つを拒否する（レビュー指摘[P2]:
 * Catalogが受理した定義が実行時に無条件で例外化する契約は避ける）。対象12行は
 * いずれも`SKILL_RUNTIME`スコープで表現できるため、この制限は対象外の
 * 不完全変換を生まない。
 */
const IMPLEMENTED_RUNTIME_COUNTER_SCOPES = ["SKILL_RUNTIME"] as const;

const RUNTIME_COUNTER_UPDATE_KINDS = ["INCREMENT", "CUMULATIVE_DAMAGE_THRESHOLD"] as const;
export type RuntimeCounterUpdateKind = (typeof RUNTIME_COUNTER_UPDATE_KINDS)[number];

/**
 * `R-EFF-11`「解決スコープ終了時にリセットするcounter」（レビュー指摘[P2]、
 * Issue #143）。省略時はcounterが戦闘終了まで持続する（対象12行はすべてこちら）。
 * `RESOLUTION_SCOPE`を指定すると、そのcounterを保持するSkillRuntimeの所有者が
 * 属する1解決スコープ（1行動、またはターン開始・終了などの行動外トップレベル
 * イベント）が終了するたびに破棄し、`RuntimeCounterReset`を発行する。
 */
const RUNTIME_COUNTER_RESET_SCOPES = ["RESOLUTION_SCOPE"] as const;
export type RuntimeCounterResetScope = (typeof RUNTIME_COUNTER_RESET_SCOPES)[number];

const RUNTIME_COUNTER_UPDATE_ALLOWED_KEYS: Record<RuntimeCounterUpdateKind, readonly string[]> = {
  INCREMENT: ["kind", "counter", "scope", "trigger", "amount", "resetScope"],
  CUMULATIVE_DAMAGE_THRESHOLD: ["kind", "counter", "scope", "trigger", "maxHpRatio", "resetScope"],
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
      readonly resetScope?: RuntimeCounterResetScope;
    }
  | {
      readonly kind: "CUMULATIVE_DAMAGE_THRESHOLD";
      readonly counter: RuntimeCounterId;
      readonly scope: RuntimeCounterScope;
      readonly trigger: TriggerDefinition;
      readonly maxHpRatio: number;
      readonly resetScope?: RuntimeCounterResetScope;
    };

export interface RuntimeCounterUpdateDefinitionInput {
  readonly kind: string;
  readonly counter: string;
  readonly scope: string;
  readonly trigger: TriggerDefinitionInput;
  readonly amount?: number;
  readonly maxHpRatio?: number;
  readonly resetScope?: string;
}

function createResetScope(
  input: RuntimeCounterUpdateDefinitionInput,
  path: string,
): RuntimeCounterResetScope | undefined {
  if (input.resetScope === undefined) {
    return undefined;
  }
  assertEnumValue(input.resetScope, RUNTIME_COUNTER_RESET_SCOPES, `${path}.resetScope`);
  return input.resetScope;
}

export function createRuntimeCounterUpdateDefinition(
  input: RuntimeCounterUpdateDefinitionInput,
  path: string,
): RuntimeCounterUpdateDefinition {
  assertEnumValue(input.kind, RUNTIME_COUNTER_UPDATE_KINDS, `${path}.kind`);
  assertKnownKeys(input, RUNTIME_COUNTER_UPDATE_ALLOWED_KEYS[input.kind], path);
  assertEnumValue(input.scope, IMPLEMENTED_RUNTIME_COUNTER_SCOPES, `${path}.scope`);
  const counter = createRuntimeCounterId(input.counter, `${path}.counter`);
  const trigger = createTriggerDefinition(input.trigger, `${path}.trigger`);
  const resetScope = createResetScope(input, path);

  if (input.kind === "INCREMENT") {
    if (input.amount === undefined) {
      throw new DomainValidationError(`${path}.amount`, "is required when kind is INCREMENT");
    }
    assertInteger(input.amount, `${path}.amount`, { min: 1 });
    return {
      kind: "INCREMENT",
      counter,
      scope: input.scope,
      trigger,
      amount: input.amount,
      ...(resetScope !== undefined ? { resetScope } : {}),
    };
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
    ...(resetScope !== undefined ? { resetScope } : {}),
  };
}
