import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toTotalWarResponseBody } from "../../../application/simulation/simulate-total-war-response-mapper.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { SimulateTotalWarResult } from "../../../application/simulation/simulation-result-assembler.js";
import type { TotalWarRequestBody } from "../../../application/contracts/request.js";
import {
  totalWarRequestSchema,
  totalWarResponseSchema,
} from "../schemas/simulation/total-war-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";
import { getRequestExecutionState } from "../protocol/request-id/request-id.js";
import type { ShutdownGatePort } from "./simulation-route.js";

export const TOTAL_WAR_SIMULATIONS_PATH = "/api/v1/total-war-simulations";

/**
 * 総力戦（UC-05）向けの最小port。`SimulateTacticalExerciseUseCasePort`と同じ理由で
 * application層の型だけで表現する。本番実装は戦闘POSTと同じ`SimulationWorkerPool`であり、
 * 同じタイムアウト・容量制御・Catalogリビジョン検査を共有する。
 */
export interface SimulateTotalWarUseCasePort {
  executeTotalWar(
    request: TotalWarRequestBody,
    context: SimulationExecutionContext,
  ): Promise<SimulateTotalWarResult>;
}

/**
 * 戦闘POSTと同じ実行境界（Worker Pool）を通るため、返り得るエラーステータスも
 * 同じになる（`10_API設計.md`「ステータスコード対応」）。
 */
const ERROR_RESPONSES = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  406: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
  503: errorResponseSchema,
  504: errorResponseSchema,
} as const;

export interface RegisterTotalWarRouteOptions {
  readonly useCase: SimulateTotalWarUseCasePort;
  readonly shutdownGate: ShutdownGatePort;
  readonly simulationTimeoutMs: number;
}

export function registerTotalWarRoute(
  app: FastifyInstance,
  { useCase, shutdownGate, simulationTimeoutMs }: RegisterTotalWarRouteOptions,
): void {
  app.post(
    TOTAL_WAR_SIMULATIONS_PATH,
    {
      schema: {
        body: totalWarRequestSchema,
        response: { 200: totalWarResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request: FastifyRequest<{ Body: TotalWarRequestBody }>, reply: FastifyReply) => {
      // `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ2。総力戦も同じ
      // Worker Poolを使うため、戦闘POSTと同じく新しい受付を止める。
      if (shutdownGate.isShuttingDown()) {
        throw new SimulationCapacityExceededError();
      }

      // `onRequest`が全リクエストで先に`trackRequestExecution`を登録済みのため、必ず存在する。
      const { requestId, cancellationController } = getRequestExecutionState(request)!;
      const context: SimulationExecutionContext = {
        requestId,
        deadlineEpochMs: Date.now() + simulationTimeoutMs,
        cancellationSignal: cancellationController.signal,
      };
      const result = await useCase.executeTotalWar(request.body, context);
      const body = toTotalWarResponseBody(result);
      // `11_インフラストラクチャ設計.md`「ログイベント」戦闘完了行の最小field。総力戦は
      // 勝敗に加えて、各陣営の撃破された編成数と組み合わせの数を記録する。
      request.log.info(
        {
          catalogRevision: result.catalogRevision,
          battleId: result.battleId,
          outcome: result.outcome,
          completionReason: result.completionReason,
          completedTurn: result.completedTurn,
          stageCount: result.stages.length,
          defeatedFormationCounts: result.defeatedFormationCounts,
          eventCount: result.events.length,
          stateTransitionCount: result.stateTransitions.length,
        },
        "total war completed",
      );
      void reply.code(200).send(body);
    },
  );
}
