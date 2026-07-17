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
