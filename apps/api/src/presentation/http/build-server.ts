import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { BattleSimulationCatalogResult } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import {
  battleSimulationRequestDocSchema,
  battleSimulationResponseDocSchema,
} from "./schemas/simulation/simulation-schema.js";
import { registerHealthRoutes, type ReadinessPort } from "./routes/health-routes.js";
import {
  registerCatalogRoute,
  BATTLE_SIMULATION_CATALOG_PATH,
  type GetBattleSimulationCatalogUseCasePort,
} from "./routes/catalog-route.js";
import {
  registerSimulationRoute,
  BATTLE_SIMULATIONS_PATH,
  type SimulateBattleUseCasePort,
  type ShutdownGatePort,
} from "./routes/simulation-route.js";
import { registerErrorHandler } from "./protocol/error-response/register-error-handler.js";
import { toErrorResponseBody } from "./protocol/error-response/error-response-mapper.js";
import {
  registerCors,
  registerCorsPreflightDocRoutes,
  withResponseHeadersDoc,
  DEFAULT_CORS_ALLOWED_ORIGINS,
  CORS_RESPONSE_HEADERS_DOC,
  CORS_PREFLIGHT_RESPONSE_HEADERS_DOC,
  CORS_PREFLIGHT_REQUIRED_HEADERS,
  CORS_PREFLIGHT_INVALID_REQUEST_RESPONSE_DOC,
} from "./protocol/cors/cors.js";
import {
  genReqId,
  trackRequestExecution,
  getRequestExecutionState,
} from "./protocol/request-id/request-id.js";
import { acceptsJson } from "./protocol/content-negotiation/content-negotiation.js";

export type { SimulateBattleUseCasePort, ShutdownGatePort } from "./routes/simulation-route.js";
export type { GetBattleSimulationCatalogUseCasePort } from "./routes/catalog-route.js";

const ALWAYS_READY: ReadinessPort = { isReady: () => true };
const NEVER_SHUTTING_DOWN: ShutdownGatePort = { isShuttingDown: () => false };
/**
 * `catalogUseCase`省略時の既定値。既存の呼び出し側・テスト（`buildServer(useCase)`
 * だけを渡すもの）を壊さないよう、空のCatalog一覧を返すno-op portにする
 * ——`bootstrap/index.ts`は常に実`GetBattleSimulationCatalogUseCase`を渡す。
 */
const EMPTY_CATALOG_RESULT: BattleSimulationCatalogResult = {
  catalogRevision: "",
  units: [],
  memories: [],
};
const NO_CATALOG: GetBattleSimulationCatalogUseCasePort = {
  execute: () => EMPTY_CATALOG_RESULT,
};

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB。`10_API設計.md`「編成入力自体は小さい」ための暫定上限。
// `11_インフラストラクチャ設計.md`「設定項目」`SIMULATION_TIMEOUT_MS`のデフォルト値。
const DEFAULT_SIMULATION_TIMEOUT_MS = 30_000;

export interface BuildServerOptions {
  readonly bodyLimit?: number;
  readonly simulationTimeoutMs?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly readiness?: ReadinessPort;
  readonly shutdownGate?: ShutdownGatePort;
  readonly catalogUseCase?: GetBattleSimulationCatalogUseCasePort;
  /**
   * `10_API設計.md`「CORS」「productionの許可originは`https://komei0727.github.io`を
   * 完全一致で設定する」。既定は空配列（全origin拒否）——`bootstrap/index.ts`が
   * `CORS_ALLOWED_ORIGINS`から検証済みの値を渡す。
   */
  readonly corsAllowedOrigins?: readonly string[];
  /**
   * `11_インフラストラクチャ設計.md`「OpenAPI」「productionではSwagger UIを
   * 既定で公開しない。開発・検証環境だけUIを有効化できる」（#85）。既定は
   * `false`——`bootstrap/index.ts`が`NODE_ENV`から実運用の値を渡す。
   */
  readonly docsEnabled?: boolean;
}

/**
 * `11_インフラストラクチャ設計.md`「ログ設計」の必須fieldは`timestamp`・
 * `message`だが、Pinoの既定キーはそれぞれ`time`・`msg`
 * （`docs/ddd/12_テスト戦略.md`「全ルートと全ステータスにSchemaがある」と同種の
 * 理由でレビュー指摘済み: 呼び出し側がキー名を個別に意識すると仕様との
 * ズレを検出できない）。呼び出し側（`bootstrap/index.ts`が渡す実運用設定、
 * テストが渡す`stream`付き設定）に関わらず、ここ一箇所でキー名を強制する。
 */
