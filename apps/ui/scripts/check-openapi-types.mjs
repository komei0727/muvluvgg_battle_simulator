/**
 * Fails if `src/shared/api/generated/v1.d.ts` has drifted from what regenerating it
 * from `apps/api/openapi/v1-baseline.json` would produce (REF-052, Issue #597).
 *
 *   mise exec -- pnpm --filter ui run openapi:check
 */
import { existsSync, readFileSync } from "node:fs";
import { BASELINE_PATH, buildGeneratedOpenApiTypes, GENERATED_PATH } from "./openapi-types-lib.mjs";

const fresh = await buildGeneratedOpenApiTypes();
const committed = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, "utf8") : undefined;

if (committed === fresh) {
  console.log(`OK: "${GENERATED_PATH}" is up to date with "${BASELINE_PATH}".`);
} else {
  console.error(`FAILED: "${GENERATED_PATH}" is stale relative to "${BASELINE_PATH}".`);
  console.error("Run `pnpm --filter ui run openapi:generate` to regenerate it.");
  process.exitCode = 1;
}
