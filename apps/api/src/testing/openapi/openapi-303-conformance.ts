/**
 * `12_テスト戦略.md`「OpenAPI」「OpenAPI 3.0.3として検証できる」を、外部の
 * meta-schema validatorを足さずに検査するための走査器。
 *
 * OpenAPI 3.0.3のSchema ObjectはJSON Schema Draft Wright 00の**部分集合**であり、
 * 採用するkeywordが仕様本文（「Schema Object」）で列挙されている。後発のJSON Schema
 * （draft 2019-09 / 2020-12、OpenAPI 3.1）で入ったkeywordは3.0.3では未定義で、
 * 厳格なclient generatorやvalidatorが落ちる。`openapi: "3.0.3"`と宣言している以上、
 * 文書側がその部分集合に収まっていることを機械的に固定する。
 *
 * ここで見るのはSchema Objectのkeywordだけで、文書全体の構造検査ではない。
 * 実際に破綻し得るのは自前で書いたschema片であり（`schemas/`配下）、
 * 文書の骨格は`@fastify/swagger`が生成するため。
 */

/** OpenAPI 3.0.3「Schema Object」がJSON Schemaからそのまま採用するkeyword。 */
const JSON_SCHEMA_KEYWORDS_TAKEN_DIRECTLY = [
  "title",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxProperties",
  "minProperties",
  "required",
  "enum",
] as const;

/** 同「Schema Object」が定義を調整して採用するkeywordと、OpenAPI固有のkeyword。 */
const OPENAPI_ADJUSTED_KEYWORDS = [
  "type",
  "allOf",
  "oneOf",
  "anyOf",
  "not",
  "items",
  "properties",
  "additionalProperties",
  "description",
  "format",
  "default",
  "nullable",
  "discriminator",
  "readOnly",
  "writeOnly",
  "xml",
  "externalDocs",
  "example",
  "deprecated",
  "$ref",
] as const;

export const OPENAPI_303_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  ...JSON_SCHEMA_KEYWORDS_TAKEN_DIRECTLY,
  ...OPENAPI_ADJUSTED_KEYWORDS,
]);

export interface SchemaKeywordViolation {
  /** 文書内の位置（JSON Pointer風のドット表記）。 */
  readonly path: string;
  readonly keyword: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schema Objectとして解釈される位置を辿り、3.0.3が定義しないkeywordを集める。
 *
 * `properties`配下のキーは利用者が決めるプロパティ名であってkeywordではないため、
 * キー名自体は検査せず値だけを辿る。`x-`で始まるspecification extensionは3.0.3が
 * 明示的に許容するので除外する。
 */
export function collectNonConformingSchemaKeywords(
  schema: unknown,
  path = "$",
): readonly SchemaKeywordViolation[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      collectNonConformingSchemaKeywords(item, `${path}[${index}]`),
    );
  }
  if (!isRecord(schema)) {
    return [];
  }

  const violations: SchemaKeywordViolation[] = [];
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword.startsWith("x-")) {
      continue;
    }
    if (!OPENAPI_303_SCHEMA_KEYWORDS.has(keyword)) {
      violations.push({ path, keyword });
      continue;
    }
    if (keyword === "properties" && isRecord(value)) {
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        violations.push(
          ...collectNonConformingSchemaKeywords(
            propertySchema,
            `${path}.properties.${propertyName}`,
          ),
        );
      }
      continue;
    }
    if (
      keyword === "items" ||
      keyword === "not" ||
      keyword === "additionalProperties" ||
      keyword === "allOf" ||
      keyword === "oneOf" ||
      keyword === "anyOf"
    ) {
      violations.push(...collectNonConformingSchemaKeywords(value, `${path}.${keyword}`));
    }
  }
  return violations;
}

interface OpenApiDocumentShape {
  readonly paths?: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly requestBody?: { readonly content?: Readonly<Record<string, MediaTypeShape>> };
            readonly responses?: Readonly<
              Record<string, { readonly content?: Readonly<Record<string, MediaTypeShape>> }>
            >;
            readonly parameters?: readonly { readonly schema?: unknown }[];
          }
        >
      >
    >
  >;
  readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> };
}

interface MediaTypeShape {
  readonly schema?: unknown;
}

/** 文書内でSchema Objectが現れる位置をすべて列挙する。 */
export function collectDocumentSchemas(
  document: unknown,
): readonly { readonly path: string; readonly schema: unknown }[] {
  const typed = document as OpenApiDocumentShape;
  const found: { path: string; schema: unknown }[] = [];

  for (const [componentName, schema] of Object.entries(typed.components?.schemas ?? {})) {
    found.push({ path: `components.schemas.${componentName}`, schema });
  }

  for (const [routePath, methods] of Object.entries(typed.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      const prefix = `paths.${routePath}.${method}`;
      for (const [mediaType, media] of Object.entries(operation.requestBody?.content ?? {})) {
        found.push({ path: `${prefix}.requestBody.${mediaType}`, schema: media.schema });
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const [mediaType, media] of Object.entries(response.content ?? {})) {
          found.push({ path: `${prefix}.responses.${status}.${mediaType}`, schema: media.schema });
        }
      }
      for (const [index, parameter] of (operation.parameters ?? []).entries()) {
        found.push({ path: `${prefix}.parameters[${index}]`, schema: parameter.schema });
      }
    }
  }

  return found;
}
