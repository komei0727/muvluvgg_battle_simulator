import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import {
  battleSimulationResponseSchema,
  battleSimulationResponseDocSchema,
  battleLogEventResponseDocSchema,
} from "./schemas.js";
import type {
  BattleSimulationRequestBody,
  BattleSimulationResponseBody,
} from "../../application/http-contract.js";
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
      catalogRevision: "rev-1",
      units: this.units,
      skills: new Map(),
      effectActions: new Map(),
      memories: new Map(),
      capabilities: new Map(),
    };
  }
}

/** `build-server.test.ts`と同様、Worker経由の実体を薄いdirect adapterで代替する。 */
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

describe("OpenAPI document", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer(buildTestUseCase());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("API-OPENAPI-001: generates an OpenAPI 3.0.3 document describing POST /api/v1/battle-simulations", () => {
    interface MinimalOpenApiV3Document {
      readonly openapi: string;
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly post?: {
              readonly requestBody?: unknown;
              readonly responses?: Readonly<Record<string, unknown>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;

    expect(document.openapi).toBe("3.0.3");
    const operation = document.paths?.["/api/v1/battle-simulations"]?.post;
    expect(operation).toBeDefined();
    expect(operation?.requestBody).toBeDefined();
    // `10_API設計.md`「ステータスコード対応」の全ステータス。429/503/504は
    // 実際のトリガー（#12/#13/#18）が未実装でも、外部契約として文書化する。
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
      ["200", "400", "406", "413", "415", "422", "429", "500", "503", "504"].sort(),
    );
  });

  it("API-OPENAPI-003 (10_API設計.md「必須項目と値域」「列挙値」): the published request schema documents turnLimit's 1-99 range and column/row/logLevel's enums, even though the runtime validator stays loose to keep out-of-range values classified as 422 INVALID_COMMAND", async () => {
    interface JsonSchemaObject {
      readonly type?: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly enum?: readonly unknown[];
      readonly items?: JsonSchemaObject;
      readonly properties?: Readonly<Record<string, JsonSchemaObject>>;
    }
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly post?: {
              readonly requestBody?: {
                readonly content?: {
                  readonly "application/json"?: { readonly schema?: JsonSchemaObject };
                };
              };
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const bodySchema =
      document.paths?.["/api/v1/battle-simulations"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema;

    expect(bodySchema?.properties?.["turnLimit"]).toMatchObject({ minimum: 1, maximum: 99 });
    const positionSchema =
      bodySchema?.properties?.["allyFormation"]?.properties?.["units"]?.items?.properties?.[
        "position"
      ];
    expect(positionSchema?.properties?.["column"]?.enum).toEqual([0, 1, 2]);
    expect(positionSchema?.properties?.["row"]?.enum).toEqual(["FRONT", "REAR"]);
    expect(bodySchema?.properties?.["options"]?.properties?.["logLevel"]?.enum).toEqual([
      "SUMMARY",
      "DETAILED",
      "DIAGNOSTIC",
    ]);

    // The runtime validator (used by the actual route, not the doc) is unaffected:
    // an out-of-range turnLimit still reaches Application's `validateCommandShape`
    // and comes back as 422 INVALID_COMMAND, not 400 MALFORMED_REQUEST.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        turnLimit: 0,
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it("API-OPENAPI-002: a representative 200 response body validates against the generated response schema (10_API設計.md/12_テスト戦略.md「実際の代表レスポンスが生成Schemaへ適合する」)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        turnLimit: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<BattleSimulationResponseBody>();
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleSimulationResponseSchema);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);

    // This scenario has no active skill in the Catalog, so it exhausts
    // TURN_LIMIT_REACHED: it exercises ActionStarted(WAIT)/TurnCompleting/
    // TurnCompleted, which the lethal-damage scenario in
    // state-restoration.test.ts never reaches. Validating both against the
    // OpenAPI-published doc schema (`battleLogEventResponseDocSchema`'s
    // per-event-type `oneOf`) together covers all 19 M3 event types.
    const validateDoc = ajv.compile(battleSimulationResponseDocSchema);
    expect(validateDoc(body), JSON.stringify(validateDoc.errors)).toBe(true);
  });

  it("API-OPENAPI-004: rejects an event whose type/details combination is inconsistent, even though details alone matches a different event type's shape (a mismatch AJV previously accepted)", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const mismatched = {
      sequence: 1,
      type: "DAMAGE_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: [],
      // This is a well-formed TurnStarted-shaped details payload, not a
      // DamageApplied one — the mismatch itself must be rejected.
      details: { turnNumber: 1 },
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    expect(validate(mismatched)).toBe(false);

    const matched = {
      ...mismatched,
      details: {
        effectActionDefinitionId: "ACT_1",
        hitIndex: 0,
        targetUnitId: "enemy:1",
        calculatedDamage: 10,
        hitPointDamage: 10,
        hpBefore: 20,
        hpAfter: 10,
        defeated: false,
      },
    };
    expect(validate(matched), JSON.stringify(validate.errors)).toBe(true);
  });
});
