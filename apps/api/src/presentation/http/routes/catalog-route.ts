import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toBattleSimulationCatalogResponseBody } from "../../../application/catalog/battle-simulation-catalog-response-mapper.js";
import type { BattleSimulationCatalogResult } from "../../../application/catalog/get-battle-simulation-catalog-use-case.js";
import { battleSimulationCatalogResponseSchema } from "../schemas/catalog/catalog-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";
import { toOpaqueEntityTag, matchesIfNoneMatch } from "../protocol/etag/etag.js";

export const BATTLE_SIMULATION_CATALOG_PATH = "/api/v1/battle-simulation-catalog";

/**
 * `GetBattleSimulationCatalogUseCase`（`09_アプリケーション設計.md`）向けの
 * 最小port。`SimulateBattleUseCasePort`と同じ理由でapplication層の型だけに
 * 依存する。読み込み済みread modelを返すだけの同期呼び出しであるため、
 * `SimulateBattleUseCasePort`と異なり`Promise`を返さない
 * （`11_インフラストラクチャ設計.md`「Catalog一覧read modelを起動時に1回だけ
 * 構築する」— ハンドラーは既に構築済みのResultを読むだけでよい）。
 */
export interface GetBattleSimulationCatalogUseCasePort {
  execute(): BattleSimulationCatalogResult;
}

/**
 * `GET /api/v1/battle-simulation-catalog`にはbody検証がなく、事前検証由来の
 * エラー（400/413/415/422/429/503/504）が起こり得ない。共通`onRequest`フックの
 * `Accept`判定（406）と、共通エラーハンドラーの予期しない例外（500）だけを
 * 文書化する。
 */
const CATALOG_ERROR_RESPONSES = {
  406: errorResponseSchema,
  500: errorResponseSchema,
} as const;

export function registerCatalogRoute(
  app: FastifyInstance,
  catalogUseCase: GetBattleSimulationCatalogUseCasePort,
): void {
  app.get(
    BATTLE_SIMULATION_CATALOG_PATH,
    {
      schema: {
        response: { 200: battleSimulationCatalogResponseSchema, ...CATALOG_ERROR_RESPONSES },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      // `11_インフラストラクチャ設計.md`「`GET /api/v1/battle-simulation-catalog`
      // のハンドラーは次だけを行う」: 起動時に構築済みのResultを参照し、
      // ETag比較で200/304を出し分けるだけ——Catalogファイルの読み込みや
      // Capability計算をリクエストごとに行わない。
      const result = catalogUseCase.execute();
      const opaqueTag = toOpaqueEntityTag(result.catalogRevision);
      const etag = `"${opaqueTag}"`;
      reply.header("ETag", etag);
      if (matchesIfNoneMatch(request.headers["if-none-match"], opaqueTag)) {
        // `10_API設計.md`「304では送らない」: Content-Typeを含む本文関連
        // ヘッダーを付けず、空bodyで返す。
        void reply.code(304).send();
        return;
      }
      void reply.code(200).send(toBattleSimulationCatalogResponseBody(result));
    },
  );
}
