import { describe, expect, it, vi } from "vitest";
import { previewFormationStats } from "./api-client.js";
import type { FormationStatPreviewRequest } from "../formation/request-mapper.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const request: FormationStatPreviewRequest = {
  allyFormation: {
    units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
};

const responseBody = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: [
    {
      side: "ALLY",
      unitDefinitionId: "UNIT_ALLY",
      formationPosition: { column: 0, row: "FRONT" },
      maximumHp: 1000,
      combatStats: {
        attack: 100,
        defense: 50,
        criticalRate: 12.5,
        actionSpeed: 12,
        affinityBonus: 25,
        criticalDamageBonus: 50,
      },
    },
  ],
};

describe("previewFormationStats (UI-API-020/021)", () => {
  it("posts the formations to the preview endpoint with no-store and returns the validated body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, responseBody));

    const result = await previewFormationStats(request, {
      baseUrl: "https://api.example",
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/api/v1/formation-stat-previews");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(result).toEqual({ ok: true, response: responseBody });
  });

  it("normalizes a 422 into a failed result instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        schemaVersion: 1,
        error: { code: "DEFINITION_NOT_FOUND", message: "unknown unit", violations: [] },
      }),
    );

    const result = await previewFormationStats(request, {
      baseUrl: "https://api.example",
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("DEFINITION_NOT_FOUND");
  });

  it("reports a contract mismatch when a 200 body is malformed, rather than surfacing partial stats", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ...responseBody, units: [{ side: "ALLY" }] }));

    const result = await previewFormationStats(request, {
      baseUrl: "https://api.example",
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  it("normalizes a network failure into a failed result", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await previewFormationStats(request, {
      baseUrl: "https://api.example",
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
  });
});