function withDocumentedLogFieldNames(
  logger: FastifyServerOptions["logger"],
): NonNullable<FastifyServerOptions["logger"]> {
  if (logger === undefined || logger === false) {
    return false;
  }
  const base = logger === true ? {} : logger;
  return {
    ...base,
    messageKey: "message",
    timestamp: () => `,"timestamp":${Date.now()}`,
  };
}

/**
 * `10_API設計.md`「Fastify injectによる正常・400・413・415・422」他の契約を
 * 満たすFastifyインスタンスを構築する。Catalog・RandomSource・ID生成器の
 * 実配線（Composition Root）は`bootstrap/index.ts`が担い、ここでは既に
 * 構築済みの`SimulateBattleUseCasePort`（実体は`SimulationWorkerPool`）を
 * 受け取るだけにする。
 *
 * `@fastify/swagger`の`register`はavvioのbootキューへ積まれるだけで、
 * プラグイン本体（`onRoute`フックの登録）は`.ready()`まで実行されない。
 * 一方`app.post(...)`は`onRoute`フックを呼び出し時点で同期発火するため、
 * `register`をawaitせずにルートを定義すると、そのルートがOpenAPI文書へ
 * 反映されない。ここで`await`し、フック登録を確実にルート定義より先に
 * 完了させる。
 */
