import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toTacticalExerciseEvaluationResponseBody } from "../../../application/simulation/evaluate-tactical-exercise-candidates-mapper.js";
import type { EvaluateTacticalExerciseCandidatesResult } from "../../../application/simulation/evaluate-tactical-exercise-candidates-use-case.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { TacticalExerciseEvaluationRequestBody } from "../../../application/contracts/request.js";
import {
  tacticalExerciseEvaluationRequestSchema,
  tacticalExerciseEvaluationResponseSchema,
} from "../schemas/simulation/tactical-exercise-evaluation-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";
import { getRequestExecutionState } from "../protocol/request-id/request-id.js";
import type { ShutdownGatePort } from "./simulation-route.js";

export const TACTICAL_EXERCISE_EVALUATIONS_PATH = "/api/v1/tactical-exercise-evaluations";

/**
 * 編成候補の一括評価（UC-04）向けの最小port。単発の演習と同じWorker Poolが実装し、
 * 同じタイムアウト・容量制御・Catalogリビジョン検査を共有する。
 */
export interface EvaluateTacticalExerciseCandidatesUseCasePort {
  executeTacticalExerciseEvaluation(
    request: TacticalExerciseEvaluationRequestBody,
    context: SimulationExecutionContext,
  ): Promise<EvaluateTacticalExerciseCandidatesResult>;
}

/**
 * 演習POSTと同じ実行境界を通るため返り得るステータスも同じで、これに404が加わる——
 * この操作を提供しない配備が存在する（`EVALUATION_ENDPOINT_ENABLED`）。
 */
const ERROR_RESPONSES = {
  400: errorResponseSchema,
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

export interface RegisterTacticalExerciseEvaluationRouteOptions {
  readonly useCase: EvaluateTacticalExerciseCandidatesUseCasePort;
  readonly shutdownGate: ShutdownGatePort;
  readonly simulationTimeoutMs: number;
}

export function registerTacticalExerciseEvaluationRoute(
  app: FastifyInstance,
  { useCase, shutdownGate, simulationTimeoutMs }: RegisterTacticalExerciseEvaluationRouteOptions,
): void {
  app.post(
    TACTICAL_EXERCISE_EVALUATIONS_PATH,
    {
      schema: {
        body: tacticalExerciseEvaluationRequestSchema,
        response: { 200: tacticalExerciseEvaluationResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (
      request: FastifyRequest<{ Body: TacticalExerciseEvaluationRequestBody }>,
      reply: FastifyReply,
    ) => {
      if (shutdownGate.isShuttingDown()) {
        throw new SimulationCapacityExceededError();
      }

      const { requestId, cancellationController } = getRequestExecutionState(request)!;
      const context: SimulationExecutionContext = {
        requestId,
        // 期限はリクエスト全体に掛かる。候補×試行がこれを超えた場合はエラーにせず、
        // 完了済みの試行だけを返す（`completedRuns`が不足を示す）。
        deadlineEpochMs: Date.now() + simulationTimeoutMs,
        cancellationSignal: cancellationController.signal,
      };
      const result = await useCase.executeTacticalExerciseEvaluation(request.body, context);
      const body = toTacticalExerciseEvaluationResponseBody(result);
      const completedRuns = result.candidates.reduce(
        (total, candidate) => total + candidate.completedRuns,
        0,
      );
      request.log.info(
        {
          catalogRevision: result.catalogRevision,
          seed: result.seed,
          candidateCount: result.candidates.length,
          runsPerCandidate: result.runsPerCandidate,
          completedRuns,
          requestedRuns: result.candidates.length * result.runsPerCandidate,
        },
        "tactical exercise evaluation completed",
      );
      void reply.code(200).send(body);
    },
  );
}
