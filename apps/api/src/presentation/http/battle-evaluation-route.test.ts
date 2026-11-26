import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type EvaluateBattlesUseCasePort,
  type EvaluateTotalWarsUseCasePort,
  type SimulateBattleUseCasePort,
} from "./build-server.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { BattleEvaluationResponseBody } from "../../application/contracts/response.js";
import { toEvaluateBattlesCommand } from "../../application/simulation/evaluate-battles-mapper.js";
import { EvaluateBattlesUseCase } from "../../application/simulation/evaluate-battles-use-case.js";
import { toEvaluateTotalWarsCommand } from "../../application/simulation/evaluate-total-wars-mapper.js";
import { EvaluateTotalWarsUseCase } from "../../application/simulation/evaluate-total-wars-use-case.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { CatalogBuilder, type TestBattleCatalog } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

/**
 * 検証対象は`routes/battle-evaluation-route.ts`・`routes/total-war-evaluation-route.ts`だが、
 * protocol header・エラー変換は`buildServer`が組み立てた実サーバーを通さないと観測できない
 * ため、演習の一括評価と同じくここへ置く。
 */
const BATTLE_PATH = "/api/v1/battle-evaluations";
const TOTAL_WAR_PATH = "/api/v1/total-war-evaluations";

const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

function catalog(): TestBattleCatalog {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_A", {
        baseStats: { maximumHp: 60, attack: 20, defense: 5, criticalRate: 0.5, maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
      }),
      unitDefinition("UNIT_IDLE", { baseStats: { maximumHp: 500 } }),
    )
    .withSkill(attackSkill("SKL_ATTACK", "ACT_ATTACK"))
    .withEffectAction(damageEffectAction("ACT_ATTACK"))
    .build();
}

function seededDependencies(testCatalog: TestBattleCatalog) {
  return {
    battleCatalog: testCatalog,
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 100 }, (_, index) => `B_API_${index}`),
    ),
    clock: new ManualClock(0),
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    runtimeInfo: { engineRevision: "engine-api" },
    limits: { maxCases: 4, maxTotalRuns: 6 },
  };
}

function battlePort(): EvaluateBattlesUseCasePort {
  const useCase = new EvaluateBattlesUseCase(seededDependencies(catalog()));
  return {
    executeBattleEvaluation: (request, context) =>
      Promise.resolve(useCase.execute(toEvaluateBattlesCommand(request), context)),
  };
}

function totalWarPort(): EvaluateTotalWarsUseCasePort {
  const useCase = new EvaluateTotalWarsUseCase(seededDependencies(catalog()));
  return {
    executeTotalWarEvaluation: (request, context) =>
      Promise.resolve(useCase.execute(toEvaluateTotalWarsCommand(request), context)),
  };
}

function formationBody(...unitIds: string[]) {
  return {
    units: unitIds.map((unitDefinitionId, column) => ({
      unitDefinitionId,
      position: { column, row: "FRONT" },
    })),
    memoryDefinitionIds: [],
  };
}

function battleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seed: "api-test",
    cases: [
      {
        caseId: "c1",
        allyFormation: formationBody("UNIT_A", "UNIT_A"),
        enemyFormation: formationBody("UNIT_A"),
        turnLimit: 5,
        runIndices: [0, 42],
      },
    ],
    ...overrides,
  };
}

function totalWarBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seed: "api-test",
    cases: [
      {
        caseId: "w1",
        allyFormations: [formationBody("UNIT_IDLE")],
        enemyFormations: [formationBody("UNIT_IDLE")],
        runIndices: [3],
      },
    ],
    ...overrides,
  };
}

