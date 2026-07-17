import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyCors from "@fastify/cors";

// `10_API設計.md`「CORS」「許可methodはGET、POST、OPTIONS」「許可request headerは
// Content-Type、Accept、X-Request-Id、If-None-Match」「公開response headerは
// X-Request-Id、Retry-After、ETag」。
export const CORS_ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
export const CORS_ALLOWED_REQUEST_HEADERS = [
  "Content-Type",
  "Accept",
  "X-Request-Id",
  "If-None-Match",
];
export const CORS_EXPOSED_HEADERS = ["X-Request-Id", "Retry-After", "ETag"];
// `11_インフラストラクチャ設計.md`「設定管理」`CORS_ALLOWED_ORIGINS`未設定時の
// 既定値。「productionの既定を`*`にしない」ため、空配列（全origin拒否）にする
// ——`bootstrap/index.ts`が`loadConfig`で検証済みの値を渡す。
export const DEFAULT_CORS_ALLOWED_ORIGINS: readonly string[] = [];

/**
 * PRレビュー指摘（#110 [P3]）: `10_API設計.md`「OpenAPIへの反映」「CORS preflightと
 * 公開header」がOpenAPI文書へ未反映だった。許可originのCatalog GET・戦闘POSTの
 * 全response（成功・エラー問わず、CORSの`onRequest`フックがrouting前に無条件で
 * 付与するため）が実際に持ちうる公開response headerを文書化する。
 */
export const CORS_RESPONSE_HEADERS_DOC = {
  "Access-Control-Allow-Origin": {
    type: "string",
    description:
      "Present only when the request's Origin matches an allowed origin (10_API設計.md「CORS」); reflects that Origin verbatim.",
  },
  "Access-Control-Expose-Headers": {
    type: "string",
    description: "X-Request-Id, Retry-After, ETag — present only for allowed-origin requests.",
  },
} as const;

/** 上記に加え、preflight（`OPTIONS`）だけが返す許可method・許可headerを文書化する。 */
export const CORS_PREFLIGHT_RESPONSE_HEADERS_DOC = {
  ...CORS_RESPONSE_HEADERS_DOC,
  "Access-Control-Allow-Methods": { type: "string", description: "GET, POST, OPTIONS." },
  "Access-Control-Allow-Headers": {
    type: "string",
    description: "Content-Type, Accept, X-Request-Id, If-None-Match.",
  },
} as const;

/**
 * PRレビュー指摘（#110 [P2再レビュー]）: preflight requestが実際に送る
 * `Origin`・`Access-Control-Request-Method`・`Access-Control-Request-Headers`
 * をOpenAPIのheader parameterとして文書化する（`@fastify/swagger`は
 * `schema.headers`を`in: "header"`のparameterへ変換する）。
 */
export const CORS_PREFLIGHT_REQUEST_HEADERS_SCHEMA = {
  type: "object",
  properties: {
    origin: {
      type: "string",
      description: "The requesting page's origin. Present on a genuine CORS preflight request.",
    },
    "access-control-request-method": {
      type: "string",
      description: "The HTTP method the actual request will use (GET or POST).",
    },
    "access-control-request-headers": {
      type: "string",
      description: "Comma-separated list of headers the actual request will send.",
    },
  },
} as const;

/**
 * PRレビュー指摘（#110 [P2再々レビュー]）: `@fastify/cors`の`strictPreflight`
 * （既定true）は、許可originからの`OPTIONS`で`Origin`または
 * `Access-Control-Request-Method`が欠けている場合、この文書専用routeへ
 * 到達する前に自身の`onRequest`フック内で`400 Invalid Preflight Request`
 * （text/plain）を返す。ドキュメント専用の`transform`だけへ`required`を
 * 適用し、実行時の`route.schema.headers`（このrouteの本来の目的は
 * 未許可origin／`Origin`なしの稀なfallthroughを204で受けるdoc placeholder）
 * には影響させない——`required`を実schemaへ入れると、その稀な
 * fallthrough自体をAJVが400 MALFORMED_REQUESTへ変えてしまい、既存の
 * 「requestを拒否しない」契約（`API-CORS-010`）の意味が変わる。
 */
export const CORS_PREFLIGHT_REQUIRED_HEADERS = ["origin", "access-control-request-method"] as const;

/**
 * 実際の応答は`@fastify/cors`が
 * `reply.status(400).type('text/plain').send('Invalid Preflight Request')`
 * で直接送るため、このhandlerのresponse schemaによるserializationは通らない
 * （204と異なり実際に固定文言のtext/plain本文を持つため、ここでは
 * `type: "null"`を使わず`content`を明示し、`@fastify/swagger`の既定
 * `application/json`自動生成をこちらの実際の内容で上書きする——
 * PRレビュー指摘（#110 [P2再々々レビュー]）: `type: "null"`のままだと
 * 実在するtext/plain本文まで「本文なし」と誤って公開してしまっていた）。
 */
