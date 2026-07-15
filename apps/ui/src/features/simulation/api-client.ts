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

async function parseJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
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

  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl}${CATALOG_PATH}`, {
      method: "GET",
      headers: requestHeaders(options),
      credentials: "omit",
      cache: "no-store",
      signal: combinedSignal,
    });
  } catch (error) {
    return { ok: false, error: normalizeRequestException(error, { timedOut }) };
  } finally {
    clearTimeout(timeoutId);
  }

  const requestIdHeader = response.headers.get("X-Request-Id");
  const requestIdField = requestIdHeader !== null ? { requestId: requestIdHeader } : {};

  if (response.status === 304) {
    const etag = response.headers.get("ETag") ?? options.etag;
    if (etag === undefined) {
      return {
        ok: false,
        status: 304,
        ...requestIdField,
        error: {
          kind: "RESPONSE_CONTRACT_MISMATCH",
          message: "Received 304 Not Modified without a matching ETag.",
        },
      };
    }
    return { ok: true, notModified: true, etag, ...requestIdField };
  }

  if (response.status === 200) {
    const body = await parseJsonBody(response);
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

  const body = await parseJsonBody(response);
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
}
