/**
 * Regenerates `src/shared/api/generated/v1.d.ts` from `apps/api/openapi/v1-baseline.json`.
 *
 * Run after `v1-baseline.json` changes so the UI's generated type mirror stays in sync
 * (`check-openapi-types.mjs` / `mise run ui:openapi:check` fails otherwise).
 *
 *   mise exec -- pnpm --filter ui run openapi:generate
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stdout } from "node:process";
import { buildGeneratedOpenApiTypes, GENERATED_PATH } from "./openapi-types-lib.mjs";

const output = await buildGeneratedOpenApiTypes();
mkdirSync(dirname(GENERATED_PATH), { recursive: true });
writeFileSync(GENERATED_PATH, output);
stdout.write(`wrote ${GENERATED_PATH}\n`);
