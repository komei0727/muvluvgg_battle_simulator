import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toErrorResponseBody } from "../error-response/error-response-mapper.js";

/**
 * `11_インフラストラクチャ設計.md`「設定項目」`API_ACCESS_KEYS`の1要素。`label`は
 * キーごとの利用量をログから集計するための識別子であり、キー本体の代わりに
 * ログへ出す。
 */
export interface ApiAccessKey {
  readonly label: string;
  readonly key: string;
}

/** 保護対象。`/health/*`・`/openapi.json`・`/docs`はCloud Runのprobeや運用のため公開のままにする。 */
const PROTECTED_PATH_PREFIX = "/api/v1/";
const BEARER_PREFIX = "bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined || header.length <= BEARER_PREFIX.length) {
    return undefined;
  }
  // RFC 9110 §11.1: auth-schemeは大文字小文字を区別しない。
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return undefined;
  }
  return header.slice(BEARER_PREFIX.length).trim();
}

/**
 * `10_API設計.md`「認証」。`/api/v1/*`へのrequestに、登録済みのいずれかのキーと一致する
 * `Authorization: Bearer <key>`を要求する。`keys`が空の配備（`API_ACCESS_KEYS`未設定）
 * では何も登録しない。
 *
 * CORSの`onRequest`より後に登録されるため、401にも許可originなら
 * `Access-Control-Allow-Origin`が付き、UIが本文を読める。preflight（`OPTIONS`）は
 * browserが`Authorization`を付けずに送るため検査しない。
 */
export function registerAccessKeyGuard(app: FastifyInstance, keys: readonly ApiAccessKey[]): void {
  if (keys.length === 0) {
    return;
  }
  // 長さの異なる値を`timingSafeEqual`へ渡すと例外になり、長さ自体が分岐で漏れる。
  // 両辺を固定長のdigestへ揃えてから比較する。
  const keyDigests = keys.map(({ label, key }) => ({ label, digest: digest(key) }));

  const findLabel = (token: string): string | undefined => {
    const tokenDigest = digest(token);
    let matched: string | undefined;
    // 一致した時点で抜けると、何番目のキーと一致したかが応答時間に出る。全件比較する。
    for (const entry of keyDigests) {
      if (timingSafeEqual(entry.digest, tokenDigest) && matched === undefined) {
        matched = entry.label;
      }
    }
    return matched;
  };

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done) => {
    if (request.method === "OPTIONS" || !request.url.startsWith(PROTECTED_PATH_PREFIX)) {
      done();
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const label = token === undefined ? undefined : findLabel(token);
    if (label === undefined) {
      // キー本体は（不正なものも含め）ログへ出さない。拒否の事実だけを残す。
      request.log.info({ accessKeyRejected: true }, "access key rejected");
      void reply
        .code(401)
        .header("WWW-Authenticate", "Bearer")
        .send(toErrorResponseBody("UNAUTHORIZED", []));
      return;
    }
    // Fastifyの`request completed`ログは`reply.log`へ書かれるため、両方を差し替えて
    // 以後このrequestで出る全ログへラベルを載せる。
    const childLogger = request.log.child({ accessKeyLabel: label });
    request.log = childLogger;
    reply.log = childLogger;
    done();
  });
}
