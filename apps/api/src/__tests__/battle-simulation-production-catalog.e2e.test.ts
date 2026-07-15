import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../infrastructure/worker/simulation-worker-pool.js";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../infrastructure/catalog/runtime/catalog-file-loader.js";
import { GetBattleSimulationCatalogUseCase } from "../application/get-battle-simulation-catalog-use-case.js";
import { buildSimulationSmokeRequest } from "../infrastructure/deploy/simulation-smoke-request.js";

/**
 * Issue #106 review (2026-07-15, 4th round): the Cloud Run CI/CD post-deploy
 * smoke test only proved `GET .../battle-simulation-catalog` reports
 * `selectable: true` for a unit — that is NOT sufficient proof a battle
 * using that unit actually runs (target selectors, resolution steps, and
 * effect payloads could still be shaped incorrectly even with zero
 * `requiredCapabilities`). This exercises a REAL battle simulation, through
 * the real Worker Thread, against the SAME production `catalog/` directory
 * and the SAME request-building logic (`buildSimulationSmokeRequest`) the CI
 * deploy job (`scripts/cloud-run/ci-deploy-candidate.sh` /
 * `.github/workflows/main.yml`) uses for its own post-deploy smoke test.
 *
 * See `docs/ddd/15_Unit_Memory変換台帳.md`「Issue #106: 台帳外の合成Unit」for
 * why `UNIT_CI_SMOKE_TEST` — a synthetic, zero-`requiredCapabilities` unit —
 * exists: every real converted character unit still references at least one
 * `PLANNED` capability, so none of them are `selectable` yet.
 *
 * Compiled/dist-based imports mirror `battle-simulation-http-worker.e2e.test.ts`
 * to avoid the dual-module-instance `ApplicationError` mismatch described
 * there.
 */
const apiPackageRoot = fileURLToPath(new URL("../../", import.meta.url));
const tscBin = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));
const distPoolUrl = new URL(
  "../../dist/infrastructure/worker/simulation-worker-pool.js",
  import.meta.url,
);
const distBuildServerUrl = new URL("../../dist/presentation/http/build-server.js", import.meta.url);

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

describe("production Catalog has a selectable unit that actually completes a battle", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let buildServer: typeof buildServerFn;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: apiPackageRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    expect(existsSync(fileURLToPath(distBuildServerUrl))).toBe(true);
    const compiledPool = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
    };
    const compiledServer = (await import(distBuildServerUrl.href)) as {
      buildServer: typeof buildServerFn;
    };
    SimulationWorkerPool = compiledPool.SimulationWorkerPool;
    buildServer = compiledServer.buildServer;
  }, 120_000);

  let pool: SimulationWorkerPoolClass | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("E2E-CATALOG-PROD-SMOKE-001: builds a minimal request from the first selectable production unit and completes a real battle", async () => {
    const catalogRevision = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
    const directory = loadBattleCatalogDirectory(CATALOG_DIR);
    const catalogResult = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: directory,
    }).execute();

    expect(catalogResult.units.some((unit) => unit.selectable)).toBe(true);

    const request = buildSimulationSmokeRequest(catalogResult);

    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision,
      minThreads: 1,
      maxThreads: 1,
    });
    app = await buildServer(pool);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: request,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ catalogRevision: string; result: { outcome: string } }>();
    expect(body.catalogRevision).toBe(catalogRevision);
    expect(body.result.outcome).toEqual(expect.any(String));
  });
});