function errorOf(response: { json: <T>() => T }) {
  return response.json<{ error: { code: string; violations: { path?: string }[] } }>().error;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serverWith(
  options: {
    battleEvaluationUseCase?: EvaluateBattlesUseCasePort;
    totalWarEvaluationUseCase?: EvaluateTotalWarsUseCasePort;
  } = {},
): Promise<FastifyInstance> {
  app = await buildServer(UNUSED_BATTLE_USE_CASE, options);
  return app;
}

describe("POST /api/v1/battle-evaluations", () => {
  it("API-BEVAL-001: returns one record per completed run keyed by caseId and runIndex with the reproduction conditions", async () => {
    const server = await serverWith({ battleEvaluationUseCase: battlePort() });

    const response = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battleBody(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<BattleEvaluationResponseBody>();
    expect(body).toMatchObject({
      schemaVersion: 1,
      seed: "api-test",
      seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
      engineRevision: "engine-api",
      requestedRuns: 2,
      completedRuns: 2,
      partial: false,
    });
    expect(body.catalogRevision).toEqual(expect.any(String));
    const caseBody = body.cases[0]!;
    expect(caseBody.caseId).toBe("c1");
    expect(caseBody.incompleteRunIndices).toEqual([]);
    expect(caseBody.runs.map((run) => run.runIndex)).toEqual([0, 42]);
    expect(caseBody.runs[0]!.units.map((unit) => [unit.side, unit.unitIndex])).toEqual([
      ["ALLY", 0],
      ["ALLY", 1],
      ["ENEMY", 0],
    ]);
    expect(caseBody.runs[0]!.units[0]).not.toHaveProperty("formationNumber");
  });

  it("API-BEVAL-002: the same request replays the same observations", async () => {
    const server = await serverWith({ battleEvaluationUseCase: battlePort() });

    const first = await server.inject({ method: "POST", url: BATTLE_PATH, payload: battleBody() });
    const second = await server.inject({ method: "POST", url: BATTLE_PATH, payload: battleBody() });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("API-BEVAL-003: a missing seed or an options.logLevel is a malformed request", async () => {
    const server = await serverWith({ battleEvaluationUseCase: battlePort() });
    const { seed: _omitted, ...withoutSeed } = battleBody();

    const missingSeed = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: withoutSeed,
    });
    const withOptions = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battleBody({ options: { logLevel: "DETAILED" } }),
    });

    expect(missingSeed.statusCode).toBe(400);
    expect(withOptions.statusCode).toBe(400);
  });

  it("API-BEVAL-004: duplicate case ids, out-of-range run indices and an exceeded run budget are 422 with their paths", async () => {
    const server = await serverWith({ battleEvaluationUseCase: battlePort() });
    const caseBody = (battleBody()["cases"] as Record<string, unknown>[])[0]!;

    const response = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battleBody({
        cases: [
          caseBody,
          { ...caseBody, runIndices: [4294967296, 1, 1] },
          { ...caseBody, caseId: "c3", runIndices: [0, 1, 2] },
        ],
      }),
    });

    expect(response.statusCode).toBe(422);
    const error = errorOf(response);
    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toEqual([
      "/cases/1/caseId",
      "/cases/1/runIndices/0",
      "/cases/1/runIndices/2",
      "/cases",
    ]);
  });

  it("API-BEVAL-005: a mismatched expected catalog revision is a 422 on expectedCatalogRevision", async () => {
    const server = await serverWith({ battleEvaluationUseCase: battlePort() });

    const response = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battleBody({ expectedCatalogRevision: "someone-elses-catalog" }),
    });

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).violations.map((violation) => violation.path)).toEqual([
      "/expectedCatalogRevision",
    ]);
  });

  it("API-BEVAL-006: a server without the evaluation endpoints enabled answers 404 for both formats", async () => {
    const server = await serverWith();

    const battle = await server.inject({ method: "POST", url: BATTLE_PATH, payload: battleBody() });
    const totalWar = await server.inject({
      method: "POST",
      url: TOTAL_WAR_PATH,
      payload: totalWarBody(),
    });

    expect(battle.statusCode).toBe(404);
    expect(errorOf(battle).code).toBe("ENDPOINT_DISABLED");
    expect(totalWar.statusCode).toBe(404);
    expect(errorOf(totalWar).code).toBe("ENDPOINT_DISABLED");
  });

  it("API-BEVAL-007: execution errors keep their documented status instead of becoming results", async () => {
    const server = await serverWith({
      battleEvaluationUseCase: {
        executeBattleEvaluation: () =>
          Promise.reject(new ApplicationError("EXECUTION_LIMIT_EXCEEDED", [{ reason: "guard" }])),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battleBody(),
    });

    expect(response.statusCode).toBe(503);
    expect(errorOf(response).code).toBe("EXECUTION_LIMIT_EXCEEDED");
  });
});

describe("POST /api/v1/total-war-evaluations", () => {
  it("API-TWEVAL-001: returns the whole total war per run with stages, formation counts and every slot", async () => {
    const server = await serverWith({ totalWarEvaluationUseCase: totalWarPort() });

    const response = await server.inject({
      method: "POST",
      url: TOTAL_WAR_PATH,
      payload: totalWarBody(),
    });

    expect(response.statusCode).toBe(200);
    const run = response.json<{
      cases: {
        runs: {
          runIndex: number;
          outcome: string;
          stages: unknown[];
          defeatedFormationCounts: unknown;
          units: unknown[];
        }[];
      }[];
    }>().cases[0]!.runs[0]!;
    expect(run.runIndex).toBe(3);
    expect(run.outcome).toBe("DRAW");
    expect(run.stages).toHaveLength(1);
    expect(run.defeatedFormationCounts).toEqual({ ally: 0, enemy: 0 });
    expect(run.units).toEqual([
      expect.objectContaining({ side: "ALLY", formationNumber: 1, unitIndex: 0, deployed: true }),
      expect.objectContaining({ side: "ENEMY", formationNumber: 1, unitIndex: 0, deployed: true }),
    ]);
  });

  it("API-TWEVAL-002: a turnLimit is a malformed request and a fourth formation is a 422 with its case path", async () => {
    const server = await serverWith({ totalWarEvaluationUseCase: totalWarPort() });
    const caseBody = (totalWarBody()["cases"] as Record<string, unknown>[])[0]!;

    const withTurnLimit = await server.inject({
      method: "POST",
      url: TOTAL_WAR_PATH,
      payload: totalWarBody({ cases: [{ ...caseBody, turnLimit: 15 }] }),
    });
    const tooMany = await server.inject({
      method: "POST",
      url: TOTAL_WAR_PATH,
      payload: totalWarBody({
        cases: [
          {
            ...caseBody,
            allyFormations: [1, 2, 3, 4].map(() => formationBody("UNIT_IDLE")),
          },
        ],
      }),
    });

    expect(withTurnLimit.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(422);
    expect(errorOf(tooMany).violations.map((violation) => violation.path)).toEqual([
      "/cases/0/allyFormations",
    ]);
  });
});
