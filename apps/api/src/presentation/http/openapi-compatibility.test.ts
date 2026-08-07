import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./build-server.js";
import { buildOpenApiTestUseCase } from "../../testing/http/openapi-test-use-case.js";
import { findBreakingChanges } from "../../testing/openapi/openapi-breaking-change.js";
import {
  collectDocumentSchemas,
  collectNonConformingSchemaKeywords,
} from "../../testing/openapi/openapi-303-conformance.js";

/**
 * `12_テスト戦略.md`「OpenAPI」のうち、単発の文書検査（`openapi.test.ts`）では
 * 表せない2点——「OpenAPI 3.0.3として検証できる」と「互換性検査で意図しない
 * 破壊的変更がない」——を担う。
 */
const BASELINE_PATH = fileURLToPath(new URL("../../../openapi/v1-baseline.json", import.meta.url));

/** 生成文書を段階的に辿る。途中が無ければ`undefined`を返す。 */
function navigate(root: unknown, keys: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

describe("OpenAPI v1 compatibility", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer(buildOpenApiTestUseCase());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("API-OPENAPI-020 (REL-004, Issue #203, 12_テスト戦略.md「OpenAPI 3.0.3として検証できる」): every Schema Object in the published document sticks to the keyword subset OpenAPI 3.0.3 defines, so the document matches the version it declares", () => {
    const document = app.swagger() as unknown;
    const schemas = collectDocumentSchemas(document);
    expect(schemas.length).toBeGreaterThan(0);

    const violations = schemas.flatMap(({ path, schema }) =>
      collectNonConformingSchemaKeywords(schema, path),
    );

    expect(
      violations,
      `OpenAPI 3.0.3 does not define these Schema Object keywords: ${JSON.stringify(
        violations.slice(0, 20),
        null,
        2,
      )}`,
    ).toEqual([]);
  });

  it("API-OPENAPI-021 (REL-004, Issue #203): the conformance walker actually rejects post-3.0.3 keywords, so the document-wide conformance check cannot pass by walking nothing", () => {
    // `const` (JSON Schema 2019-09 / OpenAPI 3.1) is the concrete risk here: the
    // repository's own doc schemas are authored with `const`, and it only stays out
    // of the published document because @fastify/swagger rewrites it to a
    // single-value `enum` for OpenAPI 3.0. If that normalization ever stops, the
    // walker must catch it.
    const withConst = {
      type: "object",
      properties: { type: { const: "DAMAGE_APPLIED" } },
    };
    expect(collectNonConformingSchemaKeywords(withConst, "$")).toEqual([
      { path: "$.properties.type", keyword: "const" },
    ]);

    const with2020Keywords = {
      type: "object",
      prefixItems: [{ type: "string" }],
      unevaluatedProperties: false,
    };
    expect(
      collectNonConformingSchemaKeywords(with2020Keywords, "$")
        .map((v) => v.keyword)
        .sort(),
    ).toEqual(["prefixItems", "unevaluatedProperties"]);

    // Specification extensions stay legal.
    expect(collectNonConformingSchemaKeywords({ type: "string", "x-internal": true }, "$")).toEqual(
      [],
    );
  });

  it("API-OPENAPI-022 (REL-004, Issue #203, 12_テスト戦略.md「互換性検査で意図しない破壊的変更がない」): the generated document introduces no breaking change against the frozen v1 baseline", () => {
    const baseline: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const current = app.swagger() as unknown;

    const breaking = findBreakingChanges(baseline, current);

    expect(
      breaking,
      [
        "The published v1 contract lost something the baseline promised.",
        "If the change is intentional it needs a major version (10_API設計.md「バージョニング」);",
        "if the baseline is simply stale, regenerate apps/api/openapi/v1-baseline.json in the same",
        "PR and make the diff part of the review.",
        JSON.stringify(breaking, null, 2),
      ].join("\n"),
    ).toEqual([]);
  });

  it("API-OPENAPI-023 (REL-004, Issue #203): the comparator flags removals and tightenings but accepts backward-compatible additions, so the baseline check cannot pass vacuously", () => {
    const baseline = app.swagger() as unknown;

    // Same document compared against itself: no breaking change.
    expect(findBreakingChanges(baseline, app.swagger() as unknown)).toEqual([]);

    /** baselineを1箇所だけ書き換えたコピーを作る。 */
    const mutate = (edit: (document: Record<string, unknown>) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
      edit(copy);
      return copy;
    };
    /** `paths./api/v1/battle-simulations.post.responses.<status>` のschemaを引く。 */
    const battleResponseSchema = (
      document: Record<string, unknown>,
      status: string,
    ): Record<string, unknown> => {
      const node = navigate(document, [
        "paths",
        "/api/v1/battle-simulations",
        "post",
        "responses",
        status,
        "content",
        "application/json",
        "schema",
      ]);
      expect(node, `battle POST ${status} has no JSON schema`).toBeDefined();
      return node as Record<string, unknown>;
    };
    const errorCodeSchema = (
      document: Record<string, unknown>,
      status: string,
    ): Record<string, unknown> => {
      const node = navigate(battleResponseSchema(document, status), [
        "properties",
        "error",
        "properties",
        "code",
      ]);
      expect(node, `battle POST ${status} publishes no error.code schema`).toBeDefined();
      return node as Record<string, unknown>;
    };

    // Backward-compatible additions listed in 10_API設計.md「バージョニング」:
    // a new optional response property and a new error code.
    const withAdditions = mutate((document) => {
      const properties = battleResponseSchema(document, "200")["properties"] as Record<
        string,
        unknown
      >;
      properties["someNewOptionalField"] = { type: "string" };
      const code = errorCodeSchema(document, "429");
      code["enum"] = [...(code["enum"] as string[]), "SOME_NEW_ERROR_CODE"];
    });
    expect(findBreakingChanges(baseline, withAdditions)).toEqual([]);

    // Breaking: a documented status disappears.
    const withoutStatus = mutate((document) => {
      const responses = navigate(document, [
        "paths",
        "/api/v1/battle-simulations",
        "post",
        "responses",
      ]) as Record<string, unknown>;
      delete responses["503"];
    });
    expect(findBreakingChanges(baseline, withoutStatus)).toEqual([
      expect.objectContaining({ kind: "RESPONSE_STATUS_REMOVED" }),
    ]);

    // Breaking: an existing enum value is dropped.
    const withoutEnumValue = mutate((document) => {
      const code = errorCodeSchema(document, "422");
      code["enum"] = (code["enum"] as string[]).slice(1);
    });
    expect(findBreakingChanges(baseline, withoutEnumValue)).toEqual([
      expect.objectContaining({ kind: "ENUM_VALUE_REMOVED" }),
    ]);

    // Breaking: a required response property is removed.
    const withoutRequiredProperty = mutate((document) => {
      const properties = battleResponseSchema(document, "200")["properties"] as Record<
        string,
        unknown
      >;
      delete properties["catalogRevision"];
    });
    expect(findBreakingChanges(baseline, withoutRequiredProperty)).toEqual([
      expect.objectContaining({ kind: "REQUIRED_PROPERTY_REMOVED" }),
    ]);

    // Breaking: an existing property changes type.
    const withChangedType = mutate((document) => {
      const schemaVersion = navigate(battleResponseSchema(document, "200"), [
        "properties",
        "schemaVersion",
      ]) as Record<string, unknown> | undefined;
      expect(schemaVersion, "the 200 response no longer documents schemaVersion").toBeDefined();
      schemaVersion!["type"] = "string";
    });
    expect(findBreakingChanges(baseline, withChangedType)).toEqual([
      expect.objectContaining({ kind: "PROPERTY_TYPE_CHANGED" }),
    ]);

    // Breaking: the request demands a property it used to accept as optional.
    const withNewlyRequired = mutate((document) => {
      const schema = navigate(document, [
        "paths",
        "/api/v1/battle-simulations",
        "post",
        "requestBody",
        "content",
        "application/json",
        "schema",
      ]) as Record<string, unknown>;
      schema["required"] = [...(schema["required"] as string[]), "options"];
    });
    expect(findBreakingChanges(baseline, withNewlyRequired)).toEqual([
      expect.objectContaining({ kind: "REQUEST_PROPERTY_NEWLY_REQUIRED" }),
    ]);

    // Breaking: a whole operation, then a whole path, disappears.
    const withoutOperation = mutate((document) => {
      const methods = navigate(document, ["paths", "/api/v1/battle-simulations"]) as Record<
        string,
        unknown
      >;
      delete methods["post"];
    });
    expect(findBreakingChanges(baseline, withoutOperation)).toEqual([
      expect.objectContaining({ kind: "OPERATION_REMOVED" }),
    ]);

    const withoutPath = mutate((document) => {
      const paths = document["paths"] as Record<string, unknown>;
      delete paths["/api/v1/battle-simulations"];
    });
    expect(findBreakingChanges(baseline, withoutPath)).toEqual([
      expect.objectContaining({ kind: "PATH_REMOVED" }),
    ]);

    // A new event type inserted mid-union is an addition, not a reordering
    // breakage: variants are matched by their `type` discriminator, not by index.
    const withNewEventVariant = mutate((document) => {
      const events = navigate(battleResponseSchema(document, "200"), [
        "properties",
        "events",
        "items",
      ]) as Record<string, unknown>;
      const variants = events["oneOf"] as unknown[];
      const sample = JSON.parse(JSON.stringify(variants[0])) as Record<string, unknown>;
      (sample["properties"] as Record<string, unknown>)["type"] = {
        type: "string",
        enum: ["SOME_FUTURE_EVENT"],
      };
      events["oneOf"] = [sample, ...variants];
    });
    expect(findBreakingChanges(baseline, withNewEventVariant)).toEqual([]);

    // Breaking: a property keeps its name but stops declaring `type` at all
    // (e.g. widened into a oneOf). 10_API設計.md「バージョニング」counts a type
    // change as breaking however it is spelled.
    const withTypeKeywordDropped = mutate((document) => {
      const schemaVersion = navigate(battleResponseSchema(document, "200"), [
        "properties",
        "schemaVersion",
      ]) as Record<string, unknown> | undefined;
      expect(schemaVersion).toBeDefined();
      delete schemaVersion!["type"];
      schemaVersion!["oneOf"] = [{ type: "string" }, { type: "integer" }];
    });
    expect(findBreakingChanges(baseline, withTypeKeywordDropped)).toEqual([
      expect.objectContaining({ kind: "PROPERTY_TYPE_CHANGED" }),
    ]);
  });

  it("API-OPENAPI-029 (REL-004, Issue #203): shared components.schemas are compared by name, so a contract reachable only through $ref cannot change unnoticed", () => {
    // `paths`側からは`{ $ref: "#/components/schemas/def-0" }`としか見えないため、
    // components を見ない比較器は参照先（再帰的な`ConditionDefinition`＝
    // `EffectApplied`/`EffectApplicationRejected`の`details.expirationConditions`）の
    // 変更を丸ごと見逃す。`$ref`は解決せず（自己参照で無限再帰になる）、
    // components を名前どうしで突き合わせることで塞ぐ。
    const baseline = app.swagger() as unknown;
    const componentsOf = (document: Record<string, unknown>): Record<string, unknown> =>
      navigate(document, ["components", "schemas"]) as Record<string, unknown>;

    const conditionDefinition = componentsOf(baseline as Record<string, unknown>)["def-0"] as
      | { readonly oneOf?: readonly unknown[] }
      | undefined;
    expect(
      conditionDefinition?.oneOf?.length,
      "def-0 is expected to be the recursive ConditionDefinition union",
    ).toBeGreaterThan(1);

    const mutate = (edit: (document: Record<string, unknown>) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
      edit(copy);
      return copy;
    };

    // Breaking: one condition kind is dropped from the shared union.
    const withVariantRemoved = mutate((document) => {
      const definition = componentsOf(document)["def-0"] as { oneOf: unknown[] };
      definition.oneOf = definition.oneOf.slice(1);
    });
    const variantRemoval = findBreakingChanges(baseline, withVariantRemoved);
    expect(variantRemoval).toHaveLength(1);
    expect(variantRemoval[0]?.kind).toBe("REQUIRED_PROPERTY_REMOVED");
    expect(variantRemoval[0]?.location).toMatch(/^components\.schemas\.def-0\.oneOf\[/);

    // Breaking: the shared schema disappears entirely.
    const withComponentRemoved = mutate((document) => {
      delete componentsOf(document)["def-0"];
    });
    expect(findBreakingChanges(baseline, withComponentRemoved)).toEqual([
      expect.objectContaining({
        kind: "REQUIRED_PROPERTY_REMOVED",
        location: "components.schemas.def-0",
      }),
    ]);

    // Breaking: a path stops pointing at the shared schema.
    const withRefRetargeted = mutate((document) => {
      const components = componentsOf(document);
      components["def-1"] = { type: "string" };
      const holder = navigate(document, [
        "paths",
        "/api/v1/battle-simulations",
        "post",
        "responses",
        "200",
        "content",
        "application/json",
        "schema",
        "properties",
        "events",
        "items",
      ]) as { oneOf: Record<string, unknown>[] };
      const refHolder = holder.oneOf.find((variant) =>
        JSON.stringify(variant).includes("#/components/schemas/def-0"),
      );
      expect(
        refHolder,
        "no published event references the shared ConditionDefinition",
      ).toBeDefined();
      const retargeted = JSON.parse(
        JSON.stringify(refHolder).replaceAll(
          "#/components/schemas/def-0",
          "#/components/schemas/def-1",
        ),
      ) as Record<string, unknown>;
      holder.oneOf[holder.oneOf.indexOf(refHolder!)] = retargeted;
    });
    // AND/OR/NOT がそれぞれ def-0 を参照しているため、報告は1件ではなく参照箇所の数になる。
    const refChanges = findBreakingChanges(baseline, withRefRetargeted);
    expect(refChanges.length).toBeGreaterThan(0);
    for (const change of refChanges) {
      expect(change.kind).toBe("PROPERTY_TYPE_CHANGED");
      expect(change.detail).toMatch(/\$ref #\/components\/schemas\/def-0 -> /);
    }

    // Adding a brand-new shared schema is a backward-compatible addition.
    const withNewComponent = mutate((document) => {
      componentsOf(document)["def-99"] = { type: "object", properties: {} };
    });
    expect(findBreakingChanges(baseline, withNewComponent)).toEqual([]);
  });
});
