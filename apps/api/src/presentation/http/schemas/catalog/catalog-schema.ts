/** `10_API設計.md`「CatalogUnitSummaryResponse」。`attribute`/`unitType`/`role`は将来値を許容するため`enum`を持たない。 */
const catalogUnitSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "unitDefinitionId",
    "displayName",
    "characterName",
    "category",
    "attribute",
    "unitType",
    "role",
    "positionAptitudes",
  ],
  properties: {
    unitDefinitionId: { type: "string" },
    displayName: { type: "string" },
    characterName: { type: "string" },
    // R-TEX-11 #1: `attribute`等と同じく将来値を許容するため`enum`を持たない。
    category: { type: "string" },
    // R-TEX-11 #4: EXERCISE_ENEMYのときだけ現れる開催中フラグ。
    exerciseActive: { type: "boolean" },
    attribute: { type: "string" },
    unitType: { type: "string" },
    role: { type: "string" },
    positionAptitudes: {
      type: "array",
      items: { type: "string", enum: ["FRONT", "BACK"] },
      minItems: 1,
    },
  },
} as const;

/** `10_API設計.md`「CatalogMemorySummaryResponse」。 */
const catalogMemorySummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memoryDefinitionId", "displayName"],
  properties: {
    memoryDefinitionId: { type: "string" },
    displayName: { type: "string" },
  },
} as const;

/**
 * `10_API設計.md`「CatalogGearEffectResponse」。R-ENH-06の適用種別で、同じパーセント値が
 * 基本値への割合補正（`RATIO`）か、値そのものへの加算（`POINT`）かを区別する。
 * Domainの`GEAR_STAT_APPLICATION_KINDS`の写しであり、一致は`API-OPENAPI-033`が検査する。
 */
export const GEAR_STAT_APPLICATION_ENUM = ["RATIO", "POINT"] as const;

/**
 * `10_API設計.md`「CatalogGearEffectValueResponse」。`tier`/`grade`は
 * `catalogUnitSummaryResponseSchema`の`attribute`等と同じ理由で`enum`を持たない
 * （将来のランク追加を破壊的変更にしない）。
 */
const catalogGearEffectValueResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier", "grade", "percentagePoints"],
  properties: {
    tier: { type: "string" },
    grade: { type: "string" },
    // R-ENH-04 #3の表の値をパーセントポイントのまま公開する（内部表現の小数ではない）。
    percentagePoints: { type: "number" },
  },
} as const;

/** `10_API設計.md`「CatalogGearEffectResponse」。 */
const catalogGearEffectResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stat", "application", "values"],
  properties: {
    stat: { type: "string" },
    application: { type: "string", enum: GEAR_STAT_APPLICATION_ENUM },
    values: { type: "array", items: catalogGearEffectValueResponseSchema },
  },
} as const;

/** `GET /api/v1/battle-simulation-catalog`の`200 OK`成功レスポンスbody schema。 */
export const battleSimulationCatalogResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "catalogRevision", "units", "memories", "gearEffects"],
  properties: {
    schemaVersion: { type: "integer" },
    catalogRevision: { type: "string" },
    units: { type: "array", items: catalogUnitSummaryResponseSchema },
    memories: { type: "array", items: catalogMemorySummaryResponseSchema },
    // R-ENH-04 #3のギア効果表。クライアントが表を持たずに上昇値を表示できるようにする。
    gearEffects: { type: "array", items: catalogGearEffectResponseSchema },
  },
} as const;
