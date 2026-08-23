import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** REF-053 (Issue #598): `06_UIテスト戦略.md`§5が定めるcontract fixtureの置き場所。 */
export const UI_FIXTURES_DIR = resolve(here, "../../../../ui/src/test/fixtures");
