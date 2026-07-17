/**
 * `11_インフラストラクチャ設計.md`「ヘルスレスポンスへCatalogの中身、環境変数、
 * エラーのスタックを含めない」ため、bodyは状態を示す1フィールドだけにする。
 * `12_テスト戦略.md`「全ルートと全ステータスにSchemaがある」を満たすため、
 * `/health/live`・`/health/ready`の各ステータスごとに個別のconst schemaを持つ。
 */
export const healthLiveResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "live" },
  },
} as const;

export const healthReadyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ready" },
  },
} as const;

export const healthNotReadyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "not_ready" },
  },
} as const;
