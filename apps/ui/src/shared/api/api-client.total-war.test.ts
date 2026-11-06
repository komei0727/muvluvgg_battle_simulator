import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { simulateTotalWar } from "./api-client.js";
import type { TotalWarRequest } from "./api-contract.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function formation(unitDefinitionId: string) {
  return {
    units: [{ unitDefinitionId, position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  } as const;
}

const validRequest: TotalWarRequest = {
  allyFormations: [formation("UNIT_ALLY")],
  enemyFormations: [formation("UNIT_ENEMY"), formation("UNIT_ENEMY")],
  options: { logLevel: "SUMMARY" },
};

function rosterEntry(battleUnitId: string, side: string, formationNumber: number) {
  return {
    battleUnitId,
    unitDefinitionId: side === "ALLY" ? "UNIT_ALLY" : "UNIT_ENEMY",
    side,
    formationNumber,
    formationPosition: { column: 0, row: "FRONT" },
    reappearance: formationNumber > 1,
    deployed: true,
  };
}

function summary(battleUnitId: string, side: string, formationNumber: number) {
  return {
    battleUnitId,
    side,
    formationNumber,
    deployed: true,
    damageDealt: 0,
    damageTaken: 0,
    healingDone: 0,
    finalHp: 0,
    maximumHp: 100,
    combatStatus: "DEFEATED",
  };
}

const validResponseBody = {
  schemaVersion: 1,
  battleId: "B_TOTAL_WAR",
  catalogRevision: "rev-1",
  result: {
    outcome: "DRAW",
    completionReason: "SIMULTANEOUS_DEFEAT",
    completedTurn: 2,
    stages: [
      {
        stageNumber: 1,
        allyFormationNumber: 1,
        enemyFormationNumber: 1,
        startTurn: 1,
        endTurn: 1,
        defeatedSides: ["ENEMY"],
      },
      {
        stageNumber: 2,
        allyFormationNumber: 1,
        enemyFormationNumber: 2,
        startTurn: 2,
        endTurn: 2,
        defeatedSides: ["ALLY", "ENEMY"],
      },
    ],
    defeatedFormationCounts: { ally: 1, enemy: 2 },
  },
  initialState: { units: [] },
  unitRoster: [
    rosterEntry("A1", "ALLY", 1),
    rosterEntry("E1", "ENEMY", 1),
    rosterEntry("E2", "ENEMY", 2),
  ],
  unitSummaries: [summary("A1", "ALLY", 1), summary("E1", "ENEMY", 1), summary("E2", "ENEMY", 2)],
  events: [],
  stateTransitions: [],
};

function neverSettlingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

// docs/ui-design/03_API・データ連携設計.md §2.7: 認証・cache・credentials・自動retryしないこと・
// タイムアウトとキャンセルは戦闘シミュレーションと同じ。
describe("simulateTotalWar", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function call(signal = new AbortController().signal, extra: { accessKey?: string } = {}) {
    return simulateTotalWar(validRequest, {
      baseUrl: "https://api.example.com",
      signal,
      requestId: "ui-req-1",
      fetchImpl: fetchMock,
      ...extra,
    });
  }

  it("POSTs to /api/v1/total-war-simulations with the battle POST's headers, cache and credential policy", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await call();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/total-war-simulations");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Request-Id")).toBe("ui-req-1");
  });

  // UI-API-046: 送信本文は組み立て済みのリクエストそのままで、`turnLimit`を足さない。
  it("sends the formations in deployment order and no turnLimit", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validResponseBody));

    await call();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toEqual(validRequest);
    expect(sent).not.toHaveProperty("turnLimit");
  });

  it("returns ok:true with the validated total war response on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, validResponseBody, { "X-Request-Id": "srv-req-1" }),
    );

    const result = await call();

    expect(result).toEqual({ ok: true, response: validResponseBody, requestId: "srv-req-1" });
  });

  // UI-API-049: 総力戦の契約で検証する。通常戦闘の結果（`stages`が無い）は通さない。
  it("maps a 200 that breaks the total war contract to RESPONSE_CONTRACT_MISMATCH", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validResponseBody,
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      }),
    );

    const result = await call();

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.status).toBe(200);
    expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  it("normalizes a 422 into a VALIDATION error carrying the formation-indexed violations", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        schemaVersion: 1,
        error: {
          code: "INVALID_COMMAND",
          message: "invalid",
          violations: [{ path: "/enemyFormations/1/units/0/unitDefinitionId", message: "重複" }],
        },
      }),
    );

    const result = await call();

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("VALIDATION");
    expect(result.ok ? undefined : result.error.violations?.[0]?.path).toBe(
      "/enemyFormations/1/units/0/unitDefinitionId",
    );
  });

  // UI-API-052: アクセスキーを送り、401を`UNAUTHORIZED`として呼び出し側へ返す。
  it("sends the access key and returns a 401 as UNAUTHORIZED", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        schemaVersion: 1,
        error: { code: "UNAUTHORIZED", message: "Unauthorized.", violations: [] },
      }),
    );

    const result = await call(undefined, { accessKey: "k".repeat(40) });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${"k".repeat(40)}`);
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.status).toBe(401);
    expect(result.ok ? undefined : result.error.kind).toBe("UNAUTHORIZED");
  });

  it("carries Retry-After on a 503 and does not auto-retry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        503,
        {
          schemaVersion: 1,
          error: { code: "CAPACITY_EXCEEDED", message: "Busy.", violations: [] },
        },
        { "Retry-After": "7" },
      ),
    );

    const result = await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok ? undefined : result.error.kind).toBe("CAPACITY");
    expect(result.ok ? undefined : result.retryAfterSeconds).toBe(7);
  });

  it("returns CANCELLED when the caller-provided signal is aborted", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(neverSettlingFetch);

    const resultPromise = call(controller.signal);
    controller.abort();
    const result = await resultPromise;

    expect(result.ok ? undefined : result.error.kind).toBe("CANCELLED");
  });

  it("returns TIMEOUT when the 55s wait limit elapses", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(neverSettlingFetch);

    const resultPromise = call();
    await vi.advanceTimersByTimeAsync(54_999);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.ok ? undefined : result.error.kind).toBe("TIMEOUT");
  });
});
