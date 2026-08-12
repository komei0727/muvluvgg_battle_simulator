import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toTacticalExerciseResponseBody } from "../../../application/simulation/simulate-tactical-exercise-response-mapper.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { SimulateTacticalExerciseResult } from "../../../application/simulation/simulation-result-assembler.js";
import type { TacticalExerciseRequestBody } from "../../../application/contracts/request.js";
import {
  tacticalExerciseRequestSchema,
  tacticalExerciseResponseSchema,
} from "../schemas/simulation/tactical-exercise-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";
import { getRequestExecutionState } from "../protocol/request-id/request-id.js";
import type { ShutdownGatePort } from "./simulation-route.js";

export const TACTICAL_EXERCISES_PATH = "/api/v1/tactical-exercises";

/**
 * 戦術演習（UC-03）向けの最小port。`SimulateBattleUseCasePort`と同じ理由で
 * application層の型だけで表現する（presentationはdomain/infrastructureを直接
 * importできない）。本番実装は戦闘POSTと同じ`SimulationWorkerPool`であり、同じ
 * タイムアウト・容量制御・Catalogリビジョン検査を共有する
 * （`09_アプリケーション設計.md`「実行境界」）——`execute`と別メソッドなのは、
 * 受け取るDTOと返る結果の型が違うためだけである。
 */
export interface SimulateTacticalExerciseUseCasePort {
  executeTacticalExercise(
    request: TacticalExerciseRequestBody,
    context: SimulationExecutionContext,
  ): Promise<SimulateTacticalExerciseResult>;
}

/**
 * 戦闘POSTと同じ実行境界（Worker Pool）を通るため、返り得るエラーステータスも
 * 同じになる（`10_API設計.md`「ステータスコード対応」）。
 */
const ERROR_RESPONSES = {
  400: errorResponseSchema,
  406: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
  503: errorResponseSchema,
  504: errorResponseSchema,
} as const;

export interface RegisterTacticalExerciseRouteOptions {
  readonly useCase: SimulateTacticalExerciseUseCasePort;
  readonly shutdownGate: ShutdownGatePort;
  readonly simulationTimeoutMs: number;
}

export function registerTacticalExerciseRoute(
  app: FastifyInstance,
  { useCase, shutdownGate, simulationTimeoutMs }: RegisterTacticalExerciseRouteOptions,
): void {
  app.post(
    TACTICAL_EXERCISES_PATH,
    {
      schema: {
        body: tacticalExerciseRequestSchema,
        response: { 200: tacticalExerciseResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request: FastifyRequest<{ Body: TacticalExerciseRequestBody }>, reply: FastifyReply) => {
      // `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ2「新しい戦闘
      // リクエストの受付を停止する」。演習も同じWorker Poolを使うため同じ扱いにする。
      if (shutdownGate.isShuttingDown()) {
        throw new SimulationCapacityExceededError();
      }

      // `onRequest`が全リクエストで先に実行され`trackRequestExecution`が登録
      // 済みのため、ここでは必ず存在する。
      const { requestId, cancellationController } = getRequestExecutionState(request)!;
      const context: SimulationExecutionContext = {
        requestId,
        deadlineEpochMs: Date.now() + simulationTimeoutMs,
        cancellationSignal: cancellationController.signal,
      };
      const result = await useCase.executeTacticalExercise(request.body, context);
      const body = toTacticalExerciseResponseBody(result);
      // `11_インフラストラクチャ設計.md`「ログイベント」戦闘完了行の最小field。
      // 演習は勝敗を持たない（R-TEX-10 #1）ため`outcome`の代わりに総スコアと
      // ブレイク回数を記録する。
      request.log.info(
        {
          catalogRevision: result.catalogRevision,
          battleId: result.battleId,
          completionReason: result.completionReason,
          completedTurn: result.completedTurn,
          totalScore: result.totalScore,
          breakCount: result.breakCount,
          eventCount: result.events.length,
          stateTransitionCount: result.stateTransitions.length,
        },
        "tactical exercise completed",
      );
      void reply.code(200).send(body);
    },
  );
}
