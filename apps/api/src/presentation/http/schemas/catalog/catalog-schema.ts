/** `10_API設計.md`「CatalogUnitSummaryResponse」。`attribute`/`unitType`/`role`は将来値を許容するため`enum`を持たない。 */
const catalogUnitSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "unitDefinitionId",
    "displayName",
    "characterName",
    "attribute",
    "unitType",
    "role",
    "positionAptitudes",
    "selectable",
    "unavailableCapabilities",
  ],
  properties: {
    unitDefinitionId: { type: "string" },
    displayName: { type: "string" },
    characterName: { type: "string" },
    attribute: { type: "string" },
    unitType: { type: "string" },
    role: { type: "string" },
    positionAptitudes: {
      type: "array",
      items: { type: "string", enum: ["FRONT", "BACK"] },
      minItems: 1,
    },
    selectable: { type: "boolean" },
    unavailableCapabilities: { type: "array", items: { type: "string" } },
  },
} as const;

/** `10_API設計.md`「CatalogMemorySummaryResponse」。 */
const catalogMemorySummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memoryDefinitionId", "displayName", "selectable", "unavailableCapabilities"],
  properties: {
    memoryDefinitionId: { type: "string" },
    displayName: { type: "string" },
    selectable: { type: "boolean" },
    unavailableCapabilities: { type: "array", items: { type: "string" } },
  },
} as const;

/** `GET /api/v1/battle-simulation-catalog`の`200 OK`成功レスポンスbody schema。 */
export const battleSimulationCatalogResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "catalogRevision", "units", "memories"],
  properties: {
    schemaVersion: { type: "integer" },
    catalogRevision: { type: "string" },
    units: { type: "array", items: catalogUnitSummaryResponseSchema },
    memories: { type: "array", items: catalogMemorySummaryResponseSchema },
  },
} as const;
