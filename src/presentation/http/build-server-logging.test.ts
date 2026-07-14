import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import { toSimulateBattleCommand } from "../../application/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation-execution-context.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/catalog-ids.js";
import type { UnitDefinition } from "../../domain/catalog/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import type { BattleSimulationRequestBody } from "../../application/http-contract.js";

/**
 * `11_インフラストラクチャ設計.md`「ログ設計」の最小field
 * （`requestId`・`catalogRevision`）が構造化JSONログへ実際に出力されることを、
 * Fastify内蔵のpinoロガーへ差し替え可能な`stream`を渡して直接検証する。
 */
function collectJsonLogLines(): {
  readonly stream: Writable;
  readonly lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
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

  constructor(units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>) {
    this.units = units;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-log-1",
      units: this.units,
      skills: new Map(),
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

describe("structured logging", () => {
  it("LOG-001 (11_インフラストラクチャ設計.md「ログ設計」テスト「ログへのRequest ID・catalogRevision記録」): a completed battle logs requestId and catalogRevision as structured JSON fields", async () => {
    const { stream, lines } = collectJsonLogLines();
    const app = await buildServer(buildTestUseCase(), { logger: { level: "info", stream } });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
        headers: { "x-request-id": "log-req-1" },
      });
      expect(response.statusCode).toBe(200);

      const completion = lines().find((line) => line["catalogRevision"] === "rev-log-1");
      expect(completion).toBeDefined();
      expect(completion?.["requestId"]).toBe("log-req-1");
      expect(completion?.["battleId"]).toBe("B_1");
      expect(completion?.["level"]).toEqual(expect.any(Number));
      // `11_インフラストラクチャ設計.md`「ログ設計」の必須field名は`timestamp`・
      // `message`（Pino既定の`time`・`msg`ではない）。
      expect(completion?.["timestamp"]).toEqual(expect.any(Number));
      expect(completion?.["message"]).toBe("battle completed");
      expect(completion?.["time"]).toBeUndefined();
      expect(completion?.["msg"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("LOG-002: a 500-mapped internal error logs requestId alongside diagnosticId, so the two logs correlate", async () => {
    const { stream, lines } = collectJsonLogLines();
    const app = await buildServer(
      {
        execute: () => Promise.reject(new Error("boom")),
      },
      { logger: { level: "info", stream } },
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
        headers: { "x-request-id": "log-req-2" },
      });
      expect(response.statusCode).toBe(500);
      const diagnosticId = response.json<{ error: { diagnosticId: string } }>().error.diagnosticId;

      const errorLog = lines().find((line) => line["diagnosticId"] === diagnosticId);
      expect(errorLog).toBeDefined();
      expect(errorLog?.["requestId"]).toBe("log-req-2");
      expect(errorLog?.["timestamp"]).toEqual(expect.any(Number));
    } finally {
      await app.close();
    }
  });

  it("LOG-003: no logger is attached by default (logger option omitted), matching prior behavior for tests that don't care about logs", async () => {
    const app = await buildServer(buildTestUseCase());
    try {
      // `request.log` must still exist (Fastify's no-op abstract-logging) so
      // route/error-handler code that calls it never throws.
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("Request ID generation via genReqId", () => {
  it("LOG-004: an invalid X-Request-Id header (e.g. containing control characters) is not trusted verbatim — the generated id is still echoed consistently on the response", async () => {
    const app = await buildServer(buildTestUseCase());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: validRequestBody(),
        headers: { "x-request-id": "bad\nheader" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-request-id"]).not.toBe("bad\nheader");
      expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });
});
