import type { CatalogApiResult } from "./api-contract.js";
import {
  normalizeHttpErrorResponse,
  normalizeRequestException,
  parseRetryAfterSeconds,
} from "./error-normalizer.js";
import { validateCatalogResponse } from "./response-validator.js";

const CATALOG_PATH = "/api/v1/battle-simulation-catalog";
// docs/ui-design/03_API・データ連携設計.md §7: 「一覧GETには10秒のUI待機上限を
// 設け、戦闘実行用AbortControllerと共有しない」。
const DEFAULT_TIMEOUT_MS = 10_000;

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

export async function getCatalog(options: GetCatalogOptions): Promise<CatalogApiResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([options.signal, timeoutController.signal]);

  // The timer and combined signal must stay live until the response body has
  // been fully read and validated: fetch() resolves as soon as headers
  // arrive, but response.json() can still hang on a stalled body stream.
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${CATALOG_PATH}`, {
        method: "GET",
        headers: requestHeaders(options),
        credentials: "omit",
        // docs/ui-design/03_API・データ連携設計.md §2.3: 一覧GETはHTTP
        // cache/ETagを利用する(no-storeは戦闘POST専用)。Catalog 200/304は
        // Cache-Control: public, max-age=300を返すため、既定のcache modeで
        // ブラウザキャッシュを再利用させる。
        signal: combinedSignal,
      });
    } catch (error) {
      return { ok: false, error: normalizeRequestException(error, { timedOut }) };
    }

    const requestIdHeader = response.headers.get("X-Request-Id");
    const requestIdField = requestIdHeader !== null ? { requestId: requestIdHeader } : {};

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
      let body: unknown;
      try {
        body = await parseJsonBody(response);
      } catch (error) {
        return { ok: false, error: normalizeRequestException(error, { timedOut }) };
      }
      const validation = validateCatalogResponse(body);
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

    let body: unknown;
    try {
      body = await parseJsonBody(response);
    } catch (error) {
      return { ok: false, error: normalizeRequestException(error, { timedOut }) };
    }
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("Retry-After"));
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
  } finally {
    clearTimeout(timeoutId);
  }
}
