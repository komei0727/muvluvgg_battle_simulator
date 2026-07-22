import {
  battleLogEventResponseSchema,
  battleLogEventResponseDocSchema,
} from "../battle-log/battle-log-schema.js";

/**
 * `10_API設計.md`のJSON契約をFastify/AJV向けのJSON Schemaへ落としたもの。
 *
 * 意図的にJSON Schemaへ入れない検証:
 * - `turnLimit`の1〜99、各`units`の1〜5件、`memoryDefinitionIds`の0〜6件、
 *   `column`/`row`/`logLevel`の許容値— これらは「人数、配置、値域などの
 *   Command違反」として`422 INVALID_COMMAND`（Application層の
 *   `validateCommandShape`）が担当する（`10_API設計.md`「ステータスコード
 *   対応」）。JSON Schemaへ`minItems`/`enum`等で重複させると、境界値が
 *   `400`と`422`のどちらで拒否されるかが契約と一致しなくなる。
 *
 * JSON Schemaが担当するのはあくまで構造・型（`400 MALFORMED_REQUEST`）だけ:
 * 必須項目の欠落、型不正（数値文字列や小数を含む）、未知プロパティ。
 */

const formationPositionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["column", "row"],
  properties: {
    column: { type: "integer" },
    row: { type: "string" },
  },
} as const;

const formationUnitRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitDefinitionId", "position"],
  properties: {
    unitDefinitionId: { type: "string", minLength: 1, maxLength: 256 },
    position: formationPositionRequestSchema,
  },
} as const;

const formationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units", "memoryDefinitionIds"],
  properties: {
    units: { type: "array", items: formationUnitRequestSchema },
    memoryDefinitionIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
  },
} as const;

const simulationOptionsRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    logLevel: { type: "string" },
  },
} as const;

/**
 * `POST /api/v1/battle-simulations`のrequest body schema（実行時validation用）。
 * 値域・列挙値をあえて持たない（ファイル冒頭の注記を参照）。
 */
export const battleSimulationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation", "turnLimit"],
  properties: {
    allyFormation: formationRequestSchema,
    enemyFormation: formationRequestSchema,
    turnLimit: { type: "integer" },
    options: simulationOptionsRequestSchema,
  },
} as const;

const formationPositionRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["column", "row"],
  properties: {
    column: { type: "integer", enum: [0, 1, 2] },
    row: { type: "string", enum: ["FRONT", "REAR"] },
  },
} as const;

const formationUnitRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitDefinitionId", "position"],
  properties: {
    unitDefinitionId: { type: "string", minLength: 1, maxLength: 256 },
    position: formationPositionRequestDocSchema,
  },
} as const;

const formationRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units", "memoryDefinitionIds"],
  properties: {
    units: { type: "array", items: formationUnitRequestDocSchema, minItems: 1, maxItems: 5 },
    memoryDefinitionIds: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 256 },
      maxItems: 6,
    },
  },
} as const;

const simulationOptionsRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    logLevel: { type: "string", enum: ["SUMMARY", "DETAILED", "DIAGNOSTIC"] },
  },
} as const;

/**
 * `POST /api/v1/battle-simulations`のOpenAPI公開用request body schema。
 * `10_API設計.md`が明記する値域・列挙値（`turnLimit`の1〜99、`units`の
 * 1〜5件、`memoryDefinitionIds`の0〜6件、`column`/`row`/`logLevel`の許容値）
 * を文書へ反映するが、実行時validationには使わない
 * （`build-server.ts`の`@fastify/swagger`用`transform`でこのschemaへ差し替え、
 * `422 INVALID_COMMAND`として集約検証したい値域違反が`400`へ先取りされる
 * ことを避ける）。
 */
export const battleSimulationRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation", "turnLimit"],
  properties: {
    allyFormation: formationRequestDocSchema,
    enemyFormation: formationRequestDocSchema,
    turnLimit: { type: "integer", minimum: 1, maximum: 99 },
    options: simulationOptionsRequestDocSchema,
  },
} as const;

/** `10_API設計.md`「HP・リソース」: HPは「0以上の有限number」（integer制約なし）。 */
const currentMaximumValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["current", "maximum"],
  properties: {
    current: { type: "number", minimum: 0 },
    maximum: { type: "number", minimum: 0 },
  },
} as const;

