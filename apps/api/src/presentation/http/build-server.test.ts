import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";
import type { BattleSimulationResponseBody } from "../../application/contracts/response.js";
import type { ErrorResponseBody } from "../../application/contracts/error.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import { SimulationCapacityExceededError } from "../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import { createCapabilityDefinition } from "../../domain/catalog/capability/capability-definition.js";
import {
  createCapabilityId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type CapabilityId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

/** `unitDefinition`の`extraSkillDefinitionId`（"SKL_EX"）が参照するEXスキル。EXゲージは満タンにならないため実際には使用されない。 */
function exSkillDefinition(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
  };
}

function unitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: { displayName: id, characterName: id, characterId: id, affiliations: [], tags: [] },
  };
}

class FakeBattleCatalog implements BattleCatalog {
  private readonly units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>;
  private readonly capabilities: BattleCatalogSnapshot["capabilities"];

  constructor(
    units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>,
    capabilities: BattleCatalogSnapshot["capabilities"] = new Map(),
  ) {
    this.units = units;
    this.capabilities = capabilities;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-1",
      units: this.units,
      skills: new Map([[createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")]]),
      effectActions: new Map(),
      memories: new Map(),
      capabilities: this.capabilities,
    };
  }
}

const UNITS = new Map([[createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")]]);

/**
 * `SimulateBattleUseCasePort`はDTOを受け取りWorker Thread経由で実行される
 * 想定（本番実装は`SimulationWorkerPool`）だが、このHTTP契約テストでは
 * ルーティング・エラーマッピングだけを検証したいため、同じ変換
 * （`toSimulateBattleCommand`）をメインスレッド内で直接呼ぶ薄いadapterで代替する。
 */
function toDirectExecutor(useCase: SimulateBattleUseCase): SimulateBattleUseCasePort {
  return {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(useCase.execute(toSimulateBattleCommand(request), context)),
  };
}

function buildTestUseCase(): SimulateBattleUseCasePort {
  return toDirectExecutor(
    new SimulateBattleUseCase({
      battleCatalog: new FakeBattleCatalog(UNITS),
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock: new ManualClock(Date.now()),
    }),
  );
}

function validRequestBody(overrides: Record<string, unknown> = {}) {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 3,
    ...overrides,
  };
}

describe("POST /api/v1/battle-simulations", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer(buildTestUseCase());
  });

  afterEach(async () => {
    await app.close();
  });

  it("API-CONTRACT-001: returns 200 with a schemaVersion 1 BattleSimulationResponse for a minimal valid request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<BattleSimulationResponseBody>();
    expect(body.schemaVersion).toBe(1);
    expect(body.battleId).toBe("B_1");
    expect(body.result.outcome).toEqual(expect.any(String));
    expect(body.initialState.stateVersion).toBe(0);
  });

  it("API-CONTRACT-002: sets Cache-Control: no-store and echoes/generates X-Request-Id on success", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { "x-request-id": "client-req-42" },
    });

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe("client-req-42");
  });

  it("API-CONTRACT-003: returns 400 MALFORMED_REQUEST for syntactically invalid JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>().error.code).toBe("MALFORMED_REQUEST");
  });

  it("API-CONTRACT-004: returns 400 MALFORMED_REQUEST for a missing required field", async () => {
    const { turnLimit: _turnLimit, ...withoutTurnLimit } = validRequestBody();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: withoutTurnLimit,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>().error.code).toBe("MALFORMED_REQUEST");
  });

  it("API-CONTRACT-005: returns 400 MALFORMED_REQUEST for an unknown top-level property", () =>
    app
      .inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody({ unexpectedField: true }),
      })
      .then((response) => {
        expect(response.statusCode).toBe(400);
        expect(response.json<ErrorResponseBody>().error.code).toBe("MALFORMED_REQUEST");
      }));

  it("API-CONTRACT-006: returns 400 MALFORMED_REQUEST for a numeric-string turnLimit instead of a number", () =>
    app
      .inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody({ turnLimit: "3" }),
      })
      .then((response) => {
        expect(response.statusCode).toBe(400);
        expect(response.json<ErrorResponseBody>().error.code).toBe("MALFORMED_REQUEST");
      }));

  it("API-CONTRACT-007: returns 415 UNSUPPORTED_MEDIA_TYPE for a non-JSON Content-Type", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: "<xml/>",
      headers: { "content-type": "application/xml" },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<ErrorResponseBody>().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("API-CONTRACT-008: returns 413 REQUEST_TOO_LARGE when the body exceeds the configured bodyLimit", async () => {
    const small = await buildServer(buildTestUseCase(), { bodyLimit: 64 });
    try {
      const response = await small.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json<ErrorResponseBody>().error.code).toBe("REQUEST_TOO_LARGE");
    } finally {
      await small.close();
    }
  });

  it("API-CONTRACT-009: returns 422 INVALID_COMMAND for an out-of-range turnLimit (Command-level, not JSON Schema)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody({ turnLimit: 0 }),
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorResponseBody>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations.length).toBeGreaterThan(0);
    expect(body.error.violations[0]!.path).toBe("/turnLimit");
  });

  it("API-CONTRACT-010: returns 422 DEFINITION_NOT_FOUND for an unknown unitDefinitionId, with an external JSON Pointer path (not the internal Command's dot/`slots` form)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody({
        allyFormation: {
          units: [{ unitDefinitionId: "UNKNOWN", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
      }),
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorResponseBody>();
    expect(body.error.code).toBe("DEFINITION_NOT_FOUND");
    expect(body.error.violations).toEqual([
      expect.objectContaining({ path: "/allyFormation/units/0/unitDefinitionId" }),
    ]);
  });

  it("API-CONTRACT-011: returns 422 UNSUPPORTED_RULE for a definition requiring an unimplemented Capability", async () => {
    const capabilityId: CapabilityId = createCapabilityId("CAP_UNSUPPORTED");
    const gated = unitDefinition("UNIT_GATED");
    const units = new Map([
      [gated.unitDefinitionId, { ...gated, requiredCapabilities: [capabilityId] }],
    ]);
    const capabilities = new Map([
      [
        capabilityId,
        createCapabilityDefinition({
          capabilityId: "CAP_UNSUPPORTED",
          schemaStatus: "SUPPORTED",
          runtimeStatus: "PLANNED",
          implementationTaskId: "TEST-001",
          description: "not yet implemented",
          verification: { productionDefinitionIds: ["TEST_DEFINITION"], testCaseIds: ["TEST-001"] },
        }),
      ],
    ]);
    const gatedUseCase = toDirectExecutor(
      new SimulateBattleUseCase({
        battleCatalog: new FakeBattleCatalog(units, capabilities),
        battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
        randomSourceFactory: new SequenceRandomSourceFactory([]),
        clock: new ManualClock(Date.now()),
      }),
    );
    const gatedApp = await buildServer(gatedUseCase);
    const gatedSlot = {
      units: [{ unitDefinitionId: "UNIT_GATED", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    };

    try {
      const response = await gatedApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody({ allyFormation: gatedSlot, enemyFormation: gatedSlot }),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<ErrorResponseBody>().error.code).toBe("UNSUPPORTED_RULE");
    } finally {
      await gatedApp.close();
    }
  });

  it("API-CONTRACT-012: returns 406 NOT_ACCEPTABLE when Accept excludes application/json and */*", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { accept: "text/plain" },
    });

    expect(response.statusCode).toBe(406);
    expect(response.json<ErrorResponseBody>().error.code).toBe("NOT_ACCEPTABLE");
  });

  it("API-CONTRACT-013: returns 406 NOT_ACCEPTABLE when application/json is explicitly excluded with q=0, not just absent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { accept: "application/json;q=0" },
    });

    expect(response.statusCode).toBe(406);
    expect(response.json<ErrorResponseBody>().error.code).toBe("NOT_ACCEPTABLE");
  });

  it("API-CONTRACT-014: returns 406 NOT_ACCEPTABLE when only the wildcard matches and that wildcard is q=0", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { accept: "text/plain, */*;q=0" },
    });

    expect(response.statusCode).toBe(406);
    expect(response.json<ErrorResponseBody>().error.code).toBe("NOT_ACCEPTABLE");
  });

  it("API-CONTRACT-015: accepts application/json when a q=0 entry for a different type coexists with an acceptable */* or application/json entry", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { accept: "text/html;q=0, application/json" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("API-CONTRACT-015b (RFC 9110 §8.3.1): matches Accept media types case-insensitively", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { accept: "Application/JSON" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("API-CONTRACT-015c (RFC 9110 §5.6.6): rejects application/json when explicitly excluded via an uppercase `Q=0` parameter name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { accept: "application/json;Q=0" },
    });

    expect(response.statusCode).toBe(406);
    expect(response.json<ErrorResponseBody>().error.code).toBe("NOT_ACCEPTABLE");
  });

  it("API-CONTRACT-016 (10_API設計.md「ErrorObject」diagnosticId): an unexpected exception (not an ApplicationError) returns 500 with a diagnosticId, without leaking the exception message", async () => {
    const throwingApp = await buildServer({
      execute: () => {
        throw new Error("unexpected failure with sensitive internal detail");
      },
    });

    try {
      const response = await throwingApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });

      expect(response.statusCode).toBe(500);
      const body = response.json<ErrorResponseBody>();
      expect(body.error.code).toBe("INTERNAL_INVARIANT_VIOLATION");
      expect(body.error.diagnosticId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain("sensitive internal detail");
    } finally {
      await throwingApp.close();
    }
  });

  it("API-CONTRACT-017 (11_インフラストラクチャ設計.md「Request IDと期限を含むリクエストコンテキストを生成する」): passes the same X-Request-Id that is echoed on the response into the UseCase port's execution context", async () => {
    let capturedRequestId: string | undefined;
    const capturingApp = await buildServer({
      execute: (_request, context) => {
        capturedRequestId = context.requestId;
        return Promise.reject(new ApplicationError("INVALID_COMMAND", [{ reason: "stub" }]));
      },
    });

    try {
      const response = await capturingApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
        headers: { "x-request-id": "client-req-42" },
      });

      expect(capturedRequestId).toBe("client-req-42");
      expect(response.headers["x-request-id"]).toBe(capturedRequestId);
    } finally {
      await capturingApp.close();
    }
  });

  it("API-CONTRACT-018: generates a requestId consistent with the response header when the client sends no X-Request-Id, rather than regenerating an unrelated one for the response", async () => {
    let capturedRequestId: string | undefined;
    const capturingApp = await buildServer({
      execute: (_request, context) => {
        capturedRequestId = context.requestId;
        return Promise.reject(new ApplicationError("INVALID_COMMAND", [{ reason: "stub" }]));
      },
    });

    try {
      const response = await capturingApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });

      expect(capturedRequestId).toEqual(expect.any(String));
      expect(capturedRequestId).not.toHaveLength(0);
      expect(response.headers["x-request-id"]).toBe(capturedRequestId);
    } finally {
      await capturingApp.close();
    }
  });

  it("API-CONTRACT-019 (11_インフラストラクチャ設計.md「設定項目」`SIMULATION_TIMEOUT_MS`): derives deadlineEpochMs from the configured simulationTimeoutMs, roughly Date.now() + simulationTimeoutMs", async () => {
    let capturedDeadlineEpochMs: number | undefined;
    const beforeRequest = Date.now();
    const capturingApp = await buildServer(
      {
        execute: (_request, context) => {
          capturedDeadlineEpochMs = context.deadlineEpochMs;
          return Promise.reject(new ApplicationError("INVALID_COMMAND", [{ reason: "stub" }]));
        },
      },
      { simulationTimeoutMs: 5_000 },
    );

    try {
      await capturingApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });

      expect(capturedDeadlineEpochMs).toBeGreaterThanOrEqual(beforeRequest + 5_000);
      expect(capturedDeadlineEpochMs).toBeLessThanOrEqual(Date.now() + 5_000);
    } finally {
      await capturingApp.close();
    }
  });

  it("API-CONTRACT-020 (regression for a reviewed P1 defect): a normal request that completes successfully never aborts its own cancellationSignal, even though the request body finishes being read well before the response is sent", async () => {
    let capturedSignal: AbortSignal | undefined;
    const directExecutor = buildTestUseCase();
    const delayedApp = await buildServer({
      execute: async (request, context) => {
        capturedSignal = context.cancellationSignal;
        // Give the request stream time to fully finish being read (and
        // therefore `request.raw`'s own `close` event, the signal this
        // previously — incorrectly — listened on, time to fire) before this
        // resolves, so a regression back to listening on `request.raw` would
        // show up as `capturedSignal?.aborted === true` here.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return directExecutor.execute(request, context);
      },
    });

    try {
      const response = await delayedApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });

      expect(capturedSignal?.aborted).toBe(false);
      expect(response.statusCode).toBe(200);
    } finally {
      await delayedApp.close();
    }
  });

  it("API-CONTRACT-021 (10_API設計.md「Worker Poolの容量不足は503 CAPACITY_EXCEEDEDで拒否する」「Retry-Afterを設定できる場合は設定する」): maps SimulationCapacityExceededError to 503 CAPACITY_EXCEEDED with a Retry-After header", async () => {
    const fullApp = await buildServer({
      execute: () => {
        throw new SimulationCapacityExceededError();
      },
    });

    try {
      const response = await fullApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json<ErrorResponseBody>().error.code).toBe("CAPACITY_EXCEEDED");
      expect(response.headers["retry-after"]).toEqual(expect.any(String));
    } finally {
      await fullApp.close();
    }
  });

  it("API-CONTRACT-022 (11_インフラストラクチャ設計.md「Graceful Shutdown」ステップ2「新しい戦闘リクエストの受付を停止する」): rejects a new battle request with 503 CAPACITY_EXCEEDED, without ever invoking the UseCase, once shutdownGate reports shutting down", async () => {
    let executed = false;
    const shuttingDownApp = await buildServer(
      {
        execute: () => {
          executed = true;
          return Promise.reject(new ApplicationError("INVALID_COMMAND", [{ reason: "unused" }]));
        },
      },
      { shutdownGate: { isShuttingDown: () => true } },
    );

    try {
      const response = await shuttingDownApp.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json<ErrorResponseBody>().error.code).toBe("CAPACITY_EXCEEDED");
      expect(response.headers["retry-after"]).toEqual(expect.any(String));
      expect(executed).toBe(false);
    } finally {
      await shuttingDownApp.close();
    }
  });
});

