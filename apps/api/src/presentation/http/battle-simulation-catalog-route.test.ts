import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type GetBattleSimulationCatalogUseCasePort,
  type SimulateBattleUseCasePort,
} from "./build-server.js";
import type { BattleSimulationCatalogResponseBody } from "../../application/contracts/catalog.js";
import type { BattleSimulationCatalogResult } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";

const CATALOG_PATH = "/api/v1/battle-simulation-catalog";

/** No test in this file exercises `POST /api/v1/battle-simulations`. */
const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

function fakeCatalogResult(
  overrides: Partial<BattleSimulationCatalogResult> = {},
): BattleSimulationCatalogResult {
  return {
    catalogRevision: "2026-07-12.12",
    units: [
      {
        unitDefinitionId: "UNIT_MEIYA_FATED",
        displayName: "【天命を受けし剣術乙女】御剣冥夜",
        characterName: "御剣冥夜",
        attribute: "SHY",
        unitType: "PHYSICAL",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
        selectable: true,
        unavailableCapabilities: [],
      },
    ],
    memories: [
      {
        memoryDefinitionId: "MEM_HEART_COLOR",
        displayName: "心の色",
        selectable: false,
        unavailableCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
      },
    ],
    ...overrides,
  } as BattleSimulationCatalogResult;
}

function fakeCatalogUseCase(
  result: BattleSimulationCatalogResult,
): GetBattleSimulationCatalogUseCasePort {
  return { execute: () => result };
}