/** `10_API設計.md`「HP・リソース」: AP・PP・EXゲージは「0以上のinteger」。 */
const currentMaximumIntegerValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["current", "maximum"],
  properties: {
    current: { type: "integer", minimum: 0 },
    maximum: { type: "integer", minimum: 0 },
  },
} as const;

const valueChangeNumberSchema = {
  type: "object",
  additionalProperties: false,
  required: ["before", "after"],
  properties: {
    before: { type: "number" },
    after: { type: "number" },
  },
} as const;

const valueChangeStringSchema = {
  type: "object",
  additionalProperties: false,
  required: ["before", "after"],
  properties: {
    before: { type: "string" },
    after: { type: "string" },
  },
} as const;

const formationPositionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["column", "row"],
  properties: {
    column: { type: "integer", enum: [0, 1, 2] },
    row: { type: "string", enum: ["FRONT", "REAR"] },
  },
} as const;

/** `10_API設計.md`「FormationPositionResponse」共通座標表: `x`0-2、`y`0-3の3×4固定格子。 */
const globalCoordinateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "integer", minimum: 0, maximum: 2 },
    y: { type: "integer", minimum: 0, maximum: 3 },
  },
} as const;

const resourceStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ap", "pp", "extraGauge"],
  properties: {
    ap: currentMaximumIntegerValueSchema,
    pp: currentMaximumIntegerValueSchema,
    extraGauge: currentMaximumIntegerValueSchema,
  },
} as const;

const combatStatsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "attack",
    "defense",
    "criticalRate",
    "actionSpeed",
    "affinityBonus",
    "criticalDamageBonus",
  ],
  properties: {
    attack: { type: "number" },
    defense: { type: "number" },
    criticalRate: { type: "number" },
    actionSpeed: { type: "number" },
    affinityBonus: { type: "number" },
    criticalDamageBonus: { type: "number" },
  },
} as const;

const shieldStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["physical", "energy", "untyped"],
  properties: {
    physical: { type: "number", minimum: 0 },
    energy: { type: "number", minimum: 0 },
    untyped: { type: "number", minimum: 0 },
  },
} as const;

/** `10_API設計.md`「SubUnitStateResponse」。 */
const subUnitStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subUnitInstanceId", "subUnitDefinitionId", "durability", "appliedTurnNumber"],
  properties: {
    subUnitInstanceId: { type: "string" },
    subUnitDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    durability: currentMaximumValueSchema,
    appliedTurnNumber: { type: "integer", minimum: 0 },
    appliedActionId: { type: "string" },
  },
} as const;

/**
 * `10_API設計.md`「EffectStateResponse」。`value`は`effectKindKey`ごとの
 * 構造化された値で、M7で具体Schemaが定まるまでは開いたまま(`{}`)にする
 * （`10_API設計.md`「`effectKindKey`を`value`の判別子として使用し、
 * 効果種別ごとの`value`SchemaはOpenAPIのoneOfで定義する」はM7時点の完成形）。
 */
const effectStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectInstanceId",
    "effectDefinitionId",
    "category",
    "effectKindKey",
    "stackMode",
    "isEffective",
    "value",
    "appliedTurnNumber",
  ],
  properties: {
    effectInstanceId: { type: "string" },
    effectDefinitionId: { type: "string" },
    sourceUnitId: { type: "string" },
    category: { type: "string", enum: ["BUFF", "DEBUFF", "STATUS_ABNORMALITY"] },
    effectKindKey: { type: "string" },
    stackMode: { type: "string", enum: ["STACKABLE", "NON_STACKING"] },
    isEffective: { type: "boolean" },
    value: {},
    duration: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "remaining"],
      properties: {
        unit: { type: "string", enum: ["ACTION", "TURN"] },
        remaining: { type: "integer", minimum: 0 },
      },
    },
    appliedTurnNumber: { type: "integer", minimum: 0 },
    appliedActionId: { type: "string" },
  },
} as const;

/**
 * `10_API設計.md`「MarkerStateResponse」(R-EFF-10、EFF-004、PR #210レビュー[P1])。
 * `EffectStateResponse`と異なり`category`/`stackMode`/`isEffective`/`value`を
 * 持たず、代わりに`stackCount`/`stackMax`を持つ（Markerは重複解決の対象外、
 * 対象ごとに常に1インスタンス）。
 */
const markerStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["markerInstanceId", "markerId", "sourceUnitId", "stackCount", "stackMax"],
  properties: {
    markerInstanceId: { type: "string" },
    markerId: { type: "string" },
    sourceUnitId: { type: "string" },
    stackCount: { type: "integer", minimum: 0 },
    stackMax: { type: ["integer", "null"], minimum: 1 },
    duration: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "remaining"],
      properties: {
        unit: { type: "string", enum: ["ACTION", "TURN"] },
        remaining: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

/**
 * `10_API設計.md`「CooldownStateResponse」。`setAtActionId`/`setAtTurnNumber`は
 * `unit`に応じてどちらか一方だけを必須にするXOR制約を`oneOf`で強制する
 * （両方欠落・両方存在は不正。M5レビュー3巡目[P2]）。`remaining`は残数がある
 * スキルだけを返す契約のため`minimum: 1`。
 */
export const cooldownStateResponseSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["skillDefinitionId", "unit", "remaining", "setAtActionId"],
      properties: {
        skillDefinitionId: { type: "string" },
        unit: { const: "ACTION" },
        remaining: { type: "integer", minimum: 1 },
        setAtActionId: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["skillDefinitionId", "unit", "remaining", "setAtTurnNumber"],
      properties: {
        skillDefinitionId: { type: "string" },
        unit: { const: "TURN" },
        remaining: { type: "integer", minimum: 1 },
        setAtTurnNumber: { type: "integer", minimum: 0 },
      },
    },
  ],
} as const;

/** `10_API設計.md`「ChargeStateResponse」。 */
const chargeStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skillDefinitionId", "startedActionId", "status"],
  properties: {
    skillDefinitionId: { type: "string" },
    startedActionId: { type: "string" },
    status: { type: "string", enum: ["CHARGING", "RELEASE_READY", "HELD_BY_FREEZE"] },
  },
} as const;

const battleUnitStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "battleUnitId",
    "unitDefinitionId",
    "side",
    "formationPosition",
    "coordinate",
    "combatStatus",
    "hp",
    "resources",
    "combatStats",
    "shields",
    "subUnits",
    "effects",
    "markers",
    "cooldowns",
  ],
  properties: {
    battleUnitId: { type: "string" },
    unitDefinitionId: { type: "string" },
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    formationPosition: formationPositionResponseSchema,
    coordinate: globalCoordinateResponseSchema,
    combatStatus: { type: "string", enum: ["ACTIVE", "DEFEATED"] },
    hp: currentMaximumValueSchema,
    resources: resourceStateResponseSchema,
    combatStats: combatStatsResponseSchema,
    shields: shieldStateResponseSchema,
    subUnits: { type: "array", items: subUnitStateResponseSchema },
    effects: { type: "array", items: effectStateResponseSchema },
    markers: { type: "array", items: markerStateResponseSchema },
    cooldowns: { type: "array", items: cooldownStateResponseSchema },
    charge: chargeStateResponseSchema,
  },
} as const;

const actionReservationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["order", "battleUnitId", "actionSpeedAtOrdering", "reservedActionType"],
  properties: {
    order: { type: "integer", minimum: 1 },
    battleUnitId: { type: "string" },
    actionSpeedAtOrdering: { type: "number" },
    reservedActionType: { type: "string", enum: ["ACTIVE_SKILL", "EXTRA_SKILL"] },
  },
} as const;

const battleStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stateVersion", "battleStatus", "turnNumber", "cycleNumber", "units", "actionQueue"],
  properties: {
    stateVersion: { type: "integer", minimum: 0 },
    battleStatus: { type: "string", enum: ["READY", "RUNNING", "COMPLETED"] },
    turnNumber: { type: "integer", minimum: 0, maximum: 99 },
    cycleNumber: { type: "integer", minimum: 0 },
    units: { type: "array", items: battleUnitStateResponseSchema },
    actionQueue: { type: "array", items: actionReservationResponseSchema },
  },
} as const;

const battleResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "completionReason", "completedTurn"],
  properties: {
    outcome: { type: "string", enum: ["ALLY_WIN", "ALLY_LOSE"] },
    completionReason: {
      type: "string",
      enum: ["ENEMY_DEFEATED", "ALLY_DEFEATED", "SIMULTANEOUS_DEFEAT", "TURN_LIMIT_REACHED"],
    },
    completedTurn: { type: "integer", minimum: 1, maximum: 99 },
  },
} as const;

/**
 * `10_API設計.md`「BattleStateDeltaResponse」の`EntityCollectionDelta`。
 * `subUnits`/`effects`/`cooldowns`のM5〜M8実装まではResponse Mapperが
 * 値を設定することはないが、`additionalProperties: false`のv1契約が
 * 将来これらのフィールドを拒否しないよう先に定義しておく。
 */
const entityCollectionDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["added", "updated", "removed"],
  properties: {
    added: { type: "array", items: {} },
    updated: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "before", "after"],
        properties: { id: { type: "string" }, before: {}, after: {} },
      },
    },
    removed: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "before"],
        properties: { id: { type: "string" }, before: {} },
      },
    },
  },
} as const;

const unitStateDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    combatStatus: valueChangeStringSchema,
    hp: valueChangeNumberSchema,
    resources: {
      type: "object",
      additionalProperties: false,
      properties: {
        ap: valueChangeNumberSchema,
        pp: valueChangeNumberSchema,
        extraGauge: valueChangeNumberSchema,
      },
    },
    combatStats: { type: "object", additionalProperties: valueChangeNumberSchema },
    shields: { type: "object", additionalProperties: valueChangeNumberSchema },
    subUnits: entityCollectionDeltaResponseSchema,
    effects: entityCollectionDeltaResponseSchema,
    markers: entityCollectionDeltaResponseSchema,
    cooldowns: entityCollectionDeltaResponseSchema,
    charge: {
      type: "object",
      additionalProperties: false,
      required: ["before", "after"],
      properties: { before: {}, after: {} },
    },
  },
} as const;

const battleStateDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    battle: {
      type: "object",
      additionalProperties: false,
      properties: {
        battleStatus: valueChangeStringSchema,
        turnNumber: valueChangeNumberSchema,
        cycleNumber: valueChangeNumberSchema,
      },
    },
    units: { type: "object", additionalProperties: unitStateDeltaResponseSchema },
    actionQueue: {
      type: "object",
      additionalProperties: false,
      required: ["before", "after"],
      properties: {
        before: { type: "array", items: actionReservationResponseSchema },
        after: { type: "array", items: actionReservationResponseSchema },
      },
    },
  },
} as const;

const stateTransitionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["causedBySequence", "stateVersionBefore", "stateVersionAfter", "delta"],
  properties: {
    causedBySequence: { type: "integer", minimum: 1 },
    stateVersionBefore: { type: "integer", minimum: 0 },
    stateVersionAfter: { type: "integer", minimum: 0 },
    delta: battleStateDeltaResponseSchema,
  },
} as const;

/** `200 OK`成功レスポンスbody schema（`BattleSimulationResponse`）。 */
export const battleSimulationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "battleId",
    "catalogRevision",
    "result",
    "initialState",
    "finalState",
    "events",
    "stateTransitions",
  ],
  properties: {
    schemaVersion: { type: "integer" },
    battleId: { type: "string" },
    catalogRevision: { type: "string" },
    result: battleResultResponseSchema,
    initialState: battleStateResponseSchema,
    finalState: battleStateResponseSchema,
    events: { type: "array", items: battleLogEventResponseSchema },
    stateTransitions: { type: "array", items: stateTransitionResponseSchema },
  },
} as const;

/**
 * OpenAPI公開専用の`200`成功レスポンスschema。実行時の
 * `battleSimulationResponseSchema`と唯一違うのは`events[].details`
 * （`battleLogEventDetailsDocSchema`でイベント種別ごとの構造を文書化する）。
 * `build-server.ts`の`transform`でこのルートの公開文書だけ差し替える。
 */
export const battleSimulationResponseDocSchema = {
  ...battleSimulationResponseSchema,
  properties: {
    ...battleSimulationResponseSchema.properties,
    events: { type: "array", items: battleLogEventResponseDocSchema },
  },
} as const;
