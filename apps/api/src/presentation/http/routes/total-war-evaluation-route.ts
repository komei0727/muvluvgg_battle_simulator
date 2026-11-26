import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toTotalWarEvaluationResponseBody } from "../../../application/simulation/evaluate-total-wars-mapper.js";
import type { EvaluateTotalWarsResult } from "../../../application/simulation/evaluate-total-wars-use-case.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { TotalWarEvaluationRequestBody } from "../../../application/contracts/request.js";
import {
  totalWarEvaluationRequestSchema,
  totalWarEvaluationResponseSchema,
} from "../schemas/simulation/total-war-evaluation-schema.js";
import {
  EVALUATION_ERROR_RESPONSES,
  evaluationContextFor,
  type RegisterEvaluationRouteOptions,
} from "./battle-evaluation-route.js";

export const TOTAL_WAR_EVALUATIONS_PATH = "/api/v1/total-war-evaluations";

/** 総力戦の大量試行向けの最小port。単発と同じWorker Poolが実装する。 */
export interface EvaluateTotalWarsUseCasePort {
  executeTotalWarEvaluation(
    request: TotalWarEvaluationRequestBody,
    context: SimulationExecutionContext,
  ): Promise<EvaluateTotalWarsResult>;
}

export function registerTotalWarEvaluationRoute(
  app: FastifyInstance,
  {
    useCase,
    shutdownGate,
    simulationTimeoutMs,
  }: RegisterEvaluationRouteOptions<EvaluateTotalWarsUseCasePort>,
): void {
  app.post(
    TOTAL_WAR_EVALUATIONS_PATH,
    {
      schema: {
        body: totalWarEvaluationRequestSchema,
        response: { 200: totalWarEvaluationResponseSchema, ...EVALUATION_ERROR_RESPONSES },
      },
    },
    async (
      request: FastifyRequest<{ Body: TotalWarEvaluationRequestBody }>,
      reply: FastifyReply,
    ) => {
      if (shutdownGate.isShuttingDown()) {
        throw new SimulationCapacityExceededError();
      }
      const result = await useCase.executeTotalWarEvaluation(
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
        "total war evaluation completed",
      );
      void reply.code(200).send(toTotalWarEvaluationResponseBody(result));
    },
  );
}
