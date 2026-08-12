import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type SimulateBattleUseCasePort,
  type SimulateTacticalExerciseUseCasePort,
} from "./build-server.js";
import { tacticalExerciseResponseDocSchema } from "./schemas/simulation/tactical-exercise-schema.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { TacticalExerciseResponseBody } from "../../application/contracts/response.js";
import { toSimulateTacticalExerciseCommand } from "../../application/simulation/simulate-tactical-exercise-request-mapper.js";
import { SimulateTacticalExerciseUseCase } from "../../application/simulation/simulate-tactical-exercise-use-case.js";
import type { SimulateTacticalExerciseResult } from "../../application/simulation/simulation-result-assembler.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import { CatalogBuilder } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

/**
 * 検証対象は`routes/tactical-exercise-route.ts`だが、protocol header・エラー変換は
 * `buildServer`が組み立てた実サーバーを通さないと観測できないため、
 * `formation-stat-preview-route.test.ts`と同じくここへ置く。
 */
const TACTICAL_EXERCISES_PATH = "/api/v1/tactical-exercises";

/** このファイルのどのテストも`POST /api/v1/battle-simulations`を叩かない。 */
const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

const REQUEST_BODY = {
  allyFormation: {
    units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
};

const ALLY_ID = createBattleUnitId("ally:1");
const ENEMY_ID = createBattleUnitId("enemy:1");
const COMBAT_STATS = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function unitSnapshot(hp: number) {
  return {
    hp,
    ap: 0,
    pp: 0,
    extraGauge: 0,
    maximumAp: 4,
    maximumPp: 4,
    maximumExtraGauge: 7,
    combatStats: COMBAT_STATS,
    baseCombatStats: COMBAT_STATS,
  };
}

function rosterEntry(battleUnitId: typeof ALLY_ID, side: "ALLY" | "ENEMY", y: number) {
  return {
    battleUnitId,
    unitDefinitionId: createUnitDefinitionId(side === "ALLY" ? "UNIT_ALLY" : "UNIT_ENEMY"),
    side,
    position: { column: "LEFT", row: "FRONT" } as const,
    globalCoordinate: { x: 0, y },
    combatStats: COMBAT_STATS,
    maximumAp: 4,
    maximumPp: 4,
    maximumExtraGauge: 7,
  };
}

const RESULT: SimulateTacticalExerciseResult = {
  battleId: createBattleId("battle-exercise-1"),
  catalogRevision: "rev-1",
  completionReason: "TURN_LIMIT_REACHED",
  completedTurn: 5,
  totalScore: 1500,
  breakCount: 1,
  breaks: [{ breakNumber: 1, turnNumber: 3, cumulativeScoreAtBreak: 1000 }],
  initialState: {
    status: "READY",
    currentTurn: 0,
    units: { [ALLY_ID]: unitSnapshot(1000), [ENEMY_ID]: unitSnapshot(1000) },
    exercise: { totalScore: 0, breakCount: 0 },
  },
  finalState: {
    status: "COMPLETED",
    currentTurn: 5,
    units: { [ALLY_ID]: unitSnapshot(800), [ENEMY_ID]: unitSnapshot(300) },
    exercise: { totalScore: 1500, breakCount: 1 },
  },
  events: [],
  stateTransitions: [
    {
      causedBySequence: 1,
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      stateDelta: { exercise: { totalScore: { before: 0, after: 500 } } },
    },
    {
      causedBySequence: 2,
      stateVersionBefore: 1,
      stateVersionAfter: 2,
      stateDelta: {
        exercise: { breakCount: { before: 0, after: 1 } },
        units: {
          [ENEMY_ID]: { baseCombatStats: { attack: { before: 100, after: 130 } } },
        },
      },
    },
  ],
  unitRoster: [rosterEntry(ALLY_ID, "ALLY", 2), rosterEntry(ENEMY_ID, "ENEMY", 1)],
};

function exerciseUseCase(
  executeTacticalExercise: SimulateTacticalExerciseUseCasePort["executeTacticalExercise"] = () =>
    Promise.resolve(RESULT),
): SimulateTacticalExerciseUseCasePort {
  return { executeTacticalExercise };
}

const EXERCISE_ATTACK_SKILL = "SKL_EXERCISE_ATTACK";
const EXERCISE_ATTACK_ACTION = "ACT_EXERCISE_ATTACK";

/**
 * 固定結果のstubではなく実`SimulateTacticalExerciseUseCase`を通す版。攻撃力が敵HPを
 * 上回るのでブレイクとブレイク強化（R-TEX-03／04）まで到達し、演習だけが発行する
 * イベントが実際に公開レスポンスへ載る——手書きのfixtureでは公開Schemaとの不一致を
 * 検出できないため（`API-TEX-010`）。Worker Threadは`build-server.cors.test.ts`と同じく
 * 薄いdirect adapterで代替する。
 */
function buildRealExerciseUseCase(): SimulateTacticalExerciseUseCasePort {
  const catalog = new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_ALLY", {
        baseStats: { maximumAp: 1, attack: 100 },
        activeSkillDefinitionIds: [createSkillDefinitionId(EXERCISE_ATTACK_SKILL)],
      }),
      unitDefinition("UNIT_ENEMY", { baseStats: { maximumHp: 100, defense: 0 } }),
    )
    .withSkill(attackSkill(EXERCISE_ATTACK_SKILL, EXERCISE_ATTACK_ACTION))
    .withEffectAction(damageEffectAction(EXERCISE_ATTACK_ACTION))
    .build();
  const useCase = new SimulateTacticalExerciseUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(["B_EXERCISE"]),
    randomSourceFactory: new SequenceRandomSourceFactory(Array.from({ length: 200 }, () => 0.99)),
    clock: new ManualClock(0),
  });
  return {
    executeTacticalExercise: (request, context) =>
      Promise.resolve(useCase.execute(toSimulateTacticalExerciseCommand(request), context)),
  };
}

