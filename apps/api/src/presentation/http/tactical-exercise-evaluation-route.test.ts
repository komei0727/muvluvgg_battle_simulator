import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type EvaluateTacticalExerciseCandidatesUseCasePort,
  type SimulateBattleUseCasePort,
} from "./build-server.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import { toEvaluateTacticalExerciseCandidatesCommand } from "../../application/simulation/evaluate-tactical-exercise-candidates-mapper.js";
import { EvaluateTacticalExerciseCandidatesUseCase } from "../../application/simulation/evaluate-tactical-exercise-candidates-use-case.js";
import type { EvaluateTacticalExerciseCandidatesResult } from "../../application/simulation/evaluate-tactical-exercise-candidates-use-case.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { CatalogBuilder } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

const PATH = "/api/v1/tactical-exercise-evaluations";

const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    candidates: [
      {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
      },
    ],
    runsPerCandidate: 2,
    seed: "api-test",
    ...overrides,
  };
}

/** 実ユースケースを合成Catalogの上で動かすport（HTTP契約を実結果で検証するため）。 */
function realUseCase(): EvaluateTacticalExerciseCandidatesUseCasePort {
  const catalog = new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_ALLY", {
        baseStats: { maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
      }),
      unitDefinition("UNIT_ENEMY", {
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        baseStats: { maximumHp: 1000, defense: 0 },
      }),
    )
    .withSkill(attackSkill("SKL_ATTACK", "ACT_ATTACK"))
    .withEffectAction(damageEffectAction("ACT_ATTACK"))
    .build();

  const useCase = new EvaluateTacticalExerciseCandidatesUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 100 }, (_, index) => `B_API_${index}`),
    ),
    clock: new ManualClock(0),
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    limits: { maxCandidates: 4, maxTotalRuns: 20 },
  });

  return {
    executeTacticalExerciseEvaluation: (request, context) =>
      Promise.resolve(
        useCase.execute(
          toEvaluateTacticalExerciseCandidatesCommand(request, "generated-seed"),
          context,
        ),
      ),
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serverWith(
  evaluationUseCase?: EvaluateTacticalExerciseCandidatesUseCasePort,
): Promise<FastifyInstance> {
  app = await buildServer(UNUSED_BATTLE_USE_CASE, {
    ...(evaluationUseCase !== undefined ? { evaluationUseCase } : {}),
  });
  return app;
}

describe("POST /api/v1/tactical-exercise-evaluations", () => {
  it("API-EVAL-001: returns raw per-run values for every candidate in request order", async () => {
    const server = await serverWith(realUseCase());

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(200);
    const body = response.json<EvaluateTacticalExerciseCandidatesResult>();
    expect(body.seed).toBe("api-test");
    expect(body.runsPerCandidate).toBe(2);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.scores).toHaveLength(2);
    expect(body.candidates[0]?.completedRuns).toBe(2);
  });

  it("API-EVAL-008: the response carries the per-run ally-unit damage totals and break counts", async () => {
    const server = await serverWith(realUseCase());

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(200);
    const candidate = response.json<EvaluateTacticalExerciseCandidatesResult>().candidates[0]!;
    expect(candidate.allyUnitDamageTotals).toHaveLength(2);
    expect(candidate.allyUnitBreakCounts).toHaveLength(2);
    for (const damageTotals of candidate.allyUnitDamageTotals) {
      expect(damageTotals).toHaveLength(1);
      expect(damageTotals[0]).toBeGreaterThan(0);
    }
    for (const breakCounts of candidate.allyUnitBreakCounts) {
      expect(breakCounts).toHaveLength(1);
    }
  });

  it("API-EVAL-002: the same seed replays the same scores across requests", async () => {
    const server = await serverWith(realUseCase());

    const first = await server.inject({ method: "POST", url: PATH, payload: requestBody() });
    const second = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    // ステータスと中身の有無を見ないと、両方がエラー応答でも「同じ本文」で通ってしまう。
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(
      first.json<EvaluateTacticalExerciseCandidatesResult>().candidates[0]?.scores,
    ).toHaveLength(2);
    expect(second.json()).toEqual(first.json());
  });

  it("API-EVAL-003: an omitted seed is generated server-side and echoed so the run can be replayed", async () => {
    const server = await serverWith(realUseCase());
    const { seed: _omitted, ...withoutSeed } = requestBody();

    const response = await server.inject({ method: "POST", url: PATH, payload: withoutSeed });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ seed: string }>().seed).toBe("generated-seed");
  });

  it("API-EVAL-004: exceeding the configured total-run budget is a 422 rather than a truncated run", async () => {
    const server = await serverWith(realUseCase());

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: requestBody({ runsPerCandidate: 999 }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_COMMAND");
  });

  it("API-EVAL-005: an unknown top-level property is rejected as a malformed request", async () => {
    const server = await serverWith(realUseCase());

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: requestBody({ unexpected: true }),
    });

    expect(response.statusCode).toBe(400);
  });

  it("API-EVAL-006: a server without the evaluation endpoint enabled answers 404 instead of running it", async () => {
    const server = await serverWith();

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ENDPOINT_DISABLED");
  });

  it("API-EVAL-007: an application error from the use case keeps its documented status mapping", async () => {
    const server = await serverWith({
      executeTacticalExerciseEvaluation: () =>
        Promise.reject(
          new ApplicationError("DEFINITION_NOT_FOUND", [
            { path: "candidates[0].allyFormation.slots[0].unitDefinitionId", reason: "unknown" },
          ]),
        ),
    });

    const response = await server.inject({ method: "POST", url: PATH, payload: requestBody() });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("DEFINITION_NOT_FOUND");
  });
});
