import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { format, resolveConfig } from "prettier";

const here = dirname(fileURLToPath(import.meta.url));

export const BASELINE_PATH = resolve(here, "../../api/openapi/v1-baseline.json");
export const GENERATED_PATH = resolve(here, "../src/shared/api/generated/v1.d.ts");

/**
 * Regenerates the UI's OpenAPI type mirror from `v1-baseline.json`, formatted with
 * Prettier so a clean regeneration produces byte-identical output to the committed
 * file (required for `check-openapi-types.mjs`'s drift check and `format:check`).
 */
export async function buildGeneratedOpenApiTypes() {
  const schema = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const ast = await openapiTS(schema);
  const raw = COMMENT_HEADER + astToString(ast);
  const options = await resolveConfig(GENERATED_PATH);
  return format(raw, { ...options, filepath: GENERATED_PATH, parser: "typescript" });
}