export async function buildServer(
  useCase: SimulateBattleUseCasePort,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const simulationTimeoutMs = options.simulationTimeoutMs ?? DEFAULT_SIMULATION_TIMEOUT_MS;
  const readiness = options.readiness ?? ALWAYS_READY;
  const shutdownGate = options.shutdownGate ?? NEVER_SHUTTING_DOWN;
  const catalogUseCase = options.catalogUseCase ?? NO_CATALOG;
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES,
    // `11_インフラストラクチャ設計.md`「構造化ログ」。既定は`false`
    // （Fastifyの無効ロガーのまま、既存の大半のテストと同じ挙動）。
    // Composition Root（`bootstrap/index.ts`）が`LOG_LEVEL`から実運用の
    // pinoロガーを渡す。フィールド名は`withDocumentedLogFieldNames`が強制する。
    logger: withDocumentedLogFieldNames(options.logger),
    genReqId,
    // `requestId`という名前でログへ出す（`11_インフラストラクチャ設計.md`
    // 「ログ設計」の`requestId`フィールド）。Fastify既定の`reqId`ラベルのままだと
    // フィールド名がドキュメントの契約と食い違う。
    requestIdLogLabel: "requestId",
    ajv: {
      customOptions: {
        // 数値文字列を暗黙変換しない（`10_API設計.md`「数値を文字列として送信できない」）。
        coerceTypes: false,
        // additionalProperties:falseを「黙って除去」ではなく検証エラーにする
        // （`10_API設計.md`「未定義のトップレベルプロパティは拒否する」）。
        removeAdditional: false,
      },
    },
  });

  // `11_インフラストラクチャ設計.md`「サーバー生成」「CORSプラグイン」をroute登録前に設定する。
  await registerCors(app, options.corsAllowedOrigins ?? DEFAULT_CORS_ALLOWED_ORIGINS);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "muvluvgg-battle-simulator API", version: "1" },
      paths: {},
    },
    // `10_API設計.md`はOpenAPIへ値域・列挙値の自動検証を要求するが、
    // `column`/`row`/`logLevel`/`turnLimit`などの値域違反は「422
    // INVALID_COMMAND」として集約検証したい（`schemas/simulation/simulation-schema.ts`
    // 冒頭の注記）。ここで公開文書だけ`battleSimulationRequestDocSchema`
    // （値域・列挙値付き）へ差し替え、実行時validationに使う`route.schema`本体は
    // 変更しない。レスポンス側も同様に、`events[].details`のイベント種別ごとの
    // 構造は`battleSimulationResponseDocSchema`で公開文書だけ書き足す
    // （実データがそのまま流れる出力を厳格化して壊さないよう、実行時
    // serializationは`battleSimulationResponseSchema`のまま変更しない）。
    transform: ({ schema, url, route }) => {
      // PRレビュー指摘（#110 [P3]）: `registerCorsPreflightDocRoutes`が登録する
      // 文書専用のOPTIONSルートへ、preflight向けのCORS response headerを
      // 差し込む。このurlは他分岐（Catalog GET・戦闘POST）とも重なるため、
      // methodで先に分岐する。
      if (route.method === "OPTIONS") {
        return {
          schema: {
            ...schema,
            // PRレビュー指摘（#110 [P2再々レビュー]）: `Origin`・
            // `Access-Control-Request-Method`はdoc上だけ`required`にする
            // （理由は`CORS_PREFLIGHT_REQUIRED_HEADERS`のコメント参照）。
            ...(schema.headers !== undefined
              ? {
                  headers: {
                    ...(schema.headers as Record<string, unknown>),
                    required: CORS_PREFLIGHT_REQUIRED_HEADERS,
                  },
                }
              : {}),
            ...(schema.response !== undefined
              ? {
                  response: {
                    ...withResponseHeadersDoc(
                      schema.response as Record<string, unknown>,
                      CORS_PREFLIGHT_RESPONSE_HEADERS_DOC,
                    ),
                    // PRレビュー指摘（#110 [P2再々レビュー]）: 許可originが
                    // `Access-Control-Request-Method`なしで送った場合の実際の
                    // 応答（`@fastify/cors`が`addCorsHeaders`実行後・
                    // `addPreflightHeaders`実行前に返す）を文書化する
                    // ——`Access-Control-Allow-Methods`／`-Headers`は付かない。
                    400: {
                      ...CORS_PREFLIGHT_INVALID_REQUEST_RESPONSE_DOC,
                      headers: CORS_RESPONSE_HEADERS_DOC,
                    },
                  },
                }
              : {}),
          },
          url,
        };
      }
      if (url === BATTLE_SIMULATION_CATALOG_PATH) {
        // `10_API設計.md`「304では送らない」: 実行時の`route.schema.response`は
        // 304を持たない（本文がなく`send()`へ渡す値もないため）。公開文書だけ
        // ここで304を追加し、「GETの200／304、Schema」契約
        // （`13_実装計画.md`）を満たす。
        return {
          schema: {
            ...schema,
            ...(schema.response !== undefined
              ? {
                  response: withResponseHeadersDoc(
                    {
                      ...schema.response,
                      304: {
                        description:
                          "Not Modified — If-None-Match matched the current catalogRevision ETag; no body.",
                      },
                    },
                    CORS_RESPONSE_HEADERS_DOC,
                  ),
                }
              : {}),
          },
          url,
        };
      }
      if (url !== BATTLE_SIMULATIONS_PATH) {
        return { schema, url };
      }
      return {
        schema: {
          ...schema,
          ...(schema.body !== undefined ? { body: battleSimulationRequestDocSchema } : {}),
          ...(schema.response !== undefined
            ? {
                response: withResponseHeadersDoc(
                  { ...schema.response, 200: battleSimulationResponseDocSchema },
                  CORS_RESPONSE_HEADERS_DOC,
                ),
              }
            : {}),
        },
        url,
      };
    },
  });

  if (options.docsEnabled ?? false) {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  registerHealthRoutes(app, readiness);

  app.addHook("onRequest", (request, reply, done) => {
    trackRequestExecution(request, reply);

    if (!acceptsJson(request.headers.accept)) {
      const body = toErrorResponseBody("NOT_ACCEPTABLE", []);
      void reply.code(406).send(body);
      return;
    }
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    // `10_API設計.md`「Cache-Control」: Catalog一覧GETの200/304応答だけ
    // `public, max-age=300`を返し、それ以外（戦闘POST・全エラー応答、
    // Catalog GET自身の406/500含む）は`no-store`のままにする
    // （`Catalog一覧の200/304と戦闘POSTのcache header差異`を混同しない）。
    const isCatalogRoute = request.url.split("?")[0] === BATTLE_SIMULATION_CATALOG_PATH;
    const isCacheableCatalogResponse =
      isCatalogRoute && (reply.statusCode === 200 || reply.statusCode === 304);
    reply.header("Cache-Control", isCacheableCatalogResponse ? "public, max-age=300" : "no-store");
    reply.header("X-Request-Id", getRequestExecutionState(request)?.requestId ?? request.id);
    done(null, payload);
  });

  registerErrorHandler(app);

  registerSimulationRoute(app, { useCase, shutdownGate, simulationTimeoutMs });
  registerCatalogRoute(app, catalogUseCase);
  registerCorsPreflightDocRoutes(app, [BATTLE_SIMULATIONS_PATH, BATTLE_SIMULATION_CATALOG_PATH]);

  app.get("/openapi.json", (_request, reply) => {
    void reply.send(app.swagger());
  });

  return app;
}
