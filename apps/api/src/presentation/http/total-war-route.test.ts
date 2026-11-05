import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type SimulateBattleUseCasePort,
  type SimulateTotalWarUseCasePort,
} from "./build-server.js";
import { totalWarResponseDocSchema } from "./schemas/simulation/total-war-schema.js";
import type { TotalWarResponseBody } from "../../application/contracts/response.js";
import { toSimulateTotalWarCommand } from "../../application/simulation/simulate-total-war-request-mapper.js";
import { SimulateTotalWarUseCase } from "../../application/simulation/simulate-total-war-use-case.js";
import {
  createMemoryDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createMemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import { CatalogBuilder } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  statModEffectAction,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

/**
 * 検証対象は`routes/total-war-route.ts`だが、protocol header・エラー変換・応答の
 * serializeは`buildServer`が組み立てた実サーバーを通さないと観測できないため、
 * `tactical-exercise-route.test.ts`と同じくここへ置く。
 */
const TOTAL_WAR_SIMULATIONS_PATH = "/api/v1/total-war-simulations";

/** このファイルのどのテストも`POST /api/v1/battle-simulations`を叩かない。 */
const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

const ATTACK_SKILL_ID = "SKL_ATTACK";
const ATTACK_ACTION_ID = "ACT_ATTACK";
const MEMORY_ACTION_ID = "ACT_MEM_ATTACK_UP";
const DEPLOY_MEMORY_ID = "MEM_DEPLOY";

function formationBody(unitIds: readonly string[], memoryIds: readonly string[] = []) {
  return {
    units: unitIds.map((unitDefinitionId, column) => ({
      unitDefinitionId,
      position: { column, row: "FRONT" },
    })),
    memoryDefinitionIds: [...memoryIds],
  };
}

/**
 * 味方1編成が敵の1番目の編成を1ターン目に倒し、2ターン目に出撃した2番目の編成も倒す。
 * 敵の2番目の編成は1番目と同じユニットを持つので再登場補正（R-TWR-02）を受け、出撃時に
 * 戦闘開始時Memoryが発動する（R-TWR-05 #2）。敵の3番目の編成は控えのまま終わる。
 */
const REQUEST_BODY = {
  allyFormations: [formationBody(["UNIT_STRIKER"])],
  enemyFormations: [
    formationBody(["UNIT_FRAGILE"]),
    formationBody(["UNIT_FRAGILE"], [DEPLOY_MEMORY_ID]),
    formationBody(["UNIT_OTHER"]),
  ],
};

/**
 * 固定結果のstubではなく実`SimulateTotalWarUseCase`を通す。総力戦だけが発行する
 * イベント・状態差分（`FORMATION_DEFEATED`／`FORMATION_DEPLOYED`、`addedUnits`／
 * `formations`）を実際に公開レスポンスへ載せないと、手書きのfixtureでは公開Schemaとの
 * 不一致を検出できない。Worker Threadは`tactical-exercise-route.test.ts`と同じく薄い
 * direct adapterで代替する。
 */
function buildRealTotalWarUseCase(): SimulateTotalWarUseCasePort {
  const catalog = new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_STRIKER", {
        baseStats: { maximumAp: 1, attack: 999 },
        activeSkillDefinitionIds: [createSkillDefinitionId(ATTACK_SKILL_ID)],
      }),
      unitDefinition("UNIT_FRAGILE", { baseStats: { maximumHp: 500, defense: 0 } }),
      unitDefinition("UNIT_OTHER", { baseStats: { maximumHp: 500, defense: 0 } }),
      unitDefinition("UNIT_TEX", { category: "EXERCISE_ENEMY", exerciseActive: true }),
    )
    .withSkill(attackSkill(ATTACK_SKILL_ID, ATTACK_ACTION_ID))
    .withEffectAction(
      damageEffectAction(ATTACK_ACTION_ID, 1, "PREVENTED"),
      statModEffectAction(MEMORY_ACTION_ID),
    )
    .withMemory(
      createMemoryDefinition({
        memoryDefinitionId: createMemoryDefinitionId(DEPLOY_MEMORY_ID),
        triggeredEffects: [
          {
            trigger: {
              eventType: "BattleStarted",
              category: "FACT",
              sourceSelector: "SELF",
              targetSelector: "SELF",
            },
            effectSequence: {
              targetBindings: [
                {
                  targetBindingId: "TGT_ALL",
                  selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
                },
              ],
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "BINDING", targetBindingId: "TGT_ALL" },
                  actions: [{ effectActionDefinitionId: MEMORY_ACTION_ID }],
                },
              ],
            },
          },
        ],
        metadata: { displayName: DEPLOY_MEMORY_ID },
      }),
    )
    .build();
  const useCase = new SimulateTotalWarUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(["B_TOTAL_WAR"]),
    randomSourceFactory: new SequenceRandomSourceFactory(Array.from({ length: 500 }, () => 0.5)),
    clock: new ManualClock(0),
  });
  return {
    executeTotalWar: (request, context) =>
      Promise.resolve(useCase.execute(toSimulateTotalWarCommand(request), context)),
  };
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly violations: readonly {
      readonly path?: string;
      readonly ruleId?: string;
      readonly definitionId?: string;
      readonly message?: string;
    }[];
  };
}

