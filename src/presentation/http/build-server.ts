import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { toBattleSimulationResponseBody } from "../../application/simulate-battle-response-mapper.js";
import { toBattleSimulationCatalogResponseBody } from "../../application/battle-simulation-catalog-response-mapper.js";
import { ApplicationError } from "../../application/application-error.js";
import type { BattleSimulationRequestBody } from "../../application/http-contract.js";
import type { BattleSimulationCatalogResult } from "../../application/get-battle-simulation-catalog-use-case.js";
import { SimulationCapacityExceededError } from "../../application/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../application/simulation-execution-context.js";
import type { SimulateBattleResult } from "../../application/simulation-result-assembler.js";
import { fromApplicationError, toErrorResponseBody } from "./error-response-mapper.js";
import { registerHealthRoutes, type ReadinessPort } from "./health-routes.js";
import {
  battleSimulationRequestSchema,
  battleSimulationRequestDocSchema,
  battleSimulationResponseSchema,
  battleSimulationResponseDocSchema,
  battleSimulationCatalogResponseSchema,
  errorResponseSchema,
} from "./schemas.js";

const BATTLE_SIMULATIONS_PATH = "/api/v1/battle-simulations";
const BATTLE_SIMULATION_CATALOG_PATH = "/api/v1/battle-simulation-catalog";

/**
 * `13_実装計画.md`「M4 API・Worker Walking Skeleton」: ルートハンドラーが呼ぶのは
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
 * `GetBattleSimulationCatalogUseCase`（`09_アプリケーション設計.md`）向けの
 * 最小port。`SimulateBattleUseCasePort`と同じ理由でapplication層の型だけに
 * 依存する。読み込み済みread modelを返すだけの同期呼び出しであるため、
 * `SimulateBattleUseCasePort`と異なり`Promise`を返さない
 * （`11_インフラストラクチャ設計.md`「Catalog一覧read modelを起動時に1回だけ
 * 構築する」— ハンドラーは既に構築済みのResultを読むだけでよい）。
 */
export interface GetBattleSimulationCatalogUseCasePort {
  execute(): BattleSimulationCatalogResult;
}

/**
 * `10_API設計.md`「ステータスコード対応」の全エラーステータスをOpenAPI文書へ
 * 登録する。`#18`で503（`CAPACITY_EXCEEDED`/`EXECUTION_CANCELLED`）と504
 * （`EXECUTION_TIMEOUT`）の実トリガーを接続した。429（利用者別レート制限）は
 * まだ配備環境側の仕組みが未定のため、外部契約としてSchemaだけ先に固定する。
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

/**
 * `GET /api/v1/battle-simulation-catalog`にはbody検証がなく、事前検証由来の
 * エラー（400/413/415/422/429/503/504）が起こり得ない。共通`onRequest`フックの
 * `Accept`判定（406）と、共通エラーハンドラーの予期しない例外（500）だけを
 * 文書化する。
 */
const CATALOG_ERROR_RESPONSES = {
  406: errorResponseSchema,
  500: errorResponseSchema,
} as const;

const REQUEST_ID_PATTERN = /^[\x20-\x7E]{1,128}$/;
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB。`10_API設計.md`「編成入力自体は小さい」ための暫定上限。
// `11_インフラストラクチャ設計.md`「設定項目」`SIMULATION_TIMEOUT_MS`のデフォルト値。
const DEFAULT_SIMULATION_TIMEOUT_MS = 30_000;
// `10_API設計.md`「Retry-Afterを設定できる場合は設定する」。容量超過は通常
// 短時間で解消するため、固定の短い秒数を返す（学習的なbackoff計算は行わない）。
const CAPACITY_EXCEEDED_RETRY_AFTER_SECONDS = "1";
// `10_API設計.md`「CORS」「許可methodはGET、POST、OPTIONS」「許可request headerは
// Content-Type、Accept、X-Request-Id、If-None-Match」「公開response headerは
// X-Request-Id、Retry-After、ETag」。
const CORS_ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
const CORS_ALLOWED_REQUEST_HEADERS = ["Content-Type", "Accept", "X-Request-Id", "If-None-Match"];
const CORS_EXPOSED_HEADERS = ["X-Request-Id", "Retry-After", "ETag"];
// `11_インフラストラクチャ設計.md`「設定管理」`CORS_ALLOWED_ORIGINS`未設定時の
// 既定値。「productionの既定を`*`にしない」ため、空配列（全origin拒否）にする
// ——`bootstrap/index.ts`が`loadConfig`で検証済みの値を渡す。
const DEFAULT_CORS_ALLOWED_ORIGINS: readonly string[] = [];

