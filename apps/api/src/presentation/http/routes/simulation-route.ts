import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toBattleSimulationResponseBody } from "../../../application/simulation/simulate-battle-response-mapper.js";
import { ApplicationError } from "../../../application/contracts/application-error.js";
import { SimulationCapacityExceededError } from "../../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../../application/simulation/simulation-execution-context.js";
import type { SimulateBattleResult } from "../../../application/simulation/simulation-result-assembler.js";
import type { BattleSimulationRequestBody } from "../../../application/contracts/request.js";
import {
  battleSimulationRequestSchema,
  battleSimulationResponseSchema,
} from "../schemas/simulation/simulation-schema.js";
import { errorResponseSchema } from "../schemas/error/error-schema.js";
import { getRequestExecutionState } from "../protocol/request-id/request-id.js";

export const BATTLE_SIMULATIONS_PATH = "/api/v1/battle-simulations";

/**
 * マイルストーンM4「API・Worker Walking Skeleton」: ルートハンドラーが呼ぶのは
 * 検証済みDTOと実行コンテキストを渡して`SimulateBattleResult`を受け取る
 * この最小portだけ。DTO→Command変換とBattle実行は、実装
 * （`SimulationWorkerPool`）がWorker Threadへ委譲する — HTTPメインスレッドは
 * Battleを直接実行しない（`11_インフラストラクチャ設計.md`「技術的な
 * 不変条件」）。presentationはdomain/infrastructureを直接importできない
 * （`no-restricted-imports`）ため、具体クラスではなくapplication層の型だけで
 * 表現したportとして受け取る。
 */
export interface SimulateBattleUseCasePort {
  execute(
    request: BattleSimulationRequestBody,
    context: SimulationExecutionContext,
  ): Promise<SimulateBattleResult>;
}

/**
 * `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ2「新しい
 * 戦闘リクエストの受付を停止する」だけを担うport。`ReadinessPort`とは意図的に
 * 分離している——Poolが稼働中のCatalogリビジョン不一致で致命的状態になった
 * 場合、`/health/ready`は失敗を報告すべきだが、個々のリクエストは従来どおり
 * `execute()`経由で`500 INVALID_DEFINITION`を返す契約を保つ必要があり
 * （`simulation-worker-pool.poisoning.integration.test.ts`）、この場合は
 * ここでの一律拒否対象ではない。
 */
export interface ShutdownGatePort {
  isShuttingDown(): boolean;
}

/**
 * `10_API設計.md`「ステータスコード対応」の全エラーステータスをOpenAPI文書へ
 * 登録する。`#18`で503（`CAPACITY_EXCEEDED`/`EXECUTION_CANCELLED`）と504
 * （`EXECUTION_TIMEOUT`）の実トリガーを接続した。429（利用者別レート制限）は
 * まだ配備環境側の仕組みが未定のため、外部契約としてSchemaだけ先に固定する。
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

/**
 * 再生指定（`replay`）を受け付けられる単発APIで、404が加わったエラーステータスの集合。
 * 再生は大量試行と同じ配備設定（`EVALUATION_ENDPOINT_ENABLED`）で開閉する。
 */
export const REPLAYABLE_ERROR_RESPONSES = { ...ERROR_RESPONSES, 404: errorResponseSchema } as const;

/**
 * 再生を提供しない配備では、再生指定付きのリクエストをWorkerへ送る前に拒否する。
 * 通常の単発リクエストはこの設定に関わらず受け付ける。
 *
 * ルートの`preValidation`に置き、JSON解析後・本文のschema検証より前に判定する。
 * 閉じた配備にとって再生指定は提供しない操作そのものなので、`replay`の形の誤り
 * （`400`）より先に提供可否（`404`）を答える。
 */
export function rejectReplayWhenDisabled(replayEnabled: boolean) {
  // 引数を本文だけの構造型にし、各ルートの`Body`型推論と衝突させない。
  return (
    request: { readonly body: unknown },
    _reply: unknown,
    done: (error?: Error) => void,
  ): void => {
    const body = request.body;
    if (
      !replayEnabled &&
      typeof body === "object" &&
      body !== null &&
      (body as { readonly replay?: unknown }).replay !== undefined
    ) {
      done(
        new ApplicationError("ENDPOINT_DISABLED", [
          { path: "replay", reason: "replay of a seeded run is not enabled on this server" },
        ]),
      );
      return;
    }
    done();
  };
}

export interface RegisterSimulationRouteOptions {
  readonly useCase: SimulateBattleUseCasePort;
  readonly shutdownGate: ShutdownGatePort;
  readonly simulationTimeoutMs: number;
  /** 再生指定を受け付けるか。大量試行APIを開いた配備だけで`true`にする。 */
  readonly replayEnabled: boolean;
}

export function registerSimulationRoute(
  app: FastifyInstance,
  { useCase, shutdownGate, simulationTimeoutMs, replayEnabled }: RegisterSimulationRouteOptions,
): void {
  app.post(
    BATTLE_SIMULATIONS_PATH,
    {
      preValidation: rejectReplayWhenDisabled(replayEnabled),
      schema: {
        body: battleSimulationRequestSchema,
        response: { 200: battleSimulationResponseSchema, ...REPLAYABLE_ERROR_RESPONSES },
      },
    },
    async (request: FastifyRequest<{ Body: BattleSimulationRequestBody }>, reply: FastifyReply) => {
      // `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ2「新しい
      // 戦闘リクエストの受付を停止する」。UseCaseへ一切到達させず、Pool容量
      // 超過と同じ`503 CAPACITY_EXCEEDED`として拒否する
      // （`build-server.test.ts`「shutdownGateが停止中を報告した時点で」参照）。
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
      const result = await useCase.execute(request.body, context);
      const body = toBattleSimulationResponseBody(result);
      // `11_インフラストラクチャ設計.md`「ログイベント」戦闘完了行の最小field。
      // `requestId`は`requestIdLogLabel`設定により`request.log`へ自動で
      // 束縛済みのため、ここで明示的に含める必要はない。
      request.log.info(
        {
          catalogRevision: result.catalogRevision,
          battleId: result.battleId,
          outcome: result.outcome,
          completionReason: result.completionReason,
          completedTurn: result.completedTurn,
          eventCount: result.events.length,
          stateTransitionCount: result.stateTransitions.length,
        },
        "battle completed",
      );
      void reply.code(200).send(body);
    },
  );
}
