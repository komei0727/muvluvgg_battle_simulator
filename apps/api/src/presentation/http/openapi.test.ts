import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./build-server.js";
import { BATTLE_SIMULATION_CATALOG_PATH } from "./routes/catalog-route.js";
import { BATTLE_SIMULATIONS_PATH } from "./routes/simulation-route.js";
import { TACTICAL_EXERCISES_PATH } from "./routes/tactical-exercise-route.js";
import {
  HTTP_ERROR_CODES,
  errorCodesForHttpStatus,
} from "./protocol/error-response/error-response-mapper.js";
import { errorResponseDocSchemaForStatus } from "./schemas/error/error-schema.js";
import {
  battleSimulationResponseSchema,
  battleSimulationResponseDocSchema,
  cooldownStateResponseSchema,
  effectStateResponseSchema,
} from "./schemas/simulation/simulation-schema.js";
import {
  battleLogEventResponseDocSchema,
  battleLogEventResponseSchema,
  exerciseBattleLogEventResponseDocSchema,
  EXERCISE_ONLY_EVENT_TYPES,
  runtimeCounterChangedDetailsSchema,
  effectDurationReducedDetailsSchema,
  CONDITION_KIND_ENUM,
  EFFECT_ACTION_KIND_ENUM,
  STATUS_KIND_ENUM,
} from "./schemas/battle-log/battle-log-schema.js";
import type { BattleLogEventResponseBody } from "../../application/contracts/battle-log.js";
import type { BattleSimulationResponseBody } from "../../application/contracts/response.js";
import { GEAR_STAT_APPLICATION_ENUM } from "./schemas/catalog/catalog-schema.js";
import { SUMMARY_EVENT_TYPE_INCLUSION } from "../../application/observation/battle-log-projection.js";
import { GEAR_STAT_APPLICATION_KINDS } from "../../domain/battle/model/gear-customization-policy.js";
import { CONDITION_KINDS } from "../../domain/catalog/definitions/condition-definition.js";
import { EFFECT_ACTION_KINDS } from "../../domain/catalog/definitions/effect-action-definition.js";
import { STATUS_KINDS } from "../../domain/catalog/definitions/effect-action-payload.js";
import { buildOpenApiTestUseCase } from "../../testing/http/openapi-test-use-case.js";

/**
 * 意図的な横断テスト（`12_テスト戦略.md`の co-location 規約における `<module>.test.ts`
 * 命名の例外）。検証対象は単一モジュールではなく`buildServer`が`routes/`と`schemas/`
 * から組み上げて公開する OpenAPI ドキュメント一枚であり、「全ルートと全ステータスに
 * Schema がある」（同書）はルート横断でしか確認できない。
 */
interface OpenApiResponseForTest {
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly content?: Readonly<
    Record<string, { readonly schema?: { readonly properties?: Record<string, unknown> } }>
  >;
}

interface OpenApiDocumentForTest {
  readonly paths?: Readonly<
    Record<
      string,
      Readonly<
        Record<string, { readonly responses?: Readonly<Record<string, OpenApiResponseForTest>> }>
      >
    >
  >;
}

