import type {
  CatalogApiResult,
  FormationStatPreviewApiResult,
  SimulationApiResult,
  UiApiError,
} from "./api-contract.js";
import {
  normalizeHttpErrorResponse,
  normalizeRequestException,
  parseRetryAfterSeconds,
} from "./error-normalizer.js";
import {
  validateCatalogResponse,
  validateFormationStatPreviewResponse,
  validateSimulationResponse,
} from "./response-validator.js";
import type {
  BattleSimulationRequest,
  FormationStatPreviewRequest,
} from "../formation/request-mapper.js";

const CATALOG_PATH = "/api/v1/battle-simulation-catalog";
// docs/ui-design/03_API・データ連携設計.md §7: 「一覧GETには10秒のUI待機上限を
// 設け、戦闘実行用AbortControllerと共有しない」。
const DEFAULT_TIMEOUT_MS = 10_000;
const SIMULATION_PATH = "/api/v1/battle-simulations";
// docs/ui-design/03_API・データ連携設計.md §7: 「UIは35秒を既定のクライアント
// 待機上限とし、API側が構造化504を返す余地を残す」。
const SIMULATION_DEFAULT_TIMEOUT_MS = 35_000;
const PREVIEW_PATH = "/api/v1/formation-stat-previews";
// docs/ui-design/03_API・データ連携設計.md §2.5: プレビューは戦闘を実行せず
// 同期的に返るため、戦闘POSTの35秒ではなく一覧GETと同じ待機上限で十分。
const PREVIEW_DEFAULT_TIMEOUT_MS = 10_000;

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

// Rethrows an aborted body read instead of swallowing it, so the caller can
// distinguish "the wait limit / caller cancelled while reading the body"
// from an ordinary malformed-JSON response.
async function parseJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return null;
  }
}

interface JsonRequestSpec {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  // 省略時はfetchの既定cache modeを使う。docs/ui-design/03_API・データ連携設計.md
  // §2.3 のとおり no-store は戦闘POST専用で、一覧GETはHTTP cache/ETagを使う。
  readonly cache?: RequestCache;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
}

interface JsonResponseContext {
  readonly response: Response;
  /** サーバがX-Request-Idを返した場合のみ`requestId`を持つ。結果へspreadする。 */
  readonly requestIdField: { readonly requestId?: string };
  /** JSON本文を読む。壊れたJSONはnull、中断された読み取りはthrowで伝わる。 */
  readonly readBody: () => Promise<unknown>;
  readonly retryAfterSeconds: number | undefined;
}

/** 待機上限・中断・requestId・ネットワーク例外の扱いは全エンドポイントで同一。 */
interface RequestFailure {
  readonly ok: false;
  readonly error: UiApiError;
}

