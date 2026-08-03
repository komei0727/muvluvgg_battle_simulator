import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { simulate } from "./api-client.js";
import type { BattleSimulationRequest } from "../formation/request-mapper.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const validRequest: BattleSimulationRequest = {
  allyFormation: {
    units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  turnLimit: 10,
  options: { logLevel: "DETAILED" },
};

const validResponseBody = {
  schemaVersion: 1,
  battleId: "battle-01J",
  catalogRevision: "rev-1",
  result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
  initialState: {
    stateVersion: 0,
    battleStatus: "READY",
    turnNumber: 0,
    cycleNumber: 0,
    units: [],
  },
  finalState: {
    stateVersion: 3,
    battleStatus: "COMPLETED",
    turnNumber: 3,
    cycleNumber: 0,
    units: [],
  },
  events: [],
  stateTransitions: [],
};

describe("simulate", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("POSTs the request with Content-Type, Accept, X-Request-Id, no-store cache, and omitted credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      requestId: "ui-req-1",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/battle-simulations");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(validRequest));
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Request-Id")).toBe("ui-req-1");
  });

  it("omits the X-Request-Id header when no requestId is supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("X-Request-Id")).toBe(false);
  });

  it("returns ok:true with the validated response on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, validResponseBody, { "X-Request-Id": "srv-req-1" }),
    );

    const result = await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true, response: validResponseBody, requestId: "srv-req-1" });
  });

  it("returns a RESPONSE_CONTRACT_MISMATCH error when the 200 body fails validation", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { schemaVersion: 1 }));

    const result = await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });

  it("normalizes a 422 INVALID_COMMAND error response with violations", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        schemaVersion: 1,
        error: {
          code: "INVALID_COMMAND",
          message: "Invalid.",
          violations: [{ path: "/turnLimit", message: "must be 1-99" }],
        },
      }),
    );

    const result = await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("VALIDATION");
      expect(result.status).toBe(422);
      expect(result.error.violations).toEqual([{ path: "/turnLimit", message: "must be 1-99" }]);
    }
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

    const result = await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("CAPACITY");
      expect(result.retryAfterSeconds).toBe(45);
    }
  });

  it("normalizes a 504 EXECUTION_TIMEOUT error response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(504, {
        schemaVersion: 1,
        error: { code: "EXECUTION_TIMEOUT", message: "Timed out.", violations: [] },
      }),
    );

    const result = await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("TIMEOUT");
    }
  });

  it("returns CORS_OR_NETWORK when fetch rejects with a TypeError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await simulate(validRequest, {
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

    const resultPromise = simulate(validRequest, {
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

  it("returns TIMEOUT when the internal 35s wait limit elapses before the caller aborts", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const resultPromise = simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("TIMEOUT");
    }
  });

  it("does not auto-retry on failure (fetch is called exactly once)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, {
        schemaVersion: 1,
        error: { code: "CAPACITY_EXCEEDED", message: "Busy.", violations: [] },
      }),
    );

    await simulate(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