describe("GET /api/v1/battle-simulation-catalog", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("HTTP-CATALOG-001 (10_API設計.md「戦闘シミュレーション用Catalogレスポンス」): returns 200 with the mapped catalog body", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult()),
    });

    const response = await app.inject({ method: "GET", url: CATALOG_PATH });

    expect(response.statusCode).toBe(200);
    const body = response.json<BattleSimulationCatalogResponseBody>();
    expect(body).toEqual({
      schemaVersion: 1,
      catalogRevision: "2026-07-12.12",
      units: [
        {
          unitDefinitionId: "UNIT_MEIYA_FATED",
          displayName: "【天命を受けし剣術乙女】御剣冥夜",
          characterName: "御剣冥夜",
          attribute: "SHY",
          unitType: "PHYSICAL",
          role: "PHYSICAL_ATTACKER",
          positionAptitudes: ["FRONT"],
          selectable: true,
          unavailableCapabilities: [],
        },
      ],
      memories: [
        {
          memoryDefinitionId: "MEM_HEART_COLOR",
          displayName: "心の色",
          selectable: false,
          unavailableCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
        },
      ],
    });
  });

  it("HTTP-CATALOG-002 (10_API設計.md「HTTPヘッダー」「ETag」): 200 sets a catalogRevision-derived ETag and Cache-Control: public, max-age=300", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const response = await app.inject({ method: "GET", url: CATALOG_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers["etag"]).toBe('"rev-42"');
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("HTTP-CATALOG-003 (10_API設計.md「If-None-Match」「304」): a matching If-None-Match returns 304 with no body and no Content-Type", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const response = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "if-none-match": '"rev-42"' },
    });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
    expect(response.headers["content-type"]).toBeUndefined();
    expect(response.headers["etag"]).toBe('"rev-42"');
  });

  it("HTTP-CATALOG-004: a stale If-None-Match (older revision) still returns 200 with the current body", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const response = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "if-none-match": '"rev-41"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<BattleSimulationCatalogResponseBody>().catalogRevision).toBe("rev-42");
  });

  it("HTTP-CATALOG-005 (10_API設計.md「Cache-Control」戦闘POSTとの混同禁止): does not confuse the battle POST's no-store with the Catalog GET's public cache", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult()),
    });

    const catalogResponse = await app.inject({ method: "GET", url: CATALOG_PATH });
    expect(catalogResponse.headers["cache-control"]).toBe("public, max-age=300");

    const healthResponse = await app.inject({ method: "GET", url: "/health/live" });
    expect(healthResponse.headers["cache-control"]).toBe("no-store");
  });

  it("HTTP-CATALOG-006 (11_インフラストラクチャ設計.md「情報公開境界」): does not leak Skill/EffectAction internals beyond the declared response schema", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult()),
    });

    const response = await app.inject({ method: "GET", url: CATALOG_PATH });
    const body = response.json<Record<string, unknown>>();

    expect(Object.keys(body).sort()).toEqual(
      ["schemaVersion", "catalogRevision", "units", "memories"].sort(),
    );
    const unit = (body["units"] as Record<string, unknown>[])[0]!;
    expect(Object.keys(unit).sort()).toEqual(
      [
        "unitDefinitionId",
        "displayName",
        "characterName",
        "attribute",
        "unitType",
        "role",
        "positionAptitudes",
        "selectable",
        "unavailableCapabilities",
      ].sort(),
    );
  });

  it("HTTP-CATALOG-007 (10_API設計.md「Request ID」): carries X-Request-Id on both 200 and 304 responses", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const okResponse = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "x-request-id": "req-catalog-1" },
    });
    expect(okResponse.headers["x-request-id"]).toBe("req-catalog-1");

    const notModifiedResponse = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "x-request-id": "req-catalog-2", "if-none-match": '"rev-42"' },
    });
    expect(notModifiedResponse.headers["x-request-id"]).toBe("req-catalog-2");
  });

  it("HTTP-CATALOG-008: defaults to an empty catalog result when no catalogUseCase is supplied (existing callers keep working)", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE);

    const response = await app.inject({ method: "GET", url: CATALOG_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.json<BattleSimulationCatalogResponseBody>().units).toEqual([]);
  });

  it("HTTP-CATALOG-009 (review: manifestのcatalogRevisionはminLength:1しか検証しないため改行や引用符を含み得る): a catalogRevision containing characters unsafe for a raw ETag header (newline, quote, backslash) still returns 200 with a syntactically valid ETag, and a subsequent request that echoes that exact ETag back is recognized as a match", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: 'rev\n"42"\\x' })),
    });

    const firstResponse = await app.inject({ method: "GET", url: CATALOG_PATH });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers["cache-control"]).toBe("public, max-age=300");
    const etag = firstResponse.headers["etag"];
    expect(typeof etag).toBe("string");
    // RFC 9110 §8.8.3 opaque-tag = DQUOTE *etagc DQUOTE, etagc = %x21 / %x23-7E
    // (no raw DQUOTE, backslash, or control characters inside).
    expect(etag as string).toMatch(/^"[\x21\x23-\x7E]*"$/);

    const secondResponse = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "if-none-match": etag as string },
    });
    expect(secondResponse.statusCode).toBe(304);
  });

  it("HTTP-CATALOG-010 (review: If-None-Matchはweak comparisonを使う, RFC 9110 §13.1.2): a weak client ETag (W/ prefix) matches the server's strong ETag and returns 304", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const response = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "if-none-match": 'W/"rev-42"' },
    });

    expect(response.statusCode).toBe(304);
  });

  it('HTTP-CATALOG-011 (review: opaque-tag内の生カンマで単純split(",")が誤って分割する): a preceding entity-tag containing a raw comma inside its opaque-tag does not corrupt parsing of a later matching tag in the same If-None-Match list', async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const response = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "if-none-match": '"unrelated,tag", "rev-42"' },
    });

    expect(response.statusCode).toBe(304);
  });

  it("HTTP-CATALOG-012: a single entity-tag whose opaque-tag contains a comma but does not equal the current ETag is correctly treated as a mismatch (no false-positive 304)", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision: "rev-42" })),
    });

    const response = await app.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "if-none-match": '"rev-42,other"' },
    });

    expect(response.statusCode).toBe(200);
  });

  it("HTTP-CATALOG-013 (review: 異なるCatalog revisionを同じETagへ写像しない): distinct catalogRevision values that previously collided under variable-width %-escaping now produce distinct ETags", async () => {
    async function etagFor(catalogRevision: string): Promise<string> {
      const server = await buildServer(UNUSED_BATTLE_USE_CASE, {
        catalogUseCase: fakeCatalogUseCase(fakeCatalogResult({ catalogRevision })),
      });
      try {
        const response = await server.inject({ method: "GET", url: CATALOG_PATH });
        return response.headers["etag"] as string;
      } finally {
        await server.close();
      }
    }

    const collidingPairs: ReadonlyArray<readonly [string, string]> = [
      // "\n" (U+000A) previously escaped to "%0a", identical to the literal
      // three-character string "%0a" (all of `%`/`0`/`a` were left as-is).
      ["\n", "%0a"],
      // "あ" (U+3042) previously escaped to "%3042", identical to the literal
      // five-character string "%3042".
      ["あ", "%3042"],
      // U+0010 followed by "0" previously escaped+concatenated to "%100",
      // identical to the literal four-character string "%100".
      [`${String.fromCharCode(0x10)}0`, "%100"],
    ];

    for (const [first, second] of collidingPairs) {
      const [firstEtag, secondEtag] = await Promise.all([etagFor(first), etagFor(second)]);
      expect(firstEtag).not.toBe(secondEtag);
    }
  });
});
