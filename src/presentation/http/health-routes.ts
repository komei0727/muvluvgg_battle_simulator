import type { FastifyInstance } from "fastify";
import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  healthNotReadyResponseSchema,
} from "./schemas.js";

/**
 * `11_インフラストラクチャ設計.md`「ヘルスチェック」`/health/ready`が要求する
 * 判定結果だけを受け取るport。presentationはdomain/infrastructureを直接
 * importできない（`no-restricted-imports`）ため、`build-server.ts`の
 * `SimulateBattleUseCasePort`と同様、具体クラス（`SimulationWorkerPool`や
 * Graceful Shutdown状態）ではなくこの最小portだけに依存する。
 */
export interface ReadinessPort {
  isReady(): boolean;
}

/**
 * `11_インフラストラクチャ設計.md`「ヘルスレスポンスへCatalogの中身、
 * 環境変数、エラーのスタックを含めない」ため、bodyは状態を示す1フィールド
 * だけにする。
 *
 * `/health/live`はプロセスがHTTP応答可能かどうかだけを示す
 * ——Catalog障害やPool飽和では失敗させない（`readiness`を一切参照しない）。
 * `/health/ready`は`readiness.isReady()`をそのまま反映し、falseなら
 * `503`を返す。ロードバランサーがこの遷移を見て新規トラフィックの送出を
 * 止められるよう、判定はリクエストのたびに再評価する（起動時に一度だけ
 * 固定した値をキャプチャしない）。
 *
 * `12_テスト戦略.md`「全ルートと全ステータスにSchemaがある」ため、200/503の
 * 両方へresponse schemaを登録する。`build-server.ts`が登録する
 * `@fastify/swagger`がここのschemaをそのままOpenAPI文書へ反映する
 * （`openapi.test.ts`参照）。
 */
export function registerHealthRoutes(app: FastifyInstance, readiness: ReadinessPort): void {
  app.get(
    "/health/live",
    { schema: { response: { 200: healthLiveResponseSchema } } },
    (_request, reply) => {
      void reply.code(200).send({ status: "live" });
    },
  );

  app.get(
    "/health/ready",
    { schema: { response: { 200: healthReadyResponseSchema, 503: healthNotReadyResponseSchema } } },
    (_request, reply) => {
      if (readiness.isReady()) {
        void reply.code(200).send({ status: "ready" });
        return;
      }
      void reply.code(503).send({ status: "not_ready" });
    },
  );
}
