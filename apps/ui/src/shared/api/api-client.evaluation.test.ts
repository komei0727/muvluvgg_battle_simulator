import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { evaluateTacticalExercise } from "./api-client.js";
import type { TacticalExerciseEvaluationRequest } from "./api-contract.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const validRequest: TacticalExerciseEvaluationRequest = {
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  candidates: [
    {
      allyFormation: {
        units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
    },
  ],
  runsPerCandidate: 2,
  seed: "abc#0",
};

const validResponseBody = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  seed: "abc#0",
  runsPerCandidate: 2,
  candidates: [
    {
      completedRuns: 2,
      scores: [10, 20],
      breakCounts: [1, 2],
      completedTurns: [5, 5],
      completionReasons: ["TURN_LIMIT_REACHED", "ALLY_DEFEATED"],
      allyUnitDamageTotals: [[6], [12]],
      allyUnitBreakCounts: [[1], [1]],
    },
  ],
};

// UI-UT-API-019: 一括評価POSTは戦闘POSTと同じ cache／credentials／待機上限の方針を使う。
describe("evaluateTacticalExercise", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
  });

  it("POSTs to /api/v1/tactical-exercise-evaluations with the battle POST's cache and credential policy", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await evaluateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      requestId: "ui-req-1",
      fetchImpl: fetchMock,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/tactical-exercise-evaluations");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Request-Id")).toBe("ui-req-1");
    expect(JSON.parse(init.body as string)).toEqual(validRequest);
  });

  it("returns ok:true with the validated evaluation response on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, validResponseBody, { "X-Request-Id": "srv-req-1" }),
    );

    const result = await evaluateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true, response: validResponseBody, requestId: "srv-req-1" });
  });

  it("maps a 200 that breaks the evaluation contract to RESPONSE_CONTRACT_MISMATCH", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validResponseBody,
        candidates: [{ ...validResponseBody.candidates[0], scores: [10] }],
      }),
    );

    const result = await evaluateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  // 404 `ENDPOINT_DISABLED` は実装が無いのではなく設定で閉じている（Q-TEX-19）。
  // codeを保ったまま返し、案内の文言は呼び出し側が決める。
  it("keeps the ENDPOINT_DISABLED code of a 404", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        schemaVersion: 1,
        error: {
          code: "ENDPOINT_DISABLED",
          message: "This endpoint is not enabled on this server.",
          violations: [],
        },
      }),
    );

    const result = await evaluateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("ENDPOINT_DISABLED");
    expect(result.ok ? undefined : result.error.status).toBe(404);
  });

  it("carries Retry-After of a 429 into the result", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        429,
        {
          schemaVersion: 1,
          error: { code: "RATE_LIMIT_EXCEEDED", message: "too many", violations: [] },
        },
        { "Retry-After": "30" },
      ),
    );

    const result = await evaluateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("RATE_LIMIT");
    expect(result.ok ? undefined : result.retryAfterSeconds).toBe(30);
  });

  it("reports a cancelled request as CANCELLED instead of a network failure", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const pending = evaluateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: controller.signal,
      fetchImpl: fetchMock,
    });
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("CANCELLED");
  });
});
