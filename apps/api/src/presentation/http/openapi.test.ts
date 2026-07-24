import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import {
  battleSimulationResponseSchema,
  battleSimulationResponseDocSchema,
  cooldownStateResponseSchema,
} from "./schemas/simulation/simulation-schema.js";
import {
  battleLogEventResponseDocSchema,
  runtimeCounterChangedDetailsSchema,
} from "./schemas/battle-log/battle-log-schema.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";
import type { BattleSimulationResponseBody } from "../../application/contracts/response.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type { BattleDomainEventType } from "../../domain/battle/events/domain-event.js";
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

class FakeBattleCatalog implements BattleCatalog {
  private readonly units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>;

  constructor(units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>) {
    this.units = units;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-1",
      units: this.units,
      skills: new Map([[createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")]]),
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

  it("UT-R-EFF-01-030 (PR #207再レビュー[P1]): every $ref in the real app.swagger() document resolves to an existing local JSON pointer (ConditionDefinition's AND/OR/NOT self-reference must not become a dangling #/components/schemas/def-N)", () => {
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

  it("API-OPENAPI-007 (PRレビュー指摘[P3]、10_API設計.md「OpenAPIへの反映」「CORS preflightと公開header」): documents an OPTIONS preflight operation for both CORS-enabled routes", () => {
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
    expect(document.paths?.["/api/v1/battle-simulation-catalog"]?.options).toBeDefined();
  });

  it("API-OPENAPI-008 (PRレビュー指摘[P3]、10_API設計.md「CORS」「公開response headerはX-Request-Id、Retry-After、ETag」): documents Access-Control-Allow-Origin and Access-Control-Expose-Headers on the successful responses of both CORS-enabled routes", () => {
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
  });

  it("API-OPENAPI-009 (PRレビュー指摘[P2再レビュー]): documents the preflight request headers (Origin, Access-Control-Request-Method, Access-Control-Request-Headers) as header parameters on the OPTIONS operation, with Origin and Access-Control-Request-Method marked required", () => {
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

  it("API-OPENAPI-010 (PRレビュー指摘[P2再レビュー]): the OPTIONS 204 response documents no body/content, matching the actual empty preflight response", () => {
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

  it("API-OPENAPI-011 (PRレビュー指摘[P2再々レビュー]): documents the 400 Invalid Preflight Request response that @fastify/cors returns for an allowed origin missing Access-Control-Request-Method", () => {
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

  it('API-OPENAPI-012 (PRレビュー指摘[P2再々々レビュー]): the OPTIONS 400 response documents its actual text/plain body ("Invalid Preflight Request"), not a JSON content type', () => {
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

  it("UT-R-EFF-01-029 (08_ドメインイベント.md EffectApplied payload; PR #207レビュー[P2]): validates EffectApplied.details.expirationConditions as a real (recursive) ConditionDefinition union, not an arbitrary object", () => {
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

  it("UT-R-EFF-01-031 (references.ts createTargetReference; PR #207再レビュー[P2]): rejects a BINDING TargetReference missing targetBindingId and a non-BINDING TargetReference that sets it, matching the domain constraint exactly", () => {
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

  it("UT-R-EFF-01-032 (condition-definition.ts TARGET_STATE_FIELD_TYPES; PR #207再レビュー[P2]): rejects a TARGET_STATE value whose type doesn't match its field's Domain-mandated type", () => {
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

  it("UT-R-EFF-01-033 (condition-definition.ts RUNTIME_COUNTER modulo assertInteger({min:1}); PR #207再レビュー[P2]): rejects a RUNTIME_COUNTER modulo that is 0 or non-integer", () => {
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

  it("API-OPENAPI-005 (regression: M5 review [P1] found COOLDOWN_*/CHARGE_*/ACTION_QUEUE_REORDERED silently unvalidated): battleLogEventResponseDocSchema's oneOf declares exactly one variant per BattleDomainEventType, so a newly-added domain event type fails this test (not silently) until its OpenAPI details schema is added", () => {
    // A mapped type over `BattleDomainEventType` forces a compile error (missing
    // or excess key) whenever `BattleDomainEventPayloadMap` gains/loses an event
    // type, so this list can't silently drift from the domain the way
    // `EVENT_DETAILS_SCHEMA_BY_TYPE` did.
    const ALL_EVENT_TYPES: Readonly<Record<BattleDomainEventType, true>> = {
      BattleStarted: true,
      TurnStarted: true,
      ResourcesRecovered: true,
      ActionQueueCreated: true,
      ActionReservationRemoved: true,
      ActionQueueReordered: true,
      ActionStarted: true,
      ActionWaited: true,
      TargetsSelected: true,
      SkillUseStarting: true,
      SkillUseStarted: true,
      SkillUseCompleted: true,
      EffectStepStarting: true,
      EffectStepSkipped: true,
      EffectStepCompleted: true,
      RandomBranchSelected: true,
      EffectActionStarting: true,
      EffectActionCompleted: true,
      UnitBeingAttacked: true,
      HitConfirmed: true,
      CriticalCheckResolved: true,
      DamageCalculated: true,
      DamageApplied: true,
      UnitDefeated: true,
      ActionCompleting: true,
      ActionCompleted: true,
      CooldownStarted: true,
      CooldownReduced: true,
      CooldownCompleted: true,
      ChargeStarted: true,
      ChargeReleased: true,
      TurnCompleting: true,
      TurnCompleted: true,
      BattleCompleted: true,
      ResourceChanged: true,
      PassivePointConsumed: true,
      ExtraGaugeIncreased: true,
      ExtraGaugeOverflowDiscarded: true,
      PassiveActivated: true,
      PassiveResolved: true,
      PassiveInterrupted: true,
      SkillUseInterrupted: true,
      RuntimeCounterChanged: true,
      RuntimeCounterReset: true,
      EffectApplied: true,
      EffectiveEffectChanged: true,
      CombatStatChanged: true,
      EffectDurationReduced: true,
      EffectConsumptionChanged: true,
      EffectExpired: true,
      MarkerApplied: true,
      MarkerUpdated: true,
      MarkerRemoved: true,
    };
    const expectedTypes = new Set(
      Object.keys(ALL_EVENT_TYPES).map((eventType) =>
        eventType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase(),
      ),
    );

    const declaredTypes = new Set(
      battleLogEventResponseDocSchema.oneOf.map(
        (variant) =>
          (variant.properties as { readonly type: { readonly const: string } }).type.const,
      ),
    );

    expect(declaredTypes).toEqual(expectedTypes);
  });

  it("API-OPENAPI-006 (M5 review round 3 [P2] fix): cooldownStateResponseSchema enforces the ACTION/TURN setting-scope XOR (10_API設計.md CooldownStateResponse) — accepts exactly one matching scope field, rejects both missing, both present, or a mismatched scope field", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(cooldownStateResponseSchema);

    expect(
      validate({ skillDefinitionId: "SKL_1", unit: "ACTION", remaining: 1, setAtActionId: "a-1" }),
    ).toBe(true);
    expect(
      validate({ skillDefinitionId: "SKL_1", unit: "TURN", remaining: 1, setAtTurnNumber: 3 }),
    ).toBe(true);

    // Both missing.
    expect(validate({ skillDefinitionId: "SKL_1", unit: "ACTION", remaining: 1 })).toBe(false);
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

  it("API-OPENAPI-007 (PR #211 review [P2] fix): runtimeCounterChangedDetailsSchema enforces the SKILL_RUNTIME/APPLIED_EFFECT scope XOR — accepts exactly one matching id field, rejects both missing, both present, or a mismatched scope field", () => {
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
});
