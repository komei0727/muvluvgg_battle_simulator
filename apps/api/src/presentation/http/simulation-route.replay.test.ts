import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type BuildServerOptions } from "./build-server.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { ErrorResponseBody } from "../../application/contracts/error.js";

/**
 * 3形式の単発APIに共通する再生指定（`10_API設計.md`「SimulationReplay」）のHTTP契約。
 *
 * 再生の実行・識別情報の照合はWorker側（`UT-TASKRUNNER-017`〜`021`、`E2E-REPLAY-*`）が
 * 担う。ここでは配備設定での開閉、構造の400、本文の素通し、Worker由来の違反パスの
 * 変換だけを確かめる。
 */
const FORMATION = {
  units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};
const REPLAY = {
  seed: "seed-a",
  runIndex: 3,
  expectedCatalogRevision: "catalog-a",
  expectedEngineRevision: "engine-a",
  expectedSeedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
};

const ROUTES = [
  {
    name: "battle",
    path: "/api/v1/battle-simulations",
    body: { allyFormation: FORMATION, enemyFormation: FORMATION, turnLimit: 3 },
  },
  {
    name: "tactical exercise",
    path: "/api/v1/tactical-exercises",
    body: { allyFormation: FORMATION, enemyFormation: FORMATION },
  },
  {
    name: "total war",
    path: "/api/v1/total-war-simulations",
    body: { allyFormations: [FORMATION], enemyFormations: [FORMATION] },
  },
] as const;

/** Worker側の照合で拒否されたことを表す。ルートが本文をそのまま渡したかを記録する。 */
const WORKER_REJECTION = new ApplicationError("INVALID_COMMAND", [
  { path: "replay.expectedEngineRevision", reason: "does not match" },
]);

describe("single-run replay over HTTP", () => {
  let app: FastifyInstance | undefined;
  let received: unknown[];

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(options: Partial<BuildServerOptions> = {}): Promise<FastifyInstance> {
    received = [];
    const reject = (request: unknown): Promise<never> => {
      received.push(request);
      return Promise.reject(WORKER_REJECTION);
    };
    app = await buildServer(
      { execute: reject },
      {
        logger: false,
        exerciseUseCase: { executeTacticalExercise: reject },
        totalWarUseCase: { executeTotalWar: reject },
        ...options,
      },
    );
    return app;
  }

  for (const route of ROUTES) {
    it(`API-REPLAY-001 (${route.name}): an enabled server passes the replay through to the worker unchanged and maps its violation to the wire path`, async () => {
      const server = await start({ replayEnabled: true });
      const body = { ...route.body, options: { logLevel: "DETAILED" }, replay: REPLAY };

      const response = await server.inject({ method: "POST", url: route.path, payload: body });

      expect(received).toEqual([body]);
      expect(response.statusCode).toBe(422);
      expect(response.json<ErrorResponseBody>().error.violations).toEqual([
        expect.objectContaining({ path: "/replay/expectedEngineRevision" }),
      ]);
    });

    it(`API-REPLAY-002 (${route.name}): a server without the evaluation endpoints answers a replay with 404 ENDPOINT_DISABLED before reaching the worker, while a plain request still runs`, async () => {
      const server = await start();

      const replayed = await server.inject({
        method: "POST",
        url: route.path,
        payload: { ...route.body, replay: REPLAY },
      });
      expect(replayed.statusCode).toBe(404);
      expect(replayed.json<ErrorResponseBody>().error.code).toBe("ENDPOINT_DISABLED");
      expect(received).toEqual([]);

      await server.inject({ method: "POST", url: route.path, payload: route.body });
      expect(received).toEqual([route.body]);
    });

    it(`API-REPLAY-003 (${route.name}): a replay missing a field, with an undefined property or with a non-integer run number is a malformed request`, async () => {
      const server = await start({ replayEnabled: true });
      const { expectedSeedDerivationVersion: _omitted, ...missing } = REPLAY;

      for (const replay of [missing, { ...REPLAY, extra: 1 }, { ...REPLAY, runIndex: "3" }]) {
        const response = await server.inject({
          method: "POST",
          url: route.path,
          payload: { ...route.body, replay },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json<ErrorResponseBody>().error.code).toBe("MALFORMED_REQUEST");
      }
      expect(received).toEqual([]);
    });
  }
});
