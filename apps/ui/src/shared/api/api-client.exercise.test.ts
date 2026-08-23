import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { simulateTacticalExercise } from "./api-client.js";
import type { TacticalExerciseRequest } from "./api-contract.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const validRequest: TacticalExerciseRequest = {
  allyFormation: {
    units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  options: { logLevel: "DETAILED" },
};

const validResponseBody = {
  schemaVersion: 1,
  battleId: "exercise-01J",
  catalogRevision: "rev-1",
  result: {
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    totalScore: 4200,
    breakCount: 1,
    breaks: [{ breakNumber: 1, turnNumber: 3, cumulativeScoreAtBreak: 2100 }],
  },
  initialState: { stateVersion: 0, battleStatus: "READY", turnNumber: 0, units: [] },
  finalState: { stateVersion: 5, battleStatus: "COMPLETED", turnNumber: 5, units: [] },
  unitSummaries: [],
  events: [],
  stateTransitions: [],
};

describe("simulateTacticalExercise", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
  });

  it("POSTs to /api/v1/tactical-exercises with the battle POST's cache and credential policy", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await simulateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      requestId: "ui-req-1",
      fetchImpl: fetchMock,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/tactical-exercises");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Request-Id")).toBe("ui-req-1");
  });

  // UI-API-014: リクエスト本文へ`turnLimit`を含めない。
  it("sends no turnLimit property in the request body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await simulateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("turnLimit");
  });

  it("returns ok:true with the validated exercise response on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, validResponseBody, { "X-Request-Id": "srv-req-1" }),
    );

    const result = await simulateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true, response: validResponseBody, requestId: "srv-req-1" });
  });

  // UI-API-015: `result`の契約違反は`RESPONSE_CONTRACT_MISMATCH`。
  it("maps a 200 whose result breaks the exercise contract to RESPONSE_CONTRACT_MISMATCH", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validResponseBody,
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      }),
    );

    const result = await simulateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  it("normalizes a 422 into a VALIDATION error carrying the server violations", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        schemaVersion: 1,
        error: {
          code: "INVALID_COMMAND",
          message: "invalid",
          violations: [{ path: "/enemyFormation/units", message: "敵は1体" }],
        },
      }),
    );

    const result = await simulateTacticalExercise(validRequest, {
      baseUrl: "https://api.example.com",
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("VALIDATION");
    expect(result.ok ? undefined : result.error.violations).toHaveLength(1);
  });
});