/** 公開文書のエラーresponseから`error.code`の`enum`を取り出す。 */
function publishedErrorCodeEnum(response: OpenApiResponseForTest | undefined): unknown {
  const schema = response?.content?.["application/json"]?.schema;
  const error = schema?.properties?.["error"] as
    | { readonly properties?: { readonly code?: { readonly enum?: unknown } } }
    | undefined;
  return error?.properties?.code?.enum;
}
describe("OpenAPI document", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer(buildOpenApiTestUseCase());
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

  it("API-OPENAPI-034 (TEX-007、10_API設計.md「戦術演習をシミュレーションする」): documents POST /api/v1/tactical-exercises with the same status set as the battle POST and an ExerciseResultResponse that carries no outcome", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly post?: {
              readonly requestBody?: unknown;
              readonly responses?: Readonly<
                Record<
                  string,
                  {
                    readonly content?: Readonly<
                      Record<
                        string,
                        {
                          readonly schema?: {
                            readonly properties?: Record<
                              string,
                              { readonly properties?: Record<string, unknown> }
                            >;
                          };
                        }
                      >
                    >;
                  }
                >
              >;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const operation = document.paths?.[TACTICAL_EXERCISES_PATH]?.post;

    expect(operation).toBeDefined();
    expect(operation?.requestBody).toBeDefined();
    // 戦闘POSTと同じWorker Poolを通るため、返り得るステータスも同じ。
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
      ["200", "400", "406", "413", "415", "422", "429", "500", "503", "504"].sort(),
    );

    const result =
      operation?.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.["result"];
    // R-TEX-10 #1: 演習は勝敗を確定しない。
    expect(Object.keys(result?.properties ?? {}).sort()).toEqual([
      "breakCount",
      "breaks",
      "completedTurn",
      "completionReason",
      "totalScore",
    ]);
  });

  it("API-OPENAPI-035 (TEX-007、10_API設計.md「TacticalExerciseRequest」): the published exercise request schema documents R-TEX-01 #3 (exactly one enemy unit, no enemy memory) and has no turnLimit, even though the runtime validator leaves those counts to 422", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly post?: {
              readonly requestBody?: {
                readonly content?: Readonly<
                  Record<
                    string,
                    {
                      readonly schema?: {
                        readonly properties?: Record<string, Record<string, unknown>>;
                      };
                    }
                  >
                >;
              };
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const schema =
      document.paths?.[TACTICAL_EXERCISES_PATH]?.post?.requestBody?.content?.["application/json"]
        ?.schema;

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "allyFormation",
      "enemyFormation",
      "options",
    ]);

    const enemyProperties = (
      schema?.properties?.["enemyFormation"] as
        | { readonly properties?: Record<string, Record<string, unknown>> }
        | undefined
    )?.properties;
    expect(enemyProperties?.["units"]).toMatchObject({ minItems: 1, maxItems: 1 });
    expect(enemyProperties?.["memoryDefinitionIds"]).toMatchObject({ maxItems: 0 });

    // 味方編成は戦闘と同じ1〜5体のまま。
    const allyProperties = (
      schema?.properties?.["allyFormation"] as
        | { readonly properties?: Record<string, Record<string, unknown>> }
        | undefined
    )?.properties;
    expect(allyProperties?.["units"]).toMatchObject({ minItems: 1, maxItems: 5 });
  });

  it("UT-R-EFF-01-030: every $ref in the real app.swagger() document resolves to an existing local JSON pointer (ConditionDefinition's AND/OR/NOT self-reference must not become a dangling #/components/schemas/def-N)", () => {
    function resolvePointer(document: unknown, pointer: string): unknown {
      if (!pointer.startsWith("#/")) {
        throw new Error(`only local JSON pointers are supported, got "${pointer}"`);
      }
      const segments = pointer
        .slice(2)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
      let node: unknown = document;
      for (const segment of segments) {
        if (typeof node !== "object" || node === null || !(segment in node)) {
          return undefined;
        }
        node = (node as Record<string, unknown>)[segment];
      }
      return node;
    }

    function collectRefs(node: unknown, into: Set<string>): void {
      if (Array.isArray(node)) {
        for (const item of node) {
          collectRefs(item, into);
        }
        return;
      }
      if (typeof node !== "object" || node === null) {
        return;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        into.add(record.$ref);
      }
      for (const value of Object.values(record)) {
        collectRefs(value, into);
      }
    }

    const document = app.swagger();
    const refs = new Set<string>();
    collectRefs(document, refs);

    // ConditionDefinition (expirationConditions items) is the only recursive
    // Catalog schema in this document, so at least one $ref must exist to
    // exercise this assertion meaningfully.
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(resolvePointer(document, ref), `dangling $ref: "${ref}"`).toBeDefined();
    }
  });

  it("API-OPENAPI-006 (12_テスト戦略.md「全ルートと全ステータスにSchemaがある」/10_API設計.md「GETの200／304」): documents GET /api/v1/battle-simulation-catalog with 200, 304, 406, and 500", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly get?: {
              readonly responses?: Readonly<Record<string, unknown>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;

    const operation = document.paths?.["/api/v1/battle-simulation-catalog"]?.get;
    expect(operation).toBeDefined();
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
      ["200", "304", "406", "500"].sort(),
    );
  });

  it("API-OPENAPI-007 (10_API設計.md「OpenAPIへの反映」「CORS preflightと公開header」): documents an OPTIONS preflight operation for every CORS-enabled route", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly options?: {
              readonly responses?: Readonly<Record<string, unknown>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;

    expect(document.paths?.["/api/v1/battle-simulations"]?.options).toBeDefined();
    expect(document.paths?.["/api/v1/tactical-exercises"]?.options).toBeDefined();
    expect(document.paths?.["/api/v1/formation-stat-previews"]?.options).toBeDefined();
    expect(document.paths?.["/api/v1/battle-simulation-catalog"]?.options).toBeDefined();
  });

  it("API-OPENAPI-008 (10_API設計.md「CORS」「公開response headerはX-Request-Id、Retry-After、ETag」): documents Access-Control-Allow-Origin and Access-Control-Expose-Headers on the successful responses of every CORS-enabled route", () => {
    interface HeaderDoc {
      readonly schema?: { readonly type?: string };
    }
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly get?: {
              readonly responses?: Readonly<
                Record<string, { readonly headers?: Readonly<Record<string, HeaderDoc>> }>
              >;
            };
            readonly post?: {
              readonly responses?: Readonly<
                Record<string, { readonly headers?: Readonly<Record<string, HeaderDoc>> }>
              >;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;

    const catalogHeaders =
      document.paths?.["/api/v1/battle-simulation-catalog"]?.get?.responses?.["200"]?.headers;
    expect(catalogHeaders?.["Access-Control-Allow-Origin"]).toBeDefined();
    expect(catalogHeaders?.["Access-Control-Expose-Headers"]).toBeDefined();

    const battleHeaders =
      document.paths?.["/api/v1/battle-simulations"]?.post?.responses?.["200"]?.headers;
    expect(battleHeaders?.["Access-Control-Allow-Origin"]).toBeDefined();
    expect(battleHeaders?.["Access-Control-Expose-Headers"]).toBeDefined();

    const previewHeaders =
      document.paths?.["/api/v1/formation-stat-previews"]?.post?.responses?.["200"]?.headers;
    expect(previewHeaders?.["Access-Control-Allow-Origin"]).toBeDefined();
    expect(previewHeaders?.["Access-Control-Expose-Headers"]).toBeDefined();
  });

  it("API-OPENAPI-009: documents the preflight request headers (Origin, Access-Control-Request-Method, Access-Control-Request-Headers) as header parameters on the OPTIONS operation, with Origin and Access-Control-Request-Method marked required", () => {
    interface ParameterDoc {
      readonly name?: string;
      readonly in?: string;
      readonly required?: boolean;
    }
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly options?: {
              readonly parameters?: readonly ParameterDoc[];
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const parameters = document.paths?.["/api/v1/battle-simulations"]?.options?.parameters ?? [];
    const headerParams = new Map(
      parameters.filter((parameter) => parameter.in === "header").map((p) => [p.name, p]),
    );

    expect(headerParams.get("origin")?.required).toBe(true);
    expect(headerParams.get("access-control-request-method")?.required).toBe(true);
    expect(headerParams.get("access-control-request-headers")?.required).toBe(false);
  });

  it("API-OPENAPI-010: the OPTIONS 204 response documents no body/content, matching the actual empty preflight response", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly options?: {
              readonly responses?: Readonly<Record<string, { readonly content?: unknown }>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const response204 = document.paths?.["/api/v1/battle-simulations"]?.options?.responses?.["204"];

    expect(response204).toBeDefined();
    expect(response204?.content).toBeUndefined();
  });

  it("API-OPENAPI-011: documents the 400 Invalid Preflight Request response that @fastify/cors returns for an allowed origin missing Access-Control-Request-Method", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly options?: {
              readonly responses?: Readonly<Record<string, unknown>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;

    expect(
      document.paths?.["/api/v1/battle-simulations"]?.options?.responses?.["400"],
    ).toBeDefined();
    expect(
      document.paths?.["/api/v1/battle-simulation-catalog"]?.options?.responses?.["400"],
    ).toBeDefined();
  });

  it('API-OPENAPI-012: the OPTIONS 400 response documents its actual text/plain body ("Invalid Preflight Request"), not a JSON content type', () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly options?: {
              readonly responses?: Readonly<
                Record<
                  string,
                  {
                    readonly content?: Readonly<
                      Record<string, { readonly schema?: { readonly type?: string } }>
                    >;
                  }
                >
              >;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const content =
      document.paths?.["/api/v1/battle-simulations"]?.options?.responses?.["400"]?.content;

    expect(content).toBeDefined();
    expect(content?.["application/json"]).toBeUndefined();
    expect(content?.["text/plain"]?.schema?.type).toBe("string");
  });

  it("API-OPENAPI-005 (12_テスト戦略.md「全ルートと全ステータスにSchemaがある」): documents /health/live (200 only) and /health/ready (200 and 503)", () => {
    interface MinimalOpenApiV3Document {
      readonly paths?: Readonly<
        Record<
          string,
          {
            readonly get?: {
              readonly responses?: Readonly<Record<string, unknown>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;

    const live = document.paths?.["/health/live"]?.get;
    expect(live).toBeDefined();
    expect(Object.keys(live?.responses ?? {}).sort()).toEqual(["200"]);

    const ready = document.paths?.["/health/ready"]?.get;
    expect(ready).toBeDefined();
    expect(Object.keys(ready?.responses ?? {}).sort()).toEqual(["200", "503"]);
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

  it("API-OPENAPI-031 (10_API設計.md「FormationEnhancementRequest」ほか、R-ENH-01/02/04/05): the published request schema documents the enhancement value ranges and enums the runtime validator deliberately leaves to 422", async () => {
    interface JsonSchemaObject {
      readonly type?: string;
      readonly minimum?: number;
      readonly maxItems?: number;
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
    const formationSchema =
      document.paths?.["/api/v1/battle-simulations"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema?.properties?.["allyFormation"];

    const academyLevels =
      formationSchema?.properties?.["enhancement"]?.properties?.["academyLevels"];
    expect(academyLevels?.properties?.["unitTypes"]?.properties?.["PHYSICAL"]).toMatchObject({
      minimum: 1,
    });
    expect(Object.keys(academyLevels?.properties?.["attributes"]?.properties ?? {})).toEqual([
      "AGGRESSIVE",
      "SHY",
      "CUTE",
      "SMART",
      "COMICAL",
      "CLEVER",
    ]);

    const unitEnhancement =
      formationSchema?.properties?.["units"]?.items?.properties?.["enhancement"];
    expect(unitEnhancement?.properties?.["level"]).toMatchObject({ minimum: 1 });
    expect(unitEnhancement?.properties?.["gears"]?.maxItems).toBe(9);
    const gear = unitEnhancement?.properties?.["gears"]?.items;
    expect(gear?.properties?.["stat"]?.enum).toEqual([
      "MAXIMUM_HP",
      "ATTACK",
      "DEFENSE",
      "ACTION_SPEED",
      "CRITICAL_RATE",
      "CRITICAL_DAMAGE_BONUS",
      "AFFINITY_BONUS",
    ]);
    expect(gear?.properties?.["tier"]?.enum).toEqual(["II", "III"]);
    expect(gear?.properties?.["grade"]?.enum).toEqual(["D", "C", "B", "A", "S"]);

    // 実行時validatorは緩いまま: 値域違反は400ではなく422 INVALID_COMMANDで返す。
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
          enhancement: { academyLevels: { unitTypes: { PHYSICAL: 0 } } },
        },
        enemyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        turnLimit: 3,
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
        // DMG-004（Issue #194、R-SHD-02/03）: シールド未所持の対象の内訳。
        hpDirectDamage: 0,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        // DMG-005（Issue #190、R-SUB-01）: サブユニット未所持の対象の内訳。
        subUnitAbsorbed: 0,
        discardedDamage: 0,
        hitPointDamage: 10,
        hpBefore: 20,
        hpAfter: 10,
        defeated: false,
      },
    };
    expect(validate(matched), JSON.stringify(validate.errors)).toBe(true);
  });

  it("UT-R-EFF-01-029 (08_ドメインイベント.md EffectApplied payload): validates EffectApplied.details.expirationConditions as a real (recursive) ConditionDefinition union, not an arbitrary object", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const base = {
      sequence: 1,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: ["unit-1"],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    const basePayload = {
      effectInstanceId: "battle-1:effect:1",
      effectActionDefinitionId: "ACT_1",
      sourceUnitId: "unit-1",
      targetUnitId: "unit-1",
      duplicate: true,
      kindKey: "ACT_1",
      // M7-011（Issue #265）: `EffectApplied`は効果分類（`effectKind`/`categories`）を
      // 必ず運ぶ（`domain-event.ts`）ため、公開Schemaでも必須プロパティ。
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
      magnitude: 10,
      linkedEffectGroupId: null,
    };

    const validNested = {
      ...base,
      details: {
        ...basePayload,
        expirationConditions: [
          {
            kind: "AND",
            conditions: [
              { kind: "TRUE" },
              {
                kind: "NOT",
                condition: {
                  kind: "TARGET_HAS_MARKER",
                  target: { kind: "SELF" },
                  markerId: "MARKER_1",
                },
              },
            ],
          },
        ],
      },
    };
    expect(validate(validNested), JSON.stringify(validate.errors)).toBe(true);

    // Not a real ConditionDefinition variant (unknown "kind" and a field no
    // variant declares): a permissive `{ type: "object" }` items schema would
    // wrongly accept this.
    const invalidCondition = {
      ...base,
      details: {
        ...basePayload,
        expirationConditions: [{ kind: "NOT_A_REAL_KIND", somethingElse: 1 }],
      },
    };
    expect(validate(invalidCondition)).toBe(false);
  });

  it("UT-R-EFF-01-031 (references.ts createTargetReference): rejects a BINDING TargetReference missing targetBindingId and a non-BINDING TargetReference that sets it, matching the domain constraint exactly", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const base = {
      sequence: 1,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: ["unit-1"],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    const basePayload = {
      effectInstanceId: "battle-1:effect:1",
      effectActionDefinitionId: "ACT_1",
      sourceUnitId: "unit-1",
      targetUnitId: "unit-1",
      duplicate: true,
      kindKey: "ACT_1",
      // M7-011（Issue #265）: `EffectApplied`の必須分類payload。
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
      magnitude: 10,
      linkedEffectGroupId: null,
    };
    function withTarget(target: unknown) {
      return {
        ...base,
        details: {
          ...basePayload,
          expirationConditions: [{ kind: "POSITION_RELATION", target, relation: "IN_FRONT_OF" }],
        },
      };
    }

    // Valid per `createTargetReference` (references.ts): BINDING requires
    // targetBindingId, every other kind must omit it.
    expect(
      validate(withTarget({ kind: "BINDING", targetBindingId: "TGT_1" })),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(validate(withTarget({ kind: "SELF" })), JSON.stringify(validate.errors)).toBe(true);

    // Invalid: BINDING without the required targetBindingId.
    expect(validate(withTarget({ kind: "BINDING" }))).toBe(false);
    // Invalid: a non-BINDING kind must not carry targetBindingId (a
    // permissive "targetBindingId is always optional" schema would wrongly
    // accept this, even though the domain rejects it as "must not be set
    // when kind is ... (only valid when kind is BINDING)").
    expect(validate(withTarget({ kind: "SELF", targetBindingId: "TGT_1" }))).toBe(false);
  });

  it("UT-R-EFF-01-032 (condition-definition.ts TARGET_STATE_FIELD_TYPES): rejects a TARGET_STATE value whose type doesn't match its field's Domain-mandated type", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const base = {
      sequence: 1,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: ["unit-1"],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    const basePayload = {
      effectInstanceId: "battle-1:effect:1",
      effectActionDefinitionId: "ACT_1",
      sourceUnitId: "unit-1",
      targetUnitId: "unit-1",
      duplicate: true,
      kindKey: "ACT_1",
      // M7-011（Issue #265）: `EffectApplied`の必須分類payload。
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
      magnitude: 10,
      linkedEffectGroupId: null,
    };
    function withCondition(field: string, value: unknown) {
      return {
        ...base,
        details: {
          ...basePayload,
          expirationConditions: [
            { kind: "TARGET_STATE", target: { kind: "SELF" }, field, op: "EQ", value },
          ],
        },
      };
    }

    // Valid per `TARGET_STATE_FIELD_TYPES` (condition-definition.ts): one
    // representative field per Domain-mandated value type.
    expect(validate(withCondition("IS_ALIVE", true)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(withCondition("HP_RATIO", 0.5)), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate(withCondition("ATTRIBUTE", "AGGRESSIVE")),
      JSON.stringify(validate.errors),
    ).toBe(true);

    // Invalid: a boolean-typed field given a string value (a single
    // `value: { type: ["string","number","boolean"] }` shared across every
    // field would wrongly accept this).
    expect(validate(withCondition("IS_ALIVE", "yes"))).toBe(false);
    // Invalid: a number-typed field given a boolean value.
    expect(validate(withCondition("HP_RATIO", true))).toBe(false);
    // Invalid: a string-typed field given a number value.
    expect(validate(withCondition("ATTRIBUTE", 1))).toBe(false);
  });

  it("UT-R-EFF-01-033 (condition-definition.ts RUNTIME_COUNTER modulo assertInteger({min:1})): rejects a RUNTIME_COUNTER modulo that is 0 or non-integer", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const base = {
      sequence: 1,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: ["unit-1"],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    const basePayload = {
      effectInstanceId: "battle-1:effect:1",
      effectActionDefinitionId: "ACT_1",
      sourceUnitId: "unit-1",
      targetUnitId: "unit-1",
      duplicate: true,
      kindKey: "ACT_1",
      // M7-011（Issue #265）: `EffectApplied`の必須分類payload。
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
      magnitude: 10,
      linkedEffectGroupId: null,
    };
    function withModulo(modulo: unknown) {
      return {
        ...base,
        details: {
          ...basePayload,
          expirationConditions: [
            { kind: "RUNTIME_COUNTER", counter: "RUNTIME_COUNTER_X", op: "EQ", value: 1, modulo },
          ],
        },
      };
    }

    expect(validate(withModulo(1)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(withModulo(3)), JSON.stringify(validate.errors)).toBe(true);
    // Invalid: assertInteger(..., { min: 1 }) rejects both 0 and non-integers.
    expect(validate(withModulo(0))).toBe(false);
    expect(validate(withModulo(1.5))).toBe(false);
  });

  it("UT-R-EFF-01-034 (condition-definition.ts TURN_NUMBER modulo assertInteger({min:1}); RES-004, Issue #171): rejects a TURN_NUMBER modulo that is 0 or non-integer", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const base = {
      sequence: 1,
      type: "EFFECT_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: ["unit-1"],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    const basePayload = {
      effectInstanceId: "battle-1:effect:1",
      effectActionDefinitionId: "ACT_1",
      sourceUnitId: "unit-1",
      targetUnitId: "unit-1",
      duplicate: true,
      kindKey: "ACT_1",
      // M7-011（Issue #265）: `EffectApplied`の必須分類payload。
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
      magnitude: 10,
      linkedEffectGroupId: null,
    };
    function withModulo(modulo: unknown) {
      return {
        ...base,
        details: {
          ...basePayload,
          expirationConditions: [{ kind: "TURN_NUMBER", op: "EQ", value: 0, modulo }],
        },
      };
    }

    expect(validate(withModulo(1)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(withModulo(2)), JSON.stringify(validate.errors)).toBe(true);
    // Invalid: assertInteger(..., { min: 1 }) rejects both 0 and non-integers.
    expect(validate(withModulo(0))).toBe(false);
    expect(validate(withModulo(-2))).toBe(false);
    expect(validate(withModulo(1.5))).toBe(false);
  });

  it("API-OPENAPI-027 (DMG-005/Issue #190): DAMAGE_APPLIED keeps subUnitAbsorbed optional so a strict v1 decoder built before DMG-005 still validates", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(battleLogEventResponseDocSchema);

    const base = {
      sequence: 1,
      type: "DAMAGE_APPLIED",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: [],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
    };
    const v1Details = {
      effectActionDefinitionId: "ACT_1",
      hitIndex: 0,
      targetUnitId: "enemy:1",
      calculatedDamage: 10,
      hpDirectDamage: 0,
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      discardedDamage: 0,
      hitPointDamage: 10,
      hpBefore: 20,
      hpAfter: 10,
      defeated: false,
    };

    // `10_API設計.md`「バージョニング」: `schemaVersion`が1のまま既存イベントのdetailsへ
    // 必須項目を足すことは後方互換な変更ではない。DMG-005の`subUnitAbsorbed`は任意項目
    // として追加してあるため、それを知らないv1 payloadも通る。
    expect(validate({ ...base, details: v1Details }), JSON.stringify(validate.errors)).toBe(true);
    // Response Mapperは常に値を設定するため、付いていても当然通る。
    expect(
      validate({ ...base, details: { ...v1Details, subUnitAbsorbed: 3 } }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it("API-OPENAPI-024 (regression: COOLDOWN_*/CHARGE_*/ACTION_QUEUE_REORDERED were silently unvalidated): the exercise event union declares exactly one variant per BattleDomainEventType, so a newly-added domain event type fails this test (not silently) until its OpenAPI details schema is added", () => {
    // `SUMMARY_EVENT_TYPE_INCLUSION` is a mapped type over `BattleDomainEventType`,
    // so it gains a compile error (missing or excess key) whenever
    // `BattleDomainEventPayloadMap` changes. Reusing it as the event-type roster
    // keeps this test from drifting the way `EVENT_DETAILS_SCHEMA_BY_TYPE` did,
    // without maintaining a second exhaustive list here.
    const expectedTypes = new Set(
      Object.keys(SUMMARY_EVENT_TYPE_INCLUSION).map((eventType) =>
        eventType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase(),
      ),
    );

    const declaredTypesOf = (docSchema: {
      readonly oneOf: readonly { readonly properties: object }[];
    }): Set<string> =>
      new Set(
        docSchema.oneOf.map(
          (variant) =>
            (variant.properties as { readonly type: { readonly const: string } }).type.const,
        ),
      );

    // 演習側のunionが全種別を持つ正本。
    expect(declaredTypesOf(exerciseBattleLogEventResponseDocSchema)).toEqual(expectedTypes);

    // 通常戦闘側は、そこから演習だけが発行する種別（R-TEX-02〜04）をちょうど除いた集合。
    // `Q-TEX-08`「既存の`POST /api/v1/battle-simulations`の契約は変更しない」を、
    // 「演習用variantが混ざっていない」と「他の種別は1つも落ちていない」の両方向で固定する。
    const battleTypes = declaredTypesOf(battleLogEventResponseDocSchema);
    expect(battleTypes).toEqual(
      new Set(
        [...expectedTypes].filter(
          (type) => !(EXERCISE_ONLY_EVENT_TYPES as readonly string[]).includes(type),
        ),
      ),
    );
  });

  it("API-OPENAPI-036 (TEX-007、Q-TEX-08): the battle POST's published event union carries no exercise-only variant and no BREAK_ENHANCEMENT reason, while the exercise POST's does", () => {
    const document = app.swagger() as unknown as OpenApiDocumentForTest;

    const eventVariantsOf = (path: string, method: string): Record<string, unknown>[] => {
      const schema = document.paths?.[path]?.[method]?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema as
        | { readonly properties?: { readonly events?: { readonly items?: { oneOf?: unknown[] } } } }
        | undefined;
      const variants = schema?.properties?.events?.items?.oneOf;
      expect(variants, `${method.toUpperCase()} ${path} publishes no event union`).toBeDefined();
      return variants as Record<string, unknown>[];
    };
    const typesOf = (variants: Record<string, unknown>[]): string[] =>
      variants.map(
        (variant) =>
          (variant["properties"] as { readonly type: { readonly enum?: readonly string[] } }).type
            .enum?.[0] ?? "",
      );
    const reasonEnumOf = (variants: Record<string, unknown>[], type: string): string[] => {
      const variant = variants.find(
        (candidate) =>
          (candidate["properties"] as { readonly type: { readonly enum?: readonly string[] } }).type
            .enum?.[0] === type,
      );
      const details = (variant?.["properties"] as { readonly details?: unknown } | undefined)
        ?.details as { readonly properties?: { readonly reason?: { readonly enum?: string[] } } };
      return details?.properties?.reason?.enum ?? [];
    };

    const battleVariants = eventVariantsOf(BATTLE_SIMULATIONS_PATH, "post");
    const exerciseVariants = eventVariantsOf(TACTICAL_EXERCISES_PATH, "post");

    for (const type of EXERCISE_ONLY_EVENT_TYPES) {
      expect(typesOf(battleVariants)).not.toContain(type);
      expect(typesOf(exerciseVariants)).toContain(type);
    }
    for (const type of ["COMBAT_STAT_CHANGED", "RESOURCE_CAPACITY_CHANGED"]) {
      expect(reasonEnumOf(battleVariants, type)).not.toContain("BREAK_ENHANCEMENT");
      expect(reasonEnumOf(exerciseVariants, type)).toContain("BREAK_ENHANCEMENT");
    }
  });

  it("API-OPENAPI-025: cooldownStateResponseSchema keeps the setting scope matched to the unit (10_API設計.md CooldownStateResponse) — it accepts the matching scope field or none at all, and rejects both present or a mismatched scope field", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(cooldownStateResponseSchema);

    expect(
      validate({ skillDefinitionId: "SKL_1", unit: "ACTION", remaining: 1, setAtActionId: "a-1" }),
    ).toBe(true);
    expect(
      validate({ skillDefinitionId: "SKL_1", unit: "TURN", remaining: 1, setAtTurnNumber: 3 }),
    ).toBe(true);

    // REL-004（Issue #203）: 設定scopeなしは正当な状態。PSが行動外のトップレベル
    // イベントから発動したクールタイム（R-SKL-04）は`setAtActionId`を持たず、
    // その不在が「どの行動でも設定scopeに一致しない」の正本になる。ここを必須に
    // していた間、`UNIT_LUCIE_MAID`の実戦闘レスポンスは500になっていた。
    expect(validate({ skillDefinitionId: "SKL_1", unit: "ACTION", remaining: 1 })).toBe(true);
    expect(validate({ skillDefinitionId: "SKL_1", unit: "TURN", remaining: 1 })).toBe(true);

    // Both present.
    expect(
      validate({
        skillDefinitionId: "SKL_1",
        unit: "ACTION",
        remaining: 1,
        setAtActionId: "a-1",
        setAtTurnNumber: 3,
      }),
    ).toBe(false);
    // Mismatched: ACTION with the TURN-shaped field.
    expect(
      validate({ skillDefinitionId: "SKL_1", unit: "ACTION", remaining: 1, setAtTurnNumber: 3 }),
    ).toBe(false);
    // remaining: 0 would never be returned (finalState lists only active
    // cooldowns), so the schema rejects it too.
    expect(
      validate({ skillDefinitionId: "SKL_1", unit: "ACTION", remaining: 0, setAtActionId: "a-1" }),
    ).toBe(false);
  });

  it("API-OPENAPI-026: runtimeCounterChangedDetailsSchema enforces the SKILL_RUNTIME/APPLIED_EFFECT scope XOR — accepts exactly one matching id field, rejects both missing, both present, or a mismatched scope field", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(runtimeCounterChangedDetailsSchema);

    const skillRuntime = {
      ownerUnitId: "unit-1",
      scope: "SKILL_RUNTIME",
      counter: "RUNTIME_COUNTER_1",
      skillDefinitionId: "SKL_1",
      before: 0,
      after: 1,
      carry: 0,
      valueChanged: true,
    };
    const appliedEffect = {
      ownerUnitId: "unit-1",
      scope: "APPLIED_EFFECT",
      counter: "RUNTIME_COUNTER_1",
      effectInstanceId: "battle-1:effect:1",
      before: 0,
      after: 1,
      carry: 0,
      valueChanged: true,
    };

    expect(validate(skillRuntime), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(appliedEffect), JSON.stringify(validate.errors)).toBe(true);

    // Both missing.
    const { skillDefinitionId: _omitted1, ...skillRuntimeMissingId } = skillRuntime;
    expect(validate(skillRuntimeMissingId)).toBe(false);
    const { effectInstanceId: _omitted2, ...appliedEffectMissingId } = appliedEffect;
    expect(validate(appliedEffectMissingId)).toBe(false);

    // Both present (mismatched scope's id also supplied).
    expect(validate({ ...skillRuntime, effectInstanceId: "battle-1:effect:1" })).toBe(false);
    expect(validate({ ...appliedEffect, skillDefinitionId: "SKL_1" })).toBe(false);

    // Mismatched: SKILL_RUNTIME scope carrying the APPLIED_EFFECT-shaped id instead.
    const { skillDefinitionId: _omitted3, ...skillRuntimeBase } = skillRuntime;
    expect(validate({ ...skillRuntimeBase, effectInstanceId: "battle-1:effect:1" })).toBe(false);
  });

  it("API-OPENAPI-013 (TGT-004 Phase 1, Issue #167): effectStateResponseSchema/effectDurationReducedDetailsSchema accept duration.unit: SKILL_USE, matching the Domain EffectSnapshot/EffectDurationReduced types widened for SKILL_USE decrement", () => {
    const ajv = new Ajv({ strict: false });
    const validateEffectState = ajv.compile(effectStateResponseSchema);
    const validateDurationReduced = ajv.compile(effectDurationReducedDetailsSchema);

    expect(
      validateEffectState({
        effectInstanceId: "battle-1:effect:1",
        effectDefinitionId: "ACT_STEALTH",
        category: "BUFF",
        effectKindKey: "ACT_STEALTH",
        stackMode: "NON_STACKING",
        isEffective: true,
        value: {},
        duration: { unit: "SKILL_USE", remaining: 3 },
        appliedTurnNumber: 1,
      }),
      JSON.stringify(validateEffectState.errors),
    ).toBe(true);

    expect(
      validateDurationReduced({
        effectInstanceId: "battle-1:effect:1",
        battleUnitId: "unit-1",
        unit: "SKILL_USE",
        before: 3,
        after: 2,
      }),
      JSON.stringify(validateDurationReduced.errors),
    ).toBe(true);
  });

  it("API-OPENAPI-014 (M7-009, Issue #182): effectStateResponseSchema accepts a STATUS_ABNORMALITY effect carrying statusKind, and EffectApplied.details documents the statusKind the Domain payload already emits", () => {
    const ajv = new Ajv({ strict: false });
    const validateEffectState = ajv.compile(effectStateResponseSchema);

    expect(
      validateEffectState({
        effectInstanceId: "battle-1:effect:1",
        effectDefinitionId: "ACT_STUN",
        category: "STATUS_ABNORMALITY",
        effectKindKey: "ACT_STUN",
        statusKind: "STUN",
        stackMode: "NON_STACKING",
        isEffective: true,
        value: { magnitude: 0 },
        duration: { unit: "ACTION", remaining: 1 },
        appliedTurnNumber: 1,
      }),
      JSON.stringify(validateEffectState.errors),
    ).toBe(true);
    // 未知の状態異常種別はenum違反として拒否する（`STATUS_KIND_ENUM`と同じ粒度）。
    expect(
      validateEffectState({
        effectInstanceId: "battle-1:effect:1",
        effectDefinitionId: "ACT_STUN",
        category: "STATUS_ABNORMALITY",
        effectKindKey: "ACT_STUN",
        statusKind: "NOT_A_STATUS",
        stackMode: "NON_STACKING",
        isEffective: true,
        value: { magnitude: 0 },
        appliedTurnNumber: 1,
      }),
    ).toBe(false);

    const validateEvent = ajv.compile(battleLogEventResponseDocSchema);
    expect(
      validateEvent({
        sequence: 1,
        type: "EFFECT_APPLIED",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 0,
        rootSequence: 1,
        targetUnitIds: ["unit-1"],
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        details: {
          effectInstanceId: "battle-1:effect:1",
          effectActionDefinitionId: "ACT_STUN",
          sourceUnitId: "unit-1",
          targetUnitId: "unit-1",
          duplicate: false,
          kindKey: "ACT_STUN",
          // M7-011（Issue #265、R-STS-01）: 状態異常はSTATUSかつDEBUFF。
          effectKind: "APPLY_STATUS",
          categories: ["DEBUFF", "STATUS"],
          magnitude: 0,
          statusKind: "STUN",
          linkedEffectGroupId: null,
        },
      }),
      JSON.stringify(validateEvent.errors),
    ).toBe(true);
  });

  it("API-OPENAPI-015 (REL-008, Issue #263, R-MEM-04): MARKER_APPLIED/MARKER_UPDATED details document the sourceUnitId-or-sourceSide union — both variants validate, and an unknown side is still rejected", () => {
    const validateEvent = new Ajv({ strict: false }).compile(battleLogEventResponseDocSchema);
    const event = (type: string, details: Record<string, unknown>): Record<string, unknown> => ({
      sequence: 1,
      type,
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: ["ally:1"],
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      details,
    });
    const applied = {
      markerInstanceId: "battle-1:marker:1",
      markerId: "MARKER_TEST",
      targetUnitId: "ally:1",
      stackCount: 1,
      stackMax: null,
      linkedEffectGroupId: null,
    };
    const updated = {
      markerInstanceId: "battle-1:marker:1",
      markerId: "MARKER_TEST",
      targetUnitId: "ally:1",
      stackBefore: 1,
      stackAfter: 2,
      linkedEffectGroupId: null,
    };

    // Memory由来（付与者ユニットを持たない）。`MARKER_UPDATED`側は`ADD`で積み増した場合に発行される。
    for (const candidate of [
      event("MARKER_APPLIED", { ...applied, sourceSide: "ALLY" }),
      event("MARKER_UPDATED", { ...updated, sourceSide: "ALLY", policy: "ADD" }),
    ]) {
      expect(validateEvent(candidate), JSON.stringify(validateEvent.errors)).toBe(true);
    }

    // 従来から公開されていたユニット付与側は、`sourceUnitId`を持つ形のまま受理される。
    for (const candidate of [
      event("MARKER_APPLIED", { ...applied, sourceUnitId: "ally:2" }),
      event("MARKER_UPDATED", { ...updated, sourceUnitId: "ally:2", policy: "ADD" }),
    ]) {
      expect(validateEvent(candidate), JSON.stringify(validateEvent.errors)).toBe(true);
    }

    // 陣営はALLY/ENEMYのenumであり、任意の文字列を受け付けない。
    expect(validateEvent(event("MARKER_APPLIED", { ...applied, sourceSide: "NEUTRAL" }))).toBe(
      false,
    );
    expect(validateEvent(event("MARKER_UPDATED", { ...updated, sourceSide: "NEUTRAL" }))).toBe(
      false,
    );
  });

  it("API-OPENAPI-016 (REL-004, Issue #203): BattleLogEventResponseBody declares exactly the properties battleLogEventResponseSchema serializes, so the wire-contract type cannot silently drift from what is actually published", () => {
    // A conditional spread (`...(x !== undefined ? { x } : {})`) bypasses TypeScript's
    // excess-property check, so the Response Mapper can emit a property the wire type
    // never declared — `sourceSide` did exactly that until this test existed.
    // The mapped type below fails to compile if the interface changes, and the
    // assertion fails if the JSON Schema changes; drift needs both to move together.
    const WIRE_TYPE_PROPERTIES: Readonly<Record<keyof BattleLogEventResponseBody, true>> = {
      sequence: true,
      type: true,
      category: true,
      turnNumber: true,
      cycleNumber: true,
      actionId: true,
      skillUseId: true,
      parentSequence: true,
      rootSequence: true,
      sourceUnitId: true,
      sourceSide: true,
      targetUnitIds: true,
      details: true,
      stateVersionBefore: true,
      stateVersionAfter: true,
      stateTransitionIndex: true,
    };

    expect(new Set(Object.keys(battleLogEventResponseSchema.properties))).toEqual(
      new Set(Object.keys(WIRE_TYPE_PROPERTIES)),
    );
  });

  it("API-OPENAPI-017 (REL-004, Issue #203, 10_API設計.md「クライアントは未知のtypeだけでレスポンス全体を拒否しないことが望ましい」): an event carrying an unrecognized type still satisfies the runtime response schema, and the published doc schema says so even though its oneOf enumerates only the currently emitted types", () => {
    const ajv = new Ajv({ strict: false });
    const validateRuntime = ajv.compile(battleSimulationResponseSchema);
    const validateDoc = ajv.compile(battleSimulationResponseDocSchema);

    const knownEvent = {
      sequence: 1,
      type: "BATTLE_STARTED",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      rootSequence: 1,
      targetUnitIds: [],
      details: { turnLimit: 1, allySlotCount: 1, enemySlotCount: 1 },
      stateVersionBefore: 0,
      stateVersionAfter: 0,
    };
    // A type this API version cannot emit, shaped like a plausible future addition.
    const futureEvent = {
      ...knownEvent,
      sequence: 2,
      type: "SOME_FUTURE_EVENT_ADDED_AFTER_V1",
      details: { somethingNew: true },
    };
    const body = {
      schemaVersion: 1,
      battleId: "battle-1",
      catalogRevision: "test",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
      initialState: {
        stateVersion: 0,
        battleStatus: "RUNNING",
        turnNumber: 0,
        cycleNumber: 0,
        units: [],
        actionQueue: [],
      },
      finalState: {
        stateVersion: 0,
        battleStatus: "COMPLETED",
        turnNumber: 1,
        cycleNumber: 0,
        units: [],
        actionQueue: [],
      },
      events: [knownEvent, futureEvent],
      stateTransitions: [],
    };

    // The wire contract keeps `type` an open string, so a v1 decoder built from the
    // runtime schema accepts the response as a whole.
    expect(validateRuntime(body), JSON.stringify(validateRuntime.errors)).toBe(true);

    // The published doc schema is deliberately stricter: it is the exhaustive
    // catalogue of what this version emits, and that strictness is what lets the
    // oneOf-completeness test below detect a domain event type nobody documented.
    // A client generated from it therefore must apply the documented tolerance itself.
    expect(validateDoc(body)).toBe(false);
    expect(battleLogEventResponseDocSchema.description).toMatch(
      /must not reject the whole response/i,
    );
  });

  it("API-OPENAPI-018 (REL-004, Issue #203, 10_API設計.md「ステータスコード対応」/「列挙値」): every documented error status publishes exactly the codes that map to it, so the spec table, STATUS_BY_CODE and the OpenAPI document cannot drift apart", () => {
    const document = app.swagger() as unknown as OpenApiDocumentForTest;

    const errorStatusesByPath = {
      [BATTLE_SIMULATIONS_PATH]: "post",
      [BATTLE_SIMULATION_CATALOG_PATH]: "get",
    } as const;

    const seenCodes = new Set<string>();
    for (const [path, method] of Object.entries(errorStatusesByPath)) {
      const responses = document.paths?.[path]?.[method]?.responses ?? {};
      const errorStatuses = Object.keys(responses).filter((status) => Number(status) >= 400);
      expect(errorStatuses.length).toBeGreaterThan(0);

      for (const status of errorStatuses) {
        const expectedCodes = errorCodesForHttpStatus(Number(status));
        expect(expectedCodes.length, `no code maps to ${status}`).toBeGreaterThan(0);

        const published = publishedErrorCodeEnum(responses[status]);
        expect(published, `${method.toUpperCase()} ${path} -> ${status}`).toEqual([
          ...expectedCodes,
        ]);
        for (const code of expectedCodes) {
          seenCodes.add(code);
        }
      }
    }

    // The battle POST documents every status in the spec table, so the union of the
    // published enums must be the whole taxonomy — a code that maps to no documented
    // status would otherwise stay invisible to clients.
    expect([...seenCodes].sort()).toEqual([...HTTP_ERROR_CODES].sort());

    // Documenting a status the taxonomy has no code for is a contradiction between
    // the route and 10_API設計.md「ステータスコード対応」, so the builder refuses it
    // rather than publishing an empty enum nothing can satisfy.
    expect(() => errorResponseDocSchemaForStatus(451)).toThrow(/451/);
  });

  it("API-OPENAPI-019 (REL-004, Issue #203, 10_API設計.md「Catalog一覧の200/304と戦闘POSTのcache header差異」): the document declares the protocol response headers the server actually sets, including the catalog-only ETag and the 503 Retry-After", async () => {
    const document = app.swagger() as unknown as OpenApiDocumentForTest;
    const battleResponses = document.paths?.[BATTLE_SIMULATIONS_PATH]?.post?.responses ?? {};
    const catalogResponses = document.paths?.[BATTLE_SIMULATION_CATALOG_PATH]?.get?.responses ?? {};

    // Cache-Control and X-Request-Id ride on every response, errors included.
    for (const responses of [battleResponses, catalogResponses]) {
      for (const [status, entry] of Object.entries(responses)) {
        const headers = Object.keys(entry?.headers ?? {});
        expect(headers, `status ${status}`).toEqual(
          expect.arrayContaining(["Cache-Control", "X-Request-Id"]),
        );
      }
    }

    // ETag is a catalog-only conditional-GET validator.
    expect(Object.keys(catalogResponses["200"]?.headers ?? {})).toContain("ETag");
    expect(Object.keys(catalogResponses["304"]?.headers ?? {})).toContain("ETag");
    expect(Object.keys(battleResponses["200"]?.headers ?? {})).not.toContain("ETag");

    // Retry-After accompanies the capacity/rate-limit statuses only.
    expect(Object.keys(battleResponses["503"]?.headers ?? {})).toContain("Retry-After");
    expect(Object.keys(battleResponses["429"]?.headers ?? {})).toContain("Retry-After");
    expect(Object.keys(battleResponses["200"]?.headers ?? {})).not.toContain("Retry-After");

    // The documented cache difference matches what onSend really emits.
    const battle = await app.inject({
      method: "POST",
      url: BATTLE_SIMULATIONS_PATH,
      payload: {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        turnLimit: 1,
      },
    });
    const catalog = await app.inject({ method: "GET", url: BATTLE_SIMULATION_CATALOG_PATH });
    expect(battle.headers["cache-control"]).toBe("no-store");
    expect(catalog.headers["cache-control"]).toBe("public, max-age=300");
    expect(battle.headers["x-request-id"]).toBeDefined();
    expect(catalog.headers["x-request-id"]).toBeDefined();
  });

  it("API-OPENAPI-028 (REL-004, Issue #203, 10_API設計.md「OpenAPIへの反映」「列挙値」): the published event-details enums list exactly the values the Domain can produce, so a Domain enum gaining a member fails here instead of 422-ing a real battle response", () => {
    // presentationは`no-restricted-imports`でdomainを直接importできないため、
    // `battle-log-schema.ts`のenumはDomainの正本を手で写したものになる。その写しが
    // 遅れると、実在Unitの正当なレスポンスが公開schemaを満たさなくなる —
    // `APPLY_DAMAGE_LINK`・`TARGET_HAS_EFFECT`・`DAMAGE_TO_HEAL`が実際にそうなっており、
    // production Catalog 8体分のレスポンスがdoc schemaを外れていた（REL-004で検出）。
    // 過去にもIssue #230・#265が同じ形の抜けを事後修正しており、写し漏れを
    // 構造的に検出するのはこのテストの役目。
    const bindings = [
      { published: CONDITION_KIND_ENUM, domain: CONDITION_KINDS, name: "conditionKind" },
      { published: EFFECT_ACTION_KIND_ENUM, domain: EFFECT_ACTION_KINDS, name: "effectKind" },
      { published: STATUS_KIND_ENUM, domain: STATUS_KINDS, name: "statusKind" },
    ] as const;

    for (const { published, domain, name } of bindings) {
      expect([...published].sort(), `${name} enum drifted from the Domain`).toEqual(
        [...domain].sort(),
      );
    }
  });
  it("API-OPENAPI-033 (Issue #423, R-ENH-06, 10_API設計.md「OpenAPIへの反映」「列挙値」): the published gear application enum lists exactly the kinds the Domain declares, and the catalog 200 documents gearEffects", () => {
    // presentationはdomainを直接importできないため、`catalog-schema.ts`の
    // `GEAR_STAT_APPLICATION_ENUM`はDomainの正本を手で写したものになる
    // （API-OPENAPI-028と同じ形の写し漏れ検出）。
    expect([...GEAR_STAT_APPLICATION_ENUM].sort()).toEqual([...GEAR_STAT_APPLICATION_KINDS].sort());

    interface JsonSchemaObject {
      readonly required?: readonly string[];
      readonly items?: JsonSchemaObject;
      readonly properties?: Readonly<Record<string, JsonSchemaObject>>;
    }
    const document = app.swagger() as unknown as OpenApiDocumentForTest;
    const schema = document.paths?.[BATTLE_SIMULATION_CATALOG_PATH]?.["get"]?.responses?.["200"]
      ?.content?.["application/json"]?.schema as JsonSchemaObject | undefined;

    const gearEffects = schema?.properties?.["gearEffects"];
    expect(gearEffects?.items?.required).toEqual(["stat", "application", "values"]);
    expect(gearEffects?.items?.properties?.["values"]?.items?.required).toEqual([
      "tier",
      "grade",
      "percentagePoints",
    ]);
  });

  it("API-OPENAPI-032 (12_テスト戦略.md「全ルートと全ステータスにSchemaがある」/10_API設計.md「編成の開始時ステータスをプレビューする」): documents POST /api/v1/formation-stat-previews with only the statuses it can return, and publishes the value ranges in the request schema", () => {
    interface JsonSchemaObject {
      readonly enum?: readonly unknown[];
      readonly maxItems?: number;
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
              readonly responses?: Readonly<Record<string, unknown>>;
            };
          }
        >
      >;
    }

    const document = app.swagger() as unknown as MinimalOpenApiV3Document;
    const operation = document.paths?.["/api/v1/formation-stat-previews"]?.post;
    expect(operation).toBeDefined();

    // 戦闘を実行しないため、Worker Pool容量・実行保護・期限の429/503/504は持たない。
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
      ["200", "400", "406", "413", "415", "422", "500"].sort(),
    );

    const bodySchema = operation?.requestBody?.content?.["application/json"]?.schema;
    expect(Object.keys(bodySchema?.properties ?? {}).sort()).toEqual([
      "allyFormation",
      "enemyFormation",
    ]);
    const positionSchema =
      bodySchema?.properties?.["allyFormation"]?.properties?.["units"]?.items?.properties?.[
        "position"
      ];
    expect(positionSchema?.properties?.["column"]?.enum).toEqual([0, 1, 2]);
    expect(positionSchema?.properties?.["row"]?.enum).toEqual(["FRONT", "REAR"]);
  });
});
