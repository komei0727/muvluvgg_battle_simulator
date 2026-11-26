import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toTacticalExerciseEvaluationResponseBody } from "../../../application/simulation/evaluate-tactical-exercises-mapper.js";
import type { EvaluateTacticalExercisesResult } from "../../../application/simulation/evaluate-tactical-exercises-use-case.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { TacticalExerciseEvaluationRequestBody } from "../../../application/contracts/request.js";
import {
  tacticalExerciseEvaluationRequestSchema,
  tacticalExerciseEvaluationResponseSchema,
} from "../schemas/simulation/tactical-exercise-evaluation-schema.js";
import {
  EVALUATION_ERROR_RESPONSES,
  evaluationContextFor,
  type RegisterEvaluationRouteOptions,
} from "./battle-evaluation-route.js";

export const TACTICAL_EXERCISE_EVALUATIONS_PATH = "/api/v1/tactical-exercise-evaluations";

/**
 * 戦術演習の大量試行向けの最小port。単発の演習と同じWorker Poolが実装し、同じタイムアウト・
 * 容量制御・Catalogリビジョン検査を共有する。
 */
export interface EvaluateTacticalExercisesUseCasePort {
  executeTacticalExerciseEvaluation(
    request: TacticalExerciseEvaluationRequestBody,
    context: SimulationExecutionContext,
  ): Promise<EvaluateTacticalExercisesResult>;
}

export function registerTacticalExerciseEvaluationRoute(
  app: FastifyInstance,
  {
    useCase,
    shutdownGate,
    simulationTimeoutMs,
  }: RegisterEvaluationRouteOptions<EvaluateTacticalExercisesUseCasePort>,
): void {
  app.post(
    TACTICAL_EXERCISE_EVALUATIONS_PATH,
    {
      schema: {
        body: tacticalExerciseEvaluationRequestSchema,
        response: { 200: tacticalExerciseEvaluationResponseSchema, ...EVALUATION_ERROR_RESPONSES },
      },
    },
    async (
      request: FastifyRequest<{ Body: TacticalExerciseEvaluationRequestBody }>,
      reply: FastifyReply,
    ) => {
      if (shutdownGate.isShuttingDown()) {
        throw new SimulationCapacityExceededError();
      }
      const result = await useCase.executeTacticalExerciseEvaluation(
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
        "tactical exercise evaluation completed",
      );
      void reply.code(200).send(toTacticalExerciseEvaluationResponseBody(result));
    },
  );
}
