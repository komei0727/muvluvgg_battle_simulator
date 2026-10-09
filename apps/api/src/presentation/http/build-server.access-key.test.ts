import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type GetBattleSimulationCatalogUseCasePort,
  type SimulateBattleUseCasePort,
} from "./build-server.js";
import type { ApiAccessKey } from "./protocol/access-key/access-key.js";
import type { BattleSimulationCatalogResult } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";

/**
 * 検証対象は`protocol/access-key/access-key.ts`だが、CORSとの順序・共通エラー
 * envelope・Fastify標準のrequestログへのラベル付与は`buildServer`が組み立てた
 * 実サーバーを通さないと観測できないため、ここに置く。
 */
const CATALOG_PATH = "/api/v1/battle-simulation-catalog";
const ALLOWED_ORIGIN = "https://komei0727.github.io";
const ALICE: ApiAccessKey = { label: "alice", key: "a".repeat(32) };
const BOB: ApiAccessKey = { label: "bob", key: "b".repeat(44) };

const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

const CATALOG_USE_CASE: GetBattleSimulationCatalogUseCasePort = {
  execute: (): BattleSimulationCatalogResult => ({
    catalogRevision: "2026-10-09.1",
    representationRevision: "2026-10-09.1+gear.test",
    units: [],
    memories: [],
    gearEffects: [],
  }),
};

function collectLogOutput(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

function logLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("access-key guard", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function serverWith(
    apiAccessKeys: readonly ApiAccessKey[],
    logStream?: Writable,
  ): Promise<FastifyInstance> {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      catalogUseCase: CATALOG_USE_CASE,
      corsAllowedOrigins: [ALLOWED_ORIGIN],
      apiAccessKeys,
      ...(logStream !== undefined ? { logger: { level: "info", stream: logStream } } : {}),
    });
    return app;
  }

  it("API-AUTH-001: with no keys configured, /api/v1/* stays reachable without Authorization", async () => {
    const server = await serverWith([]);

    const response = await server.inject({ method: "GET", url: CATALOG_PATH });

    expect(response.statusCode).toBe(200);
  });

  it("API-AUTH-002: a request without Authorization gets 401 UNAUTHORIZED in the common error envelope with WWW-Authenticate: Bearer", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({ method: "GET", url: CATALOG_PATH });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      schemaVersion: 1,
      error: { code: "UNAUTHORIZED", message: expect.any(String) as string, violations: [] },
    });
  });

  it.each([
    ["an unregistered key", `Bearer ${"z".repeat(32)}`],
    ["a registered key under a non-Bearer scheme", `Basic ${ALICE.key}`],
    ["a Bearer scheme without a token", "Bearer "],
    ["a registered key with a trailing extra character", `Bearer ${ALICE.key}x`],
  ])("API-AUTH-003: %s is rejected with 401", async (_case, authorization) => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { authorization },
    });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["the first registered key", `Bearer ${ALICE.key}`],
    ["the second registered key", `Bearer ${BOB.key}`],
    ["a case-insensitive auth-scheme", `bearer ${BOB.key}`],
  ])("API-AUTH-004: %s is accepted", async (_case, authorization) => {
    const server = await serverWith([ALICE, BOB]);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { authorization },
    });

    expect(response.statusCode).toBe(200);
  });

  it.each(["/health/live", "/health/ready", "/openapi.json"])(
    "API-AUTH-005: %s stays public so probes and tooling work without a key",
    async (url) => {
      const server = await serverWith([ALICE]);

      const response = await server.inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
    },
  );

  it("API-AUTH-006: a CORS preflight succeeds without a key and allows the Authorization request header", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({
      method: "OPTIONS",
      url: CATALOG_PATH,
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]?.toString().toLowerCase()).toContain(
      "authorization",
    );
  });

  it("API-AUTH-007: a 401 to an allowed origin carries CORS headers so the browser UI can read it", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("API-AUTH-008: an unknown path under /api/v1/ answers 401 rather than revealing whether it exists", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({ method: "GET", url: "/api/v1/no-such-endpoint" });

    expect(response.statusCode).toBe(401);
  });

  it("API-AUTH-009: an accepted request's logs, including Fastify's request completion log, carry the key's label but never the key", async () => {
    const logs = collectLogOutput();
    const server = await serverWith([ALICE, BOB], logs.stream);

    await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { authorization: `Bearer ${BOB.key}` },
    });

    const completed = logLines(logs.text()).find((line) => line["message"] === "request completed");
    expect(completed?.["accessKeyLabel"]).toBe("bob");
    expect(logs.text()).not.toContain(BOB.key);
  });

  it("API-AUTH-010: a rejected request is logged as accessKeyRejected without echoing the presented key", async () => {
    const logs = collectLogOutput();
    const server = await serverWith([ALICE], logs.stream);
    const presented = "p".repeat(40);

    await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { authorization: `Bearer ${presented}` },
    });

    expect(logLines(logs.text()).some((line) => line["accessKeyRejected"] === true)).toBe(true);
    expect(logs.text()).not.toContain(presented);
  });

  it("API-AUTH-011: an authorized Catalog 200 is cacheable only privately, since shared caches must not store responses to requests carrying Authorization", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { authorization: `Bearer ${ALICE.key}` },
    });

    expect(response.headers["cache-control"]).toBe("private, max-age=300");
  });

  it("API-AUTH-012: an unauthenticated request with an unsupported Accept still gets 401 and is logged as rejected, since authentication precedes content negotiation", async () => {
    const logs = collectLogOutput();
    const server = await serverWith([ALICE], logs.stream);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { accept: "text/plain" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(logLines(logs.text()).some((line) => line["accessKeyRejected"] === true)).toBe(true);
  });

  it("API-AUTH-013: an authenticated request with an unsupported Accept still gets 406, so the guard only reorders and does not bypass content negotiation", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { accept: "text/plain", authorization: `Bearer ${ALICE.key}` },
    });

    expect(response.statusCode).toBe(406);
  });

  it("API-AUTH-014: a 401 carries the X-Request-Id of the request, since request tracking runs before the guard", async () => {
    const server = await serverWith([ALICE]);

    const response = await server.inject({
      method: "GET",
      url: CATALOG_PATH,
      headers: { "x-request-id": "req-auth-014" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["x-request-id"]).toBe("req-auth-014");
  });
});
