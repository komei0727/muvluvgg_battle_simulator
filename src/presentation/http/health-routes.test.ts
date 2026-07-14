import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes, type ReadinessPort } from "./health-routes.js";

function stubReadiness(isReady: boolean): ReadinessPort {
  return { isReady: () => isReady };
}

describe("health routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("API-HEALTH-001 (11_インフラストラクチャ設計.md「/health/live」): GET /health/live succeeds even while the Pool is unhealthy — a Catalog/Pool failure alone must not fail liveness", async () => {
    app = Fastify();
    registerHealthRoutes(app, stubReadiness(false));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
  });

  it("API-HEALTH-002 (11_インフラストラクチャ設計.md「/health/ready」): GET /health/ready succeeds when the ReadinessPort reports ready", async () => {
    app = Fastify();
    registerHealthRoutes(app, stubReadiness(true));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
  });

  it("API-HEALTH-003 (受け入れ条件「準備未完了時にreadinessが成功しない」): GET /health/ready fails (503) when the ReadinessPort reports not ready", async () => {
    app = Fastify();
    registerHealthRoutes(app, stubReadiness(false));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
  });

  it("API-HEALTH-004 (11_インフラストラクチャ設計.md「ヘルスレスポンスへCatalogの中身、環境変数、エラーのスタックを含めない」): health responses stay minimal (no catalog/env leakage)", async () => {
    app = Fastify();
    registerHealthRoutes(app, stubReadiness(true));
    await app.ready();

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(Object.keys(live.json())).toEqual(["status"]);
    expect(Object.keys(ready.json())).toEqual(["status"]);
  });

  it("API-HEALTH-005: readiness state transitions are reflected live, request by request", async () => {
    let ready = false;
    app = Fastify();
    registerHealthRoutes(app, { isReady: () => ready });
    await app.ready();

    const before = await app.inject({ method: "GET", url: "/health/ready" });
    expect(before.statusCode).toBe(503);

    ready = true;
    const after = await app.inject({ method: "GET", url: "/health/ready" });
    expect(after.statusCode).toBe(200);
  });
});
