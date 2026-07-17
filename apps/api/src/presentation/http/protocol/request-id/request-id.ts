import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const REQUEST_ID_PATTERN = /^[\x20-\x7E]{1,128}$/;

function resolveRequestId(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && REQUEST_ID_PATTERN.test(value)) {
    return value;
  }
  return undefined;
}

/**
 * Fastifyの`genReqId`。素の`http.IncomingMessage`（Fastifyのrequest wrapper
 * 構築前）を受け取るため、ヘッダーへ直接アクセスする。ここで解決した値が
 * `request.id`として全リクエストのライフサイクル（`request.log`の`requestId`
 * ラベルを含む）に一貫して使われる——`onRequest`フックで改めて解決し直す
 * 必要がなくなる。
 */
export function genReqId(request: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  return resolveRequestId(request.headers["x-request-id"]) ?? randomUUID();
}

export interface RequestExecutionState {
  readonly requestId: string;
  readonly cancellationController: AbortController;
}

/**
 * `FastifyRequest`をキーにリクエストごとの実行状態を保持する。`decorateRequest`
 * によるプロパティ拡張の代わりにこの形を選んだのは、`presentation`層内だけで
 * 完結し、Fastifyの型システムを拡張する`declare module`を要求しないため。
 */
const requestExecutionState = new WeakMap<FastifyRequest, RequestExecutionState>();

/**
 * `11_インフラストラクチャ設計.md`「メインスレッドの責務」: Request IDの
 * 採番とHTTP切断検知は、後続の`preValidation`やルートハンドラーより前の
 * 最も早いフックで一度だけ行う。`request.id`は`genReqId`が
 * （`X-Request-Id`ヘッダー、なければ新規UUID）で解決済みの値そのもの
 * ——ここで改めて解決し直す必要はない。
 *
 * 切断検知は`reply.raw`（`ServerResponse`）の`close`を見る。`request.raw`
 * （`IncomingMessage`）の`close`はリクエスト本文を読み終えた時点で
 * ほぼ即座に発火し、クライアントが接続を維持しているか否かを問わない
 * ——実際に`request.raw`で監視すると、切断していない通常リクエストまで
 * キャンセル扱いになるレグレッションを引き起こした。`reply.raw`の`close`は
 * 応答の送信が完了する前に接続が終了した場合にだけ意味を持つため、
 * `!reply.raw.writableEnded`（＝まだ応答を書き終えていない）で正常完了後の
 * 発火と区別する。
 */
export function trackRequestExecution(request: FastifyRequest, reply: FastifyReply): void {
  const cancellationController = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) {
      cancellationController.abort();
    }
  });
  requestExecutionState.set(request, {
    requestId: request.id,
    cancellationController,
  });
}

/**
 * `onRequest`が全リクエストで先に実行され`trackRequestExecution`が登録
 * 済みのため、通常はここに必ず存在する。ただしCORS preflight（`OPTIONS`）は
 * `@fastify/cors`自身の`onRequest`フックが`reply.send()`で即座に応答を終える
 * ため、後続に登録した本フックの`onRequest`ハンドラーへ到達せず、登録されない
 * ——呼び出し側は`request.id`（`genReqId`により同じ値へ解決済み）を
 * fallbackとして使う。
 */
export function getRequestExecutionState(
  request: FastifyRequest,
): RequestExecutionState | undefined {
  return requestExecutionState.get(request);
}
