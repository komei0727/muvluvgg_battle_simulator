import { randomUUID } from "node:crypto";
import type { FastifyError, FastifyInstance } from "fastify";
import { ApplicationError } from "../../../../application/contracts/application-error.js";
import { SimulationCapacityExceededError } from "../../../../application/simulation/simulation-capacity-exceeded-error.js";
import { fromApplicationError, toErrorResponseBody } from "./error-response-mapper.js";

// `10_API設計.md`「Retry-Afterを設定できる場合は設定する」。容量超過は通常
// 短時間で解消するため、固定の短い秒数を返す（学習的なbackoff計算は行わない）。
const CAPACITY_EXCEEDED_RETRY_AFTER_SECONDS = "1";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | ApplicationError | SimulationCapacityExceededError>(
    (error, request, reply) => {
      if (error instanceof SimulationCapacityExceededError) {
        // `10_API設計.md`「同時実行とレート制限」「Retry-Afterを設定できる場合は
        // 設定する」。
        void reply
          .code(503)
          .header("Retry-After", CAPACITY_EXCEEDED_RETRY_AFTER_SECONDS)
          .send(toErrorResponseBody("CAPACITY_EXCEEDED", []));
        return;
      }

      if (error instanceof ApplicationError) {
        // `11_インフラストラクチャ設計.md`「キャンセルと期限」「クライアント切断時
        // は応答送信を試みない」: 現状`EXECUTION_CANCELLED`は`SimulationWorkerPool`
        // が`AbortSignal`の中断（`onRequest`の`reply.raw`切断検知経由）を観測した
        // 場合にだけ送出される。その中断はクライアントが既に切断済みの場合に
        // 限られる（`reply.raw`の`close`が発火し接続が破棄済みのときだけ中断する
        // ——正常完了後の`close`では中断しない）ため、このコード到達時点で
        // `reply.raw.destroyed`なら送信を試みずに終了する。
        // 将来、接続が生きたままのサーバー内部キャンセル（Graceful Shutdownなど）
        // が同じコードを使うようになった場合は、`reply.raw.destroyed`がfalseの
        // ままとなり、下の通常経路で`503`を返す。
        if (error.code === "EXECUTION_CANCELLED" && reply.raw.destroyed) {
          return;
        }
        const { status, body } = fromApplicationError(error);
        if (status >= 500) {
          // `10_API設計.md`「ErrorObject」diagnosticId: サーバーログと照合できるよう、
          // レスポンスへ返す診断IDと同じ値でログへも記録する。
          request.log.error({ diagnosticId: body.error.diagnosticId, err: error });
        }
        void reply.code(status).send(body);
        return;
      }

      switch (error.code) {
        case "FST_ERR_CTP_BODY_TOO_LARGE":
          void reply.code(413).send(toErrorResponseBody("REQUEST_TOO_LARGE", []));
          return;
        case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
          void reply.code(415).send(toErrorResponseBody("UNSUPPORTED_MEDIA_TYPE", []));
          return;
        case "FST_ERR_CTP_INVALID_JSON_BODY":
        case "FST_ERR_CTP_EMPTY_JSON_BODY":
          void reply.code(400).send(toErrorResponseBody("MALFORMED_REQUEST", []));
          return;
        case "FST_ERR_VALIDATION": {
          const violations = (error.validation ?? []).map((issue) => ({
            path: issue.instancePath.length > 0 ? issue.instancePath : "/",
            reason: issue.message ?? "is invalid",
          }));
          void reply.code(400).send(toErrorResponseBody("MALFORMED_REQUEST", violations));
          return;
        }
        default: {
          // `10_API設計.md`「情報公開」: スタックトレースや内部パスを返さない。
          // 「ErrorObject」diagnosticId: 予期しない例外も、生成したIDをレスポンス
          // とログの双方へ記録し、事後にサーバーログと照合できるようにする。
          const diagnosticId = randomUUID();
          request.log.error({ diagnosticId, err: error });
          void reply
            .code(500)
            .send(toErrorResponseBody("INTERNAL_INVARIANT_VIOLATION", [], diagnosticId));
        }
      }
    },
  );
}