describe("health routes wired through buildServer", () => {
  it("API-HEALTH-006: registers /health/live and /health/ready, defaulting readiness to true when no ReadinessPort is supplied", async () => {
    const app = await buildServer(buildTestUseCase());
    try {
      const live = await app.inject({ method: "GET", url: "/health/live" });
      const ready = await app.inject({ method: "GET", url: "/health/ready" });

      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("API-HEALTH-007 (受け入れ条件「準備未完了時にreadinessが成功しない」): /health/ready reflects a supplied ReadinessPort that reports not ready", async () => {
    const app = await buildServer(buildTestUseCase(), { readiness: { isReady: () => false } });
    try {
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("Swagger UI docs (#85 受け入れ条件「productionではSwagger UIが既定で無効である」)", () => {
  it("API-DOCS-001: does not register /docs when docsEnabled is left at its default", async () => {
    const app = await buildServer(buildTestUseCase());
    try {
      const response = await app.inject({ method: "GET", url: "/docs" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("API-DOCS-002: serves the Swagger UI HTML page at /docs when docsEnabled is true", async () => {
    const app = await buildServer(buildTestUseCase(), { docsEnabled: true });
    try {
      const response = await app.inject({ method: "GET", url: "/docs" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("swagger");
    } finally {
      await app.close();
    }
  });

  it("API-DOCS-003 (受け入れ条件「Swagger UIからPOST /api/v1/battle-simulationsの仕様を確認できる」): the Swagger UI's own OpenAPI document includes POST /api/v1/battle-simulations when docsEnabled is true", async () => {
    const app = await buildServer(buildTestUseCase(), { docsEnabled: true });
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);
      const document = response.json<{ paths?: Record<string, unknown> }>();
      expect(document.paths?.["/api/v1/battle-simulations"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("API-DOCS-004 (受け入れ条件「既存のGET /openapi.jsonを壊さない」): GET /openapi.json keeps working the same whether or not docsEnabled is set", async () => {
    const withoutDocs = await buildServer(buildTestUseCase());
    const withDocs = await buildServer(buildTestUseCase(), { docsEnabled: true });
    try {
      const withoutResponse = await withoutDocs.inject({ method: "GET", url: "/openapi.json" });
      const withResponse = await withDocs.inject({ method: "GET", url: "/openapi.json" });
      expect(withoutResponse.statusCode).toBe(200);
      expect(withResponse.statusCode).toBe(200);
      expect(withResponse.json()).toEqual(withoutResponse.json());
    } finally {
      await withoutDocs.close();
      await withDocs.close();
    }
  });
});
