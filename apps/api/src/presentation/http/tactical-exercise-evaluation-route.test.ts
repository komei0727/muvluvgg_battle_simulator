import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type EvaluateTacticalExercisesUseCasePort,
  type SimulateBattleUseCasePort,
} from "./build-server.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { TacticalExerciseEvaluationResponseBody } from "../../application/contracts/response.js";
import { toEvaluateTacticalExercisesCommand } from "../../application/simulation/evaluate-tactical-exercises-mapper.js";
import { EvaluateTacticalExercisesUseCase } from "../../application/simulation/evaluate-tactical-exercises-use-case.js";
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
 * 検証対象は`routes/tactical-exercise-evaluation-route.ts`だが、protocol header・
 * エラー変換は`buildServer`が組み立てた実サーバーを通さないと観測できないため、
 * `tactical-exercise-route.test.ts`と同じくここへ置く。
 */
const PATH = "/api/v1/tactical-exercise-evaluations";

const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

function catalog(): TestBattleCatalog {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_ALLY", {
        baseStats: { attack: 50, criticalRate: 0.5, maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
      }),
      unitDefinition("UNIT_ENEMY", {
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        baseStats: { maximumHp: 400, defense: 0 },
      }),
    )
    .withSkill(attackSkill("SKL_ATTACK", "ACT_ATTACK"))
    .withEffectAction(damageEffectAction("ACT_ATTACK"))
    .build();
}

const ALLY = {
  units: [
    { unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } },
    { unitDefinitionId: "UNIT_ALLY", position: { column: 1, row: "FRONT" } },
  ],
  memoryDefinitionIds: [],
};
const ENEMY = {
  units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

function exerciseCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: "case-a",
    allyFormation: ALLY,
    enemyFormation: ENEMY,
    runIndices: [0, 7],
    ...overrides,
  };
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { seed: "api-test", cases: [exerciseCase()], ...overrides };
}

/** 実ユースケースを合成Catalogの上で動かすport（HTTP契約を実結果で検証するため）。 */
function realUseCase(
  testCatalog: TestBattleCatalog = catalog(),
): EvaluateTacticalExercisesUseCasePort {
  const useCase = new EvaluateTacticalExercisesUseCase({
    battleCatalog: testCatalog,
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 100 }, (_, index) => `B_API_${index}`),
    ),
    clock: new ManualClock(0),
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    runtimeInfo: { engineRevision: "engine-api" },
    limits: { maxCases: 4, maxTotalRuns: 6 },
  });
  return {
    executeTacticalExerciseEvaluation: (request, context) =>
      Promise.resolve(useCase.execute(toEvaluateTacticalExercisesCommand(request), context)),
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serverWith(
  evaluationUseCase?: EvaluateTacticalExercisesUseCasePort,
): Promise<FastifyInstance> {
  app = await buildServer(UNUSED_BATTLE_USE_CASE, {
    ...(evaluationUseCase !== undefined ? { evaluationUseCase } : {}),
  });
  return app;
}

function violationPaths(body: string): string[] {
  return (JSON.parse(body) as { error: { violations: { path: string }[] } }).error.violations.map(
    (violation) => violation.path,
  );
}

describe("POST /api/v1/tactical-exercise-evaluations", () => {
  it("API-TEXEVAL-001: returns one self-contained record per completed run keyed by caseId and runIndex with the reproduction conditions", async () => {
    const testCatalog = catalog();
    const server = await serverWith(realUseCase(testCatalog));

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(200);
    const body = response.json<TacticalExerciseEvaluationResponseBody>();
    expect(body).toMatchObject({
      schemaVersion: 1,
      seed: "api-test",
      seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
      catalogRevision: testCatalog.catalogRevision,
      engineRevision: "engine-api",
      requestedRuns: 2,
      completedRuns: 2,
      partial: false,
    });
    const caseOutcome = body.cases[0]!;
    expect(caseOutcome.caseId).toBe("case-a");
    expect(caseOutcome.incompleteRunIndices).toEqual([]);
    expect(caseOutcome.runs.map((run) => run.runIndex)).toEqual([0, 7]);
    const run = caseOutcome.runs[0]!;
    expect(Object.keys(run).sort()).toEqual([
      "allyUnitBreaks",
      "breakCount",
      "completedTurn",
      "completionReason",
      "runIndex",
      "totalScore",
      "units",
    ]);
    expect(run.units.map((unit) => [unit.side, unit.unitIndex])).toEqual([
      ["ALLY", 0],
      ["ALLY", 1],
      ["ENEMY", 0],
    ]);
    expect(run.allyUnitBreaks.map((entry) => entry.unitIndex)).toEqual([0, 1]);
  });

  it("API-TEXEVAL-002: the same request replays the same observations", async () => {
    const server = await serverWith(realUseCase());

    const first = await server.inject({ method: "POST", url: PATH, payload: requestBody() });
    const second = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    // ステータスを見ないと、両方がエラー応答でも「同じ本文」で通ってしまう。
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("API-TEXEVAL-003: a missing seed, the retired candidate fields and a turnLimit are malformed requests", async () => {
    const server = await serverWith(realUseCase());
    const { seed: _omitted, ...withoutSeed } = requestBody();

    for (const payload of [
      withoutSeed,
      requestBody({ runsPerCandidate: 2 }),
      { seed: "s", enemyFormation: ENEMY, candidates: [{ allyFormation: ALLY }] },
      requestBody({ cases: [exerciseCase({ turnLimit: 5 })] }),
    ]) {
      const response = await server.inject({ method: "POST", url: PATH, payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it("API-TEXEVAL-004: duplicate case ids, run indices, an exceeded run budget and an exercise-rule violation are 422 with their paths", async () => {
    const server = await serverWith(realUseCase());

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: requestBody({
        cases: [
          exerciseCase({ runIndices: [0, 0] }),
          exerciseCase({
            runIndices: [1, 2, 3, 4, 5],
            enemyFormation: {
              ...ENEMY,
              units: [
                ...ENEMY.units,
                { unitDefinitionId: "UNIT_ENEMY", position: { column: 1, row: "FRONT" } },
              ],
            },
          }),
        ],
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(violationPaths(response.body)).toEqual([
      "/cases/0/runIndices/1",
      "/cases/1/caseId",
      "/cases",
      "/cases/1/enemyFormation/units",
    ]);
  });

  it("API-TEXEVAL-005: a mismatched expected engine revision is a 422 on expectedEngineRevision", async () => {
    const server = await serverWith(realUseCase());

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: requestBody({ expectedEngineRevision: "other" }),
    });

    expect(response.statusCode).toBe(422);
    expect(violationPaths(response.body)).toEqual(["/expectedEngineRevision"]);
  });

  it("API-TEXEVAL-006: a server without the evaluation endpoint enabled answers 404 instead of running it", async () => {
    const server = await serverWith();

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ENDPOINT_DISABLED");
  });

  it("API-TEXEVAL-007: an application error from the use case keeps its documented status mapping", async () => {
    const server = await serverWith({
      executeTacticalExerciseEvaluation: () =>
        Promise.reject(
          new ApplicationError("DEFINITION_NOT_FOUND", [
            { path: "cases[0].allyFormation.slots[0].unitDefinitionId", reason: "unknown" },
          ]),
        ),
    });

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("DEFINITION_NOT_FOUND");
  });
});