describe("POST /api/v1/tactical-exercises (10_API設計.md「戦術演習をシミュレーションする」)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("API-TEX-001 (R-TEX-10 #1、10_API設計.md「ExerciseResultResponse」): returns 200 with the exercise result — score and break history — and no outcome", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { exerciseUseCase: exerciseUseCase() });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: REQUEST_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    const body = response.json<TacticalExerciseResponseBody>();
    expect(body.schemaVersion).toBe(1);
    expect(body.battleId).toBe("battle-exercise-1");
    expect(body.catalogRevision).toBe("rev-1");
    expect(body.result).toEqual({
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 5,
      totalScore: 1500,
      breakCount: 1,
      breaks: [{ breakNumber: 1, turnNumber: 3, cumulativeScoreAtBreak: 1000 }],
    });
    expect(body.result).not.toHaveProperty("outcome");
  });

  it("API-TEX-002 (10_API設計.md「TacticalExerciseResponse」「StateTransitionResponse」): serializes the exercise-only state deltas (exercise.totalScore/breakCount, units.<id>.baseCombatStats) instead of dropping them", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { exerciseUseCase: exerciseUseCase() });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: REQUEST_BODY,
    });

    const body = response.json<TacticalExerciseResponseBody>();
    expect(body.stateTransitions[0]?.delta.exercise).toEqual({
      totalScore: { before: 0, after: 500 },
    });
    expect(body.stateTransitions[1]?.delta.exercise).toEqual({
      breakCount: { before: 0, after: 1 },
    });
    expect(body.stateTransitions[1]?.delta.units?.["enemy:1"]?.baseCombatStats).toEqual({
      attack: { before: 100, after: 130 },
    });
  });

  it("API-TEX-003 (12_テスト戦略.md「実際の代表レスポンスが生成Schemaへ適合する」): the published 200 body validates against the doc schema this route publishes to OpenAPI", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { exerciseUseCase: exerciseUseCase() });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: REQUEST_BODY,
    });

    const validate = new Ajv({ strict: false }).compile(tacticalExerciseResponseDocSchema);
    const valid = validate(response.json());
    expect(valid, JSON.stringify(validate.errors?.slice(0, 5) ?? [], null, 2)).toBe(true);
  });

  it("API-TEX-010 (12_テスト戦略.md「実際の代表レスポンスが生成Schemaへ適合する」): a real exercise's 200 body — with the exercise-only events actually emitted — satisfies the doc schema, so BATTLE_COMPLETED and the break events cannot be published in a shape no client can decode", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      exerciseUseCase: buildRealExerciseUseCase(),
    });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        options: { logLevel: "DIAGNOSTIC" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TacticalExerciseResponseBody>();

    // このCatalogは敵HPより高い攻撃力を持つので、ブレイクとブレイク強化まで到達する
    // ——`BATTLE_COMPLETED`だけでなく演習専用イベント一式が実際に公開される。
    const publishedTypes = new Set(body.events.map((event) => event.type));
    for (const type of [
      "BATTLE_COMPLETED",
      "EXERCISE_SCORE_ACCUMULATED",
      "UNIT_BROKEN",
      "UNIT_REVIVED",
    ]) {
      expect(publishedTypes, `the exercise published no ${type}`).toContain(type);
    }
    // R-TEX-10 #1: 演習の`BattleCompleted`は勝敗を持たず、総スコアとブレイク回数を運ぶ。
    const completed = body.events.find((event) => event.type === "BATTLE_COMPLETED");
    expect(completed?.details).not.toHaveProperty("outcome");
    expect(completed?.details).toMatchObject({
      completionReason: body.result.completionReason,
      completedTurn: body.result.completedTurn,
      totalScore: body.result.totalScore,
      breakCount: body.result.breakCount,
    });
    expect(body.result.breakCount).toBeGreaterThan(0);

    const validate = new Ajv({ strict: false }).compile(tacticalExerciseResponseDocSchema);
    const valid = validate(body);
    expect(valid, JSON.stringify(validate.errors?.slice(0, 5) ?? [], null, 2)).toBe(true);
  });

  it("API-TEX-004 (10_API設計.md「TacticalExerciseRequest」「`turnLimit`は持たない」): rejects turnLimit as an undefined top-level property (400 MALFORMED_REQUEST), instead of silently ignoring it and running the fixed 5 turns", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { exerciseUseCase: exerciseUseCase() });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: { ...REQUEST_BODY, turnLimit: 10 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("MALFORMED_REQUEST");
  });

  it("API-TEX-005 (R-TEX-01 #3、10_API設計.md「敵編成のユニット数・メモリー数の違反は……422として返す」): maps the enemy-formation INVALID_COMMAND violations to 422 with wire paths", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      exerciseUseCase: exerciseUseCase(() => {
        throw new ApplicationError("INVALID_COMMAND", [
          {
            path: "enemyFormation.slots",
            reason: "must contain exactly 1 unit in a tactical exercise, got 2",
          },
          {
            path: "enemyFormation.memoryDefinitionIds",
            reason: "must be empty in a tactical exercise, got 1",
          },
        ]);
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: {
        ...REQUEST_BODY,
        enemyFormation: {
          units: [
            { unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } },
            { unitDefinitionId: "UNIT_ENEMY", position: { column: 1, row: "FRONT" } },
          ],
          memoryDefinitionIds: ["MEM_001"],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; violations: { path?: string }[] } }>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations.map((violation) => violation.path)).toEqual([
      "/enemyFormation/units",
      "/enemyFormation/memoryDefinitionIds",
    ]);
  });

  it("API-TEX-006 (R-TEX-01 #3): an empty enemy formation is a 422 command violation too, not a structural 400", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      exerciseUseCase: exerciseUseCase(() => {
        throw new ApplicationError("INVALID_COMMAND", [
          {
            path: "enemyFormation.slots",
            reason: "must contain exactly 1 unit in a tactical exercise, got 0",
          },
        ]);
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: { ...REQUEST_BODY, enemyFormation: { units: [], memoryDefinitionIds: [] } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_COMMAND");
  });

  it("API-TEX-007 (10_API設計.md「Cache-Control」「X-Request-Id」): the exercise response is no-store and echoes the request ID, like the battle POST", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { exerciseUseCase: exerciseUseCase() });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: REQUEST_BODY,
      headers: { "x-request-id": "ui-exercise-1" },
    });

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe("ui-exercise-1");
  });

  it("API-TEX-008 (11_インフラストラクチャ設計.md「Graceful Shutdown」): rejects a new exercise with 503 CAPACITY_EXCEEDED once the shutdown gate reports draining, without reaching the use case", async () => {
    let reached = false;
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      shutdownGate: { isShuttingDown: () => true },
      exerciseUseCase: exerciseUseCase(() => {
        reached = true;
        return Promise.resolve(RESULT);
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: REQUEST_BODY,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CAPACITY_EXCEEDED");
    expect(reached).toBe(false);
  });

  it("API-TEX-009 (10_API設計.md「Inbound Adapterでの変換」): passes the request body through to the use case unchanged, including options.logLevel", async () => {
    const received: unknown[] = [];
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      exerciseUseCase: exerciseUseCase((request) => {
        received.push(request);
        return Promise.resolve(RESULT);
      }),
    });

    await app.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: { ...REQUEST_BODY, options: { logLevel: "SUMMARY" } },
    });

    expect(received).toEqual([{ ...REQUEST_BODY, options: { logLevel: "SUMMARY" } }]);
  });
});