// 待機上限つきでJSONエンドポイントを1回だけ呼び、レスポンス解釈のみを
// handleResponseへ委ねる。自動retryはしない(呼び出し側の責務)。
async function requestJson<TResult>(
  spec: JsonRequestSpec,
  handleResponse: (context: JsonResponseContext) => Promise<TResult>,
): Promise<TResult | RequestFailure> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, spec.timeoutMs);
  const combinedSignal = AbortSignal.any([spec.signal, timeoutController.signal]);

  // The timer and combined signal must stay live until the response body has
  // been fully read and validated: fetch() resolves as soon as headers
  // arrive, but response.json() can still hang on a stalled body stream.
  try {
    let response: Response;
    try {
      // `spec.fetchImpl(...)`と書くと`this`が`spec`になり、ブラウザの組み込み
      // fetchが Illegal invocation で失敗する。必ず束縛のない呼び出しにする。
      const { fetchImpl } = spec;
      response = await fetchImpl(spec.url, {
        method: spec.method,
        headers: spec.headers,
        credentials: "omit",
        ...(spec.cache !== undefined ? { cache: spec.cache } : {}),
        ...(spec.body !== undefined ? { body: spec.body } : {}),
        signal: combinedSignal,
      });
    } catch (error) {
      return { ok: false, error: normalizeRequestException(error, { timedOut }) };
    }

    const requestIdHeader = response.headers.get("X-Request-Id");
    try {
      return await handleResponse({
        response,
        requestIdField: requestIdHeader !== null ? { requestId: requestIdHeader } : {},
        readBody: () => parseJsonBody(response),
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("Retry-After")),
      });
    } catch (error) {
      // parseJsonBodyが再throwするのは中断された読み取りだけ。それ以外は
      // handleResponse側の欠陥であり、リクエスト失敗へ握り潰してはならない。
      if (!isAbortError(error)) {
        throw error;
      }
      return { ok: false, error: normalizeRequestException(error, { timedOut }) };
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface GetCatalogOptions {
  readonly baseUrl: string;
  readonly signal: AbortSignal;
  readonly etag?: string;
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function requestHeaders(options: GetCatalogOptions): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (options.requestId !== undefined) {
    headers.set("X-Request-Id", options.requestId);
  }
  if (options.etag !== undefined) {
    headers.set("If-None-Match", options.etag);
  }
  return headers;
}

export async function getCatalog(options: GetCatalogOptions): Promise<CatalogApiResult> {
  return requestJson<CatalogApiResult>(
    {
      url: `${options.baseUrl}${CATALOG_PATH}`,
      method: "GET",
      headers: requestHeaders(options),
      // docs/ui-design/03_API・データ連携設計.md §2.3: 一覧GETはHTTP
      // cache/ETagを利用する(no-storeは戦闘POST専用)。Catalog 200/304は
      // Cache-Control: public, max-age=300を返すため、cacheを指定せず
      // 既定のcache modeでブラウザキャッシュを再利用させる。
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    async ({ response, requestIdField, readBody, retryAfterSeconds }) => {
      if (response.status === 304) {
        // 304 is only a valid response to a conditional GET; without an etag
        // we sent, a 304 body is a server contract violation, not a cache hit.
        if (options.etag === undefined) {
          return {
            ok: false,
            status: 304,
            ...requestIdField,
            error: {
              kind: "RESPONSE_CONTRACT_MISMATCH",
              message: "Received 304 Not Modified without sending a conditional If-None-Match.",
            },
          };
        }
        const etag = response.headers.get("ETag") ?? options.etag;
        return { ok: true, notModified: true, etag, ...requestIdField };
      }

      if (response.status === 200) {
        const validation = validateCatalogResponse(await readBody());
        if (!validation.ok) {
          return { ok: false, status: 200, ...requestIdField, error: validation.error };
        }
        const etagHeader = response.headers.get("ETag");
        return {
          ok: true,
          response: validation.response,
          ...requestIdField,
          ...(etagHeader !== null ? { etag: etagHeader } : {}),
        };
      }

      const body = await readBody();
      return {
        ok: false,
        status: response.status,
        ...requestIdField,
        error: normalizeHttpErrorResponse({
          status: response.status,
          body,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        }),
      };
    },
  );
}

export interface SimulateOptions {
  readonly baseUrl: string;
  readonly signal: AbortSignal;
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function simulationRequestHeaders(options: SimulateOptions): Headers {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  if (options.requestId !== undefined) {
    headers.set("X-Request-Id", options.requestId);
  }
  return headers;
}

// docs/ui-design/03_API・データ連携設計.md §2.3, §7: 戦闘POSTは cache:
// "no-store"、credentials: "omit" とし、自動retryしない(このcallerはfetchを
// 一度だけ呼ぶ。呼び出し側のretryも別issueで扱う)。
export async function simulate(
  request: BattleSimulationRequest,
  options: SimulateOptions,
): Promise<SimulationApiResult> {
  return requestJson<SimulationApiResult>(
    {
      url: `${options.baseUrl}${SIMULATION_PATH}`,
      method: "POST",
      headers: simulationRequestHeaders(options),
      cache: "no-store",
      body: JSON.stringify(request),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? SIMULATION_DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    async ({ response, requestIdField, readBody, retryAfterSeconds }) => {
      const body = await readBody();

      if (response.status === 200) {
        const validation = validateSimulationResponse(body);
        if (!validation.ok) {
          return { ok: false, status: 200, ...requestIdField, error: validation.error };
        }
        return { ok: true, response: validation.response, ...requestIdField };
      }

      return {
        ok: false,
        status: response.status,
        ...requestIdField,
        error: normalizeHttpErrorResponse({
          status: response.status,
          body,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        }),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    },
  );
}

// docs/ui-design/03_API・データ連携設計.md §2.5: プレビューPOSTは戦闘POSTと
// 同じ cache/credentials 方針を使い、自動retryしない。失敗しても戦闘実行の
// 可否へ波及させないのは呼び出し側（use-formation-stat-preview.ts）の責務。
export async function previewFormationStats(
  request: FormationStatPreviewRequest,
  options: SimulateOptions,
): Promise<FormationStatPreviewApiResult> {
  return requestJson<FormationStatPreviewApiResult>(
    {
      url: `${options.baseUrl}${PREVIEW_PATH}`,
      method: "POST",
      headers: simulationRequestHeaders(options),
      cache: "no-store",
      body: JSON.stringify(request),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? PREVIEW_DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    async ({ response, requestIdField, readBody, retryAfterSeconds }) => {
      const body = await readBody();

      if (response.status === 200) {
        const validation = validateFormationStatPreviewResponse(body);
        if (!validation.ok) {
          return { ok: false, status: 200, ...requestIdField, error: validation.error };
        }
        return { ok: true, response: validation.response, ...requestIdField };
      }

      return {
        ok: false,
        status: response.status,
        ...requestIdField,
        error: normalizeHttpErrorResponse({
          status: response.status,
          body,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        }),
      };
    },
  );
}
