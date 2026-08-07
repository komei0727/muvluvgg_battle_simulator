import { errorCodesForHttpStatus } from "../../protocol/error-response/error-response-mapper.js";

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

/**
 * OpenAPI公開文書用のエラーSchema。`10_API設計.md`「OpenAPIへの反映」が要求する
 * 「列挙値」「正常・エラーのステータスコード」を満たすため、`code`をそのステータスで
 * 実際に返し得る値だけへ絞る。
 *
 * 実行時のserialization schema（`errorResponseSchema`）は`code: { type: "string" }`の
 * まま変えない。fast-json-stringifyは応答本文の生成に使われるため、ここを厳格化すると
 * 未知コードの追加が「文書と食い違う」ではなく「応答が壊れる」形の失敗になる。
 * 値域・列挙を公開文書側だけに置く方針は`battleSimulationRequestDocSchema`
 * （`turnLimit`/`logLevel`）と同じ。
 */
export function errorResponseDocSchemaForStatus(status: number): Record<string, unknown> {
  const codes = errorCodesForHttpStatus(status);
  if (codes.length === 0) {
    throw new Error(
      `no error code maps to HTTP status ${status}; 10_API設計.md「ステータスコード対応」と食い違っている`,
    );
  }
  return {
    ...errorResponseSchema,
    properties: {
      ...errorResponseSchema.properties,
      error: {
        ...errorResponseSchema.properties.error,
        properties: {
          ...errorResponseSchema.properties.error.properties,
          code: { type: "string", enum: [...codes] },
        },
      },
    },
  };
}
