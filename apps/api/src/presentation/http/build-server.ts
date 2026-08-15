import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { BattleSimulationCatalogResult } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import {
  battleSimulationRequestDocSchema,
  battleSimulationResponseDocSchema,
} from "./schemas/simulation/simulation-schema.js";
import { conditionDefinitionDetailsSchema } from "./schemas/battle-log/battle-log-schema.js";
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
import {
  registerFormationStatPreviewRoute,
  FORMATION_STAT_PREVIEW_PATH,
  type PreviewFormationStatsUseCasePort,
} from "./routes/formation-stat-preview-route.js";
import {
  registerTacticalExerciseRoute,
  TACTICAL_EXERCISES_PATH,
  type SimulateTacticalExerciseUseCasePort,
} from "./routes/tactical-exercise-route.js";
import { formationStatPreviewRequestDocSchema } from "./schemas/simulation/formation-stat-preview-schema.js";
import {
  tacticalExerciseRequestDocSchema,
  tacticalExerciseResponseDocSchema,
} from "./schemas/simulation/tactical-exercise-schema.js";
import { errorResponseDocSchemaForStatus } from "./schemas/error/error-schema.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
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
export type { PreviewFormationStatsUseCasePort } from "./routes/formation-stat-preview-route.js";
export type { SimulateTacticalExerciseUseCasePort } from "./routes/tactical-exercise-route.js";
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
  // Catalog未読込のno-op portであり、ギア効果表も公開しない
  // （実`GetBattleSimulationCatalogUseCase`だけがR-ENH-04 #3の表を載せる）。
  gearEffects: [],
  representationRevision: "",
};
const NO_CATALOG: GetBattleSimulationCatalogUseCasePort = {
  execute: () => EMPTY_CATALOG_RESULT,
};
/**
 * `previewUseCase`省略時の既定値。`NO_CATALOG`と同じく、`buildServer(useCase)`
 * だけを渡す既存の呼び出し側・テストを壊さないためのno-op port
 * ——`bootstrap/index.ts`は常に実`PreviewFormationStatsUseCase`を渡す。
 */
const NO_PREVIEW: PreviewFormationStatsUseCasePort = {
  execute: () => ({ catalogRevision: "", units: [] }),
};
/**
 * `exerciseUseCase`省略時の既定値。`NO_CATALOG`／`NO_PREVIEW`と違い空の結果を返せない
 * ——演習結果は`battleId`も状態も持つため、配線されていないことを空値で表せない。
 * ルート自体は常に登録する（OpenAPI文書の形を`routes/`と`schemas/`だけで決めるため、
 * `openapi-test-use-case.ts`の注記参照）ので、未配線のまま呼ばれたら黙って偽の結果を
 * 返さず`500`にする。`bootstrap/index.ts`は常に実`SimulationWorkerPool`を渡す。
 */
const NO_EXERCISE: SimulateTacticalExerciseUseCasePort = {
  executeTacticalExercise: () =>
    Promise.reject(
      new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        { reason: "this server instance has no tactical exercise use case wired in" },
      ]),
    ),
};

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB。`10_API設計.md`「編成入力自体は小さい」ための暫定上限。

/**
 * `onSend`フックが全レスポンスへ無条件に付ける protocol header
 * （`10_API設計.md`「HTTPヘッダー」「レスポンス」）。CORSと違いoriginに依存しない。
 */
const PROTOCOL_RESPONSE_HEADERS_DOC = {
  "Cache-Control": {
    type: "string",
    description:
      "no-store for battle POSTs and every error response; public, max-age=300 only for the catalog GET's 200/304 (10_API設計.md「Cache-Control」).",
  },
  "X-Request-Id": {
    type: "string",
    description:
      "Echoes the request's X-Request-Id when supplied, otherwise the server-generated one. Present on every response, including errors.",
  },
} as const;

/** Catalog一覧GETの条件付きリクエスト用（`10_API設計.md`「ETag」）。 */
const ETAG_RESPONSE_HEADER_DOC = {
  ETag: {
    type: "string",
    description:
      "Strong validator derived from catalogRevision; send it back as If-None-Match to get a 304.",
  },
} as const;

/** `10_API設計.md`「`Retry-After`を設定できる場合は設定する」（429/503）。 */
const RETRY_AFTER_RESPONSE_HEADER_DOC = {
  "Retry-After": {
    type: "string",
    description: "Seconds to wait before retrying, when the server can estimate it.",
  },
} as const;

/**
 * OpenAPI公開文書のresponse群へ、実際に返るheaderとステータスごとのエラー`code`
 * enumを与える。実行時の`route.schema.response`は変更しない
 * （このファイルの`transform`の冒頭コメント参照）。
 *
 * `10_API設計.md`「OpenAPIへの反映」の「正常・エラーのステータスコード」「列挙値」
 * 「Catalog一覧の200/304と戦闘POSTのcache header差異」をここで一括して満たす。
 */