/**
 * PRレビュー指摘（#110 [P3]）: `10_API設計.md`「OpenAPIへの反映」「CORS preflightと
 * 公開header」がOpenAPI文書へ未反映だった。許可originのCatalog GET・戦闘POSTの
 * 全response（成功・エラー問わず、CORSの`onRequest`フックがrouting前に無条件で
 * 付与するため）が実際に持ちうる公開response headerを文書化する。
 */
const CORS_RESPONSE_HEADERS_DOC = {
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
const CORS_PREFLIGHT_RESPONSE_HEADERS_DOC = {
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
const CORS_PREFLIGHT_REQUEST_HEADERS_SCHEMA = {
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
const CORS_PREFLIGHT_REQUIRED_HEADERS = ["origin", "access-control-request-method"] as const;

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
const CORS_PREFLIGHT_INVALID_REQUEST_RESPONSE_DOC = {
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
function withResponseHeadersDoc(
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
 * `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ2「新しい
 * 戦闘リクエストの受付を停止する」だけを担うport。`ReadinessPort`とは意図的に
 * 分離している——Poolが稼働中のCatalogリビジョン不一致で致命的状態になった
 * 場合、`/health/ready`は失敗を報告すべきだが、個々のリクエストは従来どおり
 * `execute()`経由で`500 INVALID_DEFINITION`を返す契約を保つ必要があり
 * （`simulation-worker-pool-poisoning.integration.test.ts`）、この場合は
 * ここでの一律拒否対象ではない。
 */
export interface ShutdownGatePort {
  isShuttingDown(): boolean;
}

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
function genReqId(request: { headers: Record<string, string | string[] | undefined> }): string {
  return resolveRequestId(request.headers["x-request-id"]) ?? randomUUID();
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
 * レビュー指摘: `14_Catalog定義スキーマ.md`のmanifest schemaは`catalogRevision`へ
 * `minLength: 1`しか強制しないため、改行・引用符・バックスラッシュを含む値も
 * 有効なCatalogとして通り得る。生のまま`ETag`ヘッダーへ埋め込むと、RFC 9110
 * §8.8.3の`opaque-tag = DQUOTE *etagc DQUOTE`（`etagc`は`"`・`\`・制御文字を
 * 含まない）に違反するだけでなく、実際にFastifyの
 * `FST_ERR_FAILED_ERROR_SERIALIZATION`による意図しない500
 * （`Cache-Control`・`X-Request-Id`も失われる）を引き起こした。
 *
 * レビュー再指摘: 変換対象外文字を可変長の16進数で`%XX`へ落とし込み、かつ
 * `%`自身をそのまま素通りさせる素朴な実装は単射（injective）ではなかった
 * ——`%`自身が「エスケープ済みの`%`」と「元から`%`だった文字」を区別できない
 * ため、例えば改行1文字(U+000A)は`%0a`（2文字）へ変換される一方、元から
 * リテラル文字列`"%0a"`（3文字の`%`・`0`・`a`）だった値もそのまま`%0a`
 * （素通り）になり、異なる`catalogRevision`が同じETagへ衝突していた
 * （実測: 改行と`"%0a"`、`あ`(U+3042)と`"%3042"`、U+0010+`"0"`と`"%100"`が
 * それぞれ衝突）。これはETagが「representationの変更を識別する」契約に反する
 * ——異なるrevisionへの更新後もクライアントが古いCatalog一覧を304として
 * 再利用してしまう。
 *
 * `etagc`範囲外の文字と`%`自身の両方をエスケープ対象にし、エスケープは常に
 * `%`＋4桁固定長16進（UTF-16コード単位ひとつ分、`￿`まで）にすることで、
 * 「素通りする1文字」と「`%`から始まる5文字のエスケープ」が曖昧さなく区別
 * できる自己区切り(self-delimiting)な符号化にし、単射性を保証する
 * （本プロセス内で自分自身が発行した値とだけ比較するため、他システムとの
 * 標準的なパーセントエンコーディング互換性は不要）。`encodeURIComponent`は
 * 単独サロゲートを含む文字列で例外を送出し得るため使わない。
 */
function toOpaqueEntityTag(catalogRevision: string): string {
  return catalogRevision.replace(
    /[^\x21\x23-\x7E]|%/g,
    (char) => `%${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * `10_API設計.md`「`If-None-Match`が現在のETagと一致する場合は本文なしの304を
 * 返す」。RFC 9110 §13.1.2: `If-None-Match`は弱い比較(weak comparison)を使う
 * ——`W/`接頭辞の有無を無視し、opaque-tagの値だけを比較する（レビュー指摘: 現在
 * 強いETagしか発行しなくても、クライアントが`W/`付きで送ってくる場合を拒否
 * すべきではない）。
 *
 * ヘッダーは`#entity-tag`（カンマ区切りリスト）で、`entity-tag`は
 * `[ "W/" ] DQUOTE *etagc DQUOTE`。`etagc`は`"`を含まないが、生カンマは含み
 * 得るため、単純な`split(",")`はopaque-tag内部のカンマを誤って分割し、正当な
 * ETagを見逃す（レビュー指摘）。ここでは引用符で囲まれた区間だけを正規表現で
 * 取り出し、カンマの位置に関わらず各`entity-tag`のopaque-tagを正しく分離する。
 */
function parseIfNoneMatchOpaqueTags(header: string): readonly string[] {
  const tags: string[] = [];
  const pattern = /(?:W\/)?"([^"]*)"/g;
  for (const match of header.matchAll(pattern)) {
    tags.push(match[1]!);
  }
  return tags;
}

function matchesIfNoneMatch(header: string | string[] | undefined, opaqueTag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value.trim() === "*") {
    return true;
  }
  return parseIfNoneMatchOpaqueTags(value).includes(opaqueTag);
}

interface RequestExecutionState {
  readonly requestId: string;
  readonly cancellationController: AbortController;
}

/**
 * `FastifyRequest`をキーにリクエストごとの実行状態を保持する。`decorateRequest`
 * によるプロパティ拡張の代わりにこの形を選んだのは、`presentation`層内だけで
 * 完結し、Fastifyの型システムを拡張する`declare module`を要求しないため。
 */
const requestExecutionState = new WeakMap<FastifyRequest, RequestExecutionState>();

interface AcceptEntry {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

/**
 * RFC 7231 `Accept`ヘッダーの`media-range[;q=value]`を単純にパースする。
 * RFC 9110 §8.3.1: media typeのtype/subtypeは大文字小文字を区別しない。
 * RFC 9110 §5.6.6: パラメータ名（`q`）も大文字小文字を区別しない。両方とも
 * 比較のために小文字へ正規化する。
 */
function parseAcceptHeader(value: string): readonly AcceptEntry[] {
  return value.split(",").map((entry): AcceptEntry => {
    const [mediaRange = "*/*", ...params] = entry.split(";").map((part) => part.trim());
    const [type = "*", subtype = "*"] = mediaRange.toLowerCase().split("/");
    let q = 1;
    for (const param of params) {
      const [key, rawValue] = param.split("=").map((part) => part.trim());
      if (key?.toLowerCase() === "q" && rawValue !== undefined) {
        const parsed = Number(rawValue);
        if (!Number.isNaN(parsed)) {
          q = parsed;
        }
      }
    }
    return { type, subtype, q };
  });
}

/**
 * `10_API設計.md`「HTTPヘッダー」: `Accept`省略時は`application/json`と
 * みなす。指定されている場合は、最も詳細度の高い一致（完全一致、
 * 次に"application"のtypeワイルドカード、次に完全ワイルドカード）のq値で
 * 判定する。単純な部分文字列一致では `Accept: application/json;q=0` や
 * 完全ワイルドカードだけをq=0にする指定のような明示的な除外を見逃す
 * （q=0は「受理不可」を意味する、RFC 7231）。
 */
function acceptsJson(header: string | string[] | undefined): boolean {
  if (header === undefined) {
    return true;
  }
  const value = Array.isArray(header) ? header.join(",") : header;
  const entries = parseAcceptHeader(value);

  const exact = entries.find((entry) => entry.type === "application" && entry.subtype === "json");
  if (exact !== undefined) {
    return exact.q > 0;
  }
  const typeWildcard = entries.find(
    (entry) => entry.type === "application" && entry.subtype === "*",
  );
  if (typeWildcard !== undefined) {
    return typeWildcard.q > 0;
  }
  const fullWildcard = entries.find((entry) => entry.type === "*" && entry.subtype === "*");
  if (fullWildcard !== undefined) {
    return fullWildcard.q > 0;
  }
  return false;
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

  // `11_インフラストラクチャ設計.md`「サーバー生成」「CORSプラグイン」をroute登録前に
  // 設定する。許可originは`corsAllowedOrigins`（`CORS_ALLOWED_ORIGINS`から構築済みの
  // 完全一致set）が持つ文字列のみ。
  //
  // PRレビュー指摘（#110 [P1]）: `origin`へ配列をそのまま渡すと、`@fastify/cors`は
  // origin不一致（未許可origin、`Origin`なし）でも`Access-Control-Expose-Headers`を
  // 無条件に付与し、preflightでは`Access-Control-Allow-Methods`・
  // `Access-Control-Allow-Headers`まで付与してしまう
  // （`addCorsHeaders`が`corsOptions.exposedHeaders`の有無だけで判定するため）。
  // `origin`を関数にして未許可・`Origin`なしの場合は明示的に`false`を返すことで、
  // `@fastify/cors`が`resolvedOriginOption === false`を検知しCORS処理全体
  // （`addCorsHeaders`・preflightの`addPreflightHeaders`）を丸ごとskipするようにする
  // ——`next()`のみ呼ばれ、request自体は拒否しない。
  const corsAllowedOriginsSet = new Set(options.corsAllowedOrigins ?? DEFAULT_CORS_ALLOWED_ORIGINS);
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

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "muvluvgg-battle-simulator API", version: "1" },
      paths: {},
    },
    // `10_API設計.md`はOpenAPIへ値域・列挙値の自動検証を要求するが、
    // `column`/`row`/`logLevel`/`turnLimit`などの値域違反は「422
    // INVALID_COMMAND」として集約検証したい（`schemas.ts`冒頭の注記）。
    // ここで公開文書だけ`battleSimulationRequestDocSchema`（値域・列挙値付き）
    // へ差し替え、実行時validationに使う`route.schema`本体は変更しない。
    // レスポンス側も同様に、`events[].details`のイベント種別ごとの構造は
    // `battleSimulationResponseDocSchema`で公開文書だけ書き足す
    // （実データがそのまま流れる出力を厳格化して壊さないよう、実行時
    // serializationは`battleSimulationResponseSchema`のまま変更しない）。
    transform: ({ schema, url, route }) => {
      // PRレビュー指摘（#110 [P3]）: 下の`app.options(path, ...)`ループが登録する
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
    // `11_インフラストラクチャ設計.md`「メインスレッドの責務」: Request IDの
    // 採番とHTTP切断検知は、後続の`preValidation`やルートハンドラーより前の
    // 最も早いフックで一度だけ行う。`request.id`は上の`genReqId`が
    // （`X-Request-Id`ヘッダー、なければ新規UUID）で解決済みの値そのもの
    // ——ここで改めて解決し直す必要はない。
    //
    // 切断検知は`reply.raw`（`ServerResponse`）の`close`を見る。`request.raw`
    // （`IncomingMessage`）の`close`はリクエスト本文を読み終えた時点で
    // ほぼ即座に発火し、クライアントが接続を維持しているか否かを問わない
    // ——実際に`request.raw`で監視すると、切断していない通常リクエストまで
    // キャンセル扱いになるレグレッションを引き起こした。`reply.raw`の`close`は
    // 応答の送信が完了する前に接続が終了した場合にだけ意味を持つため、
    // `!reply.raw.writableEnded`（＝まだ応答を書き終えていない）で正常完了後の
    // 発火と区別する。
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
    // `onRequest`が全リクエストで先に実行され`requestExecutionState`へ登録
    // 済みのため、通常はここに必ず存在する。ただしCORS preflight（`OPTIONS`）は
    // `@fastify/cors`自身の`onRequest`フックが`reply.send()`で即座に応答を終える
    // ため、後続に登録した本フックの`onRequest`ハンドラーへ到達せず、
    // `requestExecutionState`へ登録されない。`request.id`は`genReqId`により
    // 同じ値へ解決済みのため、fallbackとして使う。
    reply.header("X-Request-Id", requestExecutionState.get(request)?.requestId ?? request.id);
    done(null, payload);
  });

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
        // ——正常完了後の`close`では中断しない、上の`onRequest`フック参照）ため、
        // このコード到達時点で`reply.raw.destroyed`なら送信を試みずに終了する。
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

  app.post(
    "/api/v1/battle-simulations",
    {
      schema: {
        body: battleSimulationRequestSchema,
        response: { 200: battleSimulationResponseSchema, ...ERROR_RESPONSES },
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

      // `onRequest`が全リクエストで先に実行され`requestExecutionState`へ登録
      // 済みのため、ここでは必ず存在する。
      const { requestId, cancellationController } = requestExecutionState.get(request)!;
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

  app.get(
    BATTLE_SIMULATION_CATALOG_PATH,
    {
      schema: {
        response: { 200: battleSimulationCatalogResponseSchema, ...CATALOG_ERROR_RESPONSES },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      // `11_インフラストラクチャ設計.md`「`GET /api/v1/battle-simulation-catalog`
      // のハンドラーは次だけを行う」: 起動時に構築済みのResultを参照し、
      // ETag比較で200/304を出し分けるだけ——Catalogファイルの読み込みや
      // Capability計算をリクエストごとに行わない。
      const result = catalogUseCase.execute();
      const opaqueTag = toOpaqueEntityTag(result.catalogRevision);
      const etag = `"${opaqueTag}"`;
      reply.header("ETag", etag);
      if (matchesIfNoneMatch(request.headers["if-none-match"], opaqueTag)) {
        // `10_API設計.md`「304では送らない」: Content-Typeを含む本文関連
        // ヘッダーを付けず、空bodyで返す。
        void reply.code(304).send();
        return;
      }
      void reply.code(200).send(toBattleSimulationCatalogResponseBody(result));
    },
  );

  // PRレビュー指摘（#110 [P3]）: `10_API設計.md`「OpenAPIへの反映」「CORS
  // preflightと公開header」に対応するため、Catalog GET・戦闘POSTそれぞれの
  // path向けにOPTIONS operationを文書化専用として登録する。実際のpreflight
  // 応答は`@fastify/cors`自身の`onRequest`フックがrouting前に完結させる
  // （許可originなら`reply.send()`まで済ませ、このhandlerへは到達しない）ため、
  // ここでのhandlerは未許可originや`Origin`なしの稀な経路でのみ実行され、
  // 実質的にはOpenAPI文書へ「preflightが存在する」ことを反映するためだけに置く。
  for (const path of [BATTLE_SIMULATIONS_PATH, BATTLE_SIMULATION_CATALOG_PATH]) {
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

  app.get("/openapi.json", (_request, reply) => {
    void reply.send(app.swagger());
  });

  return app;
}
