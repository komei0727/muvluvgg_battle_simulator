import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { getCatalog } from "./api-client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const validCatalogBody = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: [],
  memories: [],
};

describe("getCatalog", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests the catalog endpoint with Accept, X-Request-Id, and If-None-Match, omitting credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validCatalogBody, { ETag: '"etag-1"' }));

    await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      etag: '"etag-0"',
      requestId: "ui-req-1",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/battle-simulation-catalog");
    const headers = new Headers(init.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Request-Id")).toBe("ui-req-1");
    expect(headers.get("If-None-Match")).toBe('"etag-0"');
    expect(init.credentials).toBe("omit");
  });

  // docs/ui-design/03_API・データ連携設計.md §2.3: 一覧GETはHTTP cache/ETagを
  // 利用し、no-storeは戦闘POST専用(apps/api/.../build-server.ts: catalog 200/304
  // はCache-Control: public, max-age=300を返す)。
  it("does not disable the browser HTTP cache for the catalog GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validCatalogBody));

    await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).not.toBe("no-store");
  });

  it("omits the X-Request-Id header when no requestId is supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validCatalogBody));

    await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("X-Request-Id")).toBe(false);
    expect(headers.has("If-None-Match")).toBe(false);
  });

  it("returns ok:true with the validated response and etag on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, validCatalogBody, { ETag: '"etag-2"', "X-Request-Id": "srv-req-1" }),
    );

    const result = await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: true,
      response: validCatalogBody,
      etag: '"etag-2"',
      requestId: "srv-req-1",
    });
  });

  it("returns a RESPONSE_CONTRACT_MISMATCH error when the 200 body fails validation", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { schemaVersion: 2 }));

    const result = await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });

  it("returns notModified:true with the matched etag on 304", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 304, headers: { ETag: '"etag-3"' } }));

    const result = await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      etag: '"etag-3"',
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true, notModified: true, etag: '"etag-3"', requestId: undefined });
  });

  it("normalizes a 503 CAPACITY_EXCEEDED error response, including Retry-After", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        503,
        {
          schemaVersion: 1,
          error: { code: "CAPACITY_EXCEEDED", message: "Busy.", violations: [] },
        },
        { "Retry-After": "45" },
      ),
    );

    const result = await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("CAPACITY");
      expect(result.error.retryAfterSeconds).toBe(45);
      expect(result.status).toBe(503);
    }
  });

  it("returns CORS_OR_NETWORK when fetch rejects with a TypeError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("CORS_OR_NETWORK");
    }
  });

  it("returns CANCELLED when the caller-provided signal is aborted", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const resultPromise = getCatalog({
      baseUrl: "https://api.example.com",
      signal: controller.signal,
      fetchImpl: fetchMock,
    });
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("CANCELLED");
    }
  });

  it("returns TIMEOUT when the internal wait limit elapses before the caller aborts", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const resultPromise = getCatalog({
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
      timeoutMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("TIMEOUT");
    }
  });
});
