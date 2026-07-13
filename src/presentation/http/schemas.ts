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

/** `POST /api/v1/battle-simulations`のrequest body schema。 */
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

const currentMaximumValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["current", "maximum"],
  properties: {
    current: { type: "number" },
    maximum: { type: "number" },
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
    column: { type: "integer" },
    row: { type: "string" },
  },
} as const;

const globalCoordinateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "integer" },
    y: { type: "integer" },
  },
} as const;

const resourceStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ap", "pp", "extraGauge"],
  properties: {
    ap: currentMaximumValueSchema,
    pp: currentMaximumValueSchema,
    extraGauge: currentMaximumValueSchema,
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
    physical: { type: "number" },
    energy: { type: "number" },
    untyped: { type: "number" },
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
    "cooldowns",
  ],
  properties: {
    battleUnitId: { type: "string" },
    unitDefinitionId: { type: "string" },
    side: { type: "string" },
    formationPosition: formationPositionResponseSchema,
    coordinate: globalCoordinateResponseSchema,
    combatStatus: { type: "string" },
    hp: currentMaximumValueSchema,
    resources: resourceStateResponseSchema,
    combatStats: combatStatsResponseSchema,
    shields: shieldStateResponseSchema,
    subUnits: { type: "array", items: {} },
    effects: { type: "array", items: {} },
    cooldowns: { type: "array", items: {} },
  },
} as const;

const actionReservationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["order", "battleUnitId", "actionSpeedAtOrdering", "reservedActionType"],
  properties: {
    order: { type: "integer" },
    battleUnitId: { type: "string" },
    actionSpeedAtOrdering: { type: "number" },
    reservedActionType: { type: "string" },
  },
} as const;

const battleStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stateVersion", "battleStatus", "turnNumber", "cycleNumber", "units", "actionQueue"],
  properties: {
    stateVersion: { type: "integer" },
    battleStatus: { type: "string" },
    turnNumber: { type: "integer" },
    cycleNumber: { type: "integer" },
    units: { type: "array", items: battleUnitStateResponseSchema },
    actionQueue: { type: "array", items: actionReservationResponseSchema },
  },
} as const;

const battleResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "completionReason", "completedTurn"],
  properties: {
    outcome: { type: "string" },
    completionReason: { type: "string" },
    completedTurn: { type: "integer" },
  },
} as const;

const battleLogEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sequence",
    "type",
    "category",
    "turnNumber",
    "cycleNumber",
    "rootSequence",
    "targetUnitIds",
    "details",
    "stateVersionBefore",
    "stateVersionAfter",
  ],
  properties: {
    sequence: { type: "integer" },
    type: { type: "string" },
    category: { type: "string" },
    turnNumber: { type: "integer" },
    cycleNumber: { type: "integer" },
    actionId: { type: "string" },
    skillUseId: { type: "string" },
    parentSequence: { type: "integer" },
    rootSequence: { type: "integer" },
    sourceUnitId: { type: "string" },
    targetUnitIds: { type: "array", items: { type: "string" } },
    details: {},
    stateVersionBefore: { type: "integer" },
    stateVersionAfter: { type: "integer" },
    stateTransitionIndex: { type: "integer" },
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
      },
    },
    units: { type: "object", additionalProperties: unitStateDeltaResponseSchema },
  },
} as const;

const stateTransitionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["causedBySequence", "stateVersionBefore", "stateVersionAfter", "delta"],
  properties: {
    causedBySequence: { type: "integer" },
    stateVersionBefore: { type: "integer" },
    stateVersionAfter: { type: "integer" },
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

const violationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    path: { type: "string" },
    definitionId: { type: "string" },
    ruleId: { type: "string" },
    message: { type: "string" },
  },
} as const;

/** エラーレスポンスbody schema（`ErrorResponse`）。全エラーステータスで共通。 */
export const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "error"],
  properties: {
    schemaVersion: { type: "integer" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "violations"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        violations: { type: "array", items: violationResponseSchema },
        diagnosticId: { type: "string" },
      },
    },
  },
} as const;
