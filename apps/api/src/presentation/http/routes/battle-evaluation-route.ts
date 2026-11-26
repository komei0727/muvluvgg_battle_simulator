import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toBattleEvaluationResponseBody } from "../../../application/simulation/evaluate-battles-mapper.js";
import type { EvaluateBattlesResult } from "../../../application/simulation/evaluate-battles-use-case.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { BattleEvaluationRequestBody } from "../../../application/contracts/request.js";
import {
  battleEvaluationRequestSchema,
  battleEvaluationResponseSchema,
} from "../schemas/simulation/battle-evaluation-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";
import { getRequestExecutionState } from "../protocol/request-id/request-id.js";
import type { ShutdownGatePort } from "./simulation-route.js";

export const BATTLE_EVALUATIONS_PATH = "/api/v1/battle-evaluations";

/** 通常戦闘の大量試行向けの最小port。単発と同じWorker Poolが実装する。 */
export interface EvaluateBattlesUseCasePort {
  executeBattleEvaluation(
    request: BattleEvaluationRequestBody,
    context: SimulationExecutionContext,
  ): Promise<EvaluateBattlesResult>;
}

/**
 * 単発のシミュレーションPOSTと同じ実行境界を通るため返り得るステータスも同じで、これに
 * 404が加わる — この操作を提供しない配備が存在する（`EVALUATION_ENDPOINT_ENABLED`）。
 * 期限到達は部分結果の`200`で返すが、単発の実行と同じく既存のエラー分類の集合は
 * 変えずに宣言する。
 */
export const EVALUATION_ERROR_RESPONSES = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  404: errorResponseSchema,
  406: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
  503: errorResponseSchema,
  504: errorResponseSchema,
} as const;

export interface RegisterEvaluationRouteOptions<Port> {
  readonly useCase: Port;
  readonly shutdownGate: ShutdownGatePort;
  readonly simulationTimeoutMs: number;
}

/** 期限はリクエスト全体に掛かる。超過した試行はエラーにせず未完了として返す。 */
export function evaluationContextFor(
  request: FastifyRequest,
  simulationTimeoutMs: number,
): SimulationExecutionContext {
  const { requestId, cancellationController } = getRequestExecutionState(request)!;
  return {
    requestId,
    deadlineEpochMs: Date.now() + simulationTimeoutMs,
    cancellationSignal: cancellationController.signal,
  };
}

export function registerBattleEvaluationRoute(
  app: FastifyInstance,
  {
    useCase,
    shutdownGate,
    simulationTimeoutMs,
  }: RegisterEvaluationRouteOptions<EvaluateBattlesUseCasePort>,
): void {
  app.post(
    BATTLE_EVALUATIONS_PATH,
    {
      schema: {
        body: battleEvaluationRequestSchema,
        response: { 200: battleEvaluationResponseSchema, ...EVALUATION_ERROR_RESPONSES },
      },
    },
    async (request: FastifyRequest<{ Body: BattleEvaluationRequestBody }>, reply: FastifyReply) => {
      if (shutdownGate.isShuttingDown()) {
        throw new SimulationCapacityExceededError();
      }
      const result = await useCase.executeBattleEvaluation(
        request.body,
        evaluationContextFor(request, simulationTimeoutMs),
      );
      request.log.info(
        {
          catalogRevision: result.catalogRevision,
          engineRevision: result.engineRevision,
          seed: result.seed,
          caseCount: result.cases.length,
          requestedRuns: result.requestedRuns,
          completedRuns: result.completedRuns,
          partial: result.partial,
        },
        "battle evaluation completed",
      );
      void reply.code(200).send(toBattleEvaluationResponseBody(result));
    },
  );
}