export const CORS_PREFLIGHT_INVALID_REQUEST_RESPONSE_DOC = {
  description:
    "Invalid Preflight Request — returned as text/plain by @fastify/cors's onRequest hook (not this handler) when an allowed Origin sends OPTIONS without Access-Control-Request-Method (11_インフラストラクチャ設計.md「CORS」).",
  content: {
    "text/plain": {
      schema: { type: "string", example: "Invalid Preflight Request" },
    },
  },
} as const;

/**
 * `schema.response`の各status codeへ`headers`を差し込む。`transform`が返す
 * schemaはOpenAPI文書生成専用（実行時validation・serializationに使う
 * `route.schema`本体には影響しない）ため、ここで自由に拡張してよい。
 */
export function withResponseHeadersDoc(
  responses: Record<string, unknown>,
  headersDoc: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(responses).map(([statusCode, entry]) => [
      statusCode,
      { ...(entry as Record<string, unknown>), headers: headersDoc },
    ]),
  );
}

/**
 * `11_インフラストラクチャ設計.md`「サーバー生成」「CORSプラグイン」をroute登録前に
 * 設定する。許可originは`allowedOrigins`（`CORS_ALLOWED_ORIGINS`から構築済みの
 * 完全一致set）が持つ文字列のみ。
 *
 * PRレビュー指摘（#110 [P1]）: `origin`へ配列をそのまま渡すと、`@fastify/cors`は
 * origin不一致（未許可origin、`Origin`なし）でも`Access-Control-Expose-Headers`を
 * 無条件に付与し、preflightでは`Access-Control-Allow-Methods`・
 * `Access-Control-Allow-Headers`まで付与してしまう
 * （`addCorsHeaders`が`corsOptions.exposedHeaders`の有無だけで判定するため）。
 * `origin`を関数にして未許可・`Origin`なしの場合は明示的に`false`を返すことで、
 * `@fastify/cors`が`resolvedOriginOption === false`を検知しCORS処理全体
 * （`addCorsHeaders`・preflightの`addPreflightHeaders`）を丸ごとskipするようにする
 * ——`next()`のみ呼ばれ、request自体は拒否しない。
 */
export async function registerCors(
  app: FastifyInstance,
  allowedOrigins: readonly string[],
): Promise<void> {
  const corsAllowedOriginsSet = new Set(allowedOrigins);
  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      callback(null, origin !== undefined && corsAllowedOriginsSet.has(origin));
    },
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: CORS_ALLOWED_REQUEST_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    // `10_API設計.md`「credentialsは許可しない」。
    credentials: false,
  });
}

/**
 * PRレビュー指摘（#110 [P3]）: `10_API設計.md`「OpenAPIへの反映」「CORS
 * preflightと公開header」に対応するため、Catalog GET・戦闘POSTそれぞれの
 * path向けにOPTIONS operationを文書化専用として登録する。実際のpreflight
 * 応答は`@fastify/cors`自身の`onRequest`フックがrouting前に完結させる
 * （許可originなら`reply.send()`まで済ませ、このhandlerへは到達しない）ため、
 * ここでのhandlerは未許可originや`Origin`なしの稀な経路でのみ実行され、
 * 実質的にはOpenAPI文書へ「preflightが存在する」ことを反映するためだけに置く。
 */
export function registerCorsPreflightDocRoutes(
  app: FastifyInstance,
  paths: readonly string[],
): void {
  for (const path of paths) {
    app.options(
      path,
      {
        schema: {
          // PRレビュー指摘（#110 [P2再レビュー]）: preflight requestが実際に
          // 送るheaderをOpenAPIへ文書化する。
          headers: CORS_PREFLIGHT_REQUEST_HEADERS_SCHEMA,
          response: {
            204: {
              // PRレビュー指摘（#110 [P2再レビュー]）: `type`を指定しないと
              // `@fastify/swagger`が本文なしの204へも`content.application/json`
              // を自動生成し、実際には存在しないbody/Content-Typeを公開して
              // しまう。`type: "null"`でbodyが無いことを明示し、content生成を
              // 抑止する。
              type: "null",
              description:
                "CORS preflight response — fulfilled by @fastify/cors's onRequest hook before this handler runs for an allowed origin (11_インフラストラクチャ設計.md「CORS」).",
            },
          },
        },
      },
      (_request: FastifyRequest, reply: FastifyReply) => {
        void reply.code(204).send();
      },
    );
  }
}