describe("POST /api/v1/total-war-simulations (10_API設計.md「総力戦をシミュレーションする」)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function post(payload: object, useCase = buildRealTotalWarUseCase()) {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { totalWarUseCase: useCase });
    return app.inject({ method: "POST", url: TOTAL_WAR_SIMULATIONS_PATH, payload });
  }

  it("API-TWR-001 [R-TWR-06] (10_API設計.md「TotalWarResultResponse」): returns 200 with the total war result — outcome, stages and defeated formation counts", async () => {
    const response = await post(REQUEST_BODY);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    const body = response.json<TotalWarResponseBody>();
    expect(body.schemaVersion).toBe(1);
    expect(body.battleId).toBe("B_TOTAL_WAR");
    expect(body.result.outcome).toBe("ALLY_WIN");
    expect(body.result.completionReason).toBe("ENEMY_DEFEATED");
    expect(body.result.defeatedFormationCounts).toEqual({ ally: 0, enemy: 3 });
    expect(body.result.stages.map((stage) => stage.enemyFormationNumber)).toEqual([1, 2, 3]);
    expect(body.result.stages[0]).toEqual({
      stageNumber: 1,
      allyFormationNumber: 1,
      enemyFormationNumber: 1,
      startTurn: 1,
      endTurn: 1,
      defeatedSides: ["ENEMY"],
    });
    expect(body.result.completedTurn).toBe(body.result.stages.at(-1)?.endTurn);
  });

  it("API-TWR-002 [R-TWR-02] (10_API設計.md「TotalWarUnitRosterResponse」「公開レベル」): SUMMARY still returns the roster of every formation's units with formation number, reappearance and deployment, and summaries for all of them", async () => {
    const response = await post({
      ...REQUEST_BODY,
      allyFormations: [formationBody(["UNIT_STRIKER"])],
      enemyFormations: [
        formationBody(["UNIT_FRAGILE"]),
        formationBody(["UNIT_FRAGILE"], [DEPLOY_MEMORY_ID]),
      ],
      options: { logLevel: "SUMMARY" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TotalWarResponseBody>();
    expect(body).not.toHaveProperty("finalState");
    expect(body.events).toEqual([]);
    expect(body.stateTransitions).toEqual([]);
    expect(
      body.unitRoster.map(
        ({ side, formationNumber, unitDefinitionId, reappearance, deployed }) => ({
          side,
          formationNumber,
          unitDefinitionId,
          reappearance,
          deployed,
        }),
      ),
    ).toEqual([
      {
        side: "ALLY",
        formationNumber: 1,
        unitDefinitionId: "UNIT_STRIKER",
        reappearance: false,
        deployed: true,
      },
      {
        side: "ENEMY",
        formationNumber: 1,
        unitDefinitionId: "UNIT_FRAGILE",
        reappearance: false,
        deployed: true,
      },
      {
        side: "ENEMY",
        formationNumber: 2,
        unitDefinitionId: "UNIT_FRAGILE",
        reappearance: true,
        deployed: true,
      },
    ]);
    expect(body.unitRoster[0]).toMatchObject({
      formationPosition: { column: 0, row: "FRONT" },
      coordinate: expect.any(Object) as unknown,
    });
    // `initialState`は両陣営の1番目の編成だけを含み、全編成のユニットは`unitRoster`が運ぶ。
    expect(body.initialState.units.map((unit) => unit.battleUnitId)).toEqual([
      body.unitRoster[0]!.battleUnitId,
      body.unitRoster[1]!.battleUnitId,
    ]);
    expect(body.initialState.formations).toEqual({
      ally: { formationCount: 1, activeFormationNumber: 1, defeatedCount: 0 },
      enemy: { formationCount: 2, activeFormationNumber: 1, defeatedCount: 0 },
    });
    expect(body.initialState.units[1]?.formationNumber).toBe(1);
    expect(body.unitSummaries.map((summary) => summary.battleUnitId)).toEqual(
      body.unitRoster.map((entry) => entry.battleUnitId),
    );
    expect(
      body.unitSummaries.map(({ formationNumber, deployed }) => ({ formationNumber, deployed })),
    ).toEqual([
      { formationNumber: 1, deployed: true },
      { formationNumber: 1, deployed: true },
      { formationNumber: 2, deployed: true },
    ]);
  });

  it("API-TWR-003 [R-TWR-03, R-TWR-04] (10_API設計.md「BattleStateDeltaResponse」): DETAILED publishes the total-war-only events and state deltas — addedUnits as full unit states and formations changes — and a finalState holding every deployed unit", async () => {
    const response = await post({ ...REQUEST_BODY, options: { logLevel: "DETAILED" } });

    expect(response.statusCode).toBe(200);
    const body = response.json<TotalWarResponseBody>();
    const publishedTypes = new Set(body.events.map((event) => event.type));
    for (const type of ["FORMATION_DEFEATED", "FORMATION_DEPLOYED", "BATTLE_COMPLETED"]) {
      expect(publishedTypes, `the total war published no ${type}`).toContain(type);
    }

    const deployments = body.stateTransitions.filter(
      (transition) => transition.delta.addedUnits !== undefined,
    );
    expect(
      deployments.map((transition) =>
        transition.delta.addedUnits?.map((unit) => unit.formationNumber),
      ),
    ).toEqual([[2], [3]]);
    const firstDeployment = deployments[0]!.delta;
    const addedUnit = firstDeployment.addedUnits![0]!;
    expect(addedUnit.battleUnitId).toBe(body.unitRoster[2]!.battleUnitId);
    expect(addedUnit).toMatchObject({
      unitDefinitionId: "UNIT_FRAGILE",
      side: "ENEMY",
      combatStatus: "ACTIVE",
      formationPosition: { column: 0, row: "FRONT" },
    });
    expect(firstDeployment.formations).toEqual({
      enemy: { activeFormationNumber: { before: 1, after: 2 } },
    });
    expect(
      body.stateTransitions.some(
        (transition) => transition.delta.formations?.enemy?.defeatedCount !== undefined,
      ),
    ).toBe(true);

    expect(body.finalState?.units.map((unit) => unit.battleUnitId)).toEqual(
      body.unitRoster.map((entry) => entry.battleUnitId),
    );
    expect(body.finalState?.formations).toEqual({
      ally: { formationCount: 1, activeFormationNumber: 1, defeatedCount: 0 },
      enemy: { formationCount: 3, activeFormationNumber: 3, defeatedCount: 3 },
    });
    // R-TWR-06 #4: 総力戦の`BattleCompleted`は引き分けを含む勝敗と戦闘履歴を運ぶ。
    const completed = body.events.find((event) => event.type === "BATTLE_COMPLETED");
    expect(completed?.details).toMatchObject({
      outcome: body.result.outcome,
      stages: body.result.stages,
      defeatedFormationCounts: body.result.defeatedFormationCounts,
    });
  });

  it("API-TWR-004 (12_テスト戦略.md「実際の代表レスポンスが生成Schemaへ適合する」): a real total war's DETAILED and SUMMARY 200 bodies satisfy the doc schema this route publishes to OpenAPI", async () => {
    for (const logLevel of ["DETAILED", "SUMMARY"] as const) {
      const response = await post({ ...REQUEST_BODY, options: { logLevel } });
      await app?.close();
      app = undefined;

      expect(response.statusCode, logLevel).toBe(200);
      const validate = new Ajv({ strict: false }).compile(totalWarResponseDocSchema);
      const valid = validate(response.json());
      expect(valid, JSON.stringify(validate.errors?.slice(0, 5) ?? [], null, 2)).toBe(true);
    }
  });

  it("API-TWR-005 [R-TWR-01] (R-TWR-01 #5、10_API設計.md「TotalWarRequest」「`turnLimit`は持たない」): rejects turnLimit as an undefined top-level property (400 MALFORMED_REQUEST)", async () => {
    const response = await post({ ...REQUEST_BODY, turnLimit: 10 });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("MALFORMED_REQUEST");
  });

  it("API-TWR-006 (10_API設計.md「null・省略・空配列」): a missing enemyFormations is a structural 400, not a command violation", async () => {
    const response = await post({ allyFormations: REQUEST_BODY.allyFormations });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("MALFORMED_REQUEST");
  });

  it("API-TWR-007 [R-TWR-01] (R-TWR-01 #1、10_API設計.md「TotalWarRequest」): zero or four formations on a side is 422 INVALID_COMMAND on that side's path, not a structural 400", async () => {
    for (const [allyFormations, label] of [
      [[], "zero"],
      [Array.from({ length: 4 }, () => formationBody(["UNIT_STRIKER"])), "four"],
    ] as const) {
      const response = await post({ ...REQUEST_BODY, allyFormations });
      await app?.close();
      app = undefined;

      expect(response.statusCode, label).toBe(422);
      const error = response.json<ErrorBody>().error;
      expect(error.code).toBe("INVALID_COMMAND");
      expect(error.violations.map((violation) => violation.path)).toContain("/allyFormations");
    }
  });

  it("API-TWR-008 [R-TWR-01] (R-TWR-01 #3・#4、10_API設計.md「violationのパスに編成の添字を含める」): a unit or memory repeated within one formation is 422 with the formation index in the wire path, while the same unit in another formation is accepted", async () => {
    const response = await post({
      ...REQUEST_BODY,
      enemyFormations: [
        formationBody(["UNIT_FRAGILE"]),
        formationBody(["UNIT_FRAGILE", "UNIT_FRAGILE"], [DEPLOY_MEMORY_ID, DEPLOY_MEMORY_ID]),
      ],
    });

    expect(response.statusCode).toBe(422);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toEqual([
      expect.objectContaining({
        path: "/enemyFormations/1/units/1/unitDefinitionId",
        definitionId: "UNIT_FRAGILE",
        ruleId: "R-TWR-01",
      }),
      expect.objectContaining({
        path: "/enemyFormations/1/memoryDefinitionIds/1",
        definitionId: DEPLOY_MEMORY_ID,
        ruleId: "R-TWR-01",
      }),
    ]);
  });

  it("API-TWR-009 [R-TEX-11] (10_API設計.md「TotalWarRequest」「編成プールの違反は通常戦闘と同じく」): an exercise enemy unit in any formation is 422 with the rule id and the formation index", async () => {
    const response = await post({
      ...REQUEST_BODY,
      enemyFormations: [formationBody(["UNIT_FRAGILE"]), formationBody(["UNIT_TEX"])],
    });

    expect(response.statusCode).toBe(422);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toContainEqual(
      expect.objectContaining({
        path: "/enemyFormations/1/units/0/unitDefinitionId",
        definitionId: "UNIT_TEX",
        ruleId: "R-TEX-11",
      }),
    );
  });

  it("API-TWR-010 (10_API設計.md「公開レベル」): returns 422 INVALID_COMMAND with path /options/logLevel for an unknown log level", async () => {
    const response = await post({ ...REQUEST_BODY, options: { logLevel: "DIAGNOSTIC" } });

    expect(response.statusCode).toBe(422);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toContainEqual(expect.objectContaining({ path: "/options/logLevel" }));
  });

  it("API-TWR-011 (10_API設計.md「Cache-Control」「X-Request-Id」): the total war response is no-store and echoes the request ID, like the battle POST", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      totalWarUseCase: buildRealTotalWarUseCase(),
    });
    const response = await app.inject({
      method: "POST",
      url: TOTAL_WAR_SIMULATIONS_PATH,
      payload: REQUEST_BODY,
      headers: { "x-request-id": "ui-total-war-1" },
    });

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe("ui-total-war-1");
  });

  it("API-TWR-012 (11_インフラストラクチャ設計.md「Graceful Shutdown」): rejects a new total war with 503 CAPACITY_EXCEEDED once the shutdown gate reports draining, without reaching the use case", async () => {
    let reached = false;
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      shutdownGate: { isShuttingDown: () => true },
      totalWarUseCase: {
        executeTotalWar: () => {
          reached = true;
          return Promise.reject(new Error("must not be reached"));
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: TOTAL_WAR_SIMULATIONS_PATH,
      payload: REQUEST_BODY,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<ErrorBody>().error.code).toBe("CAPACITY_EXCEEDED");
    expect(reached).toBe(false);
  });

  it("API-TWR-013 (10_API設計.md「Inbound Adapterでの変換」): passes the request body through to the use case unchanged, including options.logLevel", async () => {
    const received: unknown[] = [];
    const realUseCase = buildRealTotalWarUseCase();
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      totalWarUseCase: {
        executeTotalWar: (request, context) => {
          received.push(request);
          return realUseCase.executeTotalWar(request, context);
        },
      },
    });

    const payload = { ...REQUEST_BODY, options: { logLevel: "SUMMARY" } };
    await app.inject({ method: "POST", url: TOTAL_WAR_SIMULATIONS_PATH, payload });

    expect(received).toEqual([payload]);
  });

  it("API-TWR-014 (build-server.ts「未配線のまま呼ばれたら黙って偽の結果を返さず500にする」): a server built without a total war use case answers 500 instead of a fabricated result", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE);

    const response = await app.inject({
      method: "POST",
      url: TOTAL_WAR_SIMULATIONS_PATH,
      payload: REQUEST_BODY,
    });

    expect(response.statusCode).toBe(500);
  });
});
