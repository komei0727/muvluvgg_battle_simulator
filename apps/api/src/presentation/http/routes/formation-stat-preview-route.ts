import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toPreviewFormationStatsCommand } from "../../../application/simulation/preview-formation-stats-request-mapper.js";
import { toFormationStatPreviewResponseBody } from "../../../application/simulation/preview-formation-stats-response-mapper.js";
import type { PreviewFormationStatsCommand } from "../../../application/simulation/preview-formation-stats-command.js";
import type { FormationStatPreviewResult } from "../../../application/simulation/preview-formation-stats-use-case.js";
import type { FormationStatPreviewRequestBody } from "../../../application/contracts/request.js";
import {
  formationStatPreviewRequestSchema,
  formationStatPreviewResponseSchema,
} from "../schemas/simulation/formation-stat-preview-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";

export const FORMATION_STAT_PREVIEW_PATH = "/api/v1/formation-stat-previews";

/**
 * `PreviewFormationStatsUseCase`（`09_アプリケーション設計.md`）向けの最小port。
 * `SimulateBattleUseCasePort`と異なり`Promise`を返さない——戦闘を実行しないため
 * Worker Threadへ委譲せず、HTTPメインスレッドで同期的に算出できる
 * （`10_API設計.md`「戦闘を実行しないため、乱数・イベント・状態差分・Worker Pool
 * を伴わない」）。
 */
export interface PreviewFormationStatsUseCasePort {
  execute(command: PreviewFormationStatsCommand): FormationStatPreviewResult;
}

/**
 * `10_API設計.md`「ステータスコード対応」のうち、このエンドポイントで実際に
 * 返り得るものだけを文書化する。Worker Pool容量・実行保護・期限に由来する
 * `429`／`503`／`504`は構造上発生しない。
 */
const PREVIEW_ERROR_RESPONSES = {
  400: errorResponseSchema,
  406: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
} as const;

export function registerFormationStatPreviewRoute(
  app: FastifyInstance,
  useCase: PreviewFormationStatsUseCasePort,
): void {
  app.post(
    FORMATION_STAT_PREVIEW_PATH,
    {
      schema: {
        body: formationStatPreviewRequestSchema,
        response: { 200: formationStatPreviewResponseSchema, ...PREVIEW_ERROR_RESPONSES },
      },
    },
    (request: FastifyRequest<{ Body: FormationStatPreviewRequestBody }>, reply: FastifyReply) => {
      const result = useCase.execute(toPreviewFormationStatsCommand(request.body));
      void reply.code(200).send(toFormationStatPreviewResponseBody(result));
    },
  );
}
