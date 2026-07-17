import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

const ALLOWED_ORIGIN = "https://komei0727.github.io";
const DISALLOWED_ORIGIN = "https://evil.example.com";

/**
 * レビュー指摘（PR #110 [P1]）: `origin`へ配列を渡すだけでは、
 * `@fastify/cors`は未許可originや`Origin`なしのrequestでも
 * `Access-Control-Expose-Headers`（および preflightでは
 * `Access-Control-Allow-Methods`／`Access-Control-Allow-Headers`）を
 * 無条件に付与してしまう——`Access-Control-Allow-Origin`さえ確認する
 * だけでは検出できない。`access-control-*`ヘッダーが一つも存在しない
 * ことを網羅的に確認する。
 */
function accessControlHeaderKeys(headers: Record<string, unknown>): readonly string[] {
  return Object.keys(headers).filter((key) => key.toLowerCase().startsWith("access-control-"));
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

/** `unitDefinition`の`extraSkillDefinitionId`（"SKL_EX"）が参照するEXスキル。EXゲージは満タンにならないため実際には使用されない。 */
function exSkillDefinition(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
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

class FakeBattleCatalog implements BattleCatalog {
  private readonly units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>;

  constructor(units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>) {
    this.units = units;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-cors-1",
      units: this.units,
      skills: new Map([[createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")]]),
      effectActions: new Map(),
      memories: new Map(),
      capabilities: new Map(),
    };
  }
}

function toDirectExecutor(useCase: SimulateBattleUseCase): SimulateBattleUseCasePort {
  return {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(useCase.execute(toSimulateBattleCommand(request), context)),
  };
}

function buildTestUseCase(): SimulateBattleUseCasePort {
  const units = new Map([[createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")]]);
  return toDirectExecutor(
    new SimulateBattleUseCase({
      battleCatalog: new FakeBattleCatalog(units),
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock: new ManualClock(Date.now()),
    }),
  );
}

function validRequestBody() {
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
  };
}

describe("CORS (10_API設計.md「CORS」、11_インフラストラクチャ設計.md「CORS」)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("API-CORS-001: an allowed origin's Catalog GET receives a matching Access-Control-Allow-Origin header", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/battle-simulation-catalog",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("API-CORS-002: an allowed origin's battle-simulations POST receives a matching Access-Control-Allow-Origin header", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: validRequestBody(),
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("API-CORS-003: a preflight OPTIONS request from an allowed origin succeeds with the documented methods and request headers allowed", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/battle-simulations",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    const allowedMethods = String(response.headers["access-control-allow-methods"]);
    expect(allowedMethods).toContain("GET");
    expect(allowedMethods).toContain("POST");
    expect(allowedMethods).toContain("OPTIONS");
  });

  it("API-CORS-004: a disallowed origin does not receive any Access-Control-* header on a normal request", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/battle-simulation-catalog",
      headers: { origin: DISALLOWED_ORIGIN },
    });

    expect(accessControlHeaderKeys(response.headers)).toEqual([]);
  });

  it("API-CORS-005: a request without an Origin header is not rejected and receives no Access-Control-* header", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/battle-simulation-catalog",
    });

    expect(response.statusCode).toBe(200);
    expect(accessControlHeaderKeys(response.headers)).toEqual([]);
  });

  it("API-CORS-009 (PRレビュー指摘[P1]): a disallowed origin's preflight OPTIONS receives no Access-Control-* header (no Allow-Methods/Allow-Headers leak)", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/battle-simulations",
      headers: {
        origin: DISALLOWED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(accessControlHeaderKeys(response.headers)).toEqual([]);
  });

  it("API-CORS-010 (PRレビュー指摘[P1]): a preflight OPTIONS without an Origin header receives no Access-Control-* header", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/battle-simulations",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(accessControlHeaderKeys(response.headers)).toEqual([]);
  });

  it("API-CORS-006: browsers can read X-Request-Id, Retry-After, and ETag via Access-Control-Expose-Headers", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/battle-simulation-catalog",
      headers: { origin: ALLOWED_ORIGIN },
    });

    const exposedHeaders = String(response.headers["access-control-expose-headers"]);
    expect(exposedHeaders).toContain("X-Request-Id");
    expect(exposedHeaders).toContain("Retry-After");
    expect(exposedHeaders).toContain("ETag");
  });

  it("API-CORS-007: credentials are never allowed (no Access-Control-Allow-Credentials header)", async () => {
    app = await buildServer(buildTestUseCase(), { corsAllowedOrigins: [ALLOWED_ORIGIN] });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/battle-simulation-catalog",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("API-CORS-008: with no corsAllowedOrigins configured (production default), no origin is reflected", async () => {
    app = await buildServer(buildTestUseCase());

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/battle-simulation-catalog",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