function withResponseDoc(
  responses: Record<string, unknown>,
  options: { readonly etagStatuses?: readonly string[] } = {},
): Record<string, unknown> {
  const etagStatuses = new Set(options.etagStatuses ?? []);
  return Object.fromEntries(
    Object.entries(responses).map(([statusCode, entry]) => {
      const status = Number(statusCode);
      const isError = status >= 400;
      return [
        statusCode,
        {
          ...(isError ? errorResponseDocSchemaForStatus(status) : (entry as object)),
          headers: {
            ...CORS_RESPONSE_HEADERS_DOC,
            ...PROTOCOL_RESPONSE_HEADERS_DOC,
            ...(etagStatuses.has(statusCode) ? ETAG_RESPONSE_HEADER_DOC : {}),
            ...(status === 429 || status === 503 ? RETRY_AFTER_RESPONSE_HEADER_DOC : {}),
          },
        },
      ];
    }),
  );
}
// `11_インフラストラクチャ設計.md`「設定項目」`SIMULATION_TIMEOUT_MS`のデフォルト値。
const DEFAULT_SIMULATION_TIMEOUT_MS = 30_000;

export interface BuildServerOptions {
  readonly bodyLimit?: number;
  readonly simulationTimeoutMs?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly readiness?: ReadinessPort;
  readonly shutdownGate?: ShutdownGatePort;
  readonly catalogUseCase?: GetBattleSimulationCatalogUseCasePort;
  readonly previewUseCase?: PreviewFormationStatsUseCasePort;
  /**
   * `POST /api/v1/tactical-exercises`（UC-03）の実行境界。本番では戦闘POSTと同じ
   * `SimulationWorkerPool`を渡す。省略時は`NO_EXERCISE`（上の注記参照）。
   */
  readonly exerciseUseCase?: SimulateTacticalExerciseUseCasePort;
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
 * 理由: 呼び出し側がキー名を個別に意識すると仕様との
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
  const previewUseCase = options.previewUseCase ?? NO_PREVIEW;
  const exerciseUseCase = options.exerciseUseCase ?? NO_EXERCISE;
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
      // `registerCorsPreflightDocRoutes`が登録する
      // 文書専用のOPTIONSルートへ、preflight向けのCORS response headerを
      // 差し込む。このurlは他分岐（Catalog GET・戦闘POST）とも重なるため、
      // methodで先に分岐する。
      if (route.method === "OPTIONS") {
        return {
          schema: {
            ...schema,
            // `Origin`・
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
                    // 許可originが
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
        // ここで304を追加し、「GETの200／304、Schema」契約を満たす。
        return {
          schema: {
            ...schema,
            ...(schema.response !== undefined
              ? {
                  response: withResponseDoc(
                    {
                      ...schema.response,
                      304: {
                        description:
                          "Not Modified — If-None-Match matched the current catalogRevision ETag; no body.",
                      },
                    },
                    { etagStatuses: ["200", "304"] },
                  ),
                }
              : {}),
          },
          url,
        };
      }
      if (url === TACTICAL_EXERCISES_PATH) {
        // 戦闘POSTと同じ理由で、値域・列挙値を持つschema（敵編成のちょうど1体・
        // メモリー0件を含む）は公開文書側だけへ差し込む。
        return {
          schema: {
            ...schema,
            ...(schema.body !== undefined ? { body: tacticalExerciseRequestDocSchema } : {}),
            ...(schema.response !== undefined
              ? {
                  response: withResponseDoc({
                    ...schema.response,
                    200: tacticalExerciseResponseDocSchema,
                  }),
                }
              : {}),
          },
          url,
        };
      }
      if (url === FORMATION_STAT_PREVIEW_PATH) {
        // 戦闘POSTと同じ理由で、値域・列挙値を持つschemaは公開文書側だけへ
        // 差し込む（実行時validationは`route.schema`のまま）。
        return {
          schema: {
            ...schema,
            ...(schema.body !== undefined ? { body: formationStatPreviewRequestDocSchema } : {}),
            ...(schema.response !== undefined
              ? { response: withResponseDoc({ ...schema.response }) }
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
                response: withResponseDoc({
                  ...schema.response,
                  200: battleSimulationResponseDocSchema,
                }),
              }
            : {}),
        },
        url,
      };
    },
  });

  // `ConditionDefinition`（`EffectApplied.details.expirationConditions`
  // が参照する、AND/OR/NOTで自己参照する唯一の再帰的Catalog schema）を
  // Fastifyの共有schemaとして登録する。`$id`/`$ref`をこのファイル内へ埋め込む
  // だけでは、`@fastify/swagger`のOpenAPI生成が`$ref`を`#/components/schemas/def-N`
  // へ書き換えるにもかかわらず、対応する定義を`components.schemas`へ実際には
  // 配置しない（未登録のためswaggerのref resolverが本体を解決できない）。
  // `addSchema`でFastify自身のschemaストアへ登録することで、生成された
  // OpenAPI文書上でも`$ref`が実在する定義を指すようにする。
  app.addSchema(conditionDefinitionDetailsSchema);

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
  registerTacticalExerciseRoute(app, {
    useCase: exerciseUseCase,
    shutdownGate,
    simulationTimeoutMs,
  });
  registerFormationStatPreviewRoute(app, previewUseCase);
  registerCatalogRoute(app, catalogUseCase);
  registerCorsPreflightDocRoutes(app, [
    BATTLE_SIMULATIONS_PATH,
    TACTICAL_EXERCISES_PATH,
    FORMATION_STAT_PREVIEW_PATH,
    BATTLE_SIMULATION_CATALOG_PATH,
  ]);

  app.get("/openapi.json", (_request, reply) => {
    void reply.send(app.swagger());
  });

  return app;
}
